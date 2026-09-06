import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate } from "node:timers/promises";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createDockerDeployProvider, DockerDeploymentUnavailable } from "../src/deploy/docker-deploy-provider.ts";
import type { DeployProvider } from "../src/deploy/deploy-provider.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { scopeId } from "../src/types.ts";
import { createMemoryAdvisoryLock, type AdvisoryLock } from "../src/persistence/advisory-lock.ts";
import { createApp } from "../src/api/app.ts";

const input = {
  ownerScopeId: scopeId("personal", "U1"),
  createdBy: "U1",
  entrypoint: "node server.js",
  files: [{ path: "server.js", data: "process.exit(1)" }],
};

async function fixture(context: TestContext, provider: DeployProvider, advisoryLock = createMemoryAdvisoryLock()) {
  const deployDir = await mkdtemp(join(tmpdir(), "docker-deploy-service-"));
  context.after(() => rm(deployDir, { recursive: true, force: true }));
  const backing = createMemoryMap<Deployment>();
  const store = createDeployStore(backing);
  const makeService = () =>
    createDeployService({
      deployStore: createDeployStore(backing),
      provider,
      deployDir,
      acl: createAclStore(),
      advisoryLock,
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
    });
  return { store, service: makeService(), makeService };
}

test("provider maintenance can acquire the shared deployment lock during optimistic resolution", async (context) => {
  const advisoryLock = createMemoryAdvisoryLock();
  let maintained = false;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: true },
    apply: async () => ({ host: "live", port: 8080 }),
    resolveEndpoint: async (deployment) => {
      await advisoryLock.tryWithLock!(`deploy:${deployment.id}`, async () => {
        maintained = true;
      });
      return deployment.endpoint;
    },
    destroy: async () => {},
  };
  const { service } = await fixture(context, provider, advisoryLock);
  const deployment = await service.deploy(input);
  assert.equal((await service.reachDeployment(deployment.id, "U1")).status, "ok");
  assert.equal(maintained, true);
});

test("failed automatic recovery stops durably and concurrent reach never loops apply", async (context) => {
  let applies = 0;
  const provider: DeployProvider = {
    serializeEndpointResolution: true,
    profile: { managedScaleToZero: false },
    apply: async () => {
      if (++applies > 1)
        throw new DockerDeploymentUnavailable("deployment HTTP readiness timed out; republish required");
      return { host: "old", port: 8080 };
    },
    resolveEndpoint: async () => null,
    destroy: async () => {},
  };
  const { store, service, makeService } = await fixture(context, provider);
  const deployment = await service.deploy(input);
  await Promise.allSettled(Array.from({ length: 8 }, () => makeService().reachDeployment(deployment.id, "U1")));
  assert.equal(applies, 2);
  const stopped = (await store.get(deployment.id))!;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.endpoint, null);
  assert.match(stopped.failureReason!, /republish required/);
  assert.deepEqual(await makeService().reachDeployment(deployment.id, "U1"), { status: "not_found" });
  assert.equal(applies, 2);
});

test("an observed crash stops durably but denied callers cannot probe the container", async (context) => {
  let probes = 0;
  const provider: DeployProvider = {
    serializeEndpointResolution: true,
    profile: { managedScaleToZero: false },
    apply: async () => ({ host: "old", port: 8080 }),
    resolveEndpoint: async () => {
      probes++;
      throw new DockerDeploymentUnavailable("deployment not running (exit 1); republish required");
    },
    destroy: async () => {},
  };
  const { store, service } = await fixture(context, provider);
  const deployment = await service.deploy(input);
  assert.deepEqual(await service.reachDeployment(deployment.id, "stranger"), { status: "denied" });
  assert.equal(probes, 0);
  await assert.rejects(service.reachDeployment(deployment.id, "U1"), /not running/);
  assert.equal((await store.get(deployment.id))!.status, "stopped");
  assert.deepEqual(await service.reachDeployment(deployment.id, "U1"), { status: "not_found" });
  assert.equal(probes, 1);
});

test("a failed redeploy clears running state and an explicit republish clears the failure", async (context) => {
  let fail = false;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      if (fail) throw new DockerDeploymentUnavailable("deployment not running (exit 1); republish required");
      return { host: "live", port: 8080 };
    },
    destroy: async () => {},
  };
  const { store, service } = await fixture(context, provider);
  const deployment = await service.deploy(input);
  fail = true;
  await assert.rejects(service.redeploy(deployment.id, input), /republish required/);
  assert.equal((await store.get(deployment.id))!.status, "stopped");
  assert.equal((await store.get(deployment.id))!.endpoint, null);
  fail = false;
  const restored = await service.redeploy(deployment.id, input);
  assert.equal(restored.status, "running");
  assert.equal(restored.failureReason, undefined);
});

test("rejected snapshot preserves the serving app and missing-runtime recovery uses its applied version", async (context) => {
  let commands = 0;
  let missing = false;
  const applied: number[] = [];
  const resolved: number[] = [];
  const provider = createDockerDeployProvider({
    dockerExec: async (args) => {
      commands++;
      if (missing && args[0] === "inspect") {
        missing = false;
        return { code: 1, stdout: "", stderr: "No such container" };
      }
      return {
        code: 0,
        stdout: JSON.stringify({
          State: { Running: true, Status: "running", ExitCode: 0 },
          NetworkSettings: { Networks: {}, Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32789" }] } },
        }),
        stderr: "",
      };
    },
    fetch: async () => new Response("ok"),
  });
  const { service, store, makeService } = await fixture(context, {
    ...provider,
    apply: async (deployment, version) => {
      applied.push(version.version);
      return provider.apply(deployment, version);
    },
    resolveEndpoint: async (deployment, version) => {
      resolved.push(version.version);
      return provider.resolveEndpoint!(deployment, version);
    },
  });
  const deployment = await service.deploy(input);
  const before = commands;
  await assert.rejects(service.redeploy(deployment.id, { ...input, files: [] }), /invalid deployment snapshot/);
  const after = (await store.get(deployment.id))!;
  assert.equal(commands, before);
  assert.equal(after.status, "running");
  assert.deepEqual(after.endpoint, deployment.endpoint);
  assert.equal(after.appliedVersion, deployment.appliedVersion);
  assert.equal(after.failureReason, undefined);
  assert.equal(after.currentVersion, 2);
  missing = true;
  assert.equal((await makeService().reachDeployment(deployment.id, "U1")).status, "ok");
  assert.deepEqual(applied, [1, 2, 1]);
  assert.deepEqual(resolved, [1]);
  const recovered = (await store.get(deployment.id))!;
  assert.equal(recovered.status, "running");
  assert.equal(recovered.currentVersion, 2);
  assert.equal(recovered.appliedVersion, 1);
  assert.equal((await service.reachDeployment(deployment.id, "U1")).status, "ok");
  assert.deepEqual(applied, [1, 2, 1]);
  assert.deepEqual(resolved, [1, 1]);
});

test("invalid applied snapshot during missing-runtime recovery stops durably without repeated retries", async (context) => {
  let applies = 0;
  let probes = 0;
  const provider = createDockerDeployProvider({
    dockerExec: async () => {
      probes++;
      return { code: 1, stdout: "", stderr: "No such container" };
    },
  });
  const { service, store, makeService } = await fixture(context, {
    ...provider,
    apply: async (deployment, version) => {
      applies++;
      return provider.apply(deployment, version);
    },
  });
  const deployment = await store.create({ ...input, files: [], snapshotDir: "/missing-applied-snapshot" });
  await store.setEndpoint(deployment.id, { host: "old", port: 8080 });
  await store.setAppliedVersion(deployment.id, 1);
  await store.setStatus(deployment.id, "running");
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, () => makeService().reachDeployment(deployment.id, "U1")),
  );
  assert.equal(applies, 1);
  assert.equal(probes, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  const stopped = (await store.get(deployment.id))!;
  assert.equal(stopped.status, "stopped");
  assert.equal(stopped.endpoint, null);
  assert.match(stopped.failureReason!, /invalid deployment snapshot.*republish required/);
  assert.deepEqual(await service.reachDeployment(deployment.id, "U1"), { status: "not_found" });
  assert.equal(applies, 1);
  assert.equal(probes, 1);
});

for (const serialized of [true, false]) {
  test(`recovery preserves current-version behavior for ${serialized ? "legacy Docker records" : "other providers"}`, async (context) => {
    const applied: number[] = [];
    const resolved: number[] = [];
    const provider: DeployProvider = {
      serializeEndpointResolution: serialized,
      profile: { managedScaleToZero: !serialized },
      apply: async (_deployment, version) => {
        applied.push(version.version);
        return { host: "recovered", port: 8080 };
      },
      resolveEndpoint: async (_deployment, version) => {
        resolved.push(version.version);
        return null;
      },
      destroy: async () => {},
    };
    const { store, service } = await fixture(context, provider);
    const deployment = await store.create({ ...input, snapshotDir: "/legacy-snapshot" });
    await store.addVersion(deployment.id, { ...input, snapshotDir: "/new-snapshot" });
    if (!serialized) await store.setAppliedVersion(deployment.id, 1);
    await store.setEndpoint(deployment.id, { host: "old", port: 8080 });
    await store.setStatus(deployment.id, "running");
    assert.equal((await service.reachDeployment(deployment.id, "U1")).status, "ok");
    assert.deepEqual(applied, [2]);
    assert.deepEqual(resolved, serialized ? [2] : [2, 2]);
    assert.equal((await store.get(deployment.id))!.appliedVersion, 2);
  });
}

test("daemon failures neither stop nor rebuild a running deployment", async (context) => {
  let applies = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      applies++;
      return { host: "live", port: 8080 };
    },
    resolveEndpoint: async () => {
      throw new Error("docker inspect failed: daemon unavailable");
    },
    destroy: async () => {},
  };
  const { store, service } = await fixture(context, provider);
  const deployment = await service.deploy(input);
  await assert.rejects(service.reachDeployment(deployment.id, "U1"), /daemon unavailable/);
  assert.equal((await store.get(deployment.id))!.status, "running");
  assert.equal(applies, 1);
});

test("reach queued behind archive cannot revive the archived runtime", async (context) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let resolves = 0;
  let applies = 0;
  const provider: DeployProvider = {
    serializeEndpointResolution: true,
    profile: { managedScaleToZero: false },
    apply: async () => {
      applies++;
      return { host: "live", port: 8080 };
    },
    resolveEndpoint: async () => {
      resolves++;
      return null;
    },
    destroy: async () => {
      entered.resolve();
      await release.promise;
    },
  };
  const { service, store } = await fixture(context, provider);
  const deployment = await service.deploy(input);
  const archive = service.archiveDeployment(deployment.id);
  await entered.promise;
  const reach = service.reachDeployment(deployment.id, "U1");
  release.resolve();
  await archive;
  assert.deepEqual(await reach, { status: "not_found" });
  assert.equal((await store.get(deployment.id))!.status, "archived");
  assert.equal(resolves, 0);
  assert.equal(applies, 1);
});

test("stopped diagnostics are visible only through authorized views and logs are never persisted", async (context) => {
  let logReads = 0;
  const reason = "deployment not running (exit 17); republish required";
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      throw new DockerDeploymentUnavailable(reason);
    },
    destroy: async () => {},
    logs: async () => {
      logReads++;
      return "private application output";
    },
  };
  const { service, store } = await fixture(context, provider);
  const app = createApp({ deploy: service } as unknown as Parameters<typeof createApp>[0]);
  await assert.rejects(service.deploy(input), /exit 17/);
  const deployment = (await store.list())[0]!;
  assert.deepEqual(await app.listDeploymentsForViewer("stranger"), []);
  assert.deepEqual(await app.deploymentLogsFor(deployment.id, "stranger", { tailLines: 20 }), { status: "denied" });
  assert.equal(logReads, 0);
  const view = (await app.listDeploymentsForViewer("U1"))[0]!;
  assert.equal(Reflect.get(view, "failureReason"), reason);
  assert.ok(!JSON.stringify(view).includes("private application output"));
  assert.deepEqual(await app.deploymentLogsFor(deployment.id, "U1", { tailLines: 20 }), {
    status: "ok",
    logs: "private application output",
  });
  assert.equal(logReads, 1);
  assert.ok(!JSON.stringify(await store.get(deployment.id)).includes("private application output"));
  await service.archiveDeployment(deployment.id);
  assert.equal(await service.deploymentLogs(deployment.id, { tailLines: 20 }), null);
});

for (const operation of ["archive", "redeploy"] as const) {
  test(`initial publish serializes with ${operation} across services`, async (context) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const actions: string[] = [];
    const provider: DeployProvider = {
      profile: { managedScaleToZero: false },
      apply: async (_deployment, version) => {
        actions.push(`apply:${version.version}`);
        if (version.version === 1) {
          entered.resolve();
          await release.promise;
        }
        return { host: `version-${version.version}`, port: 8080 };
      },
      destroy: async () => {
        actions.push("destroy");
      },
    };
    const { service, store, makeService } = await fixture(context, provider);
    const publishing = service.deploy(input);
    await entered.promise;
    const pending = (await store.list())[0]!;
    const other = makeService();
    const competing = operation === "archive" ? other.archiveDeployment(pending.id) : other.redeploy(pending.id, input);
    try {
      await setImmediate();
      assert.deepEqual(actions, ["apply:1"]);
    } finally {
      release.resolve();
      await Promise.all([publishing, competing]);
    }
    const published = await publishing;
    assert.equal(published.status, "running");
    assert.equal(published.currentVersion, 1);
    assert.equal(published.appliedVersion, 1);
    assert.equal(published.endpoint?.host, "version-1");
    const final = (await store.get(pending.id))!;
    assert.deepEqual(actions, ["apply:1", operation === "archive" ? "destroy" : "apply:2"]);
    assert.equal(final.status, operation === "archive" ? "archived" : "running");
    assert.equal(final.endpoint?.host ?? null, operation === "archive" ? null : "version-2");
    assert.equal(final.appliedVersion, operation === "archive" ? 1 : 2);
  });
}

test("archive before initial lock acquisition leaves the deployment archived", async (context) => {
  const entered = Promise.withResolvers<string>();
  const release = Promise.withResolvers<void>();
  const sharedLock = createMemoryAdvisoryLock();
  let first = true;
  const advisoryLock: AdvisoryLock = {
    async withLock(key, fn) {
      if (first) {
        first = false;
        entered.resolve(key);
        await release.promise;
      }
      return sharedLock.withLock(key, fn);
    },
  };
  let applies = 0;
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      applies++;
      return { host: "live", port: 8080 };
    },
    destroy: async () => {},
  };
  const { service, store, makeService } = await fixture(context, provider, advisoryLock);
  const publishing = service.deploy(input);
  const id = (await entered.promise).slice("deploy:".length);
  try {
    await makeService().archiveDeployment(id);
  } finally {
    release.resolve();
  }
  const published = await publishing;
  assert.equal(published.status, "archived");
  assert.equal(published.endpoint, null);
  assert.equal(published.appliedVersion, undefined);
  assert.equal((await store.get(id))!.status, "archived");
  assert.equal(applies, 0);
});

test("initial publish stays stopped until provider readiness completes", async (context) => {
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const provider: DeployProvider = {
    profile: { managedScaleToZero: false },
    apply: async () => {
      entered.resolve();
      await release.promise;
      return { host: "ready", port: 8080 };
    },
    destroy: async () => {},
  };
  const { service, store } = await fixture(context, provider);
  const publishing = service.deploy(input);
  await entered.promise;
  const pending = (await store.list())[0]!;
  assert.equal(pending.status, "stopped");
  assert.equal(pending.endpoint, null);
  assert.deepEqual(await service.reachDeployment(pending.id, "U1"), { status: "not_found" });
  release.resolve();
  assert.equal((await publishing).status, "running");
});

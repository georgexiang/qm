import assert from "node:assert/strict";
import { test } from "node:test";
import { link, lstat, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider, DockerDeploymentUnavailable } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployStore } from "../src/deploy/deploy-store.ts";
import type { DockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";

async function fixture() {
  const snapshotDir = await mkdtemp(join(tmpdir(), "docker-publish-unit-"));
  await writeFile(join(snapshotDir, "server.js"), "process.exit(0)");
  const deployment = await createDeployStore().create({
    ownerScopeId: scopeId("personal", "U1"),
    createdBy: "U1",
    entrypoint: "node server.js",
    snapshotDir,
  });
  const calls: string[][] = [];
  const state = {
    State: { Running: true, ExitCode: 0, Status: "running" },
    NetworkSettings: {
      Networks: { [`agent-deploy-${deployment.id.slice(0, 12)}-net`]: {} },
      Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "32789" }] },
    },
  };
  const dockerExec: DockerExec = async (args) => {
    calls.push(args);
    return {
      code: 0,
      stdout: args[0] === "inspect" ? JSON.stringify(state) : "",
      stderr: "",
    };
  };
  return { snapshotDir, deployment, calls, dockerExec, state };
}

test("container Core copies its snapshot and probes the private endpoint without publishing ports", async (context) => {
  const { snapshotDir, deployment, calls, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  const urls: string[] = [];
  const provider = createDockerDeployProvider({
    dockerExec,
    coreContainer: "test-core",
    fetch: async (url, init) => {
      urls.push(String(url));
      assert.ok(init?.signal instanceof AbortSignal);
      return new Response("ready");
    },
  });
  const endpoint = await provider.apply(deployment, deployment.versions[0]!);
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  assert.deepEqual(endpoint, { host: app, port: 8080 });
  assert.deepEqual(urls, [`http://${app}:8080/`]);
  assert.ok(calls.some((args) => args[0] === "cp"));
  assert.ok(calls.some((args) => args.join(" ") === `network connect ${app}-net test-core`));
  assert.ok(!calls.some((args) => args.includes("-p") || args.includes("-v")));
  assert.ok(!calls.some((args) => args.some((arg) => arg.includes(snapshotDir))));
  const appCreate = calls.find((args) => args[0] === "create" && args.includes(app))!;
  assert.ok(appCreate.some((arg) => arg.includes("target=/app,volume-nocopy,readonly")));
  assert.ok(!appCreate.includes("--read-only"));
  assert.ok(!appCreate.includes("--tmpfs"));
});

test("republish and repeated destroy tolerate an old Core still attached to the app network", async (context) => {
  const { snapshotDir, deployment, calls, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  const provider = createDockerDeployProvider({
    coreContainer: "new-core",
    fetch: async () => new Response("ready"),
    dockerExec: async (args, timeout) => {
      const result = await dockerExec(args, timeout);
      if (args[0] === "network" && args[1] === "rm")
        return { code: 1, stdout: "", stderr: "network has active endpoints" };
      return result;
    },
  });
  await provider.apply(deployment, deployment.versions[0]!);
  await provider.apply(deployment, deployment.versions[0]!);
  assert.ok(!calls.some((args) => args[0] === "network" && args[1] === "rm"));
  await provider.destroy(deployment);
  await provider.destroy(deployment);
  assert.ok(calls.filter((args) => args[1] === "disconnect").every((args) => args.at(-1) === "new-core"));
});

test("HTTP authentication, API-only roots and temporary service errors count as startup responsiveness", async (context) => {
  const { snapshotDir, deployment, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  for (const status of [401, 404, 503]) {
    const provider = createDockerDeployProvider({
      dockerExec,
      coreContainer: "test-core",
      readinessTimeoutMs: 100,
      fetch: async () => new Response("private details", { status }),
    });
    await assert.doesNotReject(provider.apply(deployment, deployment.versions[0]!));
  }
});

test("ordinary endpoint resolution never probes HTTP and transient container states are not definitive failures", async (context) => {
  const { snapshotDir, deployment, dockerExec, state } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  let probes = 0;
  const provider = createDockerDeployProvider({
    dockerExec,
    readinessTimeoutMs: 30,
    fetch: async () => {
      probes++;
      return new Response("temporary", { status: 503 });
    },
  });
  assert.deepEqual(await provider.resolveEndpoint!(deployment, deployment.versions[0]!), {
    host: "127.0.0.1",
    port: 32789,
  });
  assert.equal(probes, 0);
  state.State.Running = false;
  for (const status of ["restarting", "created", "paused", "removing"]) {
    state.State.Status = status;
    await assert.rejects(provider.resolveEndpoint!(deployment, deployment.versions[0]!), (error) => {
      assert.ok(error instanceof Error);
      assert.ok(!(error instanceof DockerDeploymentUnavailable));
      return true;
    });
  }
});

test("snapshot symlinks are rejected before any Docker mutation", async (context) => {
  const { snapshotDir, deployment, calls, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  await symlink("/etc/passwd", join(snapshotDir, "leak"));
  const provider = createDockerDeployProvider({ dockerExec });
  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /snapshot/);
  assert.deepEqual(calls, []);
});

test("readiness aborts a stalled request within the total budget", async (context) => {
  const { snapshotDir, deployment, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  let aborted = false;
  const provider = createDockerDeployProvider({
    dockerExec,
    coreContainer: "test-core",
    readinessTimeoutMs: 50,
    fetch: async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("probe exceeded budget")), 2000);
        init!.signal!.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            aborted = true;
            reject(init!.signal!.reason);
          },
          { once: true },
        );
      }),
  });
  const started = Date.now();
  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /readiness timed out/);
  assert.equal(aborted, true);
  assert.ok(Date.now() - started < 1000);
});

test("a process exiting after an HTTP response retains its container and volume for bounded logs", async (context) => {
  const { snapshotDir, deployment, dockerExec, state, calls } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  const provider = createDockerDeployProvider({
    dockerExec,
    coreContainer: "test-core",
    fetch: async () => {
      state.State.Running = false;
      state.State.ExitCode = 23;
      state.State.Status = "exited";
      return new Response("ok");
    },
  });
  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /not running.*23/);
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  const afterStart = calls.slice(calls.findIndex((args) => args[0] === "start") + 1);
  assert.ok(!afterStart.some((args) => args.join(" ") === `rm -f ${app}`));
  assert.ok(!afterStart.some((args) => args[0] === "volume"));
  const copied = calls.find((args) => args[0] === "cp")!;
  await assert.rejects(lstat(copied[1]!), { code: "ENOENT" });
  await provider.logs!(deployment, { tailLines: 9999 });
  assert.deepEqual(calls.at(-1), ["logs", "--tail", "2000", app]);
  state.State.Running = true;
  state.State.Status = "running";
  const nextApply = calls.length;
  const replacement = createDockerDeployProvider({ dockerExec, fetch: async () => new Response("ok") });
  await replacement.apply(deployment, deployment.versions[0]!);
  assert.ok(calls.slice(nextApply).some((args) => args.join(" ") === `rm -f ${app}`));
});

for (const invalid of ["empty", "missing", "outside-root", "hardlink", "root-symlink"] as const) {
  test(`invalid ${invalid} snapshot is rejected before Docker access`, async (context) => {
    const { snapshotDir, deployment, calls, dockerExec } = await fixture();
    context.after(() => rm(snapshotDir, { recursive: true, force: true }));
    let snapshotRoot: string | undefined;
    if (invalid === "empty") await rm(join(snapshotDir, "server.js"));
    if (invalid === "missing") deployment.versions[0]!.snapshotDir = join(snapshotDir, "missing");
    if (invalid === "outside-root") snapshotRoot = join(snapshotDir, "server.js");
    if (invalid === "hardlink") await link(join(snapshotDir, "server.js"), join(snapshotDir, "another.js"));
    if (invalid === "root-symlink") {
      await symlink(snapshotDir, join(snapshotDir, "linked-root"));
      deployment.versions[0]!.snapshotDir = join(snapshotDir, "linked-root");
    }
    const provider = createDockerDeployProvider({ dockerExec, snapshotRoot });
    await assert.rejects(provider.apply(deployment, deployment.versions[0]!), /invalid deployment snapshot/);
    assert.deepEqual(calls, []);
  });
}

test("failed artifact copying cleans owned resources and never includes Docker stderr in its error", async (context) => {
  const { snapshotDir, deployment, calls, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  const provider = createDockerDeployProvider({
    coreContainer: "test-core",
    dockerExec: async (args, timeout) => {
      const result = await dockerExec(args, timeout);
      return args[0] === "cp" ? { code: 1, stdout: "", stderr: "sensitive-value" } : result;
    },
  });
  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), (error: Error) => {
    assert.match(error.message, /creation failed during artifact copy.*republish required/);
    assert.ok(!error.message.includes("sensitive-value"));
    return true;
  });
  const copied = calls.find((args) => args[0] === "cp")!;
  await assert.rejects(lstat(copied[1]!), { code: "ENOENT" });
  const afterCopy = calls.slice(calls.indexOf(copied) + 1);
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  assert.ok(afterCopy.some((args) => args.join(" ") === `rm -f ${app}-copy`));
  assert.ok(afterCopy.some((args) => args.join(" ") === `volume rm ${app}-artifact`));
  assert.ok(!afterCopy.some((args) => args.join(" ") === `rm -f ${app}`));
  assert.ok(!afterCopy.some((args) => args[0] === "network"));
  assert.ok(!calls.some((args) => args[0] === "start"));
});

test("replacement Core attaches only to the app network and ignores persisted loopback endpoints", async (context) => {
  const { snapshotDir, deployment, calls, dockerExec } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  deployment.endpoint = { host: "127.0.0.1", port: 9200 };
  const provider = createDockerDeployProvider({
    dockerExec,
    coreContainer: "replacement-core",
    fetch: async (_url, init) => {
      assert.equal(init!.redirect, "manual");
      return new Response(null, { status: 302, headers: { location: "http://must-not-follow.invalid" } });
    },
  });
  const app = `agent-deploy-${deployment.id.slice(0, 12)}`;
  assert.deepEqual(await provider.resolveEndpoint!(deployment, deployment.versions[0]!), { host: app, port: 8080 });
  assert.deepEqual(
    calls.filter((args) => args[1] === "connect"),
    [["network", "connect", `${app}-net`, "replacement-core"]],
  );
  assert.ok(!calls.some((args) => ["create", "start", "cp", "rm"].includes(args[0]!)));
});

test("host Core resolves Docker's actual port after provider recreation", async (context) => {
  const { snapshotDir, deployment, dockerExec, calls } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  deployment.endpoint = { host: "127.0.0.1", port: 9200 };
  const options = { dockerExec, fetch: async () => new Response("ready") };
  const endpoint = await createDockerDeployProvider(options).apply(deployment, deployment.versions[0]!);
  assert.deepEqual(endpoint, { host: "127.0.0.1", port: 32789 });
  assert.deepEqual(
    await createDockerDeployProvider(options).resolveEndpoint!(deployment, deployment.versions[0]!),
    endpoint,
  );
  assert.ok(calls.some((args) => args.includes("127.0.0.1:0:8080")));
});

test("a missing container resolves null without mutating Docker", async (context) => {
  const { snapshotDir, deployment } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  const calls: string[][] = [];
  const provider = createDockerDeployProvider({
    dockerExec: async (args) => {
      calls.push(args);
      return { code: 1, stdout: "", stderr: "Error: No such object: app" };
    },
  });
  assert.equal(await provider.resolveEndpoint!(deployment, deployment.versions[0]!), null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![0], "inspect");
});

test("partial old-runtime cleanup failure requires republish instead of repeated recovery", async (context) => {
  const { snapshotDir, deployment, dockerExec, calls } = await fixture();
  context.after(() => rm(snapshotDir, { recursive: true, force: true }));
  const provider = createDockerDeployProvider({
    dockerExec: async (args, timeout) => {
      const result = await dockerExec(args, timeout);
      return args[0] === "volume" && args[1] === "rm" ? { code: 1, stdout: "", stderr: "volume is in use" } : result;
    },
  });
  await assert.rejects(provider.apply(deployment, deployment.versions[0]!), DockerDeploymentUnavailable);
  assert.ok(!calls.some((args) => args[0] === "create"));
});

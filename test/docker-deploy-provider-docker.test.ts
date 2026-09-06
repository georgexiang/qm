import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDockerDeployProvider } from "../src/deploy/docker-deploy-provider.ts";
import { createDeployService } from "../src/deploy/deploy-service.ts";
import { createDeployStore, type Deployment } from "../src/deploy/deploy-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAclStore } from "../src/acl/acl-store.ts";
import { spawnDockerExec } from "../src/sandbox/docker-exec.ts";
import { scopeId } from "../src/types.ts";

const enabled = process.env.QM_DOCKER_DEPLOY_E2E === "1";
const phase = process.env.QM_DOCKER_DEPLOY_PHASE;
const dockerExec = spawnDockerExec("docker");
const appName = (id: string) => `agent-deploy-${id.slice(0, 12)}`;
const docker = async (args: string[], timeout = 60_000): Promise<string> => {
  const result = await dockerExec(args, timeout);
  assert.equal(result.code, 0, `docker ${args[0]} failed: ${result.stderr}${args[0] === "start" ? result.stdout : ""}`);
  return result.stdout.trim();
};
const appSource = (body: string, delay = 0, rootStatus = 200) => `
const http = require("node:http");
const fs = require("node:fs");
for (const path of ["/app/write-test"]) {
  try { fs.writeFileSync(path, "unexpected"); process.exit(91); }
  catch (error) { if (error.code !== "EROFS") throw error; }
}
if (fs.existsSync("/data/core-secret") || fs.existsSync("/var/run/docker.sock")) process.exit(92);
fs.writeFileSync("/tmp/allowed", "ok");
fs.writeFileSync("/root/allowed", "ok");
fs.writeFileSync("/tmp/runtime-script", "#!/bin/sh\\nexit 0\\n", { mode: 0o755 });
require("node:child_process").execFileSync("/tmp/runtime-script");
setTimeout(() => http.createServer((request, response) => {
  response.statusCode = request.url === "/" ? ${rootStatus} : request.url === "/unavailable" ? 503 : 200;
  response.end(${JSON.stringify(body)});
}).listen(Number(process.env.PORT), "0.0.0.0"), ${delay});
`;

test(
  "real Docker: named-volume Core publish and replacement",
  { skip: !enabled || !!phase, timeout: 300_000 },
  async (context) => {
    const prefix = `qm-publish-e2e-${randomUUID()}`;
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    const directory = await mkdtemp(join(tmpdir(), "qm-publish-e2e-"));
    const coreNames = [`${prefix}-core`, `${prefix}-replacement`];
    const dataVolume = `${prefix}-data`;
    const coreNetwork = `${prefix}-net`;
    const coreImage = `${prefix}:local`;
    context.after(async () => {
      for (const core of coreNames) await dockerExec(["rm", "-f", core]);
      for (const id of ids) {
        await dockerExec(["rm", "-f", appName(id), `${appName(id)}-copy`]);
        await dockerExec(["volume", "rm", `${appName(id)}-artifact`]);
        await dockerExec(["network", "rm", `${appName(id)}-net`]);
      }
      await dockerExec(["network", "rm", coreNetwork]);
      await dockerExec(["volume", "rm", dataVolume]);
      await dockerExec(["image", "rm", coreImage]);
      await rm(directory, { recursive: true, force: true });
    });
    await writeFile(join(directory, "Dockerfile"), "FROM node:24-alpine\nRUN apk add --no-cache docker-cli git\n");
    await docker(["build", "-t", coreImage, directory], 180_000);
    await docker(["volume", "create", dataVolume]);
    await docker(["network", "create", coreNetwork]);
    for (const [index, core] of coreNames.entries()) {
      const childPhase = index === 0 ? "publish" : "replacement";
      await docker([
        "create",
        "--name",
        core,
        "--network",
        coreNetwork,
        "--mount",
        `type=volume,source=${dataVolume},target=/data`,
        "--mount",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
        "-w",
        "/work/test",
        "-e",
        `QM_DOCKER_DEPLOY_PHASE=${childPhase}`,
        "-e",
        `QM_DOCKER_DEPLOY_CORE=${core}`,
        "-e",
        `QM_DOCKER_DEPLOY_OLD_CORE=${coreNames[0]}`,
        "-e",
        `QM_DOCKER_DEPLOY_IDS=${ids.join(",")}`,
        coreImage,
        "node",
        "-e",
        "setInterval(() => {}, 1000)",
      ]);
      await docker(["cp", join(import.meta.dirname, "../src"), `${core}:/work/src`]);
      await docker(["cp", import.meta.filename, `${core}:/work/test/docker-deploy-provider-docker.test.ts`]);
      await docker(["start", core]);
      const output = await docker(["exec", core, "node", "--test", "docker-deploy-provider-docker.test.ts"], 120_000);
      assert.equal(await docker(["inspect", "--format", "{{.State.Running}}", core]), "true");
      context.diagnostic(output);
    }
    for (const core of coreNames) await docker(["rm", "-f", core]);
    for (const id of ids) {
      assert.notEqual((await dockerExec(["inspect", appName(id)])).code, 0);
      await dockerExec(["network", "rm", `${appName(id)}-net`]);
      assert.notEqual((await dockerExec(["network", "inspect", `${appName(id)}-net`])).code, 0);
      assert.notEqual((await dockerExec(["volume", "inspect", `${appName(id)}-artifact`])).code, 0);
    }
  },
);

test(
  "container Core publishes only its snapshot and rejects crashes",
  { skip: phase !== "publish", timeout: 90_000 },
  async () => {
    const ids = process.env.QM_DOCKER_DEPLOY_IDS!.split(",");
    const coreContainer = process.env.QM_DOCKER_DEPLOY_CORE!;
    const provider = createDockerDeployProvider({
      coreContainer,
      snapshotRoot: "/data/deployments",
      readinessTimeoutMs: 5000,
    });
    await mkdir("/data/deployments", { recursive: true });
    await writeFile("/data/core-secret", "must not be visible to applications");
    const deployments: Deployment[] = [];
    for (const [index, id] of ids.entries()) {
      const snapshotDir = `/data/deployments/${id}`;
      await mkdir(snapshotDir);
      await writeFile(
        join(snapshotDir, "server.js"),
        index === 2
          ? 'console.error("private startup diagnostic"); process.exit(17)'
          : appSource(`app-${index}`, 500, index === 0 ? 401 : 404),
      );
      const deployment: Deployment = {
        id,
        ownerScopeId: scopeId("personal", "U1"),
        createdBy: "U1",
        status: "stopped",
        endpoint: null,
        currentVersion: 1,
        versions: [{ version: 1, createdAt: Date.now(), snapshotDir, entrypoint: "node server.js" }],
      };
      if (index === 2) {
        await assert.rejects(provider.apply(deployment, deployment.versions[0]!), (error: Error) => {
          assert.match(error.message, /not running.*17/);
          assert.ok(!error.message.includes("private startup diagnostic"));
          return true;
        });
        assert.equal(await docker(["inspect", "--format", "{{.State.Status}}", appName(id)]), "exited");
        assert.match((await provider.logs!(deployment, { tailLines: 20 }))!, /private startup diagnostic/);
        await provider.destroy(deployment);
        continue;
      }
      const started = Date.now();
      deployment.endpoint = await provider.apply(deployment, deployment.versions[0]!);
      assert.ok(Date.now() - started >= 500);
      deployment.status = "running";
      assert.deepEqual(deployment.endpoint, { host: appName(id), port: 8080 });
      assert.equal(await (await fetch(`http://${appName(id)}:8080/`)).text(), `app-${index}`);
      const state = JSON.parse(await docker(["inspect", "--format", "{{json .}}", appName(id)]));
      assert.deepEqual(state.HostConfig.PortBindings, {});
      assert.deepEqual(Object.keys(state.NetworkSettings.Networks), [`${appName(id)}-net`]);
      assert.equal(state.HostConfig.ReadonlyRootfs, false);
      assert.equal(state.Mounts.length, 1);
      assert.equal(state.Mounts[0].Name, `${appName(id)}-artifact`);
      assert.equal(state.Mounts[0].RW, false);
      assert.notEqual((await dockerExec(["inspect", `${appName(id)}-copy`])).code, 0);
      deployments.push(deployment);
    }
    const [first, second] = deployments;
    const crossApp = await dockerExec([
      "exec",
      appName(first!.id),
      "node",
      "-e",
      `fetch("http://${appName(second!.id)}:8080",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1),()=>process.exit(0))`,
    ]);
    assert.equal(crossApp.code, 0);
    const secondIp = await docker([
      "inspect",
      "--format",
      "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
      appName(second!.id),
    ]);
    assert.equal(
      (
        await dockerExec([
          "exec",
          appName(first!.id),
          "node",
          "-e",
          `fetch("http://${secondIp}:8080",{signal:AbortSignal.timeout(1000)}).then(()=>process.exit(1),()=>process.exit(0))`,
        ])
      ).code,
      0,
    );
    await writeFile("/data/deployments.json", JSON.stringify(deployments));
  },
);

test(
  "replacement Core recomputes UUID endpoints and stops crashed apps without retries",
  { skip: phase !== "replacement", timeout: 90_000 },
  async () => {
    const deployments = JSON.parse(await readFile("/data/deployments.json", "utf8")) as Deployment[];
    const coreContainer = process.env.QM_DOCKER_DEPLOY_CORE!;
    const provider = createDockerDeployProvider({ coreContainer, readinessTimeoutMs: 5000 });
    const backing = createMemoryMap<Deployment>();
    for (const deployment of deployments) {
      await backing.put(deployment.id, { ...deployment, endpoint: { host: "127.0.0.1", port: 9200 } });
    }
    const store = createDeployStore(backing);
    const service = createDeployService({
      deployStore: store,
      provider,
      deployDir: "/data/deployments",
      acl: createAclStore(),
      auditLog: { record() {}, events: async () => [], tail: async () => [] },
    });
    for (const deployment of deployments) {
      const reach = await service.reachDeployment(deployment.id, "U1");
      assert.equal(reach.status, "ok");
      assert.equal((await store.get(deployment.id))!.endpoint!.host, appName(deployment.id));
      const members = await docker([
        "network",
        "inspect",
        "--format",
        "{{range .Containers}}{{println .Name}}{{end}}",
        `${appName(deployment.id)}-net`,
      ]);
      assert.ok(members.includes(coreContainer));
      assert.ok(members.includes(process.env.QM_DOCKER_DEPLOY_OLD_CORE!));
      assert.equal((await fetch(`http://${appName(deployment.id)}:8080/unavailable`)).status, 503);
      assert.equal((await service.reachDeployment(deployment.id, "U1")).status, "ok");
      assert.equal((await store.get(deployment.id))!.status, "running");
    }
    const first = deployments[0]!;
    await service.redeploy(first.id, {
      entrypoint: "node server.js",
      files: [{ path: "server.js", data: appSource("republished", 100, 404) }],
    });
    assert.equal(await (await fetch(`http://${appName(first.id)}:8080/api`)).text(), "republished");
    assert.equal(
      await docker(["inspect", "--format", "{{.State.Running}}", process.env.QM_DOCKER_DEPLOY_OLD_CORE!]),
      "true",
    );
    await docker(["kill", appName(first.id)]);
    await assert.rejects(service.reachDeployment(first.id, "U1"), /not running/);
    assert.equal((await store.get(first.id))!.status, "stopped");
    assert.deepEqual(await service.reachDeployment(first.id, "U1"), { status: "not_found" });
    assert.equal(await docker(["inspect", "--format", "{{.State.Running}}", appName(first.id)]), "false");
    await provider.destroy(first);
    await provider.destroy(first);
    const remaining = await docker([
      "network",
      "inspect",
      "--format",
      "{{range .Containers}}{{println .Name}}{{end}}",
      `${appName(first.id)}-net`,
    ]);
    assert.ok(remaining.includes(process.env.QM_DOCKER_DEPLOY_OLD_CORE!));
    assert.ok(!remaining.includes(coreContainer));
    assert.equal(await (await fetch(`http://${appName(deployments[1]!.id)}:8080/`)).text(), "app-1");
    await provider.destroy(deployments[1]!);
  },
);

test(
  "real Docker: host Core uses an inspected random loopback port",
  { skip: !enabled || !!phase, timeout: 60_000 },
  async (context) => {
    const snapshotDir = await mkdtemp(join(tmpdir(), "qm-publish-host-e2e-"));
    const deployment: Deployment = {
      id: randomUUID(),
      ownerScopeId: scopeId("personal", "U1"),
      createdBy: "U1",
      status: "stopped",
      endpoint: null,
      currentVersion: 1,
      versions: [{ version: 1, createdAt: Date.now(), snapshotDir, entrypoint: "node server.js" }],
    };
    const provider = createDockerDeployProvider();
    context.after(async () => {
      await provider.destroy(deployment);
      await rm(snapshotDir, { recursive: true, force: true });
    });
    await writeFile(join(snapshotDir, "server.js"), appSource("host-ready"));
    deployment.endpoint = await provider.apply(deployment, deployment.versions[0]!);
    assert.equal(deployment.endpoint.host, "127.0.0.1");
    assert.ok(deployment.endpoint.port > 0);
    assert.equal(await (await fetch(`http://127.0.0.1:${deployment.endpoint.port}/`)).text(), "host-ready");
    assert.deepEqual(
      await createDockerDeployProvider().resolveEndpoint!(deployment, deployment.versions[0]!),
      deployment.endpoint,
    );
  },
);

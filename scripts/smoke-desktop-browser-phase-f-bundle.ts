import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
import { installDesktopBrowserPhaseFBundle } from "./desktop-browser-phase-f-bundle.ts";
import { parseDesktopBrowserPhaseFArgs } from "./desktop-browser-phase-f-cli.ts";
import { stopChildProcess } from "./desktop-browser-conformance.ts";
import { createNodeDesktopBrowserConformanceDeps } from "./run-browser-skill-conformance.ts";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
  buildDesktopBrowserNavigateArgv,
  buildDesktopBrowserObserveArgv,
  buildDesktopBrowserSessionStopArgv,
} from "../packages/desktop-browser-contracts/src/index.ts";
import WebSocket from "ws";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayRegistryAdapter,
} from "../packages/qm-broker-relay/src/index.ts";
import {
  createDesktopBrowserRelayOperationStore,
  createMemoryDesktopBrowserRelayOperationBacking,
} from "../packages/qm-broker-relay/src/operation-store.ts";
import { createDesktopBrowserRelayServer } from "../packages/qm-broker-relay/src/server.ts";
import { CoreHttpDesktopBrowserRelayRegistryAdapter } from "../packages/qm-broker-relay/src/process.ts";
import { confirmRegistration, loadOrCreateDeviceIdentity } from "../packages/qm-host-broker/src/index.ts";
import { createServer as createCoreServer } from "../src/api/server.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import { projectDesktopBrowserTaskActivity } from "../src/desktop-browser/task-activity.ts";
import { projectGroupRef, projectScopeId } from "../src/projects/project-store.ts";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { testConfig } from "../test/support/test-config.ts";

const values = parseDesktopBrowserPhaseFArgs(process.argv.slice(2), [
  "bundle",
  "sha256",
  "install-dir",
  "qm-url",
  "browser",
  "browser-executable",
  "fixture-url",
]);
if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Phase F bundle smoke requires macOS arm64");
}
if (values.browser !== "chrome" && values.browser !== "edge") throw new Error("--browser must be chrome or edge");
const browserExecutable = resolve(values["browser-executable"]!);
await access(browserExecutable, fsConstants.X_OK);
const expectedBrowserName = values.browser === "chrome" ? "google chrome" : "microsoft edge";
if (!browserExecutable.toLowerCase().includes(expectedBrowserName)) {
  throw new Error(`--browser-executable does not identify ${values.browser}`);
}
const home = process.env.HOME;
if (!home) throw new Error("HOME is required");
const installDir = resolve(values["install-dir"]!);
await installDesktopBrowserPhaseFBundle({
  bundlePath: resolve(values.bundle!),
  installDir,
  userHome: home,
  expectedBundleSha256: values.sha256!,
});
const bsk = join(installDir, "bin", "bsk");
const bskHome = join(installDir, "data", `bsk-${values.browser}`);
const profile = join(installDir, "data", `profile-${values.browser}`);
await Promise.all([mkdir(bskHome, { recursive: true }), rm(profile, { recursive: true, force: true })]);
const browserSkillEnvironment = { ...process.env, BSK_AUTO_UPDATE: "off", BSK_HOME: bskHome };
const daemon = spawn(bsk, ["daemon", "start", "--foreground", "--daemon-idle", "60s"], {
  env: browserSkillEnvironment,
  stdio: ["ignore", "pipe", "pipe"],
});
const browser = spawn(
  browserExecutable,
  [
    `--user-data-dir=${profile}`,
    `--disable-extensions-except=${join(installDir, "browser-skill-extension")},${join(installDir, "companion")}`,
    `--load-extension=${join(installDir, "browser-skill-extension")},${join(installDir, "companion")}`,
    "--remote-debugging-port=0",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
const processExit = (child: ReturnType<typeof spawn>, name: string) =>
  new Promise<{ code: number | null; signal: NodeJS.Signals | null; name: string }>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit({ code, signal, name }));
  });
const daemonExit = processExit(daemon, "BrowserSkill daemon");
const browserExit = processExit(browser, values.browser!);
const conformanceDeps = createNodeDesktopBrowserConformanceDeps({ env: browserSkillEnvironment });
const inspectCompanionPopup = async (): Promise<void> => {
  const deadline = Date.now() + 30_000;
  let port: string | undefined;
  while (!port && Date.now() < deadline) {
    try {
      [port] = (await readFile(join(profile, "DevToolsActivePort"), "utf8")).split("\n");
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
  }
  if (!port) throw new Error(`${values.browser} did not publish a DevTools endpoint`);
  const popupUrl = "chrome-extension://nciggffamocnffbemkbjefanopmelkgm/popup.html";
  const targetResponse = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(popupUrl)}`, {
    method: "PUT",
  });
  if (!targetResponse.ok) throw new Error(`${values.browser} refused to open the Companion popup`);
  const target = (await targetResponse.json()) as { url?: string; webSocketDebuggerUrl?: string };
  if (target.url !== popupUrl || !target.webSocketDebuggerUrl) {
    throw new Error(`${values.browser} did not load the fixed-ID Companion popup`);
  }
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise<void>((resolveOpen, rejectOpen) => {
    socket.once("open", resolveOpen);
    socket.once("error", rejectOpen);
  });
  try {
    const text = await new Promise<string>((resolveText, rejectText) => {
      const timeout = setTimeout(() => rejectText(new Error("Companion popup inspection timed out")), 10_000);
      socket.on("message", (raw) => {
        const message = JSON.parse(String(raw)) as { id?: number; result?: { result?: { value?: unknown } } };
        if (message.id !== 1) return;
        clearTimeout(timeout);
        const value = message.result?.result?.value;
        if (typeof value !== "string") return rejectText(new Error("Companion popup returned no text"));
        resolveText(value);
      });
      socket.send(JSON.stringify({ id: 1, method: "Runtime.evaluate", params: { expression: "document.body.innerText" } }));
    });
    if (!text.includes("Host Broker\nReady") || !text.includes("Browser runtime\nReady")) {
      throw new Error(`${values.browser} Companion popup did not render ready Host state`);
    }
  } finally {
    socket.close();
  }
};
const waitForBrowserInstance = async (): Promise<string> => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const result = (await conformanceDeps.queryBrowsers(bsk, browserSkillEnvironment, 5_000)) as {
        ok?: unknown;
        output?: unknown;
      };
      if (result.ok && Array.isArray(result.output) && result.output.length === 1) {
        const instanceId = result.output[0]?.instance_id;
        if (typeof instanceId === "string" && instanceId) return instanceId;
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      continue;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error(`packaged BrowserSkill Extension did not connect through ${values.browser}`);
};
let relayHttp: ReturnType<typeof createDesktopBrowserRelayServer> | null = null;
let coreHttp: ReturnType<typeof createCoreServer> | null = null;
let built: BuiltApp | null = null;
let host: ReturnType<typeof spawn> | null = null;
let hostExit: ReturnType<typeof processExit> | null = null;
try {
  const browserInstanceId = await waitForBrowserInstance();
  let coreRegistry: CoreHttpDesktopBrowserRelayRegistryAdapter | null = null;
  const registry: DesktopBrowserRelayRegistryAdapter = {
    async resolveBinding(input) {
      if (!coreRegistry) throw new Error("Phase F Core registry is not ready");
      return coreRegistry.resolveBinding(input);
    },
    async publishConnection(projection) {
      if (!coreRegistry) throw new Error("Phase F Core registry is not ready");
      return coreRegistry.publishConnection(projection);
    },
    async clearConnection(connectionId) {
      if (!coreRegistry) throw new Error("Phase F Core registry is not ready");
      return coreRegistry.clearConnection(connectionId);
    },
  };
  const relay = new DesktopBrowserRelayService({
    relayInstanceId: "phase-f-smoke-relay",
    deploymentCanonicalId: "https://phase-f-smoke.invalid",
    supportedProtocolVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS],
    supportedPolicyGrammarVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS],
    registry,
    operationStore: createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking()),
  });
  relayHttp = createDesktopBrowserRelayServer({
    host: "127.0.0.1",
    port: 0,
    path: DESKTOP_BROWSER_RELAY_WSS_PATH,
    service: relay,
    adapterReadiness: { check: async () => undefined },
    coreAuthSecret: "phase-f-smoke-core-relay-auth-secret-0001",
    shutdownDrainMs: 5_000,
  });
  await relayHttp.listen();
  const relayAddress = relayHttp.server.address();
  if (!relayAddress || typeof relayAddress === "string") throw new Error("Phase F smoke Relay did not bind TCP");
  const relayUrl = `ws://127.0.0.1:${relayAddress.port}${DESKTOP_BROWSER_RELAY_WSS_PATH}`;
  const coreSigningSecret = "phase-f-smoke-core-source-auth-secret-0001";
  const relaySourceAuthSecret = "phase-f-smoke-relay-core-auth-secret-0002";
  const coreDataDir = join(installDir, "data", "core");
  const coreConfig = () =>
    testConfig({
      dataDir: coreDataDir,
      publicWebUrl: "https://phase-f-smoke.invalid",
      desktopBrowserRelayUrl: `http://127.0.0.1:${relayAddress.port}`,
      desktopBrowserRelayAuthSecret: "phase-f-smoke-core-relay-auth-secret-0001",
      desktopBrowserRelaySourceAuthSecret: relaySourceAuthSecret,
    });
  built = buildApp(
    coreConfig(),
  );
  coreHttp = createCoreServer(built.app, {
    signingSecret: coreSigningSecret,
    desktopBrowserRelaySourceAuthSecret: relaySourceAuthSecret,
  });
  coreHttp.listen(0, "127.0.0.1");
  await once(coreHttp, "listening");
  const coreAddress = coreHttp.address() as AddressInfo;
  coreRegistry = new CoreHttpDesktopBrowserRelayRegistryAdapter({
    baseUrl: `http://127.0.0.1:${coreAddress.port}`,
    sourceAuthSecret: relaySourceAuthSecret,
  });
  await built.app.upsertDirectory([{ principalId: "phase-f-smoke-actor", displayName: "Phase F Smoke", type: "internal" }]);
  const project = await built.app.createProject("phase-f-smoke-actor", "Phase F Smoke");
  if (!project) throw new Error("Phase F smoke project was not created");
  const turnBody = JSON.stringify({
    surface: "web",
    actor: { externalId: "phase-f-smoke-actor", displayName: "Phase F Smoke" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: `web:phase-f-smoke:${values.browser}`,
      audience: [],
    },
    text: "/desktop-browser Inspect the Phase F fixture",
  });
  const turnResponse = await fetch(`http://127.0.0.1:${coreAddress.port}/v1/turns`, {
    method: "POST",
    headers: signedRequestHeaders(coreSigningSecret, "POST", "/v1/turns", turnBody, {
      "content-type": "application/json",
    }),
    body: turnBody,
  });
  if (!turnResponse.ok) throw new Error("Phase F authenticated Core Turn failed");
  const turn = (await turnResponse.json()) as { sessionId?: string; desktopBrowserActivity?: { taskId: string } };
  if (!turn.sessionId) throw new Error("Phase F Turn returned no session ID");
  if (!turn.desktopBrowserActivity) throw new Error("Phase F Turn did not create a Desktop Browser Task");
  const task = await built.desktopBrowserTasks.get(turn.desktopBrowserActivity.taskId);
  if (!task) throw new Error("Phase F Desktop Browser Task was not durable");
  const hostDataDir = join(installDir, "data", "host");
  const hostIdentity = await loadOrCreateDeviceIdentity(hostDataDir);
  const brokerInstanceId = "phase-f-smoke-broker";
  const reserved = await built.desktopBrowserDeviceRegistry.reserve({
    waitingTaskId: task.id,
    actorId: task.actorId,
    projectId: task.projectId,
    membershipEpoch: Number(task.projectMembershipVersion),
    authorityId: task.authorityId,
    authorityExpiresAt: task.authorityExpiresAt,
    devicePublicKey: hostIdentity.devicePublicKey,
    brokerInstanceId,
    browserInstanceId,
    connectionEpoch: 1,
    operatingSystem: "macos-arm64",
  });
  if (reserved.status !== "ok") throw new Error(`Phase F Device reservation failed: ${reserved.reason}`);
  const confirmation = confirmRegistration(
    hostIdentity,
    reserved.reservation.registrationTuple,
    reserved.reservation.confirmationFingerprint,
  );
  const confirmed = await built.desktopBrowserDeviceRegistry.confirm({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    authorityId: task.authorityId,
    browserRuntimeStatus: "ready",
    envelope: confirmation,
  });
  if (confirmed.status !== "ok") throw new Error(`Phase F Device confirmation failed: ${confirmed.reason}`);
  host = spawn(
  join(installDir, "bin", "qm-host-broker"),
  ["connect", "https://phase-f-smoke.invalid"],
  {
    env: {
      ...browserSkillEnvironment,
      NODE_ENV: "test",
      QM_HOST_BROKER_RELAY_URL: relayUrl,
      QM_HOST_BROKER_DATA_DIR: hostDataDir,
      QM_HOST_BROKER_INSTANCE_ID: brokerInstanceId,
    },
    stdio: ["ignore", "pipe", "pipe"],
  },
);
  hostExit = processExit(host, "Host Broker");
  const waitForReadiness = async () => {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("http://127.0.0.1:32145/v1/status", {
        headers: {
          origin: "chrome-extension://nciggffamocnffbemkbjefanopmelkgm",
          "x-qm-request-id": `smoke-request-${Date.now()}`,
          "x-qm-readiness-nonce": `smoke-readiness-${Date.now()}`,
        },
      });
      if (response.ok) {
        const status = (await response.json()) as { brokerStatus?: string; browserSkillStatus?: string };
        if (status.brokerStatus === "ready" && status.browserSkillStatus === "ready") return;
      }
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      continue;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  throw new Error("installed Host Broker and Companion readiness did not become ready");
  };
  await Promise.race([
    waitForReadiness(),
    hostExit.then(() => Promise.reject(new Error("Host Broker stopped before readiness"))),
  ]);
  await inspectCompanionPopup();
  const coordinator = built.desktopBrowserOperations;
  if (!coordinator) throw new Error("Phase F production Desktop Browser coordinator was not wired");
  const started = await coordinator.startForTask(task.id);
  if (started.status !== "ok") throw new Error(`Phase F session start failed: ${started.reason}`);
  const startedTask = await built.desktopBrowserTasks.get(task.id);
  if (!startedTask?.browserSkillSessionId) throw new Error("Phase F Host returned no Task-owned session");
  const scope = {
    sessionId: task.sessionId,
    actorId: task.actorId,
    projectScopeLabel: projectScopeId(task.projectId),
    projectMembershipVersion: task.projectMembershipVersion,
  };
  for (const argv of [
    buildDesktopBrowserNavigateArgv(values["fixture-url"]!, startedTask.browserSkillSessionId),
    buildDesktopBrowserObserveArgv(startedTask.browserSkillSessionId),
    buildDesktopBrowserSessionStopArgv(startedTask.browserSkillSessionId),
  ]) {
    const result = await coordinator.invokeForSession({ ...scope, argv });
    if (result.status !== "ok") throw new Error(`Phase F installed Host operation failed: ${result.reason}`);
  }
  const finalized = await coordinator.finalizeForSession({
    ...scope,
    outcome: "completed",
    summary: "Installed Phase F browser seam passed",
  });
  if (finalized.status !== "ok") throw new Error(`Phase F Core finalization failed: ${finalized.reason}`);
  const completed = await built.desktopBrowserTasks.get(task.id);
  if (!completed || projectDesktopBrowserTaskActivity(completed, "https://phase-f-smoke.invalid", null).result?.outcome !== "completed") {
    throw new Error("Phase F durable WebUI outcome was not completed");
  }
  await new Promise<void>((resolveClose) => coreHttp?.close(() => resolveClose()) ?? resolveClose());
  coreHttp = null;
  await built.runtime.stop();
  built = buildApp(coreConfig());
  coreHttp = createCoreServer(built.app, {
    signingSecret: coreSigningSecret,
    desktopBrowserRelaySourceAuthSecret: relaySourceAuthSecret,
  });
  coreHttp.listen(0, "127.0.0.1");
  await once(coreHttp, "listening");
  const restartedAddress = coreHttp.address() as AddressInfo;
  const sessionPath = `/v1/sessions/${encodeURIComponent(turn.sessionId)}?viewer=phase-f-smoke-actor`;
  const sessionResponse = await fetch(`http://127.0.0.1:${restartedAddress.port}${sessionPath}`, {
    headers: signedRequestHeaders(coreSigningSecret, "GET", sessionPath, "", {
      "x-actor": "phase-f-smoke-actor@default-org",
    }),
  });
  if (!sessionResponse.ok) throw new Error("Phase F durable WebUI session projection was unavailable after restart");
  const session = (await sessionResponse.json()) as {
    entries?: Array<{ payload?: { desktopBrowserActivity?: { taskId?: string; result?: { outcome?: string } } } }>;
  };
  const durableActivity = session.entries
    ?.map((entry) => entry.payload?.desktopBrowserActivity)
    .find((activity) => activity?.taskId === task.id);
  if (durableActivity?.result?.outcome !== "completed") {
    throw new Error("Phase F WebUI session API did not project the durable completed outcome after Core restart");
  }
} finally {
  await new Promise<void>((resolveClose) => coreHttp?.close(() => resolveClose()) ?? resolveClose());
  await built?.runtime.stop();
  await Promise.all([
    host && hostExit
      ? stopChildProcess({ child: host, exit: hostExit, name: "Host Broker", timeoutMs: 5_000 })
      : Promise.resolve(),
    stopChildProcess({ child: browser, exit: browserExit, name: values.browser!, timeoutMs: 5_000 }),
    stopChildProcess({ child: daemon, exit: daemonExit, name: "BrowserSkill daemon", timeoutMs: 5_000 }),
  ]);
  await relayHttp?.shutdown();
}
process.stdout.write(`${values.browser}:ok\n`);

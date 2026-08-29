import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { installDesktopBrowserPhaseFBundle } from "./desktop-browser-phase-f-bundle.ts";
import { parseDesktopBrowserPhaseFArgs } from "./desktop-browser-phase-f-cli.ts";
import { stopChildProcess } from "./desktop-browser-conformance.ts";
import { createNodeDesktopBrowserConformanceDeps } from "./run-browser-skill-conformance.ts";
import { WebSocketServer } from "ws";

const execFileAsync = promisify(execFile);
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
let localRelay: WebSocketServer | null = null;
let host: ReturnType<typeof spawn> | null = null;
let hostExit: ReturnType<typeof processExit> | null = null;
try {
  const browserInstanceId = await waitForBrowserInstance();
  localRelay = values["qm-url"] === "offline" ? new WebSocketServer({ host: "127.0.0.1", port: 0 }) : null;
  if (localRelay) {
    const relay = localRelay;
    await new Promise<void>((resolveListening, reject) => {
      relay.once("listening", resolveListening);
      relay.once("error", reject);
    });
    relay.on("connection", (socket) => {
      socket.once("message", (raw) => {
        const hello = JSON.parse(String(raw)) as { payload?: { brokerInstanceId?: unknown } };
        if (typeof hello.payload?.brokerInstanceId !== "string") return socket.close(1008, "invalid hello");
        socket.send(
          JSON.stringify({
            protocolVersion: "1.3",
            kind: "relay.challenge",
            payload: {
              relayInstanceId: "phase-f-smoke-relay",
              challengeNonce: "phase-f-smoke-challenge",
              deploymentCanonicalId: "qm://deployments/phase-f-smoke",
              brokerInstanceId: hello.payload.brokerInstanceId,
              browserInstanceId,
              connectionEpoch: 1,
              policyGrammarVersion: "1.0",
            },
          }),
        );
      });
    });
  }
  const localRelayAddress = localRelay?.address();
  const relayUrl =
    localRelayAddress && typeof localRelayAddress === "object"
      ? `ws://127.0.0.1:${localRelayAddress.port}/v1/device`
      : undefined;
  host = spawn(
  join(installDir, "bin", "qm-host-broker"),
  ["connect", values["qm-url"] === "offline" ? "https://phase-f-smoke.invalid" : values["qm-url"]!],
  {
    env: {
      ...browserSkillEnvironment,
      ...(relayUrl ? { NODE_ENV: "test", QM_HOST_BROKER_RELAY_URL: relayUrl } : {}),
      QM_HOST_BROKER_DATA_DIR: join(installDir, "data", "host"),
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
  const run = async (command: string[]) => JSON.parse((await execFileAsync(bsk, command, {
    env: browserSkillEnvironment,
  })).stdout);
  await Promise.race([
    waitForReadiness(),
    hostExit.then(() => Promise.reject(new Error("Host Broker stopped before readiness"))),
  ]);
  const started = await run(["--json", "session", "start", "--browser", browserInstanceId]);
  if (typeof started.session_id !== "string") throw new Error("session start returned no session_id");
  await run(["--json", "navigate", values["fixture-url"]!, "--session", started.session_id]);
  await run(["--json", "observe", "--session", started.session_id]);
  await run(["--json", "session", "stop", started.session_id]);
} finally {
  await Promise.all([
    host && hostExit
      ? stopChildProcess({ child: host, exit: hostExit, name: "Host Broker", timeoutMs: 5_000 })
      : Promise.resolve(),
    stopChildProcess({ child: browser, exit: browserExit, name: values.browser!, timeoutMs: 5_000 }),
    stopChildProcess({ child: daemon, exit: daemonExit, name: "BrowserSkill daemon", timeoutMs: 5_000 }),
  ]);
  await new Promise<void>((resolveClose) => localRelay?.close(() => resolveClose()) ?? resolveClose());
}
process.stdout.write(`${values.browser}:ok\n`);

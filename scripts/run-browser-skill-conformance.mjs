import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import {
  captureBrowserSkillConformanceFixtures,
  runDesktopBrowserConformance,
  runJsonCommand,
  stopChildProcess,
  runTextCommand,
  waitForDaemonReadiness,
  writeBrowserSkillConformanceManifest,
} from "./desktop-browser-conformance.ts";

const expectedSourceCommit = "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c";
const commandTimeoutMs = 15_000;
const daemonReadyTimeoutMs = 15_000;
const daemonPollIntervalMs = 250;
const browserConnectTimeoutMs = 45_000;
const browserPollIntervalMs = 1_000;
const daemonStopTimeoutMs = 5_000;
const chromeStopTimeoutMs = 5_000;

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`invalid argument ${name ?? ""}`);
    options[name.slice(2)] = value;
  }
  for (const name of [
    "source-dir",
    "bsk",
    "extension-dir",
    "extension-zip",
    "chrome",
    "chrome-version",
    "chrome-url",
    "chrome-archive-sha256",
    "out-dir",
  ]) {
    if (!options[name]) throw new Error(`missing --${name}`);
  }
  return options;
};

const captureProcessStream = (stream, maxChars = 4096) => {
  let text = "";
  stream?.setEncoding?.("utf8");
  stream?.on?.("data", (chunk) => {
    text = `${text}${chunk}`.slice(-maxChars);
  });
  return () => text;
};

const daemonInfo = async (home) => {
  try {
    return JSON.parse(await readFile(join(home, "daemon.json"), "utf8"));
  } catch {
    return null;
  }
};

const ensureExecutable = async (file, label) => {
  try {
    await access(file, fsConstants.F_OK);
  } catch {
    throw new Error(`${label} was not found at ${file}`);
  }
  try {
    await access(file, fsConstants.X_OK);
  } catch {
    throw new Error(`${label} is not executable at ${file}`);
  }
};

const ensureDirectory = async (directory, label) => {
  let info;
  try {
    info = await stat(directory);
  } catch {
    throw new Error(`${label} was not found at ${directory}`);
  }
  if (!info.isDirectory()) throw new Error(`${label} is not a directory at ${directory}`);
};

const waitForBrowser = async (queryBrowsers) => {
  const deadline = Date.now() + browserConnectTimeoutMs;
  while (Date.now() < deadline) {
    const result = await queryBrowsers();
    if (result.ok && Array.isArray(result.output) && result.output.length === 1) {
      const instanceId = result.output[0]?.instance_id;
      if (typeof instanceId === "string") return instanceId;
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(browserPollIntervalMs, remaining)));
  }
  throw new Error("BrowserSkill Extension did not connect within 45 seconds");
};

const startFixtureServer = async () => {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end("<!doctype html><title>Phase F fixture</title><h1>Phase F fixture</h1>");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not bind a TCP port");
  return { server, url: `http://127.0.0.1:${address.port}/` };
};

const closeServer = (server) => new Promise((resolve) => server.close(resolve));

const callDaemon = async (sockPath, method, params, timeoutMs) =>
  await new Promise((resolve, reject) => {
    const requestId = `qm-${randomUUID()}`;
    const socket = createConnection(sockPath);
    let settled = false;
    let buffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.end();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(`daemon IPC ${method} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: requestId, method, params })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex < 0) return;
      const line = buffer.slice(0, newlineIndex).trim();
      if (!line) {
        finish(new Error(`daemon IPC ${method} returned an empty response`));
        return;
      }
      try {
        const frame = JSON.parse(line);
        if (frame?.id !== requestId) {
          finish(new Error(`daemon IPC ${method} returned response id ${String(frame?.id)} instead of ${requestId}`));
          return;
        }
        if (frame && typeof frame === "object" && "error" in frame && frame.error) {
          const message = typeof frame.error.message === "string" ? frame.error.message : JSON.stringify(frame.error);
          finish(new Error(`daemon IPC ${method} failed: ${message}`));
          return;
        }
        if (!frame || typeof frame !== "object" || !("result" in frame)) {
          finish(new Error(`daemon IPC ${method} returned a malformed response`));
          return;
        }
        finish(null, frame.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
  });

const daemonSocketPath = async (home) => {
  const info = await daemonInfo(home);
  if (!info || typeof info.sock_path !== "string" || info.sock_path.length === 0) {
    throw new Error("no live daemon (daemon.json missing or stale)");
  }
  return info.sock_path;
};

const watchProcess = (child, name) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, name }));
  });

export const createNodeDesktopBrowserConformanceDeps = ({
  platform = process.platform,
  arch = process.arch,
  processVersion = process.version,
  env = process.env,
  makeTempDirectoryImpl = mkdtemp,
} = {}) => ({
  platform,
  arch,
  processVersion,
  env,
  ensureExecutable,
  ensureDirectory,
  makeDirectory: (directory) => mkdir(directory, { recursive: true }),
  makeTempDirectory: (prefix) => makeTempDirectoryImpl(prefix),
  startFixtureServer,
  getExecutableVersion: async (file) =>
    (await runTextCommand({ file, args: ["--version"], environment: process.env, timeoutMs: commandTimeoutMs })).trim(),
  getSourceCommit: async (sourceDir) =>
    await runTextCommand({
      file: "git",
      args: ["-C", sourceDir, "rev-parse", "HEAD"],
      environment: process.env,
      timeoutMs: commandTimeoutMs,
    }),
  getSourceTreeStatus: async (sourceDir) =>
    await runTextCommand({
      file: "git",
      args: ["-C", sourceDir, "status", "--porcelain=v1", "--untracked-files=no"],
      environment: process.env,
      timeoutMs: commandTimeoutMs,
    }),
  startDaemon: async (bskPath, environment) => {
    const child = spawn(bskPath, ["daemon", "start", "--foreground", "--port", "0", "--daemon-idle", "60s"], {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const daemonStderr = captureProcessStream(child.stderr);
    const daemonExit = watchProcess(child, "BrowserSkill daemon");
    return {
      pid: child.pid ?? null,
      readStderr: daemonStderr,
      child,
      daemonExit,
    };
  },
  waitForDaemon: async ({ daemon, environment, timeoutMs }) => {
    const home = environment.BSK_HOME ?? "";
    return await waitForDaemonReadiness({
      daemon,
      timeoutMs: Math.max(timeoutMs, daemonReadyTimeoutMs),
      pollIntervalMs: daemonPollIntervalMs,
      readDaemonInfo: async () => await daemonInfo(home),
      queryStatus: async () => await callDaemon(await daemonSocketPath(home), "system.status", {}, commandTimeoutMs),
    });
  },
  spawnChrome: async (plan, environment) => {
    const child = spawn(plan.file, plan.args, {
      env: environment,
      stdio: ["ignore", "ignore", "pipe"],
    });
    const chromeStderr = captureProcessStream(child.stderr);
    const chromeExit = watchProcess(child, "Chrome");
    return {
      pid: child.pid ?? null,
      readStderr: chromeStderr,
      child,
      chromeExit,
    };
  },
  writeTextFile: writeFile,
  waitForBrowser: ({ chrome, queryBrowsers }) =>
    Promise.race([
      waitForBrowser(queryBrowsers),
      chrome.chromeExit.then(({ code, signal, name }) => {
        throw new Error(`${name} exited before BrowserSkill connected (code=${code}, signal=${signal})`);
      }),
    ]),
  captureFixtures: captureBrowserSkillConformanceFixtures,
  runBrowserSkillCommand: (bskPath, argv, environment, timeoutMs) =>
    runJsonCommand({ file: bskPath, args: argv, environment, timeoutMs }),
  writeManifest: writeBrowserSkillConformanceManifest,
  readDaemonInfo: daemonInfo,
  queryDaemonStatus: async (_bskPath, environment, timeoutMs) => ({
    ok: true,
    output: await callDaemon(await daemonSocketPath(environment.BSK_HOME ?? ""), "system.status", {}, timeoutMs),
  }),
  queryBrowsers: async (_bskPath, environment, timeoutMs) => {
    const output = await callDaemon(
      await daemonSocketPath(environment.BSK_HOME ?? ""),
      "browser.list",
      { wait_for_browser_ms: 0 },
      timeoutMs,
    );
    const browsers = output && typeof output === "object" && Array.isArray(output.browsers) ? output.browsers : output;
    return { ok: true, output: browsers };
  },
  stopDaemon: async (daemon) =>
    stopChildProcess({
      child: daemon.child,
      exit: daemon.daemonExit,
      name: "BrowserSkill daemon",
      timeoutMs: daemonStopTimeoutMs,
    }),
  stopChrome: async (chrome) =>
    stopChildProcess({
      child: chrome.child,
      exit: chrome.chromeExit,
      name: "Chrome",
      timeoutMs: chromeStopTimeoutMs,
    }),
  stopFixtureServer: closeServer,
  removeRuntimeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  await runDesktopBrowserConformance(
    {
      sourceDir: options["source-dir"],
      expectedSourceCommit,
      bskPath: options.bsk,
      extensionDir: options["extension-dir"],
      extensionZipPath: options["extension-zip"],
      chromePath: options.chrome,
      chromeVersion: options["chrome-version"],
      chromeUrl: options["chrome-url"],
      chromeArchiveSha256: options["chrome-archive-sha256"],
      outDir: options["out-dir"],
      mode: options.mode ?? "baseline-source-build",
      releaseCliVersion: options["release-cli-version"],
      releaseCliUrl: options["release-cli-url"],
      releaseCliArchiveSha256: options["release-cli-archive-sha256"],
      releaseExtensionVersion: options["release-extension-version"],
      releaseExtensionUrl: options["release-extension-url"],
      releaseExtensionArchiveSha256: options["release-extension-archive-sha256"],
      commandTimeoutMs,
    },
    createNodeDesktopBrowserConformanceDeps(),
  );
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}

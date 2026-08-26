import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { constants as fsConstants } from "node:fs";
import {
  captureBrowserSkillConformanceFixtures,
  runDesktopBrowserConformance,
  runJsonCommand,
  stopChildProcess,
  runTextCommand,
  writeBrowserSkillConformanceManifest,
} from "./desktop-browser-conformance.ts";

const expectedSourceCommit = "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c";
const commandTimeoutMs = 15_000;
const browserConnectTimeoutMs = 45_000;
const browserPollIntervalMs = 1_000;
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

const captureProcessStream = (stream) => {
  let text = "";
  stream?.setEncoding?.("utf8");
  stream?.on?.("data", (chunk) => {
    text += chunk;
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

const waitForBrowser = async (bskPath, environment) => {
  const deadline = Date.now() + browserConnectTimeoutMs;
  while (Date.now() < deadline) {
    const result = await runJsonCommand({
      file: bskPath,
      args: ["--json", "browsers"],
      environment,
      timeoutMs: commandTimeoutMs,
    });
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

const watchProcess = (child, name) =>
  new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal, name }));
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
    {
      platform: process.platform,
      arch: process.arch,
      processVersion: process.version,
      env: process.env,
      ensureExecutable,
      ensureDirectory,
      makeDirectory: (directory) => mkdir(directory, { recursive: true }),
      makeTempDirectory: () => mkdtemp(join(tmpdir(), "qm-browser-skill-conformance-")),
      startFixtureServer,
      getExecutableVersion: async (file) => (await runTextCommand({ file, args: ["--version"], environment: process.env, timeoutMs: commandTimeoutMs })).trim(),
      getSourceCommit: async (sourceDir) =>
        await runTextCommand({ file: "git", args: ["-C", sourceDir, "rev-parse", "HEAD"], environment: process.env, timeoutMs: commandTimeoutMs }),
      getSourceTreeStatus: async (sourceDir) =>
        await runTextCommand({
          file: "git",
          args: ["-C", sourceDir, "status", "--porcelain=v1", "--untracked-files=no"],
          environment: process.env,
          timeoutMs: commandTimeoutMs,
        }),
      probeDaemonStatus: (bskPath, environment, timeoutMs) =>
        runJsonCommand({ file: bskPath, args: ["--json", "status"], environment, timeoutMs }),
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
      waitForBrowser: ({ bskPath, immediateEnvironment, chrome }) =>
        Promise.race([
          waitForBrowser(bskPath, immediateEnvironment),
          chrome.chromeExit.then(({ code, signal, name }) => {
            throw new Error(`${name} exited before BrowserSkill connected (code=${code}, signal=${signal})`);
          }),
        ]),
      captureFixtures: captureBrowserSkillConformanceFixtures,
      runBrowserSkillCommand: (bskPath, argv, environment, timeoutMs) =>
        runJsonCommand({ file: bskPath, args: argv, environment, timeoutMs }),
      writeManifest: writeBrowserSkillConformanceManifest,
      readDaemonInfo: daemonInfo,
      queryDaemonStatus: (bskPath, environment, timeoutMs) =>
        runJsonCommand({ file: bskPath, args: ["--json", "status"], environment, timeoutMs }),
      queryBrowsers: (bskPath, environment, timeoutMs) =>
        runJsonCommand({ file: bskPath, args: ["--json", "browsers"], environment, timeoutMs }),
      stopDaemon: async (bskPath, environment, timeoutMs) => {
        await runTextCommand({ file: bskPath, args: ["daemon", "stop"], environment, timeoutMs });
      },
      stopChrome: async (chrome) =>
        stopChildProcess({ child: chrome.child, exit: chrome.chromeExit, name: "Chrome", timeoutMs: chromeStopTimeoutMs }),
      stopFixtureServer: closeServer,
      removeRuntimeDirectory: (directory) => rm(directory, { recursive: true, force: true }),
    },
  );
}

if (import.meta.url === new URL(process.argv[1], "file:").href) {
  await main();
}

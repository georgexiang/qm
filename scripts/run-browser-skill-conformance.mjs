import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  captureBrowserSkillConformanceFixtures,
  normalizeBrowserSkillConformanceFixtures,
  writeBrowserSkillConformanceManifest,
} from "./desktop-browser-conformance.ts";

const execFile = promisify(execFileCallback);
const expectedSourceCommit = "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c";

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) throw new Error(`invalid argument ${name ?? ""}`);
    options[name.slice(2)] = value;
  }
  for (const name of ["source-dir", "bsk", "extension-dir", "extension-zip", "chrome", "out-dir"]) {
    if (!options[name]) throw new Error(`missing --${name}`);
  }
  return options;
};

const parseJson = (text) => {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("bsk produced no JSON output");
  return JSON.parse(trimmed);
};

const errorOutput = (error) => {
  for (const output of [error?.stderr, error?.stdout]) {
    if (typeof output === "string" && output.trim()) return output;
  }
  return undefined;
};

const processResult = async (file, args, environment) => {
  try {
    const result = await execFile(file, args, { env: environment, maxBuffer: 2 * 1024 * 1024 });
    return { ok: true, output: parseJson(result.stdout) };
  } catch (error) {
    const output = errorOutput(error);
    if (!output) throw error;
    try {
      return { ok: false, output: parseJson(output) };
    } catch {
      throw new Error(`${file} ${args.join(" ")} failed without JSON output: ${output.trim()}`, { cause: error });
    }
  }
};

const version = async (file, args = ["--version"]) => (await execFile(file, args)).stdout.trim();

const waitForBrowser = async (bskPath, environment) => {
  for (let attempt = 0; attempt < 45; attempt += 1) {
    const result = await processResult(bskPath, ["--json", "browsers"], environment);
    if (result.ok && Array.isArray(result.output) && result.output.length === 1) return result.output[0].instance_id;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
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

const stopProcess = async (child, exit) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const stopped = await Promise.race([
    exit.then(
      () => true,
      () => true,
    ),
    new Promise((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  if (!stopped) {
    child.kill("SIGKILL");
    await exit.catch(() => undefined);
  }
};

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(`BrowserSkill conformance requires darwin-arm64, got ${process.platform}-${process.arch}`);
  }
  const sourceCommit = (await execFile("git", ["-C", options["source-dir"], "rev-parse", "HEAD"])).stdout.trim();
  const sourceTreeStatus = (
    await execFile("git", ["-C", options["source-dir"], "status", "--porcelain=v1", "--untracked-files=no"])
  ).stdout.trim();
  if (sourceTreeStatus) throw new Error("BrowserSkill source tree must be clean");
  const outDir = options["out-dir"];
  await mkdir(outDir, { recursive: true });
  const runtimeDirectory = await mkdtemp(join(tmpdir(), "qm-browser-skill-conformance-"));
  const environment = {
    ...process.env,
    BSK_AUTO_UPDATE: "off",
    BSK_HOME: join(runtimeDirectory, "bsk-home"),
    RUST_LOG: "error",
  };
  const fixture = await startFixtureServer();
  const chrome = spawn(
    options.chrome,
    [
      `--user-data-dir=${join(runtimeDirectory, "chrome-profile")}`,
      `--disable-extensions-except=${options["extension-dir"]}`,
      `--load-extension=${options["extension-dir"]}`,
      "--no-first-run",
      "--no-default-browser-check",
      "about:blank",
    ],
    { env: environment, stdio: "inherit" },
  );
  const chromeExit = watchProcess(chrome, "Chrome");
  try {
    const browserInstanceId = await Promise.race([
      waitForBrowser(options.bsk, environment),
      chromeExit.then(({ code, signal, name }) => {
        throw new Error(`${name} exited before BrowserSkill connected (code=${code}, signal=${signal})`);
      }),
    ]);
    const captured = await captureBrowserSkillConformanceFixtures(
      (argv) => processResult(options.bsk, argv, environment),
      { browserInstanceId, fixtureUrl: fixture.url },
    );
    if (!captured.fixtures.observe.success.text.includes("Phase F fixture")) {
      throw new Error("BrowserSkill observation did not contain the fixture page text");
    }
    const normalized = normalizeBrowserSkillConformanceFixtures(captured.fixtures, captured.dynamic);
    const fixturesPath = join(outDir, "fixtures.json");
    await writeFile(fixturesPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await writeBrowserSkillConformanceManifest({
      sourceCommit,
      expectedSourceCommit,
      sourceTreeClean: true,
      cliPath: options.bsk,
      extensionPath: options["extension-zip"],
      fixturesPath,
      outputPath: join(outDir, "manifest.json"),
      mode: options.mode ?? "baseline",
      toolchain: {
        rust: await version("rustc"),
        node: process.version,
        pnpm: await version("pnpm"),
      },
      buildInputs: {
        target: "aarch64-apple-darwin",
        commands: ["cargo build --release --locked -p bsk --target aarch64-apple-darwin", "pnpm ext:build:zip"],
        files: Object.fromEntries(
          [
            "Cargo.lock",
            "Cargo.toml",
            "package.json",
            "pnpm-lock.yaml",
            "pnpm-workspace.yaml",
            "rust-toolchain.toml",
          ].map((name) => [name, join(options["source-dir"], name)]),
        ),
      },
      environment,
    });
  } finally {
    await processResult(options.bsk, ["daemon", "stop"], environment).catch(() => undefined);
    await stopProcess(chrome, chromeExit);
    await closeServer(fixture.server);
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
}

await main();

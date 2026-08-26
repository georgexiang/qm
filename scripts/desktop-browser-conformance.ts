import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const repository = "https://github.com/Tencent/BrowserSkill.git";
const requiredCommands = ["navigate", "observe", "session.start", "session.stop"] as const;
const maxBuffer = 2 * 1024 * 1024;
const execFile = promisify(execFileCallback);

type JsonObject = Record<string, unknown>;

export type BrowserSkillCommandRunner = (argv: string[]) => Promise<{ ok: boolean; output: JsonObject }>;

export interface BrowserSkillConformanceFixtures {
  "session.start": { success: JsonObject; error: JsonObject };
  navigate: { success: JsonObject; error: JsonObject };
  observe: { success: JsonObject; error: JsonObject };
  "session.stop": { success: JsonObject; error: JsonObject };
}

export interface BrowserSkillDynamicValues {
  sessionId: string;
  browserInstanceId: string;
  agentWindowId: number;
  tabId: number;
  fixturePort: number;
}

export interface ChromeLaunchPlan {
  file: string;
  args: string[];
}

interface SourceBuildProvenance {
  kind: "source-build";
  target: string;
  commands: string[];
  files: Record<string, string>;
}

interface ReleaseAssetProvenance {
  version?: string;
  downloadUrl?: string;
  archiveSha256?: string;
}

export interface ChromeForTestingProvenance {
  version?: string;
  downloadUrl?: string;
  archiveSha256?: string;
  executableVersion?: string;
}

export interface FailureChromeProvenance extends ChromeForTestingProvenance {
  complete: boolean;
}

interface ReleaseProvenance {
  kind: "release";
  cli?: ReleaseAssetProvenance;
  extension?: ReleaseAssetProvenance;
}

interface ManifestOptions {
  sourceCommit: string;
  expectedSourceCommit: string;
  sourceTreeClean: boolean;
  cliPath: string;
  extensionPath: string;
  fixturesPath: string;
  outputPath: string;
  mode?: "baseline-source-build" | "release-smoke";
  toolchain: { rust: string; node: string; pnpm: string };
  browser: ChromeForTestingProvenance;
  artifactProvenance: SourceBuildProvenance | ReleaseProvenance;
  environment: { BSK_AUTO_UPDATE?: string };
}

export interface FailureDiagnostics {
  error: string;
  chrome: {
    chromePath: string;
    launch: ChromeLaunchPlan;
    pid: number | null;
    mode: string;
    platform: string;
    stderr: string;
    provenance: FailureChromeProvenance;
  };
  daemon: unknown;
  status: unknown;
  browsers: unknown;
  cleanup: { step: string; ok: boolean; error?: string }[];
}

export interface KillableProcess {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

interface JsonCommandOptions {
  file: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface TextCommandOptions {
  file: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
  timeoutMs: number;
}

interface JsonCommandErrorLike {
  code?: unknown;
  name?: unknown;
  stderr?: unknown;
  stdout?: unknown;
}

export interface DesktopBrowserConformanceOptions {
  sourceDir: string;
  expectedSourceCommit: string;
  bskPath: string;
  extensionDir: string;
  extensionZipPath: string;
  chromePath: string;
  chromeVersion: string;
  chromeUrl: string;
  chromeArchiveSha256: string;
  outDir: string;
  mode?: "baseline-source-build" | "release-smoke";
  releaseCliVersion?: string;
  releaseCliUrl?: string;
  releaseCliArchiveSha256?: string;
  releaseExtensionVersion?: string;
  releaseExtensionUrl?: string;
  releaseExtensionArchiveSha256?: string;
  commandTimeoutMs: number;
}

export interface DesktopBrowserConformanceChromeHandle {
  pid: number | null;
  readStderr: () => string;
  child?: unknown;
  chromeExit?: Promise<{ code: number | null; signal: NodeJS.Signals | null; name: string }>;
}

interface DesktopBrowserFailureEvidence {
  daemon: unknown;
  status: unknown;
  browsers: unknown;
}

export interface DesktopBrowserConformanceDeps {
  platform: string;
  arch: string;
  processVersion: string;
  env: NodeJS.ProcessEnv;
  ensureExecutable(file: string, label: string): Promise<void>;
  ensureDirectory(directory: string, label: string): Promise<void>;
  makeDirectory(directory: string): Promise<void>;
  makeTempDirectory(): Promise<string>;
  startFixtureServer(): Promise<{ server: unknown; url: string }>;
  getExecutableVersion(file: string): Promise<string>;
  getSourceCommit(sourceDir: string): Promise<string>;
  getSourceTreeStatus(sourceDir: string): Promise<string>;
  probeDaemonStatus(bskPath: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<{ ok: boolean; output: JsonObject }>;
  spawnChrome(plan: ChromeLaunchPlan, environment: NodeJS.ProcessEnv): Promise<DesktopBrowserConformanceChromeHandle>;
  writeTextFile(filePath: string, text: string): Promise<void>;
  waitForBrowser(options: {
    bskPath: string;
    environment: NodeJS.ProcessEnv;
    immediateEnvironment: NodeJS.ProcessEnv;
    chrome: DesktopBrowserConformanceChromeHandle;
    timeoutMs: number;
  }): Promise<string>;
  captureFixtures(
    run: BrowserSkillCommandRunner,
    options: { browserInstanceId: string; fixtureUrl: string },
  ): Promise<{ fixtures: BrowserSkillConformanceFixtures; dynamic: BrowserSkillDynamicValues }>;
  runBrowserSkillCommand(
    bskPath: string,
    argv: string[],
    environment: NodeJS.ProcessEnv,
    timeoutMs: number,
  ): Promise<{ ok: boolean; output: JsonObject }>;
  writeManifest(options: ManifestOptions): Promise<void>;
  readDaemonInfo(home: string): Promise<unknown>;
  queryDaemonStatus(bskPath: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<unknown>;
  queryBrowsers(bskPath: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<unknown>;
  stopDaemon(bskPath: string, environment: NodeJS.ProcessEnv, timeoutMs: number): Promise<void>;
  stopChrome(chrome: DesktopBrowserConformanceChromeHandle): Promise<void>;
  stopFixtureServer(server: unknown): Promise<void>;
  removeRuntimeDirectory(directory: string): Promise<void>;
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const chromeLaunchArgs = (extensionDir: string, runtimeDirectory: string) => [
  `--user-data-dir=${runtimeDirectory}/chrome-profile`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  "--no-first-run",
  "--no-default-browser-check",
  "about:blank",
];

const parseJson = (text: string): JsonObject => {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("bsk produced no JSON output");
  return JSON.parse(trimmed);
};

const errorOutput = (error: JsonCommandErrorLike): string | undefined => {
  for (const output of [error?.stderr, error?.stdout]) {
    if (typeof output === "string" && output.trim()) return output;
  }
  return undefined;
};

const describeError = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isTimeoutError = (error: JsonCommandErrorLike): boolean =>
  error?.code === "ABORT_ERR" || error?.name === "AbortError" || error?.code === "ETIMEDOUT";

const validateReleaseAsset = (asset: ReleaseAssetProvenance | undefined): asset is Required<ReleaseAssetProvenance> =>
  Boolean(asset?.version && asset.downloadUrl && asset.archiveSha256);

const validateChromeForTesting = (
  browser: ChromeForTestingProvenance | undefined,
): browser is Required<ChromeForTestingProvenance> =>
  Boolean(browser?.version && browser.downloadUrl && browser.archiveSha256 && browser.executableVersion);

const normalizeMode = (options: ManifestOptions): "baseline-source-build" | "release-smoke" => {
  const derived = options.artifactProvenance.kind === "source-build" ? "baseline-source-build" : "release-smoke";
  if (options.mode && options.mode !== derived) {
    throw new Error(`manifest mode ${options.mode} does not match ${options.artifactProvenance.kind} provenance`);
  }
  return options.mode ?? derived;
};

export async function runJsonCommand(options: JsonCommandOptions): Promise<{ ok: boolean; output: JsonObject }> {
  try {
    const result = await execFile(options.file, options.args, {
      env: options.environment,
      maxBuffer,
      killSignal: "SIGKILL",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return { ok: true, output: parseJson(String(result.stdout)) };
  } catch (error) {
    if (isTimeoutError(error as JsonCommandErrorLike)) {
      throw new Error(`${options.file} ${options.args.join(" ")} timed out after ${options.timeoutMs}ms`, {
        cause: error,
      });
    }
    const output = errorOutput(error as JsonCommandErrorLike);
    if (!output) throw error;
    try {
      return { ok: false, output: parseJson(output) };
    } catch {
      throw new Error(`${options.file} ${options.args.join(" ")} failed without JSON output: ${output.trim()}`, {
        cause: error,
      });
    }
  }
}

export async function runTextCommand(options: TextCommandOptions): Promise<string> {
  try {
    const result = await execFile(options.file, options.args, {
      env: options.environment,
      maxBuffer,
      killSignal: "SIGKILL",
      signal: AbortSignal.timeout(options.timeoutMs),
    });
    return String(result.stdout);
  } catch (error) {
    if (isTimeoutError(error as JsonCommandErrorLike)) {
      throw new Error(`${options.file} ${options.args.join(" ")} timed out after ${options.timeoutMs}ms`, {
        cause: error,
      });
    }
    throw error;
  }
}

export function buildChromeLaunchPlan(options: {
  chromePath: string;
  extensionDir: string;
  runtimeDirectory: string;
  platform?: string;
}): ChromeLaunchPlan {
  return { file: options.chromePath, args: chromeLaunchArgs(options.extensionDir, options.runtimeDirectory) };
}

export function buildFailureDiagnostics(options: {
  error: unknown;
  launch: { chromePath: string; launch: ChromeLaunchPlan; pid: number | null; mode: string; platform: string };
  chromeProvenance: ChromeForTestingProvenance;
  chromeStderr: string;
  daemon: unknown;
  status: unknown;
  browsers: unknown;
  cleanup: { step: string; ok: boolean; error?: string }[];
}): FailureDiagnostics {
  return {
    error: describeError(options.error),
    chrome: {
      ...options.launch,
      stderr: options.chromeStderr,
      provenance: {
        ...options.chromeProvenance,
        complete: validateChromeForTesting(options.chromeProvenance),
      },
    },
    daemon: options.daemon,
    status: options.status,
    browsers: options.browsers,
    cleanup: options.cleanup,
  };
}

const waitForExitWithin = async (
  exit: Promise<{ code: number | null; signal: NodeJS.Signals | null; name: string }>,
  timeoutMs: number,
): Promise<boolean> =>
  await Promise.race([
    exit.then(
      () => true,
      () => true,
    ),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);

export async function stopChildProcess(options: {
  child?: KillableProcess;
  exit?: Promise<{ code: number | null; signal: NodeJS.Signals | null; name: string }>;
  name: string;
  timeoutMs: number;
}): Promise<void> {
  if (!options.child || !options.exit) return;
  if (options.child.exitCode !== null || options.child.signalCode !== null) return;
  options.child.kill("SIGTERM");
  if (await waitForExitWithin(options.exit, options.timeoutMs)) return;
  options.child.kill("SIGKILL");
  if (await waitForExitWithin(options.exit, options.timeoutMs)) return;
  throw new Error(`${options.name} did not exit within ${options.timeoutMs}ms after SIGKILL`);
}

export function immediateBrowserQueryEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...environment, BSK_BROWSER_WAIT_MS: "0" };
}

const sourceBuildProvenance = (sourceDir: string): SourceBuildProvenance => ({
  kind: "source-build",
  target: "aarch64-apple-darwin",
  commands: ["cargo build --release --locked -p bsk --target aarch64-apple-darwin", "pnpm ext:build:zip"],
  files: Object.fromEntries(
    ["Cargo.lock", "Cargo.toml", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "rust-toolchain.toml"].map(
      (name) => [name, join(sourceDir, name)],
    ),
  ),
});

const releaseProvenance = (options: DesktopBrowserConformanceOptions): ReleaseProvenance => {
  const required = [
    ["releaseCliVersion", options.releaseCliVersion],
    ["releaseCliUrl", options.releaseCliUrl],
    ["releaseCliArchiveSha256", options.releaseCliArchiveSha256],
    ["releaseExtensionVersion", options.releaseExtensionVersion],
    ["releaseExtensionUrl", options.releaseExtensionUrl],
    ["releaseExtensionArchiveSha256", options.releaseExtensionArchiveSha256],
  ] as const;
  for (const [name, value] of required) {
    if (!value) throw new Error(`missing ${name} for release-smoke`);
  }
  return {
    kind: "release",
    cli: {
      version: options.releaseCliVersion,
      downloadUrl: options.releaseCliUrl,
      archiveSha256: options.releaseCliArchiveSha256,
    },
    extension: {
      version: options.releaseExtensionVersion,
      downloadUrl: options.releaseExtensionUrl,
      archiveSha256: options.releaseExtensionArchiveSha256,
    },
  };
};

const artifactProvenance = (
  options: DesktopBrowserConformanceOptions,
  mode: "baseline-source-build" | "release-smoke",
): SourceBuildProvenance | ReleaseProvenance =>
  mode === "release-smoke" ? releaseProvenance(options) : sourceBuildProvenance(options.sourceDir);

const jsonOrNull = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    return await run();
  } catch (error) {
    return { ok: false, error: describeError(error) };
  }
};

const recordCleanup = async (
  cleanup: { step: string; ok: boolean; error?: string }[],
  step: string,
  run: () => Promise<void>,
): Promise<unknown | null> => {
  try {
    await run();
    cleanup.push({ step, ok: true });
    return null;
  } catch (error) {
    cleanup.push({ step, ok: false, error: describeError(error) });
    return error;
  }
};

export async function runDesktopBrowserConformance(
  options: DesktopBrowserConformanceOptions,
  deps: DesktopBrowserConformanceDeps,
): Promise<void> {
  const mode = options.mode ?? "baseline-source-build";
  if (deps.platform !== "darwin" || deps.arch !== "arm64") {
    throw new Error(`BrowserSkill conformance requires darwin-arm64, got ${deps.platform}-${deps.arch}`);
  }
  await deps.ensureExecutable(
    options.bskPath,
    mode === "release-smoke" ? "released BrowserSkill CLI" : "BrowserSkill CLI",
  );
  await deps.ensureDirectory(
    options.extensionDir,
    mode === "release-smoke" ? "released BrowserSkill extension directory" : "BrowserSkill extension directory",
  );
  await deps.ensureExecutable(options.chromePath, "Chrome for Testing executable");
  const sourceCommit = (await deps.getSourceCommit(options.sourceDir)).trim();
  const sourceTreeStatus = (await deps.getSourceTreeStatus(options.sourceDir)).trim();
  if (sourceTreeStatus) throw new Error("BrowserSkill source tree must be clean");
  await deps.makeDirectory(options.outDir);

  let runtimeDirectory: string | null = null;
  let environment: NodeJS.ProcessEnv | null = null;
  let immediateEnvironment: NodeJS.ProcessEnv | null = null;
  let fixture: { server: unknown; url: string } | null = null;
  let chrome: DesktopBrowserConformanceChromeHandle | null = null;
  let daemonAcquired = false;
  let failure: unknown = null;
  const cleanup: { step: string; ok: boolean; error?: string }[] = [];
  const cleanupErrors: unknown[] = [];
  const chromeProvenance: ChromeForTestingProvenance = {
    version: options.chromeVersion,
    downloadUrl: options.chromeUrl,
    archiveSha256: options.chromeArchiveSha256,
  };
  const launch: {
    chromePath: string;
    launch: ChromeLaunchPlan;
    pid: number | null;
    mode: string;
    platform: string;
  } = {
    chromePath: options.chromePath,
    launch: { file: options.chromePath, args: [] },
    pid: null as number | null,
    mode,
    platform: `${deps.platform}-${deps.arch}`,
  };

  try {
    runtimeDirectory = await deps.makeTempDirectory();
    environment = {
      ...deps.env,
      BSK_AUTO_UPDATE: "off",
      BSK_HOME: join(runtimeDirectory, "bsk-home"),
      RUST_LOG: "error",
    };
    immediateEnvironment = immediateBrowserQueryEnvironment(environment);
    fixture = await deps.startFixtureServer();
    chromeProvenance.executableVersion = await deps.getExecutableVersion(options.chromePath);
    launch.launch = buildChromeLaunchPlan({
      chromePath: options.chromePath,
      extensionDir: options.extensionDir,
      runtimeDirectory,
    });
    const daemonStatus = await deps.probeDaemonStatus(options.bskPath, immediateEnvironment, options.commandTimeoutMs);
    if (!daemonStatus.ok) throw new Error("BrowserSkill daemon did not respond before Chrome launch");
    daemonAcquired = true;
    await deps.writeTextFile(
      join(options.outDir, "launch.json"),
      `${JSON.stringify({ ...launch, browser: chromeProvenance }, null, 2)}\n`,
    );
    chrome = await deps.spawnChrome(launch.launch, environment);
    launch.pid = chrome.pid ?? null;
    const browserInstanceId = await deps.waitForBrowser({
      bskPath: options.bskPath,
      environment,
      immediateEnvironment,
      chrome,
      timeoutMs: options.commandTimeoutMs,
    });
    const captured = await deps.captureFixtures(
      (argv) => deps.runBrowserSkillCommand(options.bskPath, argv, environment!, options.commandTimeoutMs),
      { browserInstanceId, fixtureUrl: fixture.url },
    );
    if (
      typeof captured.fixtures.observe.success.text !== "string" ||
      !captured.fixtures.observe.success.text.includes("Phase F fixture")
    ) {
      throw new Error("BrowserSkill observation did not contain the fixture page text");
    }
    const normalized = normalizeBrowserSkillConformanceFixtures(captured.fixtures, captured.dynamic);
    const fixturesPath = join(options.outDir, "fixtures.json");
    await deps.writeTextFile(fixturesPath, `${JSON.stringify(normalized, null, 2)}\n`);
    await deps.writeManifest({
      sourceCommit,
      expectedSourceCommit: options.expectedSourceCommit,
      sourceTreeClean: true,
      cliPath: options.bskPath,
      extensionPath: options.extensionZipPath,
      fixturesPath,
      outputPath: join(options.outDir, "manifest.json"),
      mode,
      toolchain: {
        rust: (await deps.getExecutableVersion("rustc")).trim(),
        node: deps.processVersion,
        pnpm: (await deps.getExecutableVersion("pnpm")).trim(),
      },
      browser: chromeProvenance,
      artifactProvenance: artifactProvenance(options, mode),
      environment,
    });
  } catch (error) {
    failure = error;
  } finally {
    let failureEvidence: DesktopBrowserFailureEvidence | null = null;
    if (failure !== null && environment && immediateEnvironment) {
      failureEvidence = {
        daemon: await deps.readDaemonInfo(environment.BSK_HOME ?? ""),
        status: await jsonOrNull(() =>
          deps.queryDaemonStatus(options.bskPath, immediateEnvironment!, options.commandTimeoutMs),
        ),
        browsers: await jsonOrNull(() =>
          deps.queryBrowsers(options.bskPath, immediateEnvironment!, options.commandTimeoutMs),
        ),
      };
    }
    if (daemonAcquired && environment) {
      const error = await recordCleanup(cleanup, "daemon-stop", () =>
        deps.stopDaemon(options.bskPath, environment!, options.commandTimeoutMs),
      );
      if (error) cleanupErrors.push(error);
    }
    if (chrome) {
      const error = await recordCleanup(cleanup, "chrome-stop", () => deps.stopChrome(chrome!));
      if (error) cleanupErrors.push(error);
    }
    if (fixture) {
      const error = await recordCleanup(cleanup, "fixture-server-stop", () => deps.stopFixtureServer(fixture!.server));
      if (error) cleanupErrors.push(error);
    }
    if (runtimeDirectory) {
      const error = await recordCleanup(cleanup, "runtime-dir-remove", () => deps.removeRuntimeDirectory(runtimeDirectory!));
      if (error) cleanupErrors.push(error);
    }
    if (failureEvidence) {
      await deps.writeTextFile(
        join(options.outDir, "failure-diagnostics.json"),
        `${JSON.stringify(
          buildFailureDiagnostics({
            error: failure,
            launch,
            chromeProvenance,
            chromeStderr: chrome?.readStderr() ?? "",
            daemon: failureEvidence.daemon,
            status: failureEvidence.status,
            browsers: failureEvidence.browsers,
            cleanup,
          }),
          null,
          2,
        )}\n`,
      );
    }
  }
  if (failure) throw failure;
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
}

export function normalizeBrowserSkillConformanceFixtures(
  fixtures: BrowserSkillConformanceFixtures,
  dynamic: BrowserSkillDynamicValues,
): BrowserSkillConformanceFixtures {
  const replacements: readonly (readonly [string | number, string])[] = [
    [dynamic.browserInstanceId, "<browser>"],
    [dynamic.sessionId, "<session>"],
    [`http://127.0.0.1:${dynamic.fixturePort}/`, "<fixture-url>"],
  ];
  const normalize = (value: unknown, key?: string): unknown => {
    if (key === "agent_window_id" && value === dynamic.agentWindowId) return "<window>";
    if (key === "tab_id" && value === dynamic.tabId) return "<tab>";
    if (typeof value === "string") {
      return replacements.reduce(
        (normalized, [source, replacement]) => normalized.replaceAll(String(source), replacement),
        value,
      );
    }
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([entryKey, entry]) => [entryKey, normalize(entry, entryKey)]),
      );
    }
    return value;
  };
  return normalize(fixtures) as BrowserSkillConformanceFixtures;
}

export async function captureBrowserSkillConformanceFixtures(
  run: BrowserSkillCommandRunner,
  options: { browserInstanceId: string; fixtureUrl: string },
): Promise<{ fixtures: BrowserSkillConformanceFixtures; dynamic: BrowserSkillDynamicValues }> {
  const invoke = async (argv: string[], expectedOk: boolean): Promise<JsonObject> => {
    const result = await run(argv);
    if (!result || result.ok !== expectedOk || !result.output || typeof result.output !== "object") {
      throw new Error(`unexpected bsk result for ${argv.join(" ")}`);
    }
    return result.output;
  };

  const sessionStartError = await invoke(["--json", "session", "start", "--browser", "__missing__"], false);
  const sessionStart = await invoke(["--json", "session", "start", "--browser", options.browserInstanceId], true);
  if (
    typeof sessionStart["session_id"] !== "string" ||
    typeof sessionStart["browser_instance_id"] !== "string" ||
    typeof sessionStart["agent_window_id"] !== "number"
  ) {
    throw new Error("session start result is missing its Phase F identity fields");
  }

  const sessionId = sessionStart["session_id"];
  let navigateError: JsonObject | undefined;
  let navigate: JsonObject | undefined;
  let observeError: JsonObject | undefined;
  let observe: JsonObject | undefined;
  let sessionStop: JsonObject | undefined;
  try {
    navigateError = await invoke(["--json", "navigate", options.fixtureUrl], false);
    navigate = await invoke(["--json", "navigate", options.fixtureUrl, "--session", sessionId], true);
    observeError = await invoke(["--json", "observe", "--session", "__missing__"], false);
    observe = await invoke(["--json", "observe", "--session", sessionId], true);
  } finally {
    sessionStop = await invoke(["--json", "session", "stop", sessionId], true);
  }
  if (!navigateError || !navigate || !observeError || !observe || !sessionStop) {
    throw new Error("BrowserSkill conformance capture did not complete all commands");
  }
  const sessionStopError = await invoke(["--json", "session", "stop"], false);
  const tabId = navigate["tab_id"] ?? observe["tab_id"];
  if (typeof tabId !== "number") throw new Error("navigate and observe results are missing tab identity");
  const fixturePort = Number(new URL(options.fixtureUrl).port);
  if (!Number.isInteger(fixturePort) || fixturePort <= 0) throw new Error("fixture URL requires an explicit port");

  return {
    fixtures: {
      "session.start": { success: sessionStart, error: sessionStartError },
      navigate: { success: navigate, error: navigateError },
      observe: { success: observe, error: observeError },
      "session.stop": { success: sessionStop, error: sessionStopError },
    },
    dynamic: {
      sessionId,
      browserInstanceId: sessionStart["browser_instance_id"],
      agentWindowId: sessionStart["agent_window_id"],
      tabId,
      fixturePort,
    },
  };
}

export async function writeBrowserSkillConformanceManifest(options: ManifestOptions): Promise<void> {
  if (options.sourceCommit !== options.expectedSourceCommit) {
    throw new Error(
      `BrowserSkill source commit ${options.sourceCommit} does not match ${options.expectedSourceCommit}`,
    );
  }
  if (!options.sourceTreeClean) {
    throw new Error("BrowserSkill source tree must be clean");
  }
  if (options.environment.BSK_AUTO_UPDATE !== "off") {
    throw new Error("BrowserSkill conformance requires BSK_AUTO_UPDATE=off");
  }
  if (!validateChromeForTesting(options.browser)) {
    throw new Error(
      "BrowserSkill conformance requires pinned Chrome for Testing version, URL, archive checksum, and executable version",
    );
  }
  const mode = normalizeMode(options);
  let artifactProvenance:
    | {
        kind: "source-build";
        target: string;
        commands: string[];
        files: Record<string, string>;
      }
    | {
        kind: "release";
        cli: Required<ReleaseAssetProvenance>;
        extension: Required<ReleaseAssetProvenance>;
      };
  if (options.artifactProvenance.kind === "source-build") {
    const buildInputEntries = Object.entries(options.artifactProvenance.files).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    if (
      !options.artifactProvenance.target ||
      options.artifactProvenance.commands.length === 0 ||
      buildInputEntries.length === 0
    ) {
      throw new Error("BrowserSkill conformance requires target, commands, and build input files");
    }
    artifactProvenance = {
      kind: "source-build",
      target: options.artifactProvenance.target,
      commands: options.artifactProvenance.commands,
      files: Object.fromEntries(
        await Promise.all(buildInputEntries.map(async ([name, path]) => [name, sha256(await readFile(path))] as const)),
      ),
    };
  } else {
    if (!validateReleaseAsset(options.artifactProvenance.cli) || !validateReleaseAsset(options.artifactProvenance.extension)) {
      throw new Error("release smoke provenance requires pinned CLI and extension version, URL, and checksum");
    }
    artifactProvenance = {
      kind: "release",
      cli: options.artifactProvenance.cli,
      extension: options.artifactProvenance.extension,
    };
  }

  const [cli, extension, fixtureBytes] = await Promise.all([
    readFile(options.cliPath),
    readFile(options.extensionPath),
    readFile(options.fixturesPath),
  ]);
  const fixtures: unknown = JSON.parse(fixtureBytes.toString("utf8"));
  if (!fixtures || typeof fixtures !== "object" || Array.isArray(fixtures)) {
    throw new Error("BrowserSkill conformance fixtures must be a JSON object");
  }
  const commands = Object.keys(fixtures).sort();
  if (JSON.stringify(commands) !== JSON.stringify(requiredCommands)) {
    throw new Error(`BrowserSkill conformance fixtures must contain ${requiredCommands.join(", ")}`);
  }
  for (const command of requiredCommands) {
    const fixture = (fixtures as JsonObject)[command];
    if (
      !fixture ||
      typeof fixture !== "object" ||
      Array.isArray(fixture) ||
      !(fixture as JsonObject)["success"] ||
      typeof (fixture as JsonObject)["success"] !== "object" ||
      Array.isArray((fixture as JsonObject)["success"]) ||
      !(fixture as JsonObject)["error"] ||
      typeof (fixture as JsonObject)["error"] !== "object" ||
      Array.isArray((fixture as JsonObject)["error"])
    ) {
      throw new Error(`${command} fixture requires success and error objects`);
    }
  }

  const manifest = {
    schemaVersion: 1,
    mode,
    source: { repository, commit: options.sourceCommit, clean: options.sourceTreeClean },
    browser: {
      channel: "chrome-for-testing",
      platform: "mac-arm64",
      version: options.browser.version,
      downloadUrl: options.browser.downloadUrl,
      archiveSha256: options.browser.archiveSha256,
      executableVersion: options.browser.executableVersion,
    },
    artifacts: {
      cli: { platform: "darwin-arm64", sha256: sha256(cli) },
      extension: { platform: "chrome-mv3", sha256: sha256(extension) },
    },
    autoUpdate: false,
    toolchain: options.toolchain,
    artifactProvenance,
    fixtures: { commands, sha256: sha256(fixtureBytes) },
  };
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

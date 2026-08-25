import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

const repository = "https://github.com/Tencent/BrowserSkill.git";
const requiredCommands = ["navigate", "observe", "session.start", "session.stop"] as const;

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

interface ManifestOptions {
  sourceCommit: string;
  expectedSourceCommit: string;
  sourceTreeClean: boolean;
  cliPath: string;
  extensionPath: string;
  fixturesPath: string;
  outputPath: string;
  mode?: "baseline" | "smoke";
  toolchain: { rust: string; node: string; pnpm: string };
  buildInputs: {
    target: string;
    commands: string[];
    files: Record<string, string>;
  };
  environment: { BSK_AUTO_UPDATE?: string };
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

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
  const buildInputEntries = Object.entries(options.buildInputs.files).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (!options.buildInputs.target || options.buildInputs.commands.length === 0 || buildInputEntries.length === 0) {
    throw new Error("BrowserSkill conformance requires target, commands, and build input files");
  }

  const [cli, extension, fixtureBytes, buildInputHashes] = await Promise.all([
    readFile(options.cliPath),
    readFile(options.extensionPath),
    readFile(options.fixturesPath),
    Promise.all(buildInputEntries.map(async ([name, path]) => [name, sha256(await readFile(path))] as const)),
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
    mode: options.mode ?? "baseline",
    source: { repository, commit: options.sourceCommit, clean: true },
    artifacts: {
      cli: { platform: "darwin-arm64", sha256: sha256(cli) },
      extension: { platform: "chrome-mv3", sha256: sha256(extension) },
    },
    autoUpdate: false,
    toolchain: options.toolchain,
    buildInputs: {
      target: options.buildInputs.target,
      commands: options.buildInputs.commands,
      files: Object.fromEntries(buildInputHashes),
    },
    fixtures: { commands, sha256: sha256(fixtureBytes) },
  };
  await writeFile(options.outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

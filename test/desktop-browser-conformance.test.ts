import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  captureBrowserSkillConformanceFixtures,
  normalizeBrowserSkillConformanceFixtures,
  writeBrowserSkillConformanceManifest,
} from "../scripts/desktop-browser-conformance.ts";

const sourceCommit = "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c";

test("writes reproducible provenance for the pinned BrowserSkill runtime", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-browser-conformance-"));
  const cliPath = join(directory, "bsk");
  const extensionPath = join(directory, "extension.zip");
  const fixturesPath = join(directory, "fixtures.json");
  const outputPath = join(directory, "manifest.json");
  const cargoLockPath = join(directory, "Cargo.lock");
  const pnpmLockPath = join(directory, "pnpm-lock.yaml");
  const packagePath = join(directory, "package.json");
  const rustToolchainPath = join(directory, "rust-toolchain.toml");
  await writeFile(cliPath, "cli");
  await writeFile(extensionPath, "extension");
  await Promise.all([
    writeFile(cargoLockPath, "cargo-lock"),
    writeFile(pnpmLockPath, "pnpm-lock"),
    writeFile(packagePath, "package-json"),
    writeFile(rustToolchainPath, "rust-toolchain"),
  ]);
  await writeFile(
    fixturesPath,
    JSON.stringify({
      "session.start": { success: {}, error: {} },
      navigate: { success: {}, error: {} },
      observe: { success: {}, error: {} },
      "session.stop": { success: {}, error: {} },
    }),
  );

  await writeBrowserSkillConformanceManifest({
    sourceCommit,
    expectedSourceCommit: sourceCommit,
    sourceTreeClean: true,
    cliPath,
    extensionPath,
    fixturesPath,
    outputPath,
    toolchain: { rust: "rustc fixture", node: "v24.15.0", pnpm: "10.17.0" },
    buildInputs: {
      target: "aarch64-apple-darwin",
      commands: ["cargo build --release --locked -p bsk --target aarch64-apple-darwin", "pnpm ext:build:zip"],
      files: {
        "Cargo.lock": cargoLockPath,
        "package.json": packagePath,
        "pnpm-lock.yaml": pnpmLockPath,
        "rust-toolchain.toml": rustToolchainPath,
      },
    },
    environment: { BSK_AUTO_UPDATE: "off" },
  });

  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    schemaVersion: 1,
    mode: "baseline",
    source: {
      repository: "https://github.com/Tencent/BrowserSkill.git",
      commit: sourceCommit,
      clean: true,
    },
    artifacts: {
      cli: {
        platform: "darwin-arm64",
        sha256: "99bb88401742848e032fd6f51709415fb6be169a72d2e5d7fc44289255160d3c",
      },
      extension: {
        platform: "chrome-mv3",
        sha256: "26f1de33979d065ba8d86789de634228e3540fee2f6e5a66eebf93f78d83077d",
      },
    },
    autoUpdate: false,
    toolchain: { rust: "rustc fixture", node: "v24.15.0", pnpm: "10.17.0" },
    buildInputs: {
      target: "aarch64-apple-darwin",
      commands: ["cargo build --release --locked -p bsk --target aarch64-apple-darwin", "pnpm ext:build:zip"],
      files: {
        "Cargo.lock": "d20f8e0f5d845060daf9a0eb40546b6b6217dc6ae0863452e40a3f03bf7c75df",
        "package.json": "b675e0c84597ed8655710cfcbf79d546e8f5003edbc29fa843b487248d78a021",
        "pnpm-lock.yaml": "f1e4b6e0aad929cfd3ead84448f6cd2df1d180a3ebdce9dcf08764a5cd03a90a",
        "rust-toolchain.toml": "335ddbce02d068207f42ecdac988ee267eb014a7a1e7ffe8df7bedd66f716899",
      },
    },
    fixtures: {
      commands: ["navigate", "observe", "session.start", "session.stop"],
      sha256: "9a63cc1d1f564a3f175c8d6eafbc66e92834797f1cfab1ee60c07bb17dd200d6",
    },
  });
});

test("rejects mutable or incomplete conformance inputs before writing a manifest", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-browser-conformance-invalid-"));
  const cliPath = join(directory, "bsk");
  const extensionPath = join(directory, "extension.zip");
  const fixturesPath = join(directory, "fixtures.json");
  const outputPath = join(directory, "manifest.json");
  const buildInputPath = join(directory, "Cargo.lock");
  await writeFile(cliPath, "cli");
  await writeFile(extensionPath, "extension");
  await writeFile(buildInputPath, "cargo-lock");
  await writeFile(
    fixturesPath,
    JSON.stringify({
      "session.start": { success: {} },
      navigate: { success: {}, error: {} },
      observe: { success: {}, error: {} },
      "session.stop": { success: {}, error: {} },
    }),
  );
  const valid = {
    sourceCommit,
    expectedSourceCommit: sourceCommit,
    sourceTreeClean: true,
    cliPath,
    extensionPath,
    fixturesPath,
    outputPath,
    toolchain: { rust: "rustc fixture", node: "v24.15.0", pnpm: "10.17.0" },
    buildInputs: {
      target: "aarch64-apple-darwin",
      commands: ["cargo build --release --locked -p bsk --target aarch64-apple-darwin"],
      files: { "Cargo.lock": buildInputPath },
    },
    environment: { BSK_AUTO_UPDATE: "off" },
  };

  await assert.rejects(writeBrowserSkillConformanceManifest({ ...valid, sourceCommit: "wrong" }), /does not match/);
  await assert.rejects(
    writeBrowserSkillConformanceManifest({ ...valid, sourceTreeClean: false }),
    /source tree must be clean/,
  );
  await assert.rejects(
    writeBrowserSkillConformanceManifest({ ...valid, environment: { BSK_AUTO_UPDATE: "on" } }),
    /requires BSK_AUTO_UPDATE=off/,
  );
  await assert.rejects(
    writeBrowserSkillConformanceManifest(valid),
    /session\.start fixture requires success and error/,
  );
});

test("normalizes dynamic BrowserSkill identities into deterministic golden fixtures", () => {
  assert.deepEqual(
    normalizeBrowserSkillConformanceFixtures(
      {
        "session.start": {
          success: { session_id: "ABCD", browser_instance_id: "browser-123", agent_window_id: 42 },
          error: { code: "browser_not_found", message: "browser browser-123 is unavailable", exit_code: 4 },
        },
        navigate: {
          success: {
            tab_id: 91,
            url: "http://127.0.0.1:43123/",
            final_url: "http://127.0.0.1:43123/",
            reached: "load",
          },
          error: { code: "invalid_params", message: "unknown session ABCD", exit_code: 2 },
        },
        observe: {
          success: { text: "Phase F fixture", ref_count: 0, tab_id: 91, truncated: false },
          error: { code: "unknown_session", message: "unknown session ABCD", exit_code: 4 },
        },
        "session.stop": {
          success: { stopped: ["ABCD"], failed: [], returned_tab_ids: [], return_failures: [] },
          error: { code: null, message: "session stop requires SESSION_ID or --all", exit_code: 2 },
        },
      },
      { sessionId: "ABCD", browserInstanceId: "browser-123", agentWindowId: 42, tabId: 91, fixturePort: 43123 },
    ),
    {
      "session.start": {
        success: { session_id: "<session>", browser_instance_id: "<browser>", agent_window_id: "<window>" },
        error: { code: "browser_not_found", message: "browser <browser> is unavailable", exit_code: 4 },
      },
      navigate: {
        success: { tab_id: "<tab>", url: "<fixture-url>", final_url: "<fixture-url>", reached: "load" },
        error: { code: "invalid_params", message: "unknown session <session>", exit_code: 2 },
      },
      observe: {
        success: { text: "Phase F fixture", ref_count: 0, tab_id: "<tab>", truncated: false },
        error: { code: "unknown_session", message: "unknown session <session>", exit_code: 4 },
      },
      "session.stop": {
        success: { stopped: ["<session>"], failed: [], returned_tab_ids: [], return_failures: [] },
        error: { code: null, message: "session stop requires SESSION_ID or --all", exit_code: 2 },
      },
    },
  );
});

test("captures the four command fixtures with canonical argv and mandatory cleanup", async () => {
  const calls: string[][] = [];
  const outputs = new Map([
    ["--json session start --browser __missing__", { ok: false, output: { code: "browser_not_found" } }],
    [
      "--json session start --browser browser-123",
      {
        ok: true,
        output: { session_id: "ABCD", browser_instance_id: "browser-123", agent_window_id: 42 },
      },
    ],
    ["--json navigate http://127.0.0.1:43123/", { ok: false, output: { code: "invalid_params" } }],
    [
      "--json navigate http://127.0.0.1:43123/ --session ABCD",
      { ok: true, output: { tab_id: 91, url: "http://127.0.0.1:43123/", reached: "load" } },
    ],
    ["--json observe --session __missing__", { ok: false, output: { code: "unknown_session" } }],
    [
      "--json observe --session ABCD",
      { ok: true, output: { text: "Phase F fixture", ref_count: 0, tab_id: 91, truncated: false } },
    ],
    [
      "--json session stop ABCD",
      { ok: true, output: { stopped: ["ABCD"], failed: [], returned_tab_ids: [], return_failures: [] } },
    ],
    ["--json session stop", { ok: false, output: { code: null, exit_code: 2 } }],
  ]);
  const run = async (argv: string[]) => {
    calls.push(argv);
    const result = outputs.get(argv.join(" "));
    assert.ok(result, `unexpected argv: ${argv.join(" ")}`);
    return result;
  };

  const captured = await captureBrowserSkillConformanceFixtures(run, {
    browserInstanceId: "browser-123",
    fixtureUrl: "http://127.0.0.1:43123/",
  });

  assert.deepEqual(captured.dynamic, {
    sessionId: "ABCD",
    browserInstanceId: "browser-123",
    agentWindowId: 42,
    tabId: 91,
    fixturePort: 43123,
  });
  assert.deepEqual(Object.keys(captured.fixtures).sort(), ["navigate", "observe", "session.start", "session.stop"]);
  assert.deepEqual(calls.at(-2), ["--json", "session", "stop", "ABCD"]);
  assert.deepEqual(calls.at(-1), ["--json", "session", "stop"]);
});

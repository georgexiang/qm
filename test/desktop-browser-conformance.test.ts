import assert from "node:assert/strict";
import { access, chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  browserSkillRuntimeLayout,
  buildFailureDiagnostics,
  buildChromeLaunchPlan,
  captureBrowserSkillConformanceFixtures,
  createBrowserSkillRuntime,
  darwinBrowserSkillSocketPathLimit,
  immediateBrowserQueryEnvironment,
  normalizeBrowserSkillConformanceFixtures,
  runDesktopBrowserConformance,
  runJsonCommand,
  runTextCommand,
  stopChildProcess,
  waitForDaemonReadiness,
  writeBrowserSkillConformanceManifest,
} from "../scripts/desktop-browser-conformance.ts";
import {
  browserSkillForegroundDaemonArgs,
  createNodeDesktopBrowserConformanceDeps as createNodeRunnerDeps,
} from "../scripts/run-browser-skill-conformance.ts";

const sourceCommit = "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c";
const companionDir = join(import.meta.dirname, "../packages/qm-host-broker/companion");

test("foreground daemon keeps BrowserSkill's extension-compatible default WebSocket port", () => {
  const args = browserSkillForegroundDaemonArgs();
  assert.deepEqual(args, ["daemon", "start", "--foreground", "--daemon-idle", "60s"]);
  assert.equal(args.includes("--port"), false);
  assert.equal(args.includes("0"), false);
});

const daemonRecord = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  pid: 321,
  sock_path: "/runtime/bsk-home/run/daemon.sock",
  started_at_epoch_secs: 10,
  ...overrides,
});

test("createBrowserSkillRuntime uses a short unique darwin root and cleans it", async () => {
  const parent = await mkdtemp(join(tmpdir(), "desktop-browser-conformance-parent-"));
  const makeRuntime = () =>
    createBrowserSkillRuntime({
      platform: "darwin",
      tempParentDir: parent,
      makeTempDirectory: async (prefix) => await mkdtemp(prefix),
      setDirectoryPermissions: async (directory, mode) => await chmod(directory, mode),
      removeRuntimeDirectory: async (directory) => await rm(directory, { recursive: true, force: true }),
    });

  try {
    const first = await makeRuntime();
    const second = await makeRuntime();

    assert.notEqual(first.runtimeDirectory, second.runtimeDirectory);
    assert.equal(first.bskHome, first.runtimeDirectory);
    assert.equal(second.bskHome, second.runtimeDirectory);
    assert.match(first.runtimeDirectory, new RegExp(`^${parent.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/qm-bsk-`));
    assert.ok(first.daemonSocketPath.length < darwinBrowserSkillSocketPathLimit);
    assert.ok(second.daemonSocketPath.length < darwinBrowserSkillSocketPathLimit);
    assert.equal((await stat(first.runtimeDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(second.runtimeDirectory)).mode & 0o777, 0o700);

    await first.cleanup();
    await second.cleanup();

    await assert.rejects(access(first.runtimeDirectory));
    await assert.rejects(access(second.runtimeDirectory));
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("createNodeDesktopBrowserConformanceDeps forwards the darwin temp prefix chosen by createBrowserSkillRuntime", async () => {
  const seenPrefixes: string[] = [];
  const deps = createNodeRunnerDeps({
    platform: "darwin",
    arch: "arm64",
    processVersion: "v24.15.0",
    env: {},
    makeTempDirectoryImpl: async (prefix: string) => {
      seenPrefixes.push(prefix);
      return `${prefix}fixture`;
    },
  });

  const runtime = await createBrowserSkillRuntime({
    platform: deps.platform,
    makeTempDirectory: deps.makeTempDirectory,
  });

  assert.deepEqual(seenPrefixes, ["/tmp/qm-bsk-"]);
  assert.equal(runtime.runtimeDirectory, "/tmp/qm-bsk-fixture");
  assert.equal(runtime.bskHome, runtime.runtimeDirectory);
  assert.ok(runtime.daemonSocketPath.length < darwinBrowserSkillSocketPathLimit);
});

test("browserSkillRuntimeLayout preserves nested bsk-home outside darwin", () => {
  assert.deepEqual(browserSkillRuntimeLayout("linux", "/runtime-root"), {
    runtimeDirectory: "/runtime-root",
    bskHome: "/runtime-root/bsk-home",
    daemonSocketPath: "/runtime-root/bsk-home/run/daemon.sock",
  });
});

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
    browser: {
      version: "152.0.7977.64",
      downloadUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      executableVersion: "Google Chrome for Testing 152.0.7977.64",
    },
    environment: { BSK_AUTO_UPDATE: "off" },
    artifactProvenance: {
      kind: "source-build",
      target: "aarch64-apple-darwin",
      commands: ["cargo build --release --locked -p bsk --target aarch64-apple-darwin", "pnpm ext:build:zip"],
      files: {
        "Cargo.lock": cargoLockPath,
        "package.json": packagePath,
        "pnpm-lock.yaml": pnpmLockPath,
        "rust-toolchain.toml": rustToolchainPath,
      },
    },
  });

  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    schemaVersion: 1,
    mode: "baseline-source-build",
    source: {
      repository: "https://github.com/Tencent/BrowserSkill.git",
      commit: sourceCommit,
      clean: true,
    },
    browser: {
      channel: "chrome-for-testing",
      platform: "mac-arm64",
      version: "152.0.7977.64",
      downloadUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      executableVersion: "Google Chrome for Testing 152.0.7977.64",
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
    artifactProvenance: {
      kind: "source-build",
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
    browser: {
      version: "152.0.7977.64",
      downloadUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      executableVersion: "Google Chrome for Testing 152.0.7977.64",
    },
    artifactProvenance: {
      kind: "source-build" as const,
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
    writeBrowserSkillConformanceManifest({ ...valid, browser: { version: "152.0.7977.64" } }),
    /requires pinned Chrome for Testing version, URL, archive checksum, and executable version/,
  );
  await assert.rejects(
    writeBrowserSkillConformanceManifest(valid),
    /session\.start fixture requires success and error/,
  );
  await assert.rejects(
    writeBrowserSkillConformanceManifest({
      ...valid,
      mode: "release-smoke",
      artifactProvenance: {
        kind: "release",
        cli: {
          version: "0.1.10",
          downloadUrl: "https://example.test/bsk.tar.gz",
        },
      },
    }),
    /release smoke provenance requires pinned CLI and extension version, URL, and checksum/,
  );
});

test("records release smoke provenance without claiming release bytes came from source builds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "desktop-browser-conformance-release-"));
  const cliPath = join(directory, "bsk");
  const extensionPath = join(directory, "extension.zip");
  const fixturesPath = join(directory, "fixtures.json");
  const outputPath = join(directory, "manifest.json");
  await writeFile(cliPath, "cli");
  await writeFile(extensionPath, "extension");
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
    mode: "release-smoke",
    toolchain: { rust: "rustc fixture", node: "v24.15.0", pnpm: "10.17.0" },
    browser: {
      version: "152.0.7977.64",
      downloadUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      executableVersion: "Google Chrome for Testing 152.0.7977.64",
    },
    artifactProvenance: {
      kind: "release",
      cli: {
        version: "0.1.10",
        downloadUrl:
          "https://github.com/Tencent/BrowserSkill/releases/download/cli-v0.1.10/bsk-v0.1.10-aarch64-apple-darwin.tar.gz",
        archiveSha256: "50403691584243a48398d9b0c9084c562fef047878f0826dcdc70a01c4baec9f",
      },
      extension: {
        version: "0.1.6",
        downloadUrl:
          "https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.1.6/browser-skill-extension-v0.1.6-chrome.zip",
        archiveSha256: "3bcf76efeed375250dd6cd2f93eda442f9ab9fdabf00a8c43e519cd7ff234b5b",
      },
    },
    environment: { BSK_AUTO_UPDATE: "off" },
  });

  assert.deepEqual(JSON.parse(await readFile(outputPath, "utf8")), {
    schemaVersion: 1,
    mode: "release-smoke",
    source: {
      repository: "https://github.com/Tencent/BrowserSkill.git",
      commit: sourceCommit,
      clean: true,
    },
    browser: {
      channel: "chrome-for-testing",
      platform: "mac-arm64",
      version: "152.0.7977.64",
      downloadUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      executableVersion: "Google Chrome for Testing 152.0.7977.64",
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
    artifactProvenance: {
      kind: "release",
      cli: {
        version: "0.1.10",
        downloadUrl:
          "https://github.com/Tencent/BrowserSkill/releases/download/cli-v0.1.10/bsk-v0.1.10-aarch64-apple-darwin.tar.gz",
        archiveSha256: "50403691584243a48398d9b0c9084c562fef047878f0826dcdc70a01c4baec9f",
      },
      extension: {
        version: "0.1.6",
        downloadUrl:
          "https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.1.6/browser-skill-extension-v0.1.6-chrome.zip",
        archiveSha256: "3bcf76efeed375250dd6cd2f93eda442f9ab9fdabf00a8c43e519cd7ff234b5b",
      },
    },
    fixtures: {
      commands: ["navigate", "observe", "session.start", "session.stop"],
      sha256: "9a63cc1d1f564a3f175c8d6eafbc66e92834797f1cfab1ee60c07bb17dd200d6",
    },
  });
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

test("stops an opened BrowserSkill session when a later command fails", async () => {
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
    ["--json navigate http://127.0.0.1:43123/ --session ABCD", { ok: false, output: { code: "navigate_failed" } }],
    [
      "--json session stop ABCD",
      { ok: true, output: { stopped: ["ABCD"], failed: [], returned_tab_ids: [], return_failures: [] } },
    ],
  ]);

  await assert.rejects(
    captureBrowserSkillConformanceFixtures(
      async (argv) => {
        calls.push(argv);
        const result = outputs.get(argv.join(" "));
        assert.ok(result, `unexpected argv: ${argv.join(" ")}`);
        return result;
      },
      { browserInstanceId: "browser-123", fixtureUrl: "http://127.0.0.1:43123/" },
    ),
    /unexpected bsk result for --json navigate http:\/\/127\.0\.0\.1:43123\/ --session ABCD/,
  );

  assert.deepEqual(calls.at(-1), ["--json", "session", "stop", "ABCD"]);
});

test("builds a fresh macOS app launch plan for Chrome app bundles", () => {
  assert.deepEqual(
    buildChromeLaunchPlan({
      chromePath: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      extensionDir: "/tmp/extension",
      runtimeDirectory: "/tmp/runtime",
      platform: "darwin",
    }),
    {
      file: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
      args: [
        "--user-data-dir=/tmp/runtime/chrome-profile",
        `--disable-extensions-except=/tmp/extension,${companionDir}`,
        `--load-extension=/tmp/extension,${companionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
    },
  );
});

test("Ticket 10 Chrome and Edge launch the same unpacked Companion", () => {
  for (const browserPath of [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ]) {
    const plan = buildChromeLaunchPlan({
      chromePath: browserPath,
      extensionDir: "/opt/browserskill-extension",
      runtimeDirectory: "/tmp/qm-browser-runtime",
      platform: "darwin",
    });
    assert.equal(plan.file, browserPath);
    assert.ok(plan.args.includes(`--load-extension=/opt/browserskill-extension,${companionDir}`));
    assert.ok(plan.args.includes(`--disable-extensions-except=/opt/browserskill-extension,${companionDir}`));
  }
});

test("runJsonCommand enforces a wall-clock timeout", async () => {
  const started = Date.now();
  await assert.rejects(
    runJsonCommand({
      file: process.execPath,
      args: ["-e", "setTimeout(() => console.log(JSON.stringify({ok:true})), 500)"],
      environment: process.env,
      timeoutMs: 50,
    }),
    /timed out after 50ms/,
  );
  assert.ok(Date.now() - started < 400);
});

test("runTextCommand wraps timeouts with stable command context", async () => {
  const started = Date.now();
  await assert.rejects(
    runTextCommand({
      file: process.execPath,
      args: ["-e", "setTimeout(() => console.log('ok'), 500)"],
      environment: process.env,
      timeoutMs: 50,
    }),
    (error) => {
      assert.match(String(error), /timed out after 50ms/);
      assert.match(String(error), new RegExp(process.execPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      assert.match(String(error), /setTimeout\(\(\) => console\.log\('ok'\), 500\)/);
      return true;
    },
  );
  assert.ok(Date.now() - started < 400);
});

test("waitForDaemonReadiness allows readiness that takes longer than detached CLI startup", async () => {
  const sleeps: number[] = [];
  const daemon = {
    readStderr: () => "",
    daemonExit: new Promise<{ code: number | null; signal: NodeJS.Signals | null; name: string }>(() => undefined),
  };
  const statusCalls: string[] = [];
  let now = 0;
  let daemonInfoReads = 0;

  const ready = await waitForDaemonReadiness({
    daemon,
    timeoutMs: 15_000,
    pollIntervalMs: 1_000,
    readDaemonInfo: async () => {
      daemonInfoReads += 1;
      if (daemonInfoReads < 5) return null;
      return daemonRecord({ state: "ready-after-4s" });
    },
    queryStatus: async () => {
      statusCalls.push("status");
      return { ok: true, output: { state: "ready-after-4s" } };
    },
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    },
  });

  assert.deepEqual(ready, daemonRecord({ state: "ready-after-4s" }));
  assert.equal(statusCalls.length, 1);
  assert.deepEqual(sleeps, [1000, 1000, 1000, 1000]);
});

test("waitForDaemonReadiness races daemon early exit and reports bounded stderr", async () => {
  await assert.rejects(
    waitForDaemonReadiness({
      daemon: {
        readStderr: () => "x".repeat(5000),
        daemonExit: Promise.resolve({ code: 17, signal: null, name: "BrowserSkill daemon" }),
      },
      timeoutMs: 15_000,
      readDaemonInfo: async () => null,
      queryStatus: async () => ({ ok: true, output: { state: "never" } }),
      sleep: async () => undefined,
    }),
    (error) => {
      assert.match(String(error), /BrowserSkill daemon exited before readiness/);
      assert.match(String(error), /code=17/);
      assert.match(String(error), /stderr: x{256}$/);
      return true;
    },
  );
});

test("setup failures before Chrome spawn still clean every acquired resource and preserve diagnostics", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  let daemonInfoReads = 0;

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async (_file, label) => {
          calls.push(`ensureExecutable:${label}`);
        },
        ensureDirectory: async (_dir, label) => {
          calls.push(`ensureDirectory:${label}`);
        },
        makeDirectory: async (dir) => {
          calls.push(`mkdir:${dir}`);
        },
        makeTempDirectory: async () => {
          calls.push("mkdtemp");
          return "/runtime";
        },
        startFixtureServer: async () => {
          calls.push("fixture:start");
          return { server: "fixture-server", url: "http://127.0.0.1:43123/" };
        },
        getExecutableVersion: async (file) => {
          calls.push(`version:${file}`);
          return "Google Chrome for Testing 152.0.7977.64";
        },
        getSourceCommit: async () => {
          calls.push("git:rev-parse");
          return sourceCommit;
        },
        getSourceTreeStatus: async () => {
          calls.push("git:status");
          return "";
        },
        startDaemon: async () => {
          calls.push("daemon:start");
          return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
        },
        waitForDaemon: async () => {
          calls.push("daemon:wait");
          return daemonRecord({ state: "before-cleanup" });
        },
        spawnChrome: async () => {
          calls.push("chrome:spawn");
          throw new Error("chrome should not spawn");
        },
        writeTextFile: async (filePath, text) => {
          calls.push(`write:${filePath}`);
          if (filePath === "/out/launch.json") throw new Error("launch write failed");
          writes.set(filePath, text);
        },
        waitForBrowser: async () => {
          calls.push("waitForBrowser");
          return "browser-123";
        },
        captureFixtures: async () => {
          calls.push("captureFixtures");
          throw new Error("capture should not run");
        },
        runBrowserSkillCommand: async () => {
          calls.push("runBrowserSkillCommand");
          return { ok: true, output: {} };
        },
        writeManifest: async () => {
          calls.push("writeManifest");
        },
        readDaemonInfo: async () => {
          calls.push("daemon:info");
          daemonInfoReads += 1;
          return daemonInfoReads === 1 ? null : daemonRecord({ state: "before-cleanup" });
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "before-cleanup" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers:diagnostics");
          return { ok: true, output: [{ instance_id: "browser-before-cleanup" }] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /launch write failed/,
  );

  assert.ok(calls.indexOf("daemon:start") < calls.indexOf("write:/out/launch.json"));
  assert.ok(calls.indexOf("daemon:info") < calls.indexOf("cleanup:daemon-stop"));
  assert.ok(calls.indexOf("daemon:status:diagnostics") < calls.indexOf("cleanup:daemon-stop"));
  assert.ok(calls.indexOf("daemon:browsers:diagnostics") < calls.indexOf("cleanup:daemon-stop"));
  assert.equal(calls.includes("cleanup:chrome-stop"), false);
  assert.deepEqual(JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null"), {
    error: "launch write failed",
    chrome: {
      chromePath: "/tool/chrome",
      launch: {
        file: "/tool/chrome",
        args: [
          "--user-data-dir=/runtime/chrome-profile",
          `--disable-extensions-except=/tool/extension,${companionDir}`,
          `--load-extension=/tool/extension,${companionDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
      },
      pid: null,
      mode: "baseline-source-build",
      platform: "darwin-arm64",
      stderr: "",
      provenance: {
        version: "152.0.7977.64",
        downloadUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        executableVersion: "Google Chrome for Testing 152.0.7977.64",
        complete: true,
      },
    },
    daemon: daemonRecord({ state: "before-cleanup" }),
    status: { ok: true, output: { state: "before-cleanup" } },
    browsers: { ok: true, output: [{ instance_id: "browser-before-cleanup" }] },
    cleanup: [
      { step: "daemon-stop", ok: true },
      { step: "fixture-server-stop", ok: true },
      { step: "runtime-dir-remove", ok: true },
    ],
  });
});

test("pre-provenance failures still persist partial Chrome diagnostics and cleanup evidence", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => {
          calls.push("fixture:start");
          return { server: "fixture-server", url: "http://127.0.0.1:43123/" };
        },
        getExecutableVersion: async (file) => {
          calls.push(`version:${file}`);
          throw new Error("chrome version probe failed");
        },
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => {
          calls.push("daemon:start");
          return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
        },
        waitForDaemon: async () => {
          calls.push("daemon:wait");
          return daemonRecord({ state: "before-cleanup" });
        },
        spawnChrome: async () => {
          calls.push("chrome:spawn");
          throw new Error("chrome should not spawn");
        },
        writeTextFile: async (filePath, text) => {
          writes.set(filePath, text);
        },
        waitForBrowser: async () => "browser-123",
        captureFixtures: async () => {
          throw new Error("capture should not run");
        },
        runBrowserSkillCommand: async () => ({ ok: true, output: {} }),
        writeManifest: async () => undefined,
        readDaemonInfo: async () => {
          calls.push("daemon:info");
          return { state: "pre-provenance" };
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "pre-provenance" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers:diagnostics");
          return { ok: true, output: [] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /chrome version probe failed/,
  );

  assert.equal(calls.includes("daemon:start"), false);
  assert.equal(calls.includes("daemon:info"), false);
  assert.equal(calls.includes("daemon:status:diagnostics"), false);
  assert.equal(calls.includes("daemon:browsers:diagnostics"), false);
  assert.equal(calls.includes("cleanup:daemon-stop"), false);
  assert.equal(calls.includes("cleanup:chrome-stop"), false);
  assert.deepEqual(JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null"), {
    error: "chrome version probe failed",
    chrome: {
      chromePath: "/tool/chrome",
      launch: {
        file: "/tool/chrome",
        args: [],
      },
      pid: null,
      mode: "baseline-source-build",
      platform: "darwin-arm64",
      stderr: "",
      provenance: {
        version: "152.0.7977.64",
        downloadUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        complete: false,
      },
    },
    daemon: null,
    status: null,
    browsers: null,
    cleanup: [
      { step: "fixture-server-stop", ok: true },
      { step: "runtime-dir-remove", ok: true },
    ],
  });
});

test("cleanup failures do not stop later teardown steps after a run failure", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  let daemonInfoReads = 0;

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "release-smoke",
        releaseCliVersion: "0.1.10",
        releaseCliUrl: "https://example.test/cli.tgz",
        releaseCliArchiveSha256: "cli-sha",
        releaseExtensionVersion: "0.1.6",
        releaseExtensionUrl: "https://example.test/ext.zip",
        releaseExtensionArchiveSha256: "ext-sha",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
        getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => {
          calls.push("daemon:start");
          return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
        },
        waitForDaemon: async () => {
          calls.push("daemon:wait");
          return daemonRecord({ state: "before-cleanup" });
        },
        spawnChrome: async () => {
          calls.push("chrome:spawn");
          return {
            pid: 321,
            readStderr: () => "chrome stderr",
          };
        },
        writeTextFile: async (filePath, text) => {
          calls.push(`write:${filePath}`);
          writes.set(filePath, text);
        },
        waitForBrowser: async () => {
          calls.push("waitForBrowser");
          return "browser-123";
        },
        captureFixtures: async () => {
          calls.push("captureFixtures");
          throw new Error("capture failed");
        },
        runBrowserSkillCommand: async () => {
          calls.push("runBrowserSkillCommand");
          return { ok: true, output: {} };
        },
        writeManifest: async () => {
          calls.push("writeManifest");
        },
        readDaemonInfo: async () => {
          calls.push("daemon:info");
          daemonInfoReads += 1;
          return daemonInfoReads === 1 ? null : daemonRecord({ state: "before-cleanup" });
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "before-cleanup" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers:diagnostics");
          return { ok: true, output: [{ instance_id: "browser-before-cleanup" }] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
          throw new Error("daemon stop failed");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
          throw new Error("Chrome did not exit within 25ms after SIGKILL");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
          throw new Error("fixture stop failed");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /capture failed/,
  );

  assert.ok(calls.indexOf("cleanup:daemon-stop") < calls.indexOf("cleanup:chrome-stop"));
  assert.ok(calls.indexOf("cleanup:chrome-stop") < calls.indexOf("cleanup:fixture-server-stop"));
  assert.ok(calls.indexOf("cleanup:fixture-server-stop") < calls.indexOf("cleanup:runtime-dir-remove"));
  assert.ok(calls.indexOf("cleanup:runtime-dir-remove") < calls.indexOf("write:/out/failure-diagnostics.json"));
  assert.deepEqual(JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null").cleanup, [
    { step: "daemon-stop", ok: false, error: "daemon stop failed" },
    { step: "chrome-stop", ok: false, error: "Chrome did not exit within 25ms after SIGKILL" },
    { step: "fixture-server-stop", ok: false, error: "fixture stop failed" },
    { step: "runtime-dir-remove", ok: true },
  ]);
});

test("refuses to reuse daemon state that already exists before start", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
        getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => {
          calls.push("daemon:start");
          return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
        },
        waitForDaemon: async () => {
          calls.push("daemon:wait");
          return daemonRecord({ state: "wrong-pid" });
        },
        spawnChrome: async () => {
          calls.push("chrome:spawn");
          throw new Error("chrome should not spawn");
        },
        writeTextFile: async (filePath, text) => {
          writes.set(filePath, text);
        },
        waitForBrowser: async () => "browser-123",
        captureFixtures: async () => {
          throw new Error("capture should not run");
        },
        runBrowserSkillCommand: async () => ({ ok: true, output: {} }),
        writeManifest: async () => undefined,
        readDaemonInfo: async () => {
          calls.push("daemon:info");
          return daemonRecord({ pid: 999 });
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "should-not-run" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers:diagnostics");
          return { ok: true, output: [{ instance_id: "browser-before-start" }] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /runtime home was not clean before daemon start/,
  );

  assert.equal(calls.includes("daemon:start"), false);
  assert.equal(calls.includes("daemon:status:diagnostics"), false);
  assert.equal(calls.includes("daemon:browsers:diagnostics"), false);
  assert.equal(calls.includes("cleanup:daemon-stop"), false);
  assert.equal(calls.includes("cleanup:chrome-stop"), false);
  assert.deepEqual(JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null"), {
    error: "BrowserSkill runtime home was not clean before daemon start",
    chrome: {
      chromePath: "/tool/chrome",
      launch: {
        file: "/tool/chrome",
        args: [
          "--user-data-dir=/runtime/chrome-profile",
          `--disable-extensions-except=/tool/extension,${companionDir}`,
          `--load-extension=/tool/extension,${companionDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
      },
      pid: null,
      mode: "baseline-source-build",
      platform: "darwin-arm64",
      stderr: "",
      provenance: {
        version: "152.0.7977.64",
        downloadUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        executableVersion: "Google Chrome for Testing 152.0.7977.64",
        complete: true,
      },
    },
    daemon: daemonRecord({ pid: 999 }),
    status: null,
    browsers: null,
    cleanup: [
      { step: "fixture-server-stop", ok: true },
      { step: "runtime-dir-remove", ok: true },
    ],
  });
});

test("fails closed when daemon ownership changes before browser polling", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  const owned = daemonRecord({ state: "owned-before-poll" });
  const replacement = daemonRecord({
    pid: 654,
    sock_path: "/runtime/bsk-home/run/replacement.sock",
    started_at_epoch_secs: 20,
    state: "replacement-before-poll",
  });
  let daemonInfoReads = 0;

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
        getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => {
          calls.push("daemon:start");
          return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
        },
        waitForDaemon: async () => {
          calls.push("daemon:wait");
          return owned;
        },
        spawnChrome: async () => {
          calls.push("chrome:spawn");
          return { pid: 321, readStderr: () => "" };
        },
        writeTextFile: async (filePath, text) => {
          writes.set(filePath, text);
        },
        waitForBrowser: async ({ queryBrowsers }) => {
          calls.push("waitForBrowser");
          await queryBrowsers();
          throw new Error("browser poll should not have reached the daemon");
        },
        captureFixtures: async () => {
          throw new Error("capture should not run");
        },
        runBrowserSkillCommand: async () => {
          calls.push("runBrowserSkillCommand");
          return { ok: true, output: {} };
        },
        writeManifest: async () => undefined,
        readDaemonInfo: async () => {
          calls.push("daemon:info");
          daemonInfoReads += 1;
          if (daemonInfoReads === 1) return null;
          return replacement;
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "should-not-run" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers");
          return { ok: true, output: [{ instance_id: "browser-123" }] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /BrowserSkill daemon ownership lost before browser poll/,
  );

  assert.equal(calls.includes("daemon:browsers"), false);
  assert.equal(calls.includes("runBrowserSkillCommand"), false);
  assert.equal(calls.includes("daemon:status:diagnostics"), false);
  assert.equal(calls.includes("cleanup:daemon-stop"), true);
  assert.deepEqual(JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null"), {
    error: "BrowserSkill daemon ownership lost before browser poll",
    chrome: {
      chromePath: "/tool/chrome",
      launch: {
        file: "/tool/chrome",
        args: [
          "--user-data-dir=/runtime/chrome-profile",
          `--disable-extensions-except=/tool/extension,${companionDir}`,
          `--load-extension=/tool/extension,${companionDir}`,
          "--no-first-run",
          "--no-default-browser-check",
          "about:blank",
        ],
      },
      pid: 321,
      mode: "baseline-source-build",
      platform: "darwin-arm64",
      stderr: "",
      provenance: {
        version: "152.0.7977.64",
        downloadUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        executableVersion: "Google Chrome for Testing 152.0.7977.64",
        complete: true,
      },
    },
    daemon: replacement,
    status: {
      ok: false,
      error: "BrowserSkill daemon ownership lost before diagnostics",
      expected: { pid: 321, sock_path: "/runtime/bsk-home/run/daemon.sock", started_at_epoch_secs: 10 },
      actual: replacement,
    },
    browsers: {
      ok: false,
      error: "BrowserSkill daemon ownership lost before diagnostics",
      expected: { pid: 321, sock_path: "/runtime/bsk-home/run/daemon.sock", started_at_epoch_secs: 10 },
      actual: replacement,
    },
    cleanup: [
      { step: "daemon-stop", ok: true },
      { step: "chrome-stop", ok: true },
      { step: "fixture-server-stop", ok: true },
      { step: "runtime-dir-remove", ok: true },
    ],
  });
});

test("fails closed when daemon readiness publishes a different pid than the owned child", async () => {
  const calls: string[] = [];

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
        getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => {
          calls.push("daemon:start");
          return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
        },
        waitForDaemon: async () => {
          calls.push("daemon:wait");
          return daemonRecord({ pid: 654, state: "wrong-pid" });
        },
        spawnChrome: async () => {
          calls.push("chrome:spawn");
          throw new Error("chrome should not spawn");
        },
        writeTextFile: async () => undefined,
        waitForBrowser: async () => "browser-123",
        captureFixtures: async () => {
          throw new Error("capture should not run");
        },
        runBrowserSkillCommand: async () => ({ ok: true, output: {} }),
        writeManifest: async () => undefined,
        readDaemonInfo: async () => {
          calls.push("daemon:info");
          return calls.filter((call) => call === "daemon:info").length === 1
            ? null
            : daemonRecord({ pid: 654, state: "wrong-pid" });
        },
        queryDaemonStatus: async () => ({ ok: true, output: { state: "wrong-pid" } }),
        queryBrowsers: async () => ({ ok: true, output: [] }),
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /owned child pid 321.*daemon pid 654|daemon pid 654.*owned child pid 321/,
  );

  assert.equal(calls.includes("chrome:spawn"), false);
  assert.equal(calls.includes("cleanup:daemon-stop"), true);
});

test("cleanup stops the owned daemon child directly even if daemon.json changes before teardown", async () => {
  const calls: string[] = [];
  let daemonInfoReads = 0;

  await runDesktopBrowserConformance(
    {
      sourceDir: "/source",
      expectedSourceCommit: sourceCommit,
      bskPath: "/tool/bsk",
      extensionDir: "/tool/extension",
      extensionZipPath: "/tool/extension.zip",
      chromePath: "/tool/chrome",
      chromeVersion: "152.0.7977.64",
      chromeUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      outDir: "/out",
      mode: "baseline-source-build",
      commandTimeoutMs: 15_000,
    },
    {
      platform: "darwin",
      arch: "arm64",
      processVersion: "v24.15.0",
      env: {},
      ensureExecutable: async () => undefined,
      ensureDirectory: async () => undefined,
      makeDirectory: async () => undefined,
      makeTempDirectory: async () => "/runtime",
      startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
      getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
      getSourceCommit: async () => sourceCommit,
      getSourceTreeStatus: async () => "",
      startDaemon: async () => {
        calls.push("daemon:start");
        return { pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) };
      },
      waitForDaemon: async () => {
        calls.push("daemon:wait");
        return daemonRecord({ state: "owned-before-cleanup" });
      },
      spawnChrome: async () => ({ pid: 999, readStderr: () => "" }),
      writeTextFile: async () => undefined,
      waitForBrowser: async () => "browser-123",
      captureFixtures: async () => ({
        fixtures: {
          "session.start": { success: {}, error: {} },
          navigate: { success: { text: "Phase F fixture" }, error: {} },
          observe: { success: { text: "Phase F fixture" }, error: {} },
          "session.stop": { success: {}, error: {} },
        },
        dynamic: {
          sessionId: "session-1",
          browserInstanceId: "browser-123",
          agentWindowId: 7,
          tabId: 9,
          fixturePort: 43123,
        },
      }),
      runBrowserSkillCommand: async () => ({ ok: true, output: {} }),
      writeManifest: async () => {
        calls.push("writeManifest");
      },
      readDaemonInfo: async () => {
        daemonInfoReads += 1;
        if (daemonInfoReads === 1) return null;
        return daemonRecord({ pid: 654, sock_path: "/runtime/bsk-home/run/replacement.sock", state: "replacement" });
      },
      queryDaemonStatus: async () => ({ ok: true, output: { state: "owned-before-cleanup" } }),
      queryBrowsers: async () => ({ ok: true, output: [{ instance_id: "browser-123" }] }),
      stopDaemon: async () => {
        calls.push("cleanup:daemon-stop");
      },
      stopChrome: async () => {
        calls.push("cleanup:chrome-stop");
      },
      stopFixtureServer: async () => {
        calls.push("cleanup:fixture-server-stop");
      },
      removeRuntimeDirectory: async () => {
        calls.push("cleanup:runtime-dir-remove");
      },
    },
  );

  assert.equal(calls.includes("writeManifest"), true);
  assert.equal(calls.includes("cleanup:daemon-stop"), true);
});

test("fails closed when daemon ownership changes before fixture commands", async () => {
  const calls: string[] = [];
  const owned = daemonRecord({ state: "owned-before-fixtures" });
  const replacement = daemonRecord({
    pid: 777,
    sock_path: "/runtime/bsk-home/run/replacement.sock",
    started_at_epoch_secs: 30,
    state: "replacement-before-fixtures",
  });
  let daemonInfoReads = 0;

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
        getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => ({ pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) }),
        waitForDaemon: async () => owned,
        spawnChrome: async () => ({ pid: 321, readStderr: () => "" }),
        writeTextFile: async () => undefined,
        waitForBrowser: async ({ queryBrowsers }) => {
          const result = await queryBrowsers();
          assert.deepEqual(result, { ok: true, output: [{ instance_id: "browser-123" }] });
          return "browser-123";
        },
        captureFixtures: async (run) => {
          calls.push("captureFixtures");
          await run(["--json", "session", "start", "--browser", "browser-123"]);
          throw new Error("fixture command should not have reached the daemon");
        },
        runBrowserSkillCommand: async () => {
          calls.push("runBrowserSkillCommand");
          return { ok: true, output: {} };
        },
        writeManifest: async () => undefined,
        readDaemonInfo: async () => {
          daemonInfoReads += 1;
          if (daemonInfoReads === 1) return null;
          if (daemonInfoReads === 2) return owned;
          return replacement;
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "should-not-run" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers");
          return { ok: true, output: [{ instance_id: "browser-123" }] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /BrowserSkill daemon ownership lost before fixture command/,
  );

  assert.equal(calls.includes("captureFixtures"), true);
  assert.equal(calls.includes("daemon:browsers"), true);
  assert.equal(calls.includes("runBrowserSkillCommand"), false);
  assert.equal(calls.includes("daemon:status:diagnostics"), false);
  assert.equal(calls.includes("cleanup:daemon-stop"), true);
});

test("failure diagnostics report ownership loss without querying replacement daemons", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  const owned = daemonRecord({ state: "owned-before-diagnostics" });
  const replacement = daemonRecord({
    pid: 888,
    sock_path: "/runtime/bsk-home/run/replacement.sock",
    started_at_epoch_secs: 40,
    state: "replacement-before-diagnostics",
  });
  let daemonInfoReads = 0;

  await assert.rejects(
    runDesktopBrowserConformance(
      {
        sourceDir: "/source",
        expectedSourceCommit: sourceCommit,
        bskPath: "/tool/bsk",
        extensionDir: "/tool/extension",
        extensionZipPath: "/tool/extension.zip",
        chromePath: "/tool/chrome",
        chromeVersion: "152.0.7977.64",
        chromeUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        outDir: "/out",
        mode: "baseline-source-build",
        commandTimeoutMs: 15_000,
      },
      {
        platform: "darwin",
        arch: "arm64",
        processVersion: "v24.15.0",
        env: {},
        ensureExecutable: async () => undefined,
        ensureDirectory: async () => undefined,
        makeDirectory: async () => undefined,
        makeTempDirectory: async () => "/runtime",
        startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
        getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
        getSourceCommit: async () => sourceCommit,
        getSourceTreeStatus: async () => "",
        startDaemon: async () => ({ pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) }),
        waitForDaemon: async () => owned,
        spawnChrome: async () => ({ pid: 321, readStderr: () => "" }),
        writeTextFile: async (filePath, text) => {
          writes.set(filePath, text);
        },
        waitForBrowser: async () => "browser-123",
        captureFixtures: async () => ({
          fixtures: {
            "session.start": { success: {}, error: {} },
            navigate: { success: {}, error: {} },
            observe: { success: { text: "Phase F fixture" }, error: {} },
            "session.stop": { success: {}, error: {} },
          },
          dynamic: {
            sessionId: "session-1",
            browserInstanceId: "browser-123",
            agentWindowId: 7,
            tabId: 9,
            fixturePort: 43123,
          },
        }),
        runBrowserSkillCommand: async () => ({ ok: true, output: {} }),
        writeManifest: async () => {
          throw new Error("manifest failed");
        },
        readDaemonInfo: async () => {
          daemonInfoReads += 1;
          if (daemonInfoReads === 1) return null;
          return replacement;
        },
        queryDaemonStatus: async () => {
          calls.push("daemon:status:diagnostics");
          return { ok: true, output: { state: "should-not-run" } };
        },
        queryBrowsers: async () => {
          calls.push("daemon:browsers:diagnostics");
          return { ok: true, output: [{ instance_id: "browser-123" }] };
        },
        stopDaemon: async () => {
          calls.push("cleanup:daemon-stop");
        },
        stopChrome: async () => {
          calls.push("cleanup:chrome-stop");
        },
        stopFixtureServer: async () => {
          calls.push("cleanup:fixture-server-stop");
        },
        removeRuntimeDirectory: async () => {
          calls.push("cleanup:runtime-dir-remove");
        },
      },
    ),
    /manifest failed/,
  );

  assert.equal(calls.includes("daemon:status:diagnostics"), false);
  assert.equal(calls.includes("daemon:browsers:diagnostics"), false);
  assert.equal(calls.includes("cleanup:daemon-stop"), true);
  const diagnostics = JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null");
  assert.deepEqual(diagnostics.daemon, replacement);
  assert.deepEqual(diagnostics.status, {
    ok: false,
    error: "BrowserSkill daemon ownership lost before diagnostics",
    expected: { pid: 321, sock_path: "/runtime/bsk-home/run/daemon.sock", started_at_epoch_secs: 10 },
    actual: replacement,
  });
  assert.deepEqual(diagnostics.browsers, {
    ok: false,
    error: "BrowserSkill daemon ownership lost before diagnostics",
    expected: { pid: 321, sock_path: "/runtime/bsk-home/run/daemon.sock", started_at_epoch_secs: 10 },
    actual: replacement,
  });
});

test("successful runs still stop the owned daemon child after daemon.json changes", async () => {
  const calls: string[] = [];
  const writes = new Map<string, string>();
  const owned = daemonRecord({ state: "owned-before-cleanup" });
  const replacement = daemonRecord({
    pid: 999,
    sock_path: "/runtime/bsk-home/run/replacement.sock",
    started_at_epoch_secs: 50,
    state: "replacement-before-cleanup",
  });
  let daemonInfoReads = 0;

  await runDesktopBrowserConformance(
    {
      sourceDir: "/source",
      expectedSourceCommit: sourceCommit,
      bskPath: "/tool/bsk",
      extensionDir: "/tool/extension",
      extensionZipPath: "/tool/extension.zip",
      chromePath: "/tool/chrome",
      chromeVersion: "152.0.7977.64",
      chromeUrl:
        "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      chromeArchiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      outDir: "/out",
      mode: "baseline-source-build",
      commandTimeoutMs: 15_000,
    },
    {
      platform: "darwin",
      arch: "arm64",
      processVersion: "v24.15.0",
      env: {},
      ensureExecutable: async () => undefined,
      ensureDirectory: async () => undefined,
      makeDirectory: async () => undefined,
      makeTempDirectory: async () => "/runtime",
      startFixtureServer: async () => ({ server: "fixture-server", url: "http://127.0.0.1:43123/" }),
      getExecutableVersion: async () => "Google Chrome for Testing 152.0.7977.64",
      getSourceCommit: async () => sourceCommit,
      getSourceTreeStatus: async () => "",
      startDaemon: async () => ({ pid: 321, readStderr: () => "", daemonExit: new Promise(() => undefined) }),
      waitForDaemon: async () => owned,
      spawnChrome: async () => ({ pid: 321, readStderr: () => "" }),
      writeTextFile: async (filePath, text) => {
        writes.set(filePath, text);
      },
      waitForBrowser: async () => "browser-123",
      captureFixtures: async () => ({
        fixtures: {
          "session.start": { success: {}, error: {} },
          navigate: { success: { text: "Phase F fixture" }, error: {} },
          observe: { success: { text: "Phase F fixture" }, error: {} },
          "session.stop": { success: {}, error: {} },
        },
        dynamic: {
          sessionId: "session-1",
          browserInstanceId: "browser-123",
          agentWindowId: 7,
          tabId: 9,
          fixturePort: 43123,
        },
      }),
      runBrowserSkillCommand: async () => ({ ok: true, output: {} }),
      writeManifest: async () => {
        calls.push("writeManifest");
      },
      readDaemonInfo: async () => {
        daemonInfoReads += 1;
        if (daemonInfoReads === 1) return null;
        if (daemonInfoReads === 2) return owned;
        return replacement;
      },
      queryDaemonStatus: async () => ({ ok: true, output: { state: "unused" } }),
      queryBrowsers: async () => ({ ok: true, output: [{ instance_id: "browser-123" }] }),
      stopDaemon: async () => {
        calls.push("cleanup:daemon-stop");
      },
      stopChrome: async () => {
        calls.push("cleanup:chrome-stop");
      },
      stopFixtureServer: async () => {
        calls.push("cleanup:fixture-server-stop");
      },
      removeRuntimeDirectory: async () => {
        calls.push("cleanup:runtime-dir-remove");
      },
    },
  );

  assert.equal(calls.includes("writeManifest"), true);
  assert.equal(calls.includes("cleanup:daemon-stop"), true);
  assert.deepEqual(calls.slice(-3), [
    "cleanup:chrome-stop",
    "cleanup:fixture-server-stop",
    "cleanup:runtime-dir-remove",
  ]);
  assert.equal(writes.has("/out/failure-diagnostics.json"), false);
});

test("buildFailureDiagnostics keeps launch, browser, daemon, and cleanup evidence together", () => {
  assert.deepEqual(
    buildFailureDiagnostics({
      error: new Error("boom"),
      launch: {
        chromePath: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        launch: {
          file: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          args: ["about:blank"],
        },
        pid: 321,
        mode: "release-smoke",
        platform: "darwin-arm64",
      },
      chromeProvenance: {
        version: "152.0.7977.64",
        downloadUrl:
          "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        executableVersion: "Google Chrome for Testing 152.0.7977.64",
      },
      chromeStderr: "chrome stderr",
      daemon: { connected: true },
      status: { ok: true },
      browsers: [{ instance_id: "browser-123" }],
      cleanup: [
        { step: "daemon-stop", ok: true },
        { step: "chrome-stop", ok: false, error: "SIGKILL failed" },
      ],
    }),
    {
      error: "boom",
      chrome: {
        chromePath: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
        launch: {
          file: "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          args: ["about:blank"],
        },
        pid: 321,
        mode: "release-smoke",
        platform: "darwin-arm64",
        stderr: "chrome stderr",
        provenance: {
          version: "152.0.7977.64",
          downloadUrl:
            "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
          archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
          executableVersion: "Google Chrome for Testing 152.0.7977.64",
          complete: true,
        },
      },
      daemon: { connected: true },
      status: { ok: true },
      browsers: [{ instance_id: "browser-123" }],
      cleanup: [
        { step: "daemon-stop", ok: true },
        { step: "chrome-stop", ok: false, error: "SIGKILL failed" },
      ],
    },
  );
});

test("stopChildProcess enforces a second deadline after SIGKILL", async () => {
  const signals: (NodeJS.Signals | undefined)[] = [];

  await assert.rejects(
    stopChildProcess({
      child: {
        exitCode: null,
        signalCode: null,
        kill: (signal) => {
          signals.push(signal);
          return true;
        },
      },
      exit: new Promise(() => undefined),
      name: "Chrome",
      timeoutMs: 5,
    }),
    /Chrome did not exit within 5ms after SIGKILL/,
  );

  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("builds a direct Chrome launch plan outside macOS app-bundle paths", () => {
  assert.deepEqual(
    buildChromeLaunchPlan({
      chromePath: "/opt/chrome/chrome",
      extensionDir: "/tmp/extension",
      runtimeDirectory: "/tmp/runtime",
      platform: "linux",
    }),
    {
      file: "/opt/chrome/chrome",
      args: [
        "--user-data-dir=/tmp/runtime/chrome-profile",
        `--disable-extensions-except=/tmp/extension,${companionDir}`,
        `--load-extension=/tmp/extension,${companionDir}`,
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
    },
  );
});

test("forces non-blocking browser queries for scripted polling and diagnostics", () => {
  assert.deepEqual(immediateBrowserQueryEnvironment({ BSK_AUTO_UPDATE: "off", OTHER: "value" }), {
    BSK_AUTO_UPDATE: "off",
    OTHER: "value",
    BSK_BROWSER_WAIT_MS: "0",
  });
});

test("the desktop browser workflow pins Chrome provenance and validates extracted release artifacts", async () => {
  const workflow = await readFile(".github/workflows/desktop-browser-conformance.yml", "utf8");

  assert.match(workflow, /CHROME_FOR_TESTING_VERSION: 152\.0\.7977\.64/);
  assert.match(
    workflow,
    /CHROME_FOR_TESTING_URL: "https:\/\/storage\.googleapis\.com\/chrome-for-testing-public\/152\.0\.7977\.64\/mac-arm64\/chrome-mac-arm64\.zip"/,
  );
  assert.match(workflow, /CHROME_FOR_TESTING_SHA256: 10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f/);
  assert.match(workflow, /chrome_version="\$\("\$chrome" --version\)"/);
  assert.match(workflow, /released BrowserSkill CLI was not found at \$cli/);
  assert.match(workflow, /released BrowserSkill CLI is not executable at \$cli/);
  assert.match(workflow, /released BrowserSkill extension directory was not found at \$extension_dir/);
  assert.match(
    workflow,
    /released BrowserSkill extension directory is missing manifest\.json at \$extension_dir\/manifest\.json/,
  );
  assert.match(workflow, /--chrome-version "\$CHROME_FOR_TESTING_VERSION"/);
  assert.match(workflow, /--chrome-url "\$CHROME_FOR_TESTING_URL"/);
  assert.match(workflow, /--chrome-archive-sha256 "\$CHROME_FOR_TESTING_SHA256"/);
});

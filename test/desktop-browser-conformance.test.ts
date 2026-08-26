import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildFailureDiagnostics,
  buildChromeLaunchPlan,
  captureBrowserSkillConformanceFixtures,
  immediateBrowserQueryEnvironment,
  normalizeBrowserSkillConformanceFixtures,
  runDesktopBrowserConformance,
  runJsonCommand,
  runTextCommand,
  stopChildProcess,
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
    browser: {
      version: "152.0.7977.64",
      downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
      downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
      downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
      downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
      archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
      executableVersion: "Google Chrome for Testing 152.0.7977.64",
    },
    artifactProvenance: {
      kind: "release",
      cli: {
        version: "0.1.10",
        downloadUrl: "https://github.com/Tencent/BrowserSkill/releases/download/cli-v0.1.10/bsk-v0.1.10-aarch64-apple-darwin.tar.gz",
        archiveSha256: "50403691584243a48398d9b0c9084c562fef047878f0826dcdc70a01c4baec9f",
      },
      extension: {
        version: "0.1.6",
        downloadUrl: "https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.1.6/browser-skill-extension-v0.1.6-chrome.zip",
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
      downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
        downloadUrl: "https://github.com/Tencent/BrowserSkill/releases/download/cli-v0.1.10/bsk-v0.1.10-aarch64-apple-darwin.tar.gz",
        archiveSha256: "50403691584243a48398d9b0c9084c562fef047878f0826dcdc70a01c4baec9f",
      },
      extension: {
        version: "0.1.6",
        downloadUrl: "https://github.com/Tencent/BrowserSkill/releases/download/ext-v0.1.6/browser-skill-extension-v0.1.6-chrome.zip",
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
    [
      "--json navigate http://127.0.0.1:43123/ --session ABCD",
      { ok: false, output: { code: "navigate_failed" } },
    ],
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
        "--disable-extensions-except=/tmp/extension",
        "--load-extension=/tmp/extension",
        "--no-first-run",
        "--no-default-browser-check",
        "about:blank",
      ],
    },
  );
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

test("setup failures before Chrome spawn still clean every acquired resource and preserve diagnostics", async () => {
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
        chromeUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
        probeDaemonStatus: async () => {
          calls.push("daemon:status:prelaunch");
          return { ok: true, output: { status: "ok" } };
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
          return { state: "before-cleanup" };
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

  assert.ok(calls.indexOf("daemon:info") < calls.indexOf("cleanup:daemon-stop"));
  assert.ok(calls.indexOf("daemon:status:diagnostics") < calls.indexOf("cleanup:daemon-stop"));
  assert.ok(calls.indexOf("daemon:browsers:diagnostics") < calls.indexOf("cleanup:daemon-stop"));
  assert.equal(calls.includes("cleanup:chrome-stop"), false);
  assert.deepEqual(
    JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null"),
    {
      error: "launch write failed",
      chrome: {
        chromePath: "/tool/chrome",
        launch: {
          file: "/tool/chrome",
          args: [
            "--user-data-dir=/runtime/chrome-profile",
            "--disable-extensions-except=/tool/extension",
            "--load-extension=/tool/extension",
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
          downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
          archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
          executableVersion: "Google Chrome for Testing 152.0.7977.64",
          complete: true,
        },
      },
      daemon: { state: "before-cleanup" },
      status: { ok: true, output: { state: "before-cleanup" } },
      browsers: { ok: true, output: [{ instance_id: "browser-before-cleanup" }] },
      cleanup: [
        { step: "daemon-stop", ok: true },
        { step: "fixture-server-stop", ok: true },
        { step: "runtime-dir-remove", ok: true },
      ],
    },
  );
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
        chromeUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
        probeDaemonStatus: async () => ({ ok: true, output: { status: "ok" } }),
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
        downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
        archiveSha256: "10033804338bd0a5aa098149a8dd64f3f2e0e8b201bf3d400d7c17d067ff696f",
        complete: false,
      },
    },
    daemon: { state: "pre-provenance" },
    status: { ok: true, output: { state: "pre-provenance" } },
    browsers: { ok: true, output: [] },
    cleanup: [
      { step: "fixture-server-stop", ok: true },
      { step: "runtime-dir-remove", ok: true },
    ],
  });
});

test("cleanup failures do not stop later teardown steps after a run failure", async () => {
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
        chromeUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
        probeDaemonStatus: async () => ({ ok: true, output: { status: "ok" } }),
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
          return { state: "before-cleanup" };
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
  assert.deepEqual(
    JSON.parse(writes.get("/out/failure-diagnostics.json") ?? "null").cleanup,
    [
      { step: "daemon-stop", ok: false, error: "daemon stop failed" },
      { step: "chrome-stop", ok: false, error: "Chrome did not exit within 25ms after SIGKILL" },
      { step: "fixture-server-stop", ok: false, error: "fixture stop failed" },
      { step: "runtime-dir-remove", ok: true },
    ],
  );
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
        downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
          downloadUrl: "https://storage.googleapis.com/chrome-for-testing-public/152.0.7977.64/mac-arm64/chrome-mac-arm64.zip",
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
        "--disable-extensions-except=/tmp/extension",
        "--load-extension=/tmp/extension",
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
  assert.match(workflow, /released BrowserSkill extension directory is missing manifest\.json at \$extension_dir\/manifest\.json/);
  assert.match(workflow, /--chrome-version "\$CHROME_FOR_TESTING_VERSION"/);
  assert.match(workflow, /--chrome-url "\$CHROME_FOR_TESTING_URL"/);
  assert.match(workflow, /--chrome-archive-sha256 "\$CHROME_FOR_TESTING_SHA256"/);
});

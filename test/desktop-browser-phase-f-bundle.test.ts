import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import {
  buildDesktopBrowserPhaseFBundle,
  computeDesktopBrowserHostArtifactHash,
  installDesktopBrowserPhaseFBundle,
  verifyDesktopBrowserPhaseFBundle,
} from "../scripts/desktop-browser-phase-f-bundle.ts";
import { parseDesktopBrowserPhaseFArgs } from "../scripts/desktop-browser-phase-f-cli.ts";

const execFileAsync = promisify(execFile);

const browserSkillCommit = "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c";
const hostCommit = "936dd2b232e3b143e00f269d18b8c061167024c6";

function storedZip(name: string, data: Buffer): Buffer {
  const table = Array.from({ length: 256 }, (_, value) => {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    return crc >>> 0;
  });
  let crc = 0xffffffff;
  for (const byte of data) crc = table[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  const encodedName = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(encodedName.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(encodedName.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + encodedName.length, 12);
  end.writeUInt32LE(local.length + encodedName.length + data.length, 16);
  return Buffer.concat([local, encodedName, data, central, encodedName, end]);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-browser-phase-f-bundle-"));
  const hostDir = join(root, "host");
  const contractsDir = join(root, "contracts");
  const companionDir = join(import.meta.dirname, "../packages/qm-host-broker/companion");
  const browserSkillDir = join(root, "browser-skill-extension");
  await Promise.all([hostDir, contractsDir, browserSkillDir].map((directory) => mkdir(directory)));
  await mkdir(join(hostDir, "src", "bin"), { recursive: true });
  await mkdir(join(contractsDir, "src"), { recursive: true });
  await writeFile(join(hostDir, "src", "index.ts"), "export const host = true;\n");
  await writeFile(join(hostDir, "src", "bin", "qm-host-broker.ts"), "#!/usr/bin/env node\n");
  await writeFile(join(hostDir, "package.json"), JSON.stringify({ name: "qm-host-broker", type: "module" }));
  await writeFile(join(contractsDir, "src", "index.ts"), "export const contract = true;\n");
  await writeFile(join(contractsDir, "package.json"), JSON.stringify({ name: "qm-desktop-browser-contracts", type: "module" }));
  const browserSkillManifest = Buffer.from(JSON.stringify({ manifest_version: 3, version: "0.1.6" }));
  await writeFile(join(browserSkillDir, "manifest.json"), browserSkillManifest);
  const bskPath = join(root, "bsk");
  const browserSkillExtensionArchivePath = join(root, "browser-skill-extension.zip");
  await writeFile(bskPath, "#!/bin/sh\nexit 0\n");
  const browserSkillExtensionArchive = storedZip("manifest.json", browserSkillManifest);
  await writeFile(browserSkillExtensionArchivePath, browserSkillExtensionArchive);
  await chmod(bskPath, 0o755);
  const conformancePath = join(root, "conformance.json");
  await writeFile(
    conformancePath,
    JSON.stringify({
      schemaVersion: 1,
      mode: "baseline-source-build",
      source: { repository: "https://github.com/Tencent/BrowserSkill.git", commit: browserSkillCommit, clean: true },
      artifacts: {
        cli: { platform: "darwin-arm64", sha256: createHash("sha256").update("#!/bin/sh\nexit 0\n").digest("hex") },
        extension: {
          platform: "chrome-mv3",
          sha256: createHash("sha256").update(browserSkillExtensionArchive).digest("hex"),
        },
      },
      autoUpdate: false,
      toolchain: { rust: "rustc 1.90.0", node: "v24.15.0", pnpm: "10.17.0" },
      artifactProvenance: {
        kind: "source-build",
        target: "aarch64-apple-darwin",
        commands: ["cargo build --release --locked", "pnpm ext:build:zip"],
        files: { "Cargo.lock": "a".repeat(64) },
      },
    }),
  );
  const hostArtifactSha256 = await computeDesktopBrowserHostArtifactHash(
    hostDir,
    contractsDir,
    join(import.meta.dirname, "../node_modules/zod"),
  );
  return {
    root,
    hostDir,
    contractsDir,
    companionDir,
    browserSkillDir,
    browserSkillExtensionArchivePath,
    bskPath,
    conformancePath,
    hostArtifactSha256,
  };
}

test("Ticket 15 builds and installs a deterministic pinned user-local macOS bundle", async () => {
  const input = await fixture();
  const first = join(input.root, "phase-f-1.tar.gz");
  const second = join(input.root, "phase-f-2.tar.gz");
  const options = {
    hostSourceCommit: hostCommit,
    expectedHostArtifactSha256: input.hostArtifactSha256,
    expectedBrowserSkillCommit: browserSkillCommit,
    hostSourceDir: input.hostDir,
    contractsSourceDir: input.contractsDir,
    zodSourceDir: join(import.meta.dirname, "../node_modules/zod"),
    companionDir: input.companionDir,
    browserSkillCliPath: input.bskPath,
    browserSkillExtensionDir: input.browserSkillDir,
    browserSkillExtensionArchivePath: input.browserSkillExtensionArchivePath,
    conformanceManifestPath: input.conformancePath,
    toolchain: { node: "v24.15.0", npm: "11.10.0" },
  };
  const firstBuilt = await buildDesktopBrowserPhaseFBundle({ ...options, outputPath: first });
  await buildDesktopBrowserPhaseFBundle({ ...options, outputPath: second });

  assert.deepEqual(await readFile(first), await readFile(second));
  const verified = await verifyDesktopBrowserPhaseFBundle(first);
  assert.equal(verified.manifest.platform, "darwin-arm64");
  assert.equal(verified.manifest.hostBroker.sourceCommit, hostCommit);
  assert.equal(verified.manifest.browserSkill.sourceCommit, browserSkillCommit);
  assert.equal(verified.manifest.autoUpdate.hostBroker, false);
  assert.equal(verified.manifest.autoUpdate.browserSkill, false);
  assert.deepEqual(verified.manifest.companion.browsers, ["chrome", "edge"]);
  assert.equal(verified.manifest.install.scope, "user-local");
  assert.deepEqual(verified.manifest.commands, ["session.start", "navigate", "observe", "session.stop"]);
  assert.equal(JSON.stringify(verified.manifest).includes("latest"), false);

  const installDir = join(input.root, "home", ".qm", "desktop-browser-phase-f");
  await mkdir(join(input.root, "home"));
  await installDesktopBrowserPhaseFBundle({
    bundlePath: first,
    installDir,
    userHome: join(input.root, "home"),
    expectedBundleSha256: firstBuilt.sha256,
  });
  assert.equal((await stat(join(installDir, "bin", "bsk"))).mode & 0o777, 0o755);
  assert.equal((await stat(join(installDir, "companion", "manifest.json"))).isFile(), true);
  assert.equal((await stat(join(installDir, "browser-skill-extension", "manifest.json"))).isFile(), true);
  assert.equal(
    (await readFile(join(installDir, "lib", "qm-host-broker", "browser-skill-executable.txt"), "utf8")).trim(),
    join(installDir, "bin", "bsk"),
  );
  assert.match(await readFile(join(installDir, "bin", "qm-host-broker"), "utf8"), /BSK_AUTO_UPDATE=off/);
  await assert.rejects(
    installDesktopBrowserPhaseFBundle({
      bundlePath: first,
      installDir,
      userHome: join(input.root, "home"),
      expectedBundleSha256: firstBuilt.sha256,
    }),
    /install directory already exists/,
  );

  const corrupted = join(input.root, "phase-f-corrupted.tar.gz");
  const corruptedBytes = Buffer.from(await readFile(first));
  corruptedBytes[Math.floor(corruptedBytes.length / 2)]! ^= 0xff;
  await writeFile(corrupted, corruptedBytes);
  await assert.rejects(verifyDesktopBrowserPhaseFBundle(corrupted));
  await assert.rejects(
    installDesktopBrowserPhaseFBundle({
      bundlePath: first,
      installDir: join(input.root, "home", "wrong-hash"),
      userHome: join(input.root, "home"),
      expectedBundleSha256: "0".repeat(64),
    }),
    /expected SHA-256/,
  );

  const outside = join(input.root, "outside");
  const linkedHome = join(input.root, "home", "linked");
  await mkdir(outside);
  await symlink(outside, linkedHome);
  await assert.rejects(
    installDesktopBrowserPhaseFBundle({
      bundlePath: first,
      installDir: join(linkedHome, "escaped"),
      userHome: join(input.root, "home"),
      expectedBundleSha256: firstBuilt.sha256,
    }),
    /resolve inside the current user home/,
  );
});

test("Ticket 15 fails closed when a pinned artifact hash does not match", async () => {
  const input = await fixture();
  const outputPath = join(input.root, "phase-f-invalid.tar.gz");
  const manifest = JSON.parse(await readFile(input.conformancePath, "utf8"));
  manifest.artifacts.cli.sha256 = "0".repeat(64);
  await writeFile(input.conformancePath, JSON.stringify(manifest));

  await assert.rejects(
    buildDesktopBrowserPhaseFBundle({
      outputPath,
      hostSourceCommit: hostCommit,
      expectedHostArtifactSha256: input.hostArtifactSha256,
      expectedBrowserSkillCommit: browserSkillCommit,
      hostSourceDir: input.hostDir,
      contractsSourceDir: input.contractsDir,
      zodSourceDir: join(import.meta.dirname, "../node_modules/zod"),
      companionDir: input.companionDir,
      browserSkillCliPath: input.bskPath,
      browserSkillExtensionDir: input.browserSkillDir,
      browserSkillExtensionArchivePath: input.browserSkillExtensionArchivePath,
      conformanceManifestPath: input.conformancePath,
      toolchain: { node: "v24.15.0", npm: "11.10.0" },
    }),
    /BrowserSkill CLI hash does not match conformance provenance/,
  );

  const mismatch = await fixture();
  await writeFile(join(mismatch.browserSkillDir, "manifest.json"), "{}\n");
  await assert.rejects(
    buildDesktopBrowserPhaseFBundle({
      outputPath: join(mismatch.root, "extension-mismatch.tar.gz"),
      hostSourceCommit: hostCommit,
      expectedHostArtifactSha256: mismatch.hostArtifactSha256,
      expectedBrowserSkillCommit: browserSkillCommit,
      hostSourceDir: mismatch.hostDir,
      contractsSourceDir: mismatch.contractsDir,
      zodSourceDir: join(import.meta.dirname, "../node_modules/zod"),
      companionDir: mismatch.companionDir,
      browserSkillCliPath: mismatch.bskPath,
      browserSkillExtensionDir: mismatch.browserSkillDir,
      browserSkillExtensionArchivePath: mismatch.browserSkillExtensionArchivePath,
      conformanceManifestPath: mismatch.conformancePath,
      toolchain: { node: "v24.15.0", npm: "11.10.0" },
    }),
    /unpacked Extension does not match pinned archive/,
  );
});

test("Ticket 15 Phase F CLIs reject unknown and duplicate arguments", () => {
  assert.throws(
    () => parseDesktopBrowserPhaseFArgs(["--bundle", "a", "--bundle", "b"], ["bundle"]),
    /duplicate argument/,
  );
  assert.throws(() => parseDesktopBrowserPhaseFArgs(["--latest", "true"], ["bundle"]), /unknown argument/);
});

test("Ticket 15 checked-in provenance matches the pinned Host source artifact", async () => {
  const provenance = JSON.parse(
    await readFile(join(import.meta.dirname, "../artifacts/research/desktop-browser-phase-f-runtime.json"), "utf8"),
  );
  assert.equal(provenance.hostBroker.sourceCommit, hostCommit);
  assert.equal(
    provenance.hostBroker.compiledArtifactSha256,
    await computeDesktopBrowserHostArtifactHash(
      join(import.meta.dirname, "../packages/qm-host-broker"),
      join(import.meta.dirname, "../packages/desktop-browser-contracts"),
      join(import.meta.dirname, "../node_modules/zod"),
    ),
  );
  assert.equal(JSON.stringify(provenance).includes("latest"), false);
});

test("Ticket 15 installed real Host Broker starts from the user-local bundle", async () => {
  const input = await fixture();
  const provenance = JSON.parse(
    await readFile(join(import.meta.dirname, "../artifacts/research/desktop-browser-phase-f-runtime.json"), "utf8"),
  );
  const bundlePath = join(input.root, "phase-f-real-host.tar.gz");
  const built = await buildDesktopBrowserPhaseFBundle({
    outputPath: bundlePath,
    hostSourceCommit: hostCommit,
    expectedHostArtifactSha256: provenance.hostBroker.compiledArtifactSha256,
    expectedBrowserSkillCommit: browserSkillCommit,
    hostSourceDir: join(import.meta.dirname, "../packages/qm-host-broker"),
    contractsSourceDir: join(import.meta.dirname, "../packages/desktop-browser-contracts"),
    zodSourceDir: join(import.meta.dirname, "../node_modules/zod"),
    companionDir: input.companionDir,
    browserSkillCliPath: input.bskPath,
    browserSkillExtensionDir: input.browserSkillDir,
    browserSkillExtensionArchivePath: input.browserSkillExtensionArchivePath,
    conformanceManifestPath: input.conformancePath,
    toolchain: { node: process.version, npm: "11.19.0" },
  });
  const installDir = join(input.root, "installed");
  await installDesktopBrowserPhaseFBundle({
    bundlePath,
    installDir,
    userHome: input.root,
    expectedBundleSha256: built.sha256,
  });

  const result = await execFileAsync(join(installDir, "bin", "qm-host-broker"), ["status", "--json"], {
    env: { ...process.env, QM_HOST_BROKER_DATA_DIR: join(input.root, "host-data") },
  });
  const status = JSON.parse(result.stdout) as { brokerStatus: string; notice: string };
  assert.equal(status.brokerStatus, "disconnected");
  assert.match(status.notice, /QM controls the browser/);
});
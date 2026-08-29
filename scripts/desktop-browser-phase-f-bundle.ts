import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, posix, relative, sep } from "node:path";
import { gzipSync, gunzipSync, inflateRawSync } from "node:zlib";
import { makeTar, parseTar } from "../src/sandbox/tar.ts";
import ts from "typescript";

const expectedCompanionExtensionId = "nciggffamocnffbemkbjefanopmelkgm";
const manifestPath = "phase-f-manifest.json";
const maxExtensionArchiveBytes = 64 * 1024 * 1024;
const maxExtensionEntryBytes = 32 * 1024 * 1024;
const maxExtensionExpandedBytes = 128 * 1024 * 1024;
const maxExtensionEntries = 4_096;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const lexicalCompare = (left: string, right: string): number => {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
};

const crcTable = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});
const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
};

type BundleFile = { path: string; data: Buffer; mode: 0o644 | 0o755 };

export interface DesktopBrowserPhaseFBundleManifest {
  schemaVersion: 1;
  platform: "darwin-arm64";
  hostBroker: { sourceCommit: string; sha256: string; toolchain: { node: string; npm: string; typescript: string } };
  companion: {
    extensionId: string;
    manifestVersion: number;
    version: string;
    browsers: ["chrome", "edge"];
    sha256: string;
  };
  browserSkill: {
    repository: string;
    sourceCommit: string;
    cliSha256: string;
    extensionArchiveSha256: string;
    toolchain: Record<string, string>;
    provenance: unknown;
  };
  autoUpdate: { hostBroker: false; browserSkill: false };
  install: { scope: "user-local"; systemService: false; loginAgent: false; updater: false };
  commands: ["session.start", "navigate", "observe", "session.stop"];
  files: Array<{ path: string; sha256: string; sizeBytes: number; mode: 420 | 493 }>;
}

export interface BuildDesktopBrowserPhaseFBundleOptions {
  outputPath: string;
  hostSourceCommit: string;
  expectedHostArtifactSha256: string;
  expectedBrowserSkillCommit: string;
  hostSourceDir: string;
  contractsSourceDir: string;
  zodSourceDir: string;
  companionDir: string;
  browserSkillCliPath: string;
  browserSkillExtensionDir: string;
  browserSkillExtensionArchivePath: string;
  conformanceManifestPath: string;
  toolchain: { node: string; npm: string };
}

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => lexicalCompare(left, right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  throw new Error("Phase F bundle contains a non-JSON manifest value");
};

async function collectDirectory(directory: string, prefix: string): Promise<BundleFile[]> {
  const files: BundleFile[] = [];
  const walk = async (current: string, relative: string): Promise<void> => {
    const names = (await readdir(current)).sort();
    for (const name of names) {
      const source = join(current, name);
      const child = relative ? posix.join(relative, name) : name;
      const info = await lstat(source);
      if (info.isSymbolicLink()) throw new Error(`Phase F bundle source cannot contain symlink ${child}`);
      if (info.isDirectory()) await walk(source, child);
      else if (info.isFile()) files.push({ path: posix.join(prefix, child), data: await readFile(source), mode: 0o644 });
      else throw new Error(`Phase F bundle source contains unsupported entry ${child}`);
    }
  };
  await walk(directory, "");
  return files;
}

async function collectCompiledPackage(directory: string, prefix: string): Promise<BundleFile[]> {
  const source = await collectDirectory(directory, prefix);
  return source.map((file) => {
    if (file.path.endsWith(".ts")) {
      const compiled = ts.transpileModule(file.data.toString("utf8"), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2022,
          module: ts.ModuleKind.ESNext,
          moduleResolution: ts.ModuleResolutionKind.Bundler,
          verbatimModuleSyntax: true,
        },
        fileName: file.path,
      });
      return {
        ...file,
        path: `${file.path.slice(0, -3)}.js`,
        data: Buffer.from(compiled.outputText.replaceAll('.ts"', '.js"').replaceAll(".ts'", ".js'")),
      };
    }
    if (file.path.endsWith("/package.json")) {
      return { ...file, data: Buffer.from(file.data.toString("utf8").replaceAll('.ts"', '.js"')) };
    }
    return file;
  });
}

function parseZipFiles(archive: Buffer): Map<string, Buffer> {
  if (archive.length > maxExtensionArchiveBytes) throw new Error("BrowserSkill Extension ZIP exceeds size limit");
  let end = -1;
  for (let offset = archive.length - 22; offset >= Math.max(0, archive.length - 65_557); offset -= 1) {
    if (archive.readUInt32LE(offset) === 0x06054b50) {
      end = offset;
      break;
    }
  }
  if (end < 0) throw new Error("BrowserSkill Extension archive has no ZIP directory");
  const count = archive.readUInt16LE(end + 10);
  const centralSize = archive.readUInt32LE(end + 12);
  let offset = archive.readUInt32LE(end + 16);
  if (count > maxExtensionEntries || offset + centralSize > end) {
    throw new Error("BrowserSkill Extension ZIP directory exceeds limits");
  }
  const files = new Map<string, Buffer>();
  let expandedBytes = 0;
  for (let index = 0; index < count; index += 1) {
    if (offset + 46 > archive.length) throw new Error("BrowserSkill Extension ZIP directory is truncated");
    if (archive.readUInt32LE(offset) !== 0x02014b50) throw new Error("BrowserSkill Extension ZIP directory is invalid");
    const flags = archive.readUInt16LE(offset + 8);
    const method = archive.readUInt16LE(offset + 10);
    const expectedCrc = archive.readUInt32LE(offset + 16);
    const compressedSize = archive.readUInt32LE(offset + 20);
    const size = archive.readUInt32LE(offset + 24);
    const nameLength = archive.readUInt16LE(offset + 28);
    const extraLength = archive.readUInt16LE(offset + 30);
    const commentLength = archive.readUInt16LE(offset + 32);
    const localOffset = archive.readUInt32LE(offset + 42);
    if (
      (flags & 1) !== 0 ||
      compressedSize === 0xffffffff ||
      size === 0xffffffff ||
      compressedSize > maxExtensionArchiveBytes ||
      size > maxExtensionEntryBytes
    ) {
      throw new Error("BrowserSkill Extension ZIP uses unsupported encryption or ZIP64");
    }
    expandedBytes += size;
    if (expandedBytes > maxExtensionExpandedBytes) throw new Error("BrowserSkill Extension ZIP expands beyond limit");
    if (offset + 46 + nameLength + extraLength + commentLength > archive.length) {
      throw new Error("BrowserSkill Extension ZIP directory entry is truncated");
    }
    const name = archive.subarray(offset + 46, offset + 46 + nameLength).toString("utf8");
    if (name.startsWith("/") || name.includes("..") || posix.normalize(name) !== name) {
      throw new Error(`BrowserSkill Extension ZIP contains unsafe path ${name}`);
    }
    if (!name.endsWith("/")) {
      if (localOffset + 30 > archive.length) throw new Error("BrowserSkill Extension ZIP entry is truncated");
      if (archive.readUInt32LE(localOffset) !== 0x04034b50) throw new Error("BrowserSkill Extension ZIP entry is invalid");
      const localFlags = archive.readUInt16LE(localOffset + 6);
      const localMethod = archive.readUInt16LE(localOffset + 8);
      const localCrc = archive.readUInt32LE(localOffset + 14);
      const localNameLength = archive.readUInt16LE(localOffset + 26);
      const localExtraLength = archive.readUInt16LE(localOffset + 28);
      const start = localOffset + 30 + localNameLength + localExtraLength;
      const localName = archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString("utf8");
      if (localFlags !== flags || localMethod !== method || localCrc !== expectedCrc || localName !== name) {
        throw new Error("BrowserSkill Extension ZIP local metadata does not match directory");
      }
      if (start + compressedSize > archive.length) throw new Error("BrowserSkill Extension ZIP data is truncated");
      const compressed = archive.subarray(start, start + compressedSize);
      let data: Buffer | null = null;
      if (method === 0) data = Buffer.from(compressed);
      else if (method === 8) data = inflateRawSync(compressed, { maxOutputLength: maxExtensionEntryBytes });
      if (!data || data.length !== size || crc32(data) !== expectedCrc) {
        throw new Error(`BrowserSkill Extension ZIP entry is unsupported or corrupt ${name}`);
      }
      if (files.has(name)) throw new Error(`BrowserSkill Extension ZIP contains duplicate path ${name}`);
      files.set(name, data);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

async function assertExtensionArchiveMatchesDirectory(archive: Buffer, directory: string): Promise<void> {
  const archiveFiles = parseZipFiles(archive);
  const directoryFiles = await collectDirectory(directory, "");
  let normalized = archiveFiles;
  if (!archiveFiles.has("manifest.json") && archiveFiles.size > 0) {
    const roots = new Set([...archiveFiles.keys()].map((path) => path.split("/", 1)[0]));
    if (roots.size === 1) {
      const root = [...roots][0]!;
      normalized = new Map([...archiveFiles].map(([path, data]) => [path.slice(root.length + 1), data]));
    }
  }
  if (normalized.size !== directoryFiles.length) {
    throw new Error("BrowserSkill unpacked Extension does not match pinned archive");
  }
  for (const file of directoryFiles) {
    const archived = normalized.get(file.path);
    if (!archived || !archived.equals(file.data)) {
      throw new Error("BrowserSkill unpacked Extension does not match pinned archive");
    }
  }
}

function companionId(key: string): string {
  return [...createHash("sha256").update(Buffer.from(key, "base64")).digest().subarray(0, 16)]
    .flatMap((byte) => [String.fromCharCode(97 + (byte >> 4)), String.fromCharCode(97 + (byte & 15))])
    .join("");
}

function treeHash(files: BundleFile[], prefix: string): string {
  const hash = createHash("sha256");
  for (const file of files
    .filter((entry) => entry.path.startsWith(prefix))
    .sort((left, right) => lexicalCompare(left.path, right.path))) {
    hash.update(file.path).update("\0").update(file.data).update("\0");
  }
  return hash.digest("hex");
}

export async function computeDesktopBrowserHostArtifactHash(
  hostSourceDir: string,
  contractsSourceDir: string,
  zodSourceDir: string,
): Promise<string> {
  const files = [
    ...(await collectCompiledPackage(hostSourceDir, "lib/qm-host-broker")),
    ...(await collectCompiledPackage(
      contractsSourceDir,
      "lib/qm-host-broker/node_modules/qm-desktop-browser-contracts",
    )),
    ...(await collectDirectory(zodSourceDir, "lib/qm-host-broker/node_modules/zod")),
  ];
  return treeHash(files, "lib/qm-host-broker/");
}

function validateCommit(value: string, label: string): void {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new Error(`${label} must be one full immutable commit`);
}

export async function buildDesktopBrowserPhaseFBundle(
  options: BuildDesktopBrowserPhaseFBundleOptions,
): Promise<{ sha256: string; manifest: DesktopBrowserPhaseFBundleManifest }> {
  validateCommit(options.hostSourceCommit, "Host Broker source commit");
  validateCommit(options.expectedBrowserSkillCommit, "BrowserSkill source commit");
  await access(join(options.hostSourceDir, "src", "bin", "qm-host-broker.ts"), fsConstants.R_OK);
  const zodPackage = JSON.parse(await readFile(join(options.zodSourceDir, "package.json"), "utf8")) as {
    name?: string;
    version?: string;
  };
  if (zodPackage.name !== "zod" || zodPackage.version !== "4.4.3") {
    throw new Error("Phase F bundle requires pinned zod 4.4.3 runtime files");
  }
  const conformance = JSON.parse(await readFile(options.conformanceManifestPath, "utf8")) as Record<string, any>;
  if (
    conformance.mode !== "baseline-source-build" ||
    conformance.source?.commit !== options.expectedBrowserSkillCommit ||
    conformance.source?.clean !== true
  ) {
    throw new Error("BrowserSkill source does not match pinned clean conformance provenance");
  }
  if (conformance.autoUpdate !== false || conformance.artifactProvenance?.kind !== "source-build") {
    throw new Error("BrowserSkill conformance provenance must disable automatic update and use a source build");
  }
  const cli = await readFile(options.browserSkillCliPath);
  const extensionArchive = await readFile(options.browserSkillExtensionArchivePath);
  if (sha256(cli) !== conformance.artifacts?.cli?.sha256) {
    throw new Error("BrowserSkill CLI hash does not match conformance provenance");
  }
  if (sha256(extensionArchive) !== conformance.artifacts?.extension?.sha256) {
    throw new Error("BrowserSkill Extension hash does not match conformance provenance");
  }
  await assertExtensionArchiveMatchesDirectory(extensionArchive, options.browserSkillExtensionDir);
  const companionManifest = JSON.parse(await readFile(join(options.companionDir, "manifest.json"), "utf8")) as {
    manifest_version?: number;
    version?: string;
    key?: string;
  };
  if (!companionManifest.key || companionId(companionManifest.key) !== expectedCompanionExtensionId) {
    throw new Error("Companion manifest does not produce the fixed Phase F Extension ID");
  }
  if (companionManifest.manifest_version !== 3 || !companionManifest.version) {
    throw new Error("Companion manifest is not a versioned Manifest V3 artifact");
  }

  const files = [
    ...(await collectCompiledPackage(options.hostSourceDir, "lib/qm-host-broker")),
    ...(await collectCompiledPackage(
      options.contractsSourceDir,
      "lib/qm-host-broker/node_modules/qm-desktop-browser-contracts",
    )),
    ...(await collectDirectory(options.zodSourceDir, "lib/qm-host-broker/node_modules/zod")),
    ...(await collectDirectory(options.companionDir, "companion")),
    ...(await collectDirectory(options.browserSkillExtensionDir, "browser-skill-extension")),
    { path: "bin/bsk", data: cli, mode: 0o755 as const },
    { path: "provenance/browser-skill-extension.zip", data: extensionArchive, mode: 0o644 as const },
    {
      path: "bin/qm-host-broker",
      data: Buffer.from(
        '#!/bin/sh\nexport BSK_AUTO_UPDATE=off\nexec node "$(dirname "$0")/../lib/qm-host-broker/src/bin/qm-host-broker.js" "$@"\n',
      ),
      mode: 0o755 as const,
    },
  ].sort((left, right) => lexicalCompare(left.path, right.path));
  if (new Set(files.map((file) => file.path)).size !== files.length) throw new Error("Phase F bundle has duplicate paths");
  const hostArtifactSha256 = treeHash(files, "lib/qm-host-broker/");
  if (hostArtifactSha256 !== options.expectedHostArtifactSha256) {
    throw new Error("Host Broker artifact hash does not match pinned provenance");
  }

  const fileRecords = files.map((file) => ({
    path: file.path,
    sha256: sha256(file.data),
    sizeBytes: file.data.length,
    mode: file.mode,
  }));
  const manifest: DesktopBrowserPhaseFBundleManifest = {
    schemaVersion: 1,
    platform: "darwin-arm64",
    hostBroker: {
      sourceCommit: options.hostSourceCommit,
      sha256: hostArtifactSha256,
      toolchain: { ...options.toolchain, typescript: ts.version },
    },
    companion: {
      extensionId: expectedCompanionExtensionId,
      manifestVersion: companionManifest.manifest_version,
      version: companionManifest.version,
      browsers: ["chrome", "edge"],
      sha256: treeHash(files, "companion/"),
    },
    browserSkill: {
      repository: String(conformance.source.repository),
      sourceCommit: options.expectedBrowserSkillCommit,
      cliSha256: sha256(cli),
      extensionArchiveSha256: sha256(extensionArchive),
      toolchain: { ...conformance.toolchain },
      provenance: conformance.artifactProvenance,
    },
    autoUpdate: { hostBroker: false, browserSkill: false },
    install: { scope: "user-local", systemService: false, loginAgent: false, updater: false },
    commands: ["session.start", "navigate", "observe", "session.stop"],
    files: fileRecords,
  };
  const archiveEntries = [
    { path: manifestPath, data: Buffer.from(`${canonicalJson(manifest)}\n`), mode: 0o644 as const },
    ...files,
  ];
  const tar = await makeTar(archiveEntries.map((entry) => ({ path: entry.path, data: entry.data })));
  const archive = gzipSync(tar, { level: 9 });
  await mkdir(dirname(options.outputPath), { recursive: true });
  await writeFile(options.outputPath, archive, { mode: 0o644 });
  return { sha256: sha256(archive), manifest };
}

export async function verifyDesktopBrowserPhaseFBundle(bundlePath: string): Promise<{
  manifest: DesktopBrowserPhaseFBundleManifest;
  files: Map<string, Buffer>;
}> {
  const entries = await parseTar(gunzipSync(await readFile(bundlePath)));
  const byPath = new Map<string, Buffer>();
  for (const entry of entries) {
    if (entry.path.startsWith("/") || entry.path.includes("..") || posix.normalize(entry.path) !== entry.path) {
      throw new Error(`Phase F bundle contains unsafe path ${entry.path}`);
    }
    if (byPath.has(entry.path)) throw new Error(`Phase F bundle contains duplicate path ${entry.path}`);
    byPath.set(entry.path, entry.data);
  }
  const encodedManifest = byPath.get(manifestPath);
  if (!encodedManifest) throw new Error("Phase F bundle manifest is missing");
  const manifest = JSON.parse(encodedManifest.toString("utf8")) as DesktopBrowserPhaseFBundleManifest;
  if (manifest.schemaVersion !== 1 || manifest.platform !== "darwin-arm64") {
    throw new Error("Phase F bundle manifest is incompatible");
  }
  const expectedPaths = new Set([manifestPath, ...manifest.files.map((file) => file.path)]);
  if (expectedPaths.size !== manifest.files.length + 1 || expectedPaths.size !== byPath.size) {
    throw new Error("Phase F bundle file inventory does not match the archive");
  }
  for (const file of manifest.files) {
    const data = byPath.get(file.path);
    if (!data || data.length !== file.sizeBytes || sha256(data) !== file.sha256) {
      throw new Error(`Phase F bundle hash mismatch for ${file.path}`);
    }
    if (file.mode !== 0o644 && file.mode !== 0o755) throw new Error(`Phase F bundle mode is invalid for ${file.path}`);
  }
  if (
    manifest.autoUpdate.hostBroker !== false ||
    manifest.autoUpdate.browserSkill !== false ||
    manifest.install.scope !== "user-local" ||
    manifest.install.systemService ||
    manifest.install.loginAgent ||
    manifest.install.updater
  ) {
    throw new Error("Phase F bundle installation policy is unsafe");
  }
  return { manifest, files: byPath };
}

export async function installDesktopBrowserPhaseFBundle(options: {
  bundlePath: string;
  installDir: string;
  userHome: string;
  expectedBundleSha256: string;
}): Promise<DesktopBrowserPhaseFBundleManifest> {
  const archive = await readFile(options.bundlePath);
  if (!/^[0-9a-f]{64}$/.test(options.expectedBundleSha256) || sha256(archive) !== options.expectedBundleSha256) {
    throw new Error("Phase F bundle does not match the expected SHA-256");
  }
  const verified = await verifyDesktopBrowserPhaseFBundle(options.bundlePath);
  const parent = dirname(options.installDir);
  const resolvedHome = await realpath(options.userHome);
  let ancestor = parent;
  while (true) {
    try {
      ancestor = await realpath(ancestor);
      break;
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
      const next = dirname(ancestor);
      if (next === ancestor) throw new Error("Phase F install directory has no existing parent", { cause: error });
      ancestor = next;
    }
  }
  const fromHome = relative(resolvedHome, ancestor);
  if (fromHome === ".." || fromHome.startsWith(`..${sep}`) || isAbsolute(fromHome)) {
    throw new Error("Phase F install directory must resolve inside the current user home");
  }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.phase-f-${randomUUID()}.installing`);
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const file of verified.manifest.files) {
      const data = verified.files.get(file.path)!;
      const destination = join(temporary, ...file.path.split("/"));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, data, { mode: file.mode });
      await chmod(destination, file.mode);
    }
    await writeFile(
      join(temporary, "lib", "qm-host-broker", "browser-skill-executable.txt"),
      `${join(options.installDir, "bin", "bsk")}\n`,
      { mode: 0o600 },
    );
    await writeFile(join(temporary, manifestPath), `${canonicalJson(verified.manifest)}\n`, { mode: 0o600 });
    try {
      await lstat(options.installDir);
      throw new Error("Phase F install directory already exists");
    } catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT")) throw error;
    }
    await rename(temporary, options.installDir);
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    throw error;
  }
  return verified.manifest;
}

import { writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { relative } from "node:path";
import { promisify } from "node:util";
import { buildDesktopBrowserPhaseFBundle } from "./desktop-browser-phase-f-bundle.ts";
import { parseDesktopBrowserPhaseFArgs } from "./desktop-browser-phase-f-cli.ts";

const execFileAsync = promisify(execFile);

const names = [
  "output",
  "fixture",
  "host-source-commit",
  "host-artifact-sha256",
  "browser-skill-source-commit",
  "host-source-dir",
  "contracts-source-dir",
  "zod-source-dir",
  "companion-dir",
  "browser-skill-cli",
  "browser-skill-extension-dir",
  "browser-skill-extension-archive",
  "conformance-manifest",
  "node-version",
  "npm-version",
] as const;
const args = parseDesktopBrowserPhaseFArgs(process.argv.slice(2), names);

const repository = (await execFileAsync("git", ["-C", args["host-source-dir"]!, "rev-parse", "--show-toplevel"]))
  .stdout.trim();
await execFileAsync("git", ["-C", repository, "cat-file", "-e", `${args["host-source-commit"]!}^{commit}`]);
const sourcePaths = [args["host-source-dir"]!, args["contracts-source-dir"]!].map((path) => relative(repository, path));
await execFileAsync("git", ["-C", repository, "diff", "--quiet", args["host-source-commit"]!, "--", ...sourcePaths]);
const untracked = (
  await execFileAsync("git", ["-C", repository, "ls-files", "--others", "--exclude-standard", "--", ...sourcePaths])
).stdout.trim();
if (untracked) throw new Error(`Host build inputs contain untracked files: ${untracked}`);
const npmVersion = (await execFileAsync("npm", ["--version"])).stdout.trim();
if (args["node-version"] !== process.version || args["npm-version"] !== npmVersion) {
  throw new Error("declared Host build toolchain does not match the active Node and npm versions");
}

const built = await buildDesktopBrowserPhaseFBundle({
  outputPath: args.output!,
  hostSourceCommit: args["host-source-commit"]!,
  expectedHostArtifactSha256: args["host-artifact-sha256"]!,
  expectedBrowserSkillCommit: args["browser-skill-source-commit"]!,
  hostSourceDir: args["host-source-dir"]!,
  contractsSourceDir: args["contracts-source-dir"]!,
  zodSourceDir: args["zod-source-dir"]!,
  companionDir: args["companion-dir"]!,
  browserSkillCliPath: args["browser-skill-cli"]!,
  browserSkillExtensionDir: args["browser-skill-extension-dir"]!,
  browserSkillExtensionArchivePath: args["browser-skill-extension-archive"]!,
  conformanceManifestPath: args["conformance-manifest"]!,
  toolchain: { node: args["node-version"]!, npm: args["npm-version"]! },
});
await writeFile(
  args.fixture!,
  `${JSON.stringify({ schemaVersion: 1, bundleSha256: built.sha256, manifest: built.manifest }, null, 2)}\n`,
  { mode: 0o644 },
);
process.stdout.write(`${built.sha256}\n`);

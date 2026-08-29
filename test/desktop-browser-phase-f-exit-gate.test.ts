import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = join(import.meta.dirname, "..");
const gatePath = join(root, "artifacts", "research", "desktop-browser-phase-f-exit-gate.json");
const reviewArtifactPaths = new Set([
  "artifacts/research/desktop-browser-phase-f-security-review.json",
  "artifacts/research/desktop-browser-phase-f-code-review.json",
]);

async function reviewedChangeSet(sourceCommit: string): Promise<{ paths: string[]; sha256: string }> {
  const tracked = execFileSync("git", ["diff", "--name-only", sourceCommit, "--"], { cwd: root, encoding: "utf8" });
  const untracked = execFileSync("git", ["ls-files", "--others", "--exclude-standard"], { cwd: root, encoding: "utf8" });
  const paths = [...new Set(`${tracked}\n${untracked}`.split("\n"))]
    .filter((path) => path && !reviewArtifactPaths.has(path))
    .sort();
  const digest = createHash("sha256");
  for (const path of paths) {
    let content = await readFile(join(root, path));
    if (path === "artifacts/research/desktop-browser-phase-f-exit-gate.json") {
      const manifest = JSON.parse(content.toString("utf8"));
      manifest.status = "review-pending";
      manifest.reviews.security.status = "review-pending";
      manifest.reviews.code.status = "review-pending";
      content = Buffer.from(JSON.stringify(manifest));
    }
    digest.update(path).update("\0").update(createHash("sha256").update(content).digest("hex")).update("\n");
  }
  return { paths, sha256: digest.digest("hex") };
}

async function desktopBrowserTests(): Promise<Map<string, string>> {
  const tests = new Map<string, string>();
  for (const file of (await readdir(join(root, "test"))).filter((name) => /^desktop-browser-.*\.test\.ts$/.test(name))) {
    const source = await readFile(join(root, "test", file), "utf8");
    for (const match of source.matchAll(/test\(\s*["']([^"']+)["']/g)) tests.set(match[1]!, `test/${file}`);
  }
  return tests;
}

test("Ticket 16 Phase F exit gate maps every accepted seam, fault boundary, and ADR to executable evidence", async () => {
  const gate = JSON.parse(await readFile(gatePath, "utf8")) as {
    schemaVersion: number;
    status: string;
    sourceCommit: string;
    acceptance: Record<string, { tests: string[]; workflowSteps?: string[] }>;
    faults: Record<string, { tests: string[] }>;
    adrs: Record<string, { status: string; title: string; file: string }>;
    reviews: { security: { status: string; file: string }; code: { status: string; file: string } };
  };
  assert.equal(gate.schemaVersion, 1);
  assert.equal(gate.status, "ready-for-macos-validation");
  assert.match(gate.sourceCommit, /^[0-9a-f]{40}$/);
  assert.deepEqual(Object.keys(gate.faults).sort(), [
    "callback_delivery",
    "core_terminal_cas",
    "core_to_relay_request",
    "host_fence",
    "host_result",
    "process_spawn",
    "relay_accept_commit",
    "relay_prepare_commit",
    "relay_terminal_commit",
    "restart_recovery",
    "stop",
    "wss_delivery",
  ]);
  assert.deepEqual(Object.keys(gate.adrs).sort(), ["0001", "0002", "0003", "0004", "0005"]);
  assert.deepEqual(
    Object.fromEntries(Object.entries(gate.adrs).map(([id, adr]) => [id, adr.status])),
    { "0001": "accepted", "0002": "accepted", "0003": "proposed", "0004": "accepted", "0005": "accepted" },
  );
  for (const [id, expected] of Object.entries(gate.adrs)) {
    assert.ok(expected.file.startsWith(`${id}-`));
    const source = await readFile(join(root, "adrs", expected.file), "utf8");
    assert.match(source, new RegExp(`^---\\nstatus: ${expected.status}\\n---`));
    assert.match(source, new RegExp(`# ${expected.title.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }

  const available = await desktopBrowserTests();
  for (const [category, evidence] of [
    ...Object.entries(gate.acceptance),
    ...Object.entries(gate.faults),
  ]) {
    assert.ok(evidence.tests.length > 0, `${category} has no executable evidence`);
    for (const name of evidence.tests) assert.ok(available.has(name), `${category} references missing test ${name}`);
  }
  const workflow = await readFile(join(root, ".github", "workflows", "desktop-browser-conformance.yml"), "utf8");
  for (const evidence of Object.values(gate.acceptance)) {
    for (const step of evidence.workflowSteps ?? []) assert.match(workflow, new RegExp(`name: ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  }
  const reviewed = await reviewedChangeSet(gate.sourceCommit);
  for (const [kind, expected] of Object.entries(gate.reviews)) {
    assert.equal(expected.status, "approved");
    const report = JSON.parse(await readFile(join(root, "artifacts", "research", expected.file), "utf8")) as {
      schemaVersion: number;
      kind: string;
      status: string;
      sourceCommit: string;
      reviewedPaths: string[];
      reviewedDiffSha256: string;
      findings: unknown[];
    };
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, kind);
    assert.equal(report.status, "approved");
    assert.equal(report.sourceCommit, gate.sourceCommit);
    assert.deepEqual(report.reviewedPaths, reviewed.paths);
    assert.equal(report.reviewedDiffSha256, reviewed.sha256);
    assert.deepEqual(report.findings, []);
  }
});
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import type { DesktopBrowserArtifactIntent } from "qm-desktop-browser-contracts";
import {
  createDesktopBrowserArtifactGrantService,
  type DesktopBrowserArtifactGrantRecord,
} from "../src/desktop-browser/artifact-grant-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { projectScopeId } from "../src/projects/project-store.ts";

const bytes = Buffer.from("phase-f-fake-artifact", "utf8");
const intent: DesktopBrowserArtifactIntent = {
  artifactIntentId: "artifact-intent-1",
  taskId: "task-1",
  attemptId: "attempt-1",
  operationId: "operation-1",
  requestHash: "sha256:request-1",
  deviceId: "device-1",
  actorId: "actor-1",
  projectId: "project-1",
  leaseId: "lease-1",
  leaseVersion: 3,
  leaseExpiresAt: "2026-08-29T12:01:00.000Z",
  name: "capture.bin",
  contentType: "application/octet-stream",
  sizeBytes: bytes.length,
  expectedSha256: createHash("sha256").update(bytes).digest("hex"),
};

function harness(now = 10_000) {
  let currentTime = now;
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const grants = createMemoryMap<DesktopBrowserArtifactGrantRecord>();
  const service = createDesktopBrowserArtifactGrantService({
    grants,
    files,
    now: () => currentTime,
    token: () => "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_-token",
    validateIntent: async (candidate) =>
      JSON.stringify(candidate) === JSON.stringify(intent)
        ? { status: "ok" as const }
        : { status: "refused" as const, reason: "Artifact intent does not match current Task authority" },
  });
  return { files, grants, service, setNow: (value: number) => (currentTime = value) };
}

test("Ticket 13 redeems one short-lived grant into a Task-bound FileArtifact", async () => {
  const { files, service } = harness();
  const issued = await service.issue(intent, "https://qm.example.com/v1/desktop-browser/artifacts");
  assert.equal(issued.status, "ok");
  if (issued.status !== "ok") return;
  assert.equal(issued.grant.expiresAt, "1970-01-01T00:01:10.000Z");
  assert.equal(JSON.stringify(await service.records()), JSON.stringify(await service.records()).replaceAll(issued.grant.bearerToken, ""));
  assert.equal((await files.listOwnedByScopes([projectScopeId(intent.projectId)])).files.length, 0);

  const redeemed = await service.redeem({
    bearerToken: issued.grant.bearerToken,
    deviceId: intent.deviceId,
    contentType: intent.contentType,
    data: bytes,
  });

  assert.equal(redeemed.status, "ok");
  if (redeemed.status !== "ok") return;
  assert.equal(redeemed.artifact.ownerScopeId, projectScopeId(intent.projectId));
  assert.equal(redeemed.artifact.createdBy, intent.actorId);
  assert.equal(redeemed.artifact.createdInScope, projectScopeId(intent.projectId));
  assert.equal(redeemed.artifact.sha256, intent.expectedSha256);
  assert.deepEqual(Buffer.concat(await Array.fromAsync((await files.open(redeemed.artifact.id))!.stream)), bytes);
  assert.deepEqual(await service.redeem({
    bearerToken: issued.grant.bearerToken,
    deviceId: intent.deviceId,
    contentType: intent.contentType,
    data: bytes,
  }), { status: "refused", reason: "Artifact grant is not redeemable" });
});

test("Ticket 13 keeps failed artifact uploads invisible", async () => {
  for (const failure of ["wrong_device", "wrong_content_type", "wrong_size", "wrong_hash", "interrupted", "expired"] as const) {
    const { files, service, setNow } = harness(failure === "expired" ? 100_000 : 10_000);
    const issued = await service.issue(intent, "https://qm.example.com/v1/desktop-browser/artifacts");
    assert.equal(issued.status, "ok");
    if (issued.status !== "ok") continue;
    if (failure === "expired") setNow(200_000);
    const substituted = Buffer.from(bytes);
    substituted[0] = substituted[0]! ^ 0xff;
    const interrupted = async function* () {
      yield bytes.subarray(0, 4);
      throw new Error("connection interrupted");
    };
    let data: Buffer | AsyncIterable<Uint8Array> = bytes;
    if (failure === "wrong_size") data = Buffer.concat([bytes, Buffer.from("x")]);
    else if (failure === "wrong_hash") data = substituted;
    else if (failure === "interrupted") data = interrupted();
    const redeemed = await service.redeem({
      bearerToken: issued.grant.bearerToken,
      deviceId: failure === "wrong_device" ? "device-2" : intent.deviceId,
      contentType: failure === "wrong_content_type" ? "text/plain" : intent.contentType,
      data,
    });
    assert.equal(redeemed.status, "refused");
    assert.equal((await files.listOwnedByScopes([projectScopeId(intent.projectId)])).files.length, 0);
  }
});

test("Ticket 13 allows only one concurrent redemption winner", async () => {
  const { files, service } = harness();
  const issued = await service.issue(intent, "https://qm.example.com/v1/desktop-browser/artifacts");
  assert.equal(issued.status, "ok");
  if (issued.status !== "ok") return;

  const results = await Promise.all([
    service.redeem({
      bearerToken: issued.grant.bearerToken,
      deviceId: intent.deviceId,
      contentType: intent.contentType,
      data: bytes,
    }),
    service.redeem({
      bearerToken: issued.grant.bearerToken,
      deviceId: intent.deviceId,
      contentType: intent.contentType,
      data: bytes,
    }),
  ]);

  assert.deepEqual(results.map((result) => result.status).sort(), ["ok", "refused"]);
  assert.equal((await files.listOwnedByScopes([projectScopeId(intent.projectId)])).files.length, 1);
});

test("Ticket 13 refuses an upload whose grant expires while bytes are arriving", async () => {
  const { files, service, setNow } = harness();
  const issued = await service.issue(intent, "https://qm.example.com/v1/desktop-browser/artifacts");
  assert.equal(issued.status, "ok");
  if (issued.status !== "ok") return;
  const slowUpload = async function* () {
    yield bytes.subarray(0, 4);
    setNow(80_000);
    yield bytes.subarray(4);
  };

  const result = await service.redeem({
    bearerToken: issued.grant.bearerToken,
    deviceId: intent.deviceId,
    contentType: intent.contentType,
    data: slowUpload(),
  });

  assert.deepEqual(result, { status: "refused", reason: "Artifact grant expired during upload" });
  assert.equal((await files.listOwnedByScopes([projectScopeId(intent.projectId)])).files.length, 0);
});
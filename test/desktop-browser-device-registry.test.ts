import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import { buildDesktopBrowserSessionStartArgv, computeDesktopBrowserRequestHash } from "qm-desktop-browser-contracts";
import {
  createDesktopBrowserDeviceRegistry,
  type DesktopBrowserConfirmMutationPoint,
  type DesktopBrowserDeviceRegistry,
} from "../src/desktop-browser/device-registry.ts";
import type { DesktopBrowserPreparedSessionStartOperation } from "../src/desktop-browser/browser-task-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

type Reserved = Awaited<ReturnType<DesktopBrowserDeviceRegistry["reserve"]>>;

function createKeyMaterial(): { devicePublicKey: string; signEnvelope: (payload: Uint8Array<ArrayBuffer>) => string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "der", type: "spki" });
  return {
    devicePublicKey: `ed25519:${Buffer.from(exported).toString("base64")}`,
    signEnvelope: (payload) => Buffer.from(sign(null, Buffer.from(payload), privateKey)).toString("base64"),
  };
}

function createRegistry(now = 1_725_000_000_000): {
  registry: DesktopBrowserDeviceRegistry;
  tick: (ms: number) => void;
} {
  let current = now;
  return {
    registry: createDesktopBrowserDeviceRegistry(
      {
        state: createMemoryMap(),
      },
      {
        deploymentCanonicalId: "qm://deployments/example",
        now: () => current,
      },
    ),
    tick: (ms) => {
      current += ms;
    },
  };
}

function assertReserved(result: Reserved): Extract<Reserved, { status: "ok" }> {
  assert.equal(result.status, "ok");
  return result;
}

function confirmationEnvelope(
  reservation: Extract<Reserved, { status: "ok" }>["reservation"],
  signEnvelope: (payload: Uint8Array<ArrayBuffer>) => string,
) {
  return {
    registrationTuple: reservation.registrationTuple,
    publicIdentity: reservation.publicIdentity,
    confirmationFingerprint: reservation.confirmationFingerprint,
    signatureAlgorithm: "ed25519" as const,
    signature: signEnvelope(reservation.verificationBytes),
  };
}

test("reserve returns canonical tuple material and challenge binding without replacing the current projected device", async () => {
  const { registry } = createRegistry();
  const { devicePublicKey } = createKeyMaterial();
  const reserved = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );

  assert.equal(reserved.reservation.registrationTuple.registrationProtocolVersion, "1.0");
  assert.match(reserved.reservation.registrationTuple.registrationId, /^reg-[0-9a-f]{32}$/);
  assert.equal(reserved.reservation.registrationTuple.actorId, "owner");
  assert.equal(reserved.reservation.registrationTuple.originatingProjectId, "project-1");
  assert.equal(reserved.reservation.registrationTuple.membershipEpoch, 42);
  assert.equal(reserved.reservation.registrationTuple.devicePublicKey, devicePublicKey);
  assert.equal(reserved.reservation.registrationTuple.brokerInstanceId, "broker-1");
  assert.equal(reserved.reservation.registrationTuple.browserInstanceId, "browser-1");
  assert.equal(reserved.reservation.registrationTuple.connectionEpoch, 7);
  assert.equal(reserved.reservation.publicIdentity.devicePublicKey, devicePublicKey);
  assert.equal(reserved.reservation.publicDeviceFingerprint.length, 16);
  assert.equal(reserved.reservation.confirmationFingerprint.length, 16);
  assert.equal(reserved.reservation.registrationTuple.expiresAt, "2024-08-30T06:45:00.000Z");
  assert.deepEqual(await registry.challengeBinding(reserved.reservation.registrationTuple.registrationId), {
    registrationId: reserved.reservation.registrationTuple.registrationId,
    devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    expiresAt: "2024-08-30T06:45:00.000Z",
  });
  assert.equal(await registry.projectProjection("project-1"), null);
});

test("confirm verifies the shared canonical bytes with Ed25519, spends the reservation once, and rejects reserve-after-confirm reuse", async () => {
  const { registry, tick } = createRegistry();
  const { devicePublicKey, signEnvelope } = createKeyMaterial();
  const reserved = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );

  const confirmed = await registry.confirm({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reserved.reservation, signEnvelope),
  });
  assert.equal(confirmed.status, "ok");
  assert.deepEqual(confirmed.device, {
    sharedProfileMode: "deployment_shared_browser_principal",
    device: {
      publicDeviceFingerprint: reserved.reservation.publicDeviceFingerprint,
      browserInstanceId: "browser-1",
      operatingSystem: "macos-arm64",
      status: "online",
      browserRuntimeStatus: "ready",
      lastSeenAt: "2024-08-30T06:40:00.000Z",
    },
  });

  const spent = await registry.confirm({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reserved.reservation, signEnvelope),
  });
  assert.deepEqual(spent, { status: "refused", reason: "registration is no longer pending" });

  const duplicateReserve = await registry.reserve({
    waitingTaskId: "task-1",
    actorId: "owner",
    projectId: "project-1",
    membershipEpoch: 42,
    authorityId: "authority-1",
    authorityExpiresAt: 1_725_000_600_000,
    devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-2",
    connectionEpoch: 8,
    operatingSystem: "macos-arm64",
  });
  assert.deepEqual(duplicateReserve, {
    status: "refused",
    reason: "desktop browser task already confirmed a device",
  });

  tick(5 * 60_000 + 1);
  assert.equal(await registry.challengeBinding(reserved.reservation.registrationTuple.registrationId), null);
});

test("duplicate reserve for the same tuple is deterministic and one-time even under concurrency", async () => {
  const { registry } = createRegistry();
  const { devicePublicKey } = createKeyMaterial();
  const reserveInput = {
    waitingTaskId: "task-1",
    actorId: "owner",
    projectId: "project-1",
    membershipEpoch: 42,
    authorityId: "authority-1",
    authorityExpiresAt: 1_725_000_600_000,
    devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  };

  const [left, right] = await Promise.all([registry.reserve(reserveInput), registry.reserve(reserveInput)]);
  const first = assertReserved(left);
  const second = assertReserved(right);
  assert.equal(first.reservation.registrationTuple.registrationId, second.reservation.registrationTuple.registrationId);
  assert.deepEqual(first.reservation, second.reservation);
});

test("replacement reserve for the same task atomically supersedes older pending or staged siblings", async () => {
  const { registry } = createRegistry();
  const first = createKeyMaterial();
  const second = createKeyMaterial();
  const reservedA = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: first.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  const staged = await registry.stageConfirmation({
    registrationId: reservedA.reservation.registrationTuple.registrationId,
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedA.reservation, first.signEnvelope),
  });
  assert.equal(staged.status, "ok");

  const reservedB = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: second.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  );

  assert.equal((await registry.get(reservedA.reservation.registrationTuple.registrationId))?.status, "offline");
  assert.equal(await registry.stagedConfirmation(reservedA.reservation.registrationTuple.registrationId), null);
  assert.equal(await registry.challengeBinding(reservedA.reservation.registrationTuple.registrationId), null);
  assert.equal(
    (await registry.taskRegistration("task-1"))?.registrationId,
    reservedB.reservation.registrationTuple.registrationId,
  );

  const staleConfirm = await registry.confirm({
    registrationId: reservedA.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedA.reservation, first.signEnvelope),
  });
  assert.deepEqual(staleConfirm, { status: "refused", reason: "registration is no longer pending" });

  const confirmed = await registry.confirm({
    registrationId: reservedB.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedB.reservation, second.signEnvelope),
  });
  assert.equal(confirmed.status, "ok");
});

test("parallel replacement reserves converge to one current reservation for the task", async () => {
  const { registry } = createRegistry();
  const first = createKeyMaterial();
  const second = createKeyMaterial();
  const [left, right] = await Promise.all([
    registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: first.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
    registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: second.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  ]);
  const reservedLeft = assertReserved(left);
  const reservedRight = assertReserved(right);
  const current = await registry.taskRegistration("task-1");
  assert.ok(current);

  const currentId = current.registrationId;
  const staleId =
    currentId === reservedLeft.reservation.registrationTuple.registrationId
      ? reservedRight.reservation.registrationTuple.registrationId
      : reservedLeft.reservation.registrationTuple.registrationId;
  assert.equal((await registry.get(currentId))?.status, "pending");
  assert.equal((await registry.get(staleId))?.status, "offline");
  assert.equal(await registry.stagedConfirmation(staleId), null);
});

test("replacement reservations must advance the connection epoch and reject same-epoch different bindings", async () => {
  const { registry } = createRegistry();
  const identity = createKeyMaterial();
  const initial = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: identity.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );

  const sameEpochDifferentBrowser = await registry.reserve({
    waitingTaskId: "task-2",
    actorId: "owner",
    projectId: "project-1",
    membershipEpoch: 43,
    authorityId: "authority-2",
    authorityExpiresAt: 1_725_000_600_000,
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-2",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });
  assert.deepEqual(sameEpochDifferentBrowser, {
    status: "refused",
    reason: "desktop browser connection epoch must advance for a replacement binding",
  });

  const lowerEpoch = await registry.reserve({
    waitingTaskId: "task-3",
    actorId: "owner",
    projectId: "project-1",
    membershipEpoch: 44,
    authorityId: "authority-3",
    authorityExpiresAt: 1_725_000_600_000,
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-3",
    connectionEpoch: 6,
    operatingSystem: "macos-arm64",
  });
  assert.deepEqual(lowerEpoch, {
    status: "refused",
    reason: "desktop browser connection epoch is stale",
  });

  assert.equal((await registry.get(initial.reservation.registrationTuple.registrationId))?.status, "pending");
});

test("a pending reservation never evicts the current online device, and a later valid confirm swaps projection and offlines the old device", async () => {
  const { registry } = createRegistry();
  const first = createKeyMaterial();
  const second = createKeyMaterial();
  const reservedA = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: first.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  const confirmedA = await registry.confirm({
    registrationId: reservedA.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedA.reservation, first.signEnvelope),
  });
  assert.equal(confirmedA.status, "ok");

  const reservedB = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-2",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 43,
      authorityId: "authority-2",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: second.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  );
  assert.deepEqual(await registry.projectProjection("project-1"), confirmedA.device);

  const confirmedB = await registry.confirm({
    registrationId: reservedB.reservation.registrationTuple.registrationId,
    authorityId: "authority-2",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedB.reservation, second.signEnvelope),
  });
  assert.equal(confirmedB.status, "ok");
  assert.deepEqual(await registry.projectProjection("project-1"), confirmedB.device);
  assert.equal((await registry.get(reservedA.reservation.registrationTuple.registrationId))?.status, "offline");
});

test("stale or rejected registration attempts leave the current online projection untouched", async () => {
  const { registry } = createRegistry();
  const current = createKeyMaterial();
  const stale = createKeyMaterial();
  const invalid = createKeyMaterial();
  const reservedCurrent = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: current.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  const confirmedCurrent = await registry.confirm({
    registrationId: reservedCurrent.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedCurrent.reservation, current.signEnvelope),
  });
  assert.equal(confirmedCurrent.status, "ok");

  const reservedStale = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-2",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 43,
      authorityId: "authority-2",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: stale.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  );
  const refused = await registry.confirm({
    registrationId: reservedStale.reservation.registrationTuple.registrationId,
    authorityId: "wrong-authority",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reservedStale.reservation, stale.signEnvelope),
  });
  assert.deepEqual(refused, { status: "refused", reason: "reservation authority is no longer current" });
  assert.deepEqual(await registry.projectProjection("project-1"), confirmedCurrent.device);
  assert.equal((await registry.get(reservedStale.reservation.registrationTuple.registrationId))?.status, "offline");

  const reservedInvalid = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-3",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 44,
      authorityId: "authority-3",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: invalid.devicePublicKey,
      brokerInstanceId: "broker-3",
      browserInstanceId: "browser-3",
      connectionEpoch: 9,
      operatingSystem: "macos-arm64",
    }),
  );
  const badSignature = await registry.confirm({
    registrationId: reservedInvalid.reservation.registrationTuple.registrationId,
    authorityId: "authority-3",
    browserRuntimeStatus: "ready",
    envelope: {
      ...confirmationEnvelope(reservedInvalid.reservation, invalid.signEnvelope),
      signature: Buffer.from("not-a-real-signature").toString("base64"),
    },
  });
  assert.deepEqual(badSignature, { status: "refused", reason: "registration signature verification failed" });
  assert.deepEqual(await registry.projectProjection("project-1"), confirmedCurrent.device);
});

test("stale offline callbacks leave the current online projection untouched", async () => {
  const { registry } = createRegistry();
  const current = createKeyMaterial();
  const reserved = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: current.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  const confirmed = await registry.confirm({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reserved.reservation, current.signEnvelope),
  });
  assert.equal(confirmed.status, "ok");

  const refused = await registry.markOffline({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 6,
  });
  assert.deepEqual(refused, { status: "refused", reason: "registration connection is no longer current" });
  assert.deepEqual(await registry.projectProjection("project-1"), confirmed.device);
});

test("offline fencing still marks the current device offline after authority expiry when the connection tuple still matches", async () => {
  const { registry, tick } = createRegistry();
  const current = createKeyMaterial();
  const reserved = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_000_100,
      devicePublicKey: current.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  const confirmed = await registry.confirm({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    authorityId: "authority-1",
    browserRuntimeStatus: "ready",
    envelope: confirmationEnvelope(reserved.reservation, current.signEnvelope),
  });
  assert.equal(confirmed.status, "ok");

  tick(200);
  const offline = await registry.markOffline({
    registrationId: reserved.reservation.registrationTuple.registrationId,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
  });
  assert.equal(offline.status, "ok");
  assert.equal(offline.device.device.status, "offline");
  assert.equal((await registry.get(reserved.reservation.registrationTuple.registrationId))?.status, "offline");
});

test("validated session-start authority refuses a bind after a stale pre-read loses the project head", async () => {
  const { registry } = createRegistry(Date.parse("2026-08-27T12:00:00.000Z"));
  const first = createKeyMaterial();
  const second = createKeyMaterial();
  const reserveOne = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: Date.parse("2026-08-27T12:01:00.000Z"),
      devicePublicKey: first.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  assert.equal(
    (
      await registry.confirm({
        registrationId: reserveOne.reservation.registrationTuple.registrationId,
        authorityId: "authority-1",
        browserRuntimeStatus: "ready",
        envelope: confirmationEnvelope(reserveOne.reservation, first.signEnvelope),
      })
    ).status,
    "ok",
  );
  await registry.publishRelayConnection({
    connectionId: "connection-1",
    publicDeviceFingerprint: reserveOne.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    registrationState: "registered",
    protocolVersion: "1.2",
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-1",
    lastSeenAt: "2026-08-27T12:00:00.000Z",
  });

  const stale = await registry.sessionStartAuthorityState("task-1");
  assert.equal(stale.status, "ok");
  if (stale.status !== "ok") return;

  const authority = {
    authorityVersion: "1.0" as const,
    audience: "qm-desktop-broker-relay" as const,
    deploymentCanonicalId: stale.authority.registration.deploymentCanonicalId,
    actorId: stale.authority.registration.actorId,
    actorSnapshotHash: "sha256:actor-snapshot-1",
    projectId: stale.authority.registration.projectId,
    projectSnapshotHash: "sha256:project-snapshot-1",
    membershipEpoch: stale.authority.registration.membershipEpoch,
    taskId: stale.authority.registration.waitingTaskId,
    attemptId: "attempt-1",
    deviceId: stale.authority.registration.publicDeviceFingerprint,
    browserInstanceId: stale.authority.registration.browserInstanceId,
    leaseId: "lease-1",
    leaseVersion: 1,
    leaseExpiresAt: "2026-08-27T12:01:00.000Z",
    operationId: "operation-1",
    operationSequence: 1,
    capabilitySet: {
      protocolVersion: stale.authority.relayConnection.protocolVersion as `${number}.${number}`,
      policyGrammarVersion: stale.authority.relayConnection.policyGrammarVersion as `${number}.${number}`,
      bskVersion: stale.authority.relayConnection.bskVersion,
      extensionVersion: stale.authority.relayConnection.extensionVersion,
      cliShapeHash: stale.authority.relayConnection.cliShapeHash,
    },
    argv: buildDesktopBrowserSessionStartArgv(stale.authority.registration.browserInstanceId),
    brokerOptions: { forceSharedRuntime: false },
    effectClass: "local_effect" as const,
    nonce: "nonce-1",
    issuedAt: "2026-08-27T12:00:00.000Z",
  };
  const operation = {
    authority,
    requestHash: computeDesktopBrowserRequestHash(
      authority,
      stale.authority.relayConnection.protocolVersion,
      stale.authority.relayConnection.policyGrammarVersion,
    ),
  } satisfies DesktopBrowserPreparedSessionStartOperation;

  const reserveTwo = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-2",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 43,
      authorityId: "authority-2",
      authorityExpiresAt: Date.parse("2026-08-27T12:01:00.000Z"),
      devicePublicKey: second.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  );
  assert.equal(
    (
      await registry.confirm({
        registrationId: reserveTwo.reservation.registrationTuple.registrationId,
        authorityId: "authority-2",
        browserRuntimeStatus: "ready",
        envelope: confirmationEnvelope(reserveTwo.reservation, second.signEnvelope),
      })
    ).status,
    "ok",
  );
  await registry.publishRelayConnection({
    connectionId: "connection-2",
    publicDeviceFingerprint: reserveTwo.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-2",
    browserInstanceId: "browser-2",
    connectionEpoch: 8,
    registrationState: "registered",
    protocolVersion: "1.2",
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-1",
    lastSeenAt: "2026-08-27T12:00:01.000Z",
  });

  let callbackCalls = 0;
  const validated = await registry.withValidatedSessionStartAuthority("task-1", operation, async () => {
    callbackCalls += 1;
    return { status: "ok" as const };
  });

  assert.deepEqual(validated, {
    status: "refused",
    reason: "Desktop Browser Relay connection is no longer bound to the registered device",
  });
  assert.equal(callbackCalls, 0);
});

test("confirm faults at each former boundary roll back atomically so retry can still install the device", async () => {
  const points: DesktopBrowserConfirmMutationPoint[] = [
    "afterTaskClaimWrite",
    "afterCurrentRegistrationInstall",
    "afterProjectHeadInstall",
    "afterSiblingReservationInvalidate",
  ];

  for (const point of points) {
    let current = 1_725_000_000_000;
    let armed = true;
    const device = createKeyMaterial();
    const registry = createDesktopBrowserDeviceRegistry(
      { state: createMemoryMap() },
      {
        deploymentCanonicalId: "qm://deployments/example",
        now: () => current,
        onConfirmMutation: (candidate) => {
          if (armed && candidate === point) throw new Error(`fault:${point}`);
        },
      },
    );
    const reserved = assertReserved(
      await registry.reserve({
        waitingTaskId: `task-${point}`,
        actorId: "owner",
        projectId: `project-${point}`,
        membershipEpoch: 42,
        authorityId: "authority-1",
        authorityExpiresAt: current + 60_000,
        devicePublicKey: device.devicePublicKey,
        brokerInstanceId: "broker-1",
        browserInstanceId: "browser-1",
        connectionEpoch: 7,
        operatingSystem: "macos-arm64",
      }),
    );

    await assert.rejects(
      registry.confirm({
        registrationId: reserved.reservation.registrationTuple.registrationId,
        authorityId: "authority-1",
        browserRuntimeStatus: "ready",
        envelope: confirmationEnvelope(reserved.reservation, device.signEnvelope),
      }),
      new RegExp(`fault:${point}`),
    );

    assert.equal(await registry.projectProjection(`project-${point}`), null);
    assert.equal((await registry.get(reserved.reservation.registrationTuple.registrationId))?.status, "pending");

    armed = false;
    current += 1;
    const retried = await registry.confirm({
      registrationId: reserved.reservation.registrationTuple.registrationId,
      authorityId: "authority-1",
      browserRuntimeStatus: "ready",
      envelope: confirmationEnvelope(reserved.reservation, device.signEnvelope),
    });
    assert.equal(retried.status, "ok");
    assert.equal(retried.device.device.status, "online");
  }
});

test("validated session-start authority holds the registry lock until the bind decision finishes so rotation cannot interleave", async () => {
  const { registry } = createRegistry();
  const first = createKeyMaterial();
  const second = createKeyMaterial();
  const reserveOne = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: Date.parse("2026-08-27T12:01:00.000Z"),
      devicePublicKey: first.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  assert.equal(
    (
      await registry.confirm({
        registrationId: reserveOne.reservation.registrationTuple.registrationId,
        authorityId: "authority-1",
        browserRuntimeStatus: "ready",
        envelope: confirmationEnvelope(reserveOne.reservation, first.signEnvelope),
      })
    ).status,
    "ok",
  );
  await registry.publishRelayConnection({
    connectionId: "connection-1",
    publicDeviceFingerprint: reserveOne.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    registrationState: "registered",
    protocolVersion: "1.2",
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-1",
    lastSeenAt: "2026-08-27T12:00:00.000Z",
  });

  const current = await registry.sessionStartAuthorityState("task-1");
  assert.equal(current.status, "ok");
  if (current.status !== "ok") return;

  const authority = {
    authorityVersion: "1.0" as const,
    audience: "qm-desktop-broker-relay" as const,
    deploymentCanonicalId: current.authority.registration.deploymentCanonicalId,
    actorId: current.authority.registration.actorId,
    actorSnapshotHash: "sha256:actor-snapshot-1",
    projectId: current.authority.registration.projectId,
    projectSnapshotHash: "sha256:project-snapshot-1",
    membershipEpoch: current.authority.registration.membershipEpoch,
    taskId: current.authority.registration.waitingTaskId,
    attemptId: "attempt-1",
    deviceId: current.authority.registration.publicDeviceFingerprint,
    browserInstanceId: current.authority.registration.browserInstanceId,
    leaseId: "lease-1",
    leaseVersion: 1,
    leaseExpiresAt: "2026-08-27T12:01:00.000Z",
    operationId: "operation-1",
    operationSequence: 1,
    capabilitySet: {
      protocolVersion: current.authority.relayConnection.protocolVersion as `${number}.${number}`,
      policyGrammarVersion: current.authority.relayConnection.policyGrammarVersion as `${number}.${number}`,
      bskVersion: current.authority.relayConnection.bskVersion,
      extensionVersion: current.authority.relayConnection.extensionVersion,
      cliShapeHash: current.authority.relayConnection.cliShapeHash,
    },
    argv: buildDesktopBrowserSessionStartArgv(current.authority.registration.browserInstanceId),
    brokerOptions: { forceSharedRuntime: false },
    effectClass: "local_effect" as const,
    nonce: "nonce-1",
    issuedAt: "2026-08-27T12:00:00.000Z",
  };
  const operation = {
    authority,
    requestHash: computeDesktopBrowserRequestHash(
      authority,
      current.authority.relayConnection.protocolVersion,
      current.authority.relayConnection.policyGrammarVersion,
    ),
  } satisfies DesktopBrowserPreparedSessionStartOperation;

  const reserveTwo = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-2",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 43,
      authorityId: "authority-2",
      authorityExpiresAt: Date.parse("2026-08-27T12:01:00.000Z"),
      devicePublicKey: second.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  );

  let releaseBind!: () => void;
  const bindStarted = new Promise<void>((resolve) => {
    releaseBind = resolve;
  });
  let bindEntered = false;
  const validated = registry.withValidatedSessionStartAuthority("task-1", operation, async () => {
    bindEntered = true;
    await bindStarted;
    return { status: "ok" as const };
  });

  while (!bindEntered) {
    await Promise.resolve();
  }

  let rotationCompleted = false;
  const rotation = (async () => {
    const confirmed = await registry.confirm({
      registrationId: reserveTwo.reservation.registrationTuple.registrationId,
      authorityId: "authority-2",
      browserRuntimeStatus: "ready",
      envelope: confirmationEnvelope(reserveTwo.reservation, second.signEnvelope),
    });
    if (confirmed.status !== "ok") return confirmed;
    await registry.publishRelayConnection({
      connectionId: "connection-2",
      publicDeviceFingerprint: reserveTwo.reservation.publicDeviceFingerprint,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      registrationState: "registered",
      protocolVersion: "1.2",
      policyGrammarVersion: "1.0",
      brokerVersion: "2.0.0",
      bskVersion: "3.0.0",
      extensionVersion: "4.0.0",
      cliShapeHash: "sha256:cli-shape-1",
      lastSeenAt: "2026-08-27T12:00:01.000Z",
    });
    rotationCompleted = true;
    return confirmed;
  })();

  await Promise.resolve();
  await Promise.resolve();
  assert.equal(rotationCompleted, false);

  releaseBind();
  assert.deepEqual(await validated, { status: "ok" });
  assert.equal((await rotation).status, "ok");
  assert.equal(rotationCompleted, true);
  assert.deepEqual(await registry.sessionStartAuthorityState("task-1"), {
    status: "refused",
    reason: "Desktop Browser Relay connection is no longer bound to the registered device",
  });
});

test("parallel reservations race through a task-scoped CAS and only one confirmation wins", async () => {
  const { registry } = createRegistry();
  const first = createKeyMaterial();
  const second = createKeyMaterial();
  const reservedA = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: first.devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    }),
  );
  const reservedB = assertReserved(
    await registry.reserve({
      waitingTaskId: "task-1",
      actorId: "owner",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: 1_725_000_600_000,
      devicePublicKey: second.devicePublicKey,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    }),
  );

  const [left, right] = await Promise.all([
    registry.confirm({
      registrationId: reservedA.reservation.registrationTuple.registrationId,
      authorityId: "authority-1",
      browserRuntimeStatus: "ready",
      envelope: confirmationEnvelope(reservedA.reservation, first.signEnvelope),
    }),
    registry.confirm({
      registrationId: reservedB.reservation.registrationTuple.registrationId,
      authorityId: "authority-1",
      browserRuntimeStatus: "ready",
      envelope: confirmationEnvelope(reservedB.reservation, second.signEnvelope),
    }),
  ]);

  const wins = [left, right].filter((result) => result.status === "ok");
  const losses = [left, right].filter((result) => result.status === "refused");
  assert.equal(wins.length, 1);
  assert.equal(losses.length, 1);
  assert.deepEqual(await registry.projectProjection("project-1"), wins[0]?.device ?? null);
  assert.equal(
    (await registry.get(reservedA.reservation.registrationTuple.registrationId))?.status === "online" ||
      (await registry.get(reservedB.reservation.registrationTuple.registrationId))?.status === "online",
    true,
  );
  assert.equal(
    (await registry.get(reservedA.reservation.registrationTuple.registrationId))?.status === "offline" ||
      (await registry.get(reservedB.reservation.registrationTuple.registrationId))?.status === "offline",
    true,
  );
});

import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { buildApp } from "../src/wiring.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "desktop-browser-registration-route-secret".repeat(2);

function reservePath(taskId: string): string {
  return `/v1/desktop-browser/tasks/${taskId}/registration-reservations`;
}

function confirmPath(registrationId: string): string {
  return `/v1/desktop-browser/registrations/${registrationId}/confirm`;
}

function stagePath(registrationId: string): string {
  return `/v1/desktop-browser/registrations/${registrationId}/confirmation-envelope`;
}

function offlinePath(registrationId: string): string {
  return `/v1/desktop-browser/registrations/${registrationId}/offline`;
}

function signed(
  method: string,
  path: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(SECRET, ts, `${method}\n${path}\n${body}`),
  };
}

function assertReservation(json: unknown): {
  registrationTuple: Record<string, unknown>;
  publicIdentity: Record<string, unknown>;
  confirmationFingerprint: string;
  verificationBytesBase64: string;
} {
  assert.ok(json && typeof json === "object");
  assert.ok("reservation" in json);
  const reservation = (json as { reservation: unknown }).reservation;
  assert.ok(reservation && typeof reservation === "object");
  assert.ok("registrationTuple" in reservation);
  assert.ok("publicIdentity" in reservation);
  assert.ok("confirmationFingerprint" in reservation);
  assert.ok("verificationBytesBase64" in reservation);
  return reservation as {
    registrationTuple: Record<string, unknown>;
    publicIdentity: Record<string, unknown>;
    confirmationFingerprint: string;
    verificationBytesBase64: string;
  };
}

async function openWaitingTask(
  built: ReturnType<typeof buildApp>,
  actorId = "owner",
): Promise<{ projectId: string; taskId: string; authorityId: string }> {
  const project = await built.app.createProject(actorId, "Registration Project");
  assert.ok(project);
  const turn = await built.app.turn({
    surface: "web",
    actor: { externalId: actorId, displayName: actorId === "owner" ? "Owner" : "Alice" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: `web:${actorId}:desktop-browser-registration`,
      audience: [],
    },
    text: "/desktop-browser open the browser",
  });
  const taskId = turn.desktopBrowserActivity?.taskId;
  const authorityId = turn.desktopBrowserActivity?.actionAuthority;
  assert.ok(taskId);
  assert.ok(authorityId);
  return { projectId: project.id, taskId: taskId!, authorityId: authorityId! };
}

test("signed reservation and confirmation routes publish the shared-profile projection without exposing the raw device key", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const { taskId, authorityId } = await openWaitingTask(built);

  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;

    const reserveBody = JSON.stringify({
      authorityId,
      devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const reserve = await fetch(`${base}${reservePath(taskId!)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId!), reserveBody),
      body: reserveBody,
    });
    assert.equal(reserve.status, 200);
    const reserved = (await reserve.json()) as {
      reservation: {
        registrationTuple: Record<string, unknown>;
        publicIdentity: Record<string, unknown>;
        confirmationFingerprint: string;
        verificationBytesBase64: string;
      };
    };
    const signature = Buffer.from(
      sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
    ).toString("base64");

    const stageBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reserved.reservation.registrationTuple,
        publicIdentity: reserved.reservation.publicIdentity,
        confirmationFingerprint: reserved.reservation.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature,
      },
    });
    const stage = await fetch(`${base}${stagePath(String(reserved.reservation.registrationTuple.registrationId))}`, {
      method: "POST",
      headers: signed("POST", stagePath(String(reserved.reservation.registrationTuple.registrationId)), stageBody),
      body: stageBody,
    });
    assert.equal(stage.status, 200);

    const confirmBody = JSON.stringify({
      principalId: "owner",
      taskId,
      authorityId,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    });
    const confirm = await fetch(
      `${base}${confirmPath(String(reserved.reservation.registrationTuple.registrationId))}`,
      {
        method: "POST",
        headers: signed(
          "POST",
          confirmPath(String(reserved.reservation.registrationTuple.registrationId)),
          confirmBody,
        ),
        body: confirmBody,
      },
    );
    assert.equal(confirm.status, 200);

    const projects = await fetch(`${base}/v1/projects?principalId=owner`, {
      headers: signed("GET", "/v1/projects?principalId=owner", ""),
    });
    assert.equal(projects.status, 200);
    const body = (await projects.json()) as {
      projects: Array<{
        id: string;
        desktopBrowser?: {
          sharedProfileMode: string;
          device: Record<string, unknown>;
        };
      }>;
    };
    assert.deepEqual(body.projects[0]?.desktopBrowser, {
      sharedProfileMode: "deployment_shared_browser_principal",
      device: {
        publicDeviceFingerprint: body.projects[0]?.desktopBrowser?.device.publicDeviceFingerprint,
        browserInstanceId: "browser-1",
        operatingSystem: "macos-arm64",
        status: "online",
        browserRuntimeStatus: "ready",
        lastSeenAt: body.projects[0]?.desktopBrowser?.device.lastSeenAt,
      },
    });
    assert.equal("devicePublicKey" in (body.projects[0]?.desktopBrowser?.device ?? {}), false);
    assert.equal("registrationId" in (body.projects[0]?.desktopBrowser?.device ?? {}), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reserve and confirm both trust source-auth signatures", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-auth-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const { taskId, authorityId } = await openWaitingTask(built);
  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;
    const reserveBody = JSON.stringify({
      authorityId,
      devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const forgedReserve = await fetch(`${base}${reservePath(taskId)}`, {
      method: "POST",
      headers: { ...signed("POST", reservePath(taskId), reserveBody), "x-signature": "v0=deadbeef" },
      body: reserveBody,
    });
    assert.equal(forgedReserve.status, 401);

    const reserve = await fetch(`${base}${reservePath(taskId)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId), reserveBody),
      body: reserveBody,
    });
    assert.equal(reserve.status, 200);
    const reserved = (await reserve.json()) as {
      reservation: {
        registrationTuple: Record<string, unknown>;
        publicIdentity: Record<string, unknown>;
        confirmationFingerprint: string;
        verificationBytesBase64: string;
      };
    };
    const stageBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reserved.reservation.registrationTuple,
        publicIdentity: reserved.reservation.publicIdentity,
        confirmationFingerprint: reserved.reservation.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
        ).toString("base64"),
      },
    });
    const stageRoute = stagePath(String(reserved.reservation.registrationTuple.registrationId));
    const forgedConfirm = await fetch(`${base}${stageRoute}`, {
      method: "POST",
      headers: { ...signed("POST", stageRoute, stageBody), "x-signature": "v0=deadbeef" },
      body: stageBody,
    });
    assert.equal(forgedConfirm.status, 401);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("reserve rejects an invalid Ed25519 public key", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-key-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const { taskId, authorityId } = await openWaitingTask(built);
  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const reserveBody = JSON.stringify({
      authorityId,
      devicePublicKey: "ed25519:not-base64-spki",
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const reserve = await fetch(`${base}${reservePath(taskId)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId), reserveBody),
      body: reserveBody,
    });
    assert.equal(reserve.status, 409);
    assert.deepEqual(await reserve.json(), {
      error: "conflict",
      message: "device public key is invalid",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("confirm rejects duplicate delivery, and offline fencing still works after membership drift for the matching device epoch", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-drift-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "alice", displayName: "Alice", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Registration Project");
  assert.ok(project);
  assert.equal((await built.projects.addMember(project.id, "owner", "alice")).status, "ok");
  const turn = await built.app.turn({
    surface: "web",
    actor: { externalId: "alice", displayName: "Alice" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:alice:desktop-browser-registration",
      audience: [],
    },
    text: "/desktop-browser open the browser",
  });
  const taskId = turn.desktopBrowserActivity?.taskId;
  const authorityId = turn.desktopBrowserActivity?.actionAuthority;
  assert.ok(taskId);
  assert.ok(authorityId);

  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;
    const reserveBody = JSON.stringify({
      authorityId,
      devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const reserve = await fetch(`${base}${reservePath(taskId!)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId!), reserveBody),
      body: reserveBody,
    });
    assert.equal(reserve.status, 200);
    const reserved = (await reserve.json()) as {
      reservation: {
        registrationTuple: Record<string, unknown>;
        publicIdentity: Record<string, unknown>;
        confirmationFingerprint: string;
        verificationBytesBase64: string;
      };
    };
    const stageBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reserved.reservation.registrationTuple,
        publicIdentity: reserved.reservation.publicIdentity,
        confirmationFingerprint: reserved.reservation.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
        ).toString("base64"),
      },
    });
    const stageRoute = stagePath(String(reserved.reservation.registrationTuple.registrationId));
    const stage = await fetch(`${base}${stageRoute}`, {
      method: "POST",
      headers: signed("POST", stageRoute, stageBody),
      body: stageBody,
    });
    assert.equal(stage.status, 200);
    const confirmBody = JSON.stringify({
      principalId: "alice",
      taskId,
      authorityId,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    });
    const path = confirmPath(String(reserved.reservation.registrationTuple.registrationId));
    const confirmed = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, confirmBody),
      body: confirmBody,
    });
    assert.equal(confirmed.status, 200);

    const duplicate = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, confirmBody, Math.floor(Date.now() / 1000) + 1),
      body: confirmBody,
    });
    assert.equal(duplicate.status, 409);

    const projectsBefore = await fetch(`${base}/v1/projects?principalId=alice`, {
      headers: signed("GET", "/v1/projects?principalId=alice", ""),
    });
    const beforeBody = (await projectsBefore.json()) as {
      projects: Array<{ desktopBrowser?: { device: Record<string, unknown> } }>;
    };
    assert.equal(beforeBody.projects[0]?.desktopBrowser?.device.status, "online");

    assert.equal((await built.projects.removeMember(project.id, "owner", "alice")).status, "ok");
    const drifted = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, confirmBody, Math.floor(Date.now() / 1000) + 2),
      body: confirmBody,
    });
    assert.equal(drifted.status, 409);

    const projectsAfter = await fetch(`${base}/v1/projects?principalId=owner`, {
      headers: signed("GET", "/v1/projects?principalId=owner", ""),
    });
    const afterBody = (await projectsAfter.json()) as {
      projects: Array<{ desktopBrowser?: { device: Record<string, unknown> } }>;
    };
    assert.equal(afterBody.projects[0]?.desktopBrowser?.device.status, "online");

    const staleOfflineBody = JSON.stringify({
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 6,
    });
    const staleOffline = await fetch(
      `${base}${offlinePath(String(reserved.reservation.registrationTuple.registrationId))}`,
      {
        method: "POST",
        headers: signed(
          "POST",
          offlinePath(String(reserved.reservation.registrationTuple.registrationId)),
          staleOfflineBody,
        ),
        body: staleOfflineBody,
      },
    );
    assert.equal(staleOffline.status, 409);

    const projectsAfterStaleOffline = await fetch(`${base}/v1/projects?principalId=owner`, {
      headers: signed("GET", "/v1/projects?principalId=owner", ""),
    });
    const afterStaleOfflineBody = (await projectsAfterStaleOffline.json()) as {
      projects: Array<{ desktopBrowser?: { device: Record<string, unknown> } }>;
    };
    assert.equal(afterStaleOfflineBody.projects[0]?.desktopBrowser?.device.status, "online");

    const offlineBody = JSON.stringify({
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
    });
    const offline = await fetch(
      `${base}${offlinePath(String(reserved.reservation.registrationTuple.registrationId))}`,
      {
        method: "POST",
        headers: signed(
          "POST",
          offlinePath(String(reserved.reservation.registrationTuple.registrationId)),
          offlineBody,
        ),
        body: offlineBody,
      },
    );
    assert.equal(offline.status, 200);

    const projectsAfterOffline = await fetch(`${base}/v1/projects?principalId=owner`, {
      headers: signed("GET", "/v1/projects?principalId=owner", ""),
    });
    const afterOfflineBody = (await projectsAfterOffline.json()) as {
      projects: Array<{ desktopBrowser?: { device: Record<string, unknown> } }>;
    };
    assert.equal(afterOfflineBody.projects[0]?.desktopBrowser?.device.status, "offline");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("concurrent confirm delivery is deterministic at the HTTP seam and only installs one device", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-race-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const { taskId, authorityId } = await openWaitingTask(built);
  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const reserveOneBody = JSON.stringify({
      authorityId,
      devicePublicKey: `ed25519:${Buffer.from(first.publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const reserveTwoBody = JSON.stringify({
      authorityId,
      devicePublicKey: `ed25519:${Buffer.from(second.publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    });
    const [reserveOne, reserveTwo] = await Promise.all([
      fetch(`${base}${reservePath(taskId)}`, {
        method: "POST",
        headers: signed("POST", reservePath(taskId), reserveOneBody),
        body: reserveOneBody,
      }),
      fetch(`${base}${reservePath(taskId)}`, {
        method: "POST",
        headers: signed("POST", reservePath(taskId), reserveTwoBody),
        body: reserveTwoBody,
      }),
    ]);
    assert.equal(reserveOne.status, 200);
    assert.equal(reserveTwo.status, 200);
    const reservedOne = assertReservation(await reserveOne.json());
    const reservedTwo = assertReservation(await reserveTwo.json());
    const stageOneBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reservedOne.registrationTuple,
        publicIdentity: reservedOne.publicIdentity,
        confirmationFingerprint: reservedOne.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reservedOne.verificationBytesBase64, "base64"), first.privateKey),
        ).toString("base64"),
      },
    });
    const stageTwoBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reservedTwo.registrationTuple,
        publicIdentity: reservedTwo.publicIdentity,
        confirmationFingerprint: reservedTwo.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reservedTwo.verificationBytesBase64, "base64"), second.privateKey),
        ).toString("base64"),
      },
    });
    const stageOnePath = stagePath(String(reservedOne.registrationTuple.registrationId));
    const stageTwoPath = stagePath(String(reservedTwo.registrationTuple.registrationId));
    const [stageOne, stageTwo] = await Promise.all([
      fetch(`${base}${stageOnePath}`, {
        method: "POST",
        headers: signed("POST", stageOnePath, stageOneBody),
        body: stageOneBody,
      }),
      fetch(`${base}${stageTwoPath}`, {
        method: "POST",
        headers: signed("POST", stageTwoPath, stageTwoBody),
        body: stageTwoBody,
      }),
    ]);
    assert.deepEqual(
      [stageOne.status, stageTwo.status].sort((left, right) => left - right),
      [200, 409],
    );
    const stageOneAccepted = stageOne.status === 200;
    const confirmOneBody = JSON.stringify({
      principalId: "owner",
      taskId,
      authorityId,
      confirmationFingerprint: reservedOne.confirmationFingerprint,
    });
    const confirmTwoBody = JSON.stringify({
      principalId: "owner",
      taskId,
      authorityId,
      confirmationFingerprint: reservedTwo.confirmationFingerprint,
    });
    const confirmOnePath = confirmPath(String(reservedOne.registrationTuple.registrationId));
    const confirmTwoPath = confirmPath(String(reservedTwo.registrationTuple.registrationId));
    const [confirmOne, confirmTwo] = await Promise.all([
      fetch(`${base}${confirmOnePath}`, {
        method: "POST",
        headers: signed("POST", confirmOnePath, confirmOneBody),
        body: confirmOneBody,
      }),
      fetch(`${base}${confirmTwoPath}`, {
        method: "POST",
        headers: signed("POST", confirmTwoPath, confirmTwoBody),
        body: confirmTwoBody,
      }),
    ]);
    assert.deepEqual(
      [confirmOne.status, confirmTwo.status].sort((left, right) => left - right),
      [200, 409],
    );
    assert.equal(confirmOne.status, stageOneAccepted ? 200 : 409);
    assert.equal(confirmTwo.status, stageOneAccepted ? 409 : 200);

    const projects = await fetch(`${base}/v1/projects?principalId=owner`, {
      headers: signed("GET", "/v1/projects?principalId=owner", ""),
    });
    assert.equal(projects.status, 200);
    const body = (await projects.json()) as {
      projects: Array<{ desktopBrowser?: { device: Record<string, unknown> } }>;
    };
    assert.equal(body.projects[0]?.desktopBrowser?.device.status, "online");
    assert.equal("devicePublicKey" in (body.projects[0]?.desktopBrowser?.device ?? {}), false);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("replacement reservations reject an old staged confirmation envelope at the route seam", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-stale-stage-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const { taskId, authorityId } = await openWaitingTask(built);
  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const first = generateKeyPairSync("ed25519");
    const second = generateKeyPairSync("ed25519");
    const reserveOneBody = JSON.stringify({
      authorityId,
      devicePublicKey: `ed25519:${Buffer.from(first.publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const reserveOne = await fetch(`${base}${reservePath(taskId)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId), reserveOneBody),
      body: reserveOneBody,
    });
    assert.equal(reserveOne.status, 200);
    const reservedOne = assertReservation(await reserveOne.json());

    const reserveTwoBody = JSON.stringify({
      authorityId,
      devicePublicKey: `ed25519:${Buffer.from(second.publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
      brokerInstanceId: "broker-2",
      browserInstanceId: "browser-2",
      connectionEpoch: 8,
      operatingSystem: "macos-arm64",
    });
    const reserveTwo = await fetch(`${base}${reservePath(taskId)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId), reserveTwoBody),
      body: reserveTwoBody,
    });
    assert.equal(reserveTwo.status, 200);
    const reservedTwo = assertReservation(await reserveTwo.json());

    const staleStageBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reservedOne.registrationTuple,
        publicIdentity: reservedOne.publicIdentity,
        confirmationFingerprint: reservedOne.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reservedOne.verificationBytesBase64, "base64"), first.privateKey),
        ).toString("base64"),
      },
    });
    const staleStagePath = stagePath(String(reservedOne.registrationTuple.registrationId));
    const staleStage = await fetch(`${base}${staleStagePath}`, {
      method: "POST",
      headers: signed("POST", staleStagePath, staleStageBody),
      body: staleStageBody,
    });
    assert.equal(staleStage.status, 409);
    assert.deepEqual(await staleStage.json(), {
      error: "conflict",
      message: "registration is no longer pending",
    });

    const currentStageBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reservedTwo.registrationTuple,
        publicIdentity: reservedTwo.publicIdentity,
        confirmationFingerprint: reservedTwo.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reservedTwo.verificationBytesBase64, "base64"), second.privateKey),
        ).toString("base64"),
      },
    });
    const currentStagePath = stagePath(String(reservedTwo.registrationTuple.registrationId));
    const currentStage = await fetch(`${base}${currentStagePath}`, {
      method: "POST",
      headers: signed("POST", currentStagePath, currentStageBody),
      body: currentStageBody,
    });
    assert.equal(currentStage.status, 200);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("final confirm waits for a staged host envelope and binds the owner task and fingerprint exactly", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-registration-routes-confirm-awaits-")),
      publicWebUrl: "https://qm.example.com",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const { taskId, authorityId } = await openWaitingTask(built);
  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;

  try {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;
    const reserveBody = JSON.stringify({
      authorityId,
      devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
      operatingSystem: "macos-arm64",
    });
    const reserve = await fetch(`${base}${reservePath(taskId)}`, {
      method: "POST",
      headers: signed("POST", reservePath(taskId), reserveBody),
      body: reserveBody,
    });
    assert.equal(reserve.status, 200);
    const reserved = (await reserve.json()) as {
      reservation: {
        registrationTuple: Record<string, unknown>;
        publicIdentity: Record<string, unknown>;
        confirmationFingerprint: string;
        verificationBytesBase64: string;
      };
    };
    const path = confirmPath(String(reserved.reservation.registrationTuple.registrationId));
    const confirmBeforeStageBody = JSON.stringify({
      principalId: "owner",
      taskId,
      authorityId,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    });
    const confirmBeforeStage = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, confirmBeforeStageBody),
      body: confirmBeforeStageBody,
    });
    assert.equal(confirmBeforeStage.status, 409);
    assert.deepEqual(await confirmBeforeStage.json(), {
      error: "conflict",
      message: "waiting for local confirmation",
    });

    const stageBody = JSON.stringify({
      browserRuntimeStatus: "ready",
      envelope: {
        registrationTuple: reserved.reservation.registrationTuple,
        publicIdentity: reserved.reservation.publicIdentity,
        confirmationFingerprint: reserved.reservation.confirmationFingerprint,
        signatureAlgorithm: "ed25519",
        signature: Buffer.from(
          sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
        ).toString("base64"),
      },
    });
    const stageRoute = stagePath(String(reserved.reservation.registrationTuple.registrationId));
    const stage = await fetch(`${base}${stageRoute}`, {
      method: "POST",
      headers: signed("POST", stageRoute, stageBody),
      body: stageBody,
    });
    assert.equal(stage.status, 200);

    const wrongFingerprintBody = JSON.stringify({
      principalId: "owner",
      taskId,
      authorityId,
      confirmationFingerprint: "ffffffffffffffff",
    });
    const wrongFingerprint = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, wrongFingerprintBody),
      body: wrongFingerprintBody,
    });
    assert.equal(wrongFingerprint.status, 409);

    const wrongPrincipalBody = JSON.stringify({
      principalId: "member",
      taskId,
      authorityId,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    });
    const wrongPrincipal = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, wrongPrincipalBody),
      body: wrongPrincipalBody,
    });
    assert.equal(wrongPrincipal.status, 409);

    const confirmedBody = JSON.stringify({
      principalId: "owner",
      taskId,
      authorityId,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    });
    const confirmed = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, confirmedBody, Math.floor(Date.now() / 1000) + 1),
      body: confirmedBody,
    });
    assert.equal(confirmed.status, 200);
    const confirmedJson = (await confirmed.json()) as {
      desktopBrowserActivity?: { status?: string; actions?: string[] };
    };
    assert.equal(confirmedJson.desktopBrowserActivity?.status, "registration_confirmed");
    assert.deepEqual(confirmedJson.desktopBrowserActivity?.actions, ["cancel"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("production wiring requires durable desktop-browser registration storage", () => {
  assert.throws(
    () =>
      buildApp(
        testConfig({
          production: true,
          signingSecret: SECRET,
          publicWebUrl: "https://qm.example.com",
          databaseUrl: undefined,
        }),
      ),
    /Desktop Browser registration requires DATABASE_URL in production/,
  );
});

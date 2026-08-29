import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import {
  createDesktopBrowserArtifactGrantService,
  type DesktopBrowserArtifactGrantRecord,
} from "../src/desktop-browser/artifact-grant-service.ts";
import { createMemoryDurableByteStore } from "../src/files/durable-byte-store.ts";
import { createMemoryFileArtifactStore } from "../src/files/file-artifact-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { testConfig } from "./support/test-config.ts";
import {
  desktopBrowserRelayConnectionProjectionFixture,
  desktopBrowserSessionStartAcceptedFixture,
  desktopBrowserSessionStartCompletedResultFixture,
} from "qm-desktop-browser-contracts/fixtures";

const SECRET = "desktop-browser-relay-route-secret".repeat(2);
const GENERIC_SECRET = "generic-core-source-route-secret".repeat(2);

function signed(
  method: string,
  path: string,
  body: string,
  ts = Math.floor(Date.now() / 1000),
  secret = SECRET,
): Record<string, string> {
  return {
    "content-type": "application/json",
    "x-timestamp": String(ts),
    "x-signature": signRequest(secret, ts, `${method}\n${path}\n${body}`),
  };
}

async function openWaitingTask(
  built: ReturnType<typeof buildApp>,
): Promise<{ projectId: string; taskId: string; authorityId: string }> {
  const project = await built.app.createProject("owner", "Relay Route Project");
  assert.ok(project);
  const turn = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-relay-routes",
      audience: [],
    },
    text: "/desktop-browser open the browser",
  });
  assert.ok(turn.desktopBrowserActivity?.taskId);
  assert.ok(turn.desktopBrowserActivity?.actionAuthority);
  return {
    projectId: project.id,
    taskId: turn.desktopBrowserActivity!.taskId,
    authorityId: turn.desktopBrowserActivity!.actionAuthority,
  };
}

test("relay registry routes resolve pending bindings and accept low-sensitivity connection projections", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-relay-routes-")),
      publicWebUrl: "https://qm.example.test",
      signingSecret: SECRET,
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const { taskId, authorityId } = await openWaitingTask(built);
  const { publicKey } = generateKeyPairSync("ed25519");
  const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;
  const reserve = await built.app.desktopBrowserReserveRegistration(taskId, authorityId, {
    devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });
  assert.equal(reserve.status, "ok");

  const server = createServer(built.app, {
    signingSecret: GENERIC_SECRET,
    desktopBrowserRelaySourceAuthSecret: SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const resolvePath = "/v1/desktop-browser/relay/bindings/resolve";
    const resolveBody = JSON.stringify({
      devicePublicKey,
      brokerInstanceId: "broker-1",
    });
    const genericResponse = await fetch(`${base}${resolvePath}`, {
      method: "POST",
      headers: signed("POST", resolvePath, resolveBody, Math.floor(Date.now() / 1000), GENERIC_SECRET),
      body: resolveBody,
    });
    assert.equal(genericResponse.status, 401);
    const bindingResponse = await fetch(`${base}${resolvePath}`, {
      method: "POST",
      headers: signed("POST", resolvePath, resolveBody),
      body: resolveBody,
    });
    assert.equal(bindingResponse.status, 200);
    assert.deepEqual(await bindingResponse.json(), {
      binding: {
        registrationId: reserve.reservation.registrationTuple.registrationId,
        registrationState: "pending",
        devicePublicKey,
        brokerInstanceId: "broker-1",
        browserInstanceId: "browser-1",
        connectionEpoch: 7,
      },
    });

    const publishPath = "/v1/desktop-browser/relay/connections/connection-1";
    const publishBody = JSON.stringify({
      projection: {
        connectionId: "connection-1",
        publicDeviceFingerprint: reserve.reservation.publicDeviceFingerprint,
        brokerInstanceId: "broker-1",
        browserInstanceId: "browser-1",
        connectionEpoch: 7,
        registrationState: "pending",
        protocolVersion: "1.2",
        policyGrammarVersion: "1.1",
        brokerVersion: "0.0.0-test",
        bskVersion: "bsk-1",
        extensionVersion: "extension-1",
        cliShapeHash: "shape-1",
        lastSeenAt: "2026-08-26T12:00:00.000Z",
      },
    });
    const publishResponse = await fetch(`${base}${publishPath}`, {
      method: "PUT",
      headers: signed("PUT", publishPath, publishBody),
      body: publishBody,
    });
    assert.equal(publishResponse.status, 204);

    const clearResponse = await fetch(`${base}${publishPath}`, {
      method: "DELETE",
      headers: signed("DELETE", publishPath, ""),
    });
    assert.equal(clearResponse.status, 204);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

test("relay terminal callback route authenticates and consumes acceptance before result", async () => {
  const calls: string[] = [];
  const app = {
    async desktopBrowserConsumeRelayTerminalCallback(taskId: string, accepted: unknown, result: unknown) {
      calls.push(`accepted:${taskId}:${(accepted as { kind: string }).kind}`);
      calls.push(`result:${taskId}:${(result as { kind: string }).kind}`);
      return { status: "ok" };
    },
  };
  const server = createServer(app as any, {
    signingSecret: GENERIC_SECRET,
    desktopBrowserRelaySourceAuthSecret: SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/v1/desktop-browser/relay/callbacks/terminal";
  const body = JSON.stringify({
    taskId: "task-1",
    accepted: desktopBrowserSessionStartAcceptedFixture,
    result: desktopBrowserSessionStartCompletedResultFixture,
  });

  try {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: signed("POST", path, body),
      body,
    });
    assert.equal(response.status, 204);
    assert.deepEqual(calls, ["accepted:task-1:host.accepted", "result:task-1:host.result"]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Ticket 13 issues a source-authenticated grant and redeems bytes outside Relay WSS", async () => {
  const bytes = Buffer.from("phase-f-http-artifact", "utf8");
  const files = createMemoryFileArtifactStore(createMemoryDurableByteStore());
  const artifacts = createDesktopBrowserArtifactGrantService({
    grants: createMemoryMap<DesktopBrowserArtifactGrantRecord>(),
    files,
    validateIntent: async () => ({ status: "ok" }),
  });
  const server = createServer({} as any, {
    signingSecret: GENERIC_SECRET,
    desktopBrowserRelaySourceAuthSecret: SECRET,
    publicUrl: "https://qm.example.test",
    desktopBrowserArtifacts: artifacts,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const grantPath = "/v1/desktop-browser/relay/artifact-grants";
  const intent = {
    artifactIntentId: "artifact-http-1",
    taskId: "task-1",
    attemptId: "attempt-1",
    operationId: "operation-1",
    requestHash: "sha256:request-1",
    deviceId: "device-1",
    actorId: "actor-1",
    projectId: "project-1",
    leaseId: "lease-1",
    leaseVersion: 3,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    name: "capture.bin",
    contentType: "application/octet-stream",
    sizeBytes: bytes.length,
    expectedSha256: createHash("sha256").update(bytes).digest("hex"),
  };
  const grantBody = JSON.stringify({ intent });

  try {
    for (const malformedIntent of [
      { ...intent, expectedSha256: undefined },
      { ...intent, unexpected: true },
      { ...intent, sizeBytes: 10 * 1024 * 1024 + 1 },
    ]) {
      const malformedBody = JSON.stringify({ intent: malformedIntent });
      const malformedResponse = await fetch(`${base}${grantPath}`, {
        method: "POST",
        headers: signed("POST", grantPath, malformedBody),
        body: malformedBody,
      });
      assert.equal(malformedResponse.status, 400);
    }
    assert.deepEqual(await artifacts.records(), []);

    const issuedResponse = await fetch(`${base}${grantPath}`, {
      method: "POST",
      headers: signed("POST", grantPath, grantBody),
      body: grantBody,
    });
    assert.equal(issuedResponse.status, 200);
    const issued = (await issuedResponse.json()) as { grant: { bearerToken: string; uploadUrl: string } };
    assert.equal(issued.grant.uploadUrl, "https://qm.example.test/v1/desktop-browser/artifacts");
    assert.equal((await files.listOwnedByScopes([])).files.length, 0);

    const uploadResponse = await fetch(`${base}/v1/desktop-browser/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.grant.bearerToken}`,
        "content-type": intent.contentType,
        "x-desktop-browser-device-id": intent.deviceId,
      },
      body: bytes,
    });
    assert.equal(uploadResponse.status, 200);
    const uploaded = (await uploadResponse.json()) as { artifact: { artifactId: string; sha256: string } };
    assert.equal(uploaded.artifact.sha256, intent.expectedSha256);
    assert.ok(await files.get(uploaded.artifact.artifactId));

    const duplicate = await fetch(`${base}/v1/desktop-browser/artifacts`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.grant.bearerToken}`,
        "content-type": intent.contentType,
        "x-desktop-browser-device-id": intent.deviceId,
      },
      body: bytes,
    });
    assert.equal(duplicate.status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("relay connection publish rejects malformed projections before the durable publish path and accepts a valid strict projection", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-relay-routes-")),
      publicWebUrl: "https://qm.example.test",
      signingSecret: SECRET,
    }),
  );
  const seen: unknown[] = [];
  built.app.desktopBrowserPublishRelayConnection = async (projection) => {
    seen.push(projection);
  };

  const server = createServer(built.app, {
    signingSecret: GENERIC_SECRET,
    desktopBrowserRelaySourceAuthSecret: SECRET,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/v1/desktop-browser/relay/connections/connection-1";

  try {
    for (const body of [
      {
        projection: {
          ...desktopBrowserRelayConnectionProjectionFixture,
          connectionId: "connection-1",
          connectionEpoch: 7.5,
        },
      },
      {
        projection: {
          ...desktopBrowserRelayConnectionProjectionFixture,
          connectionId: "connection-1",
          lastSeenAt: "2026-02-30T11:59:00.000Z",
        },
      },
      {
        projection: {
          ...desktopBrowserRelayConnectionProjectionFixture,
          connectionId: " connection-1",
        },
      },
      {
        projection: {
          ...desktopBrowserRelayConnectionProjectionFixture,
          connectionId: "connection-1",
          unexpectedField: true,
        },
      },
      {
        projection: {
          ...desktopBrowserRelayConnectionProjectionFixture,
          connectionId: "connection-1",
        },
        unexpectedRootField: true,
      },
    ]) {
      const encoded = JSON.stringify(body);
      const response = await fetch(`${base}${path}`, {
        method: "PUT",
        headers: signed("PUT", path, encoded),
        body: encoded,
      });
      assert.equal(response.status, 400);
    }

    assert.equal(seen.length, 0);

    const validBody = JSON.stringify({
      projection: {
        ...desktopBrowserRelayConnectionProjectionFixture,
        connectionId: "connection-1",
        protocolVersion: "1.2",
        policyGrammarVersion: "1.1",
      },
    });
    const validResponse = await fetch(`${base}${path}`, {
      method: "PUT",
      headers: signed("PUT", path, validBody),
      body: validBody,
    });
    assert.equal(validResponse.status, 204);
    assert.deepEqual(seen, [
      {
        ...desktopBrowserRelayConnectionProjectionFixture,
        connectionId: "connection-1",
        protocolVersion: "1.2",
        policyGrammarVersion: "1.1",
      },
    ]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await built.runtime.stop();
  }
});

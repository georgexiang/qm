import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { signRequest } from "../src/auth/source-auth.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";
import { desktopBrowserRelayConnectionProjectionFixture } from "qm-desktop-browser-contracts/fixtures";

const SECRET = "desktop-browser-relay-route-secret".repeat(2);

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

  const server = createServer(built.app, { signingSecret: SECRET });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  try {
    const resolvePath = "/v1/desktop-browser/relay/bindings/resolve";
    const resolveBody = JSON.stringify({
      devicePublicKey,
      brokerInstanceId: "broker-1",
    });
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

  const server = createServer(built.app, { signingSecret: SECRET });
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

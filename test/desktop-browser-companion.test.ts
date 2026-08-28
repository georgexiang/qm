import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { AddressInfo } from "node:net";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HOST_BROKER_COMPANION_EXTENSION_ID,
  HOST_BROKER_COMPANION_ORIGIN,
  createHostBrokerCompanionServer,
  createHostBrokerLocalControl,
  listHostBrokerLocalStopReceipts,
} from "../packages/qm-host-broker/src/companion-control.ts";

test("Ticket 10 Companion status is low-sensitivity, no-store, and consumes a readiness nonce once", async () => {
  const control = createHostBrokerLocalControl({
    dataDir: mkdtempSync(join(tmpdir(), "host-broker-companion-status-")),
    processEpoch: 41,
    now: () => 12_500,
    createNonce: () => "stop-nonce-1",
  });
  control.setBrokerState({ brokerStatus: "ready", browserSkillStatus: "ready" });
  control.beginOperation({
    taskId: "secret-task-id",
    attemptId: "secret-attempt-id",
    operationId: "secret-operation-id",
    category: "browser_effect",
    startedAt: 10_000,
    cancel: async () => undefined,
  });
  const runtime = createHostBrokerCompanionServer({ control, port: 0 });
  await runtime.listen();
  const port = (runtime.server.address() as AddressInfo).port;
  const headers = {
    host: `127.0.0.1:${port}`,
    origin: HOST_BROKER_COMPANION_ORIGIN,
    "x-qm-request-id": "request-status-1",
    "x-qm-readiness-nonce": "readiness-nonce-1",
  };

  try {
    const response = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), HOST_BROKER_COMPANION_ORIGIN);
    const body = await response.json();
    assert.deepEqual(body, {
      requestId: "request-status-1",
      brokerStatus: "ready",
      browserSkillStatus: "ready",
      currentTaskPresent: true,
      operationCategory: "browser_effect",
      elapsedMs: 2_500,
      stopNonce: "stop-nonce-1",
      stopNonceExpiresAt: 42_500,
    });
    const serialized = JSON.stringify(body);
    assert.doesNotMatch(serialized, /secret-task|secret-attempt|secret-operation/);

    const replay = await fetch(`http://127.0.0.1:${port}/v1/status`, { headers });
    assert.equal(replay.status, 409);
  assert.equal(HOST_BROKER_COMPANION_EXTENSION_ID, "nciggffamocnffbemkbjefanopmelkgm");
  } finally {
    await runtime.close();
  }
});

test("Ticket 10 unpacked Companion has one fixed Chrome and Edge identity without browser-content permissions", () => {
  const root = join(import.meta.dirname, "../packages/qm-host-broker/companion");
  const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8")) as {
    manifest_version: number;
    key: string;
    permissions?: string[];
    host_permissions?: string[];
    action?: { default_popup?: string };
  };
  const digest = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest().subarray(0, 16);
  const alphabet = "abcdefghijklmnop";
  const extensionId = [...digest].map((byte) => `${alphabet[byte >> 4]}${alphabet[byte & 15]}`).join("");

  assert.equal(manifest.manifest_version, 3);
  assert.equal(extensionId, HOST_BROKER_COMPANION_EXTENSION_ID);
  assert.deepEqual(manifest.permissions ?? [], []);
  assert.deepEqual(manifest.host_permissions, ["http://127.0.0.1:32145/*"]);
  assert.equal(manifest.action?.default_popup, "popup.html");
  const serialized = JSON.stringify(manifest);
  assert.doesNotMatch(serialized, /activeTab|tabs|scripting|cookies|webRequest|<all_urls>/);
  assert.doesNotMatch(readFileSync(join(root, "popup.js"), "utf8"), /BrowserSkill|chrome\.tabs|browser\.tabs/);
});

test("Ticket 10 stale Stop nonce cannot stop a newer Task or persist the wrong receipt", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-broker-companion-stale-stop-"));
  const nonces = ["stop-nonce-old", "stop-nonce-new"];
  const canceled: string[] = [];
  const control = createHostBrokerLocalControl({
    dataDir,
    processEpoch: 42,
    now: () => 20_000,
    createNonce: () => nonces.shift()!,
  });
  control.setBrokerState({ brokerStatus: "disconnected", browserSkillStatus: "ready" });
  control.beginOperation({
    taskId: "task-old",
    attemptId: "attempt-old",
    operationId: "operation-old",
    category: "observation",
    startedAt: 19_000,
    cancel: async () => {
      canceled.push("old");
    },
  });
  const runtime = createHostBrokerCompanionServer({ control, port: 0 });
  await runtime.listen();
  const port = (runtime.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const common = { host: `127.0.0.1:${port}`, origin: HOST_BROKER_COMPANION_ORIGIN };

  try {
    const oldStatus = await fetch(`${base}/v1/status`, {
      headers: { ...common, "x-qm-request-id": "status-old", "x-qm-readiness-nonce": "readiness-old" },
    });
    const oldNonce = (await oldStatus.json() as { stopNonce: string }).stopNonce;
    control.endOperation("operation-old");
    control.beginOperation({
      taskId: "task-new",
      attemptId: "attempt-new",
      operationId: "operation-new",
      category: "browser_effect",
      startedAt: 19_500,
      cancel: async () => {
        canceled.push("new");
      },
    });

    const stale = await fetch(`${base}/v1/stop`, {
      method: "POST",
      headers: { ...common, "content-type": "application/json", "x-qm-request-id": "stop-stale" },
      body: JSON.stringify({ stopNonce: oldNonce }),
    });
    assert.equal(stale.status, 409);
    assert.deepEqual(await stale.json(), { error: "task_changed", requestId: "stop-stale" });
    assert.deepEqual(canceled, []);
    assert.deepEqual(listHostBrokerLocalStopReceipts(dataDir), []);

    const nextStatus = await fetch(`${base}/v1/status`, {
      headers: { ...common, "x-qm-request-id": "status-new", "x-qm-readiness-nonce": "readiness-new" },
    });
    const nextNonce = (await nextStatus.json() as { stopNonce: string }).stopNonce;
    const stopped = await fetch(`${base}/v1/stop`, {
      method: "POST",
      headers: { ...common, "content-type": "application/json", "x-qm-request-id": "stop-new" },
      body: JSON.stringify({ stopNonce: nextNonce }),
    });
    assert.equal(stopped.status, 202);
    assert.deepEqual(canceled, ["new"]);
    assert.deepEqual(listHostBrokerLocalStopReceipts(dataDir), [
      {
        receiptVersion: "1.0",
        receiptId: "local-stop-42-operation-new-20000",
        processEpoch: 42,
        taskId: "task-new",
        attemptId: "attempt-new",
        operationId: "operation-new",
        operationCategory: "browser_effect",
        requestedAt: 20_000,
        status: "canceled",
        origin: HOST_BROKER_COMPANION_ORIGIN,
      },
    ]);

    const replay = await fetch(`${base}/v1/stop`, {
      method: "POST",
      headers: { ...common, "content-type": "application/json", "x-qm-request-id": "stop-replay" },
      body: JSON.stringify({ stopNonce: nextNonce }),
    });
    assert.equal(replay.status, 409);
    assert.equal((await replay.json() as { error: string }).error, "task_changed");
  } finally {
    await runtime.close();
  }
});

test("Ticket 10 localhost API enforces preflight, exact Origin and Host, no credentials, JSON, and body bounds", async () => {
  const control = createHostBrokerLocalControl({
    dataDir: mkdtempSync(join(tmpdir(), "host-broker-companion-http-")),
    processEpoch: 43,
  });
  const runtime = createHostBrokerCompanionServer({ control, port: 0 });
  await runtime.listen();
  const port = (runtime.server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  const host = `127.0.0.1:${port}`;

  try {
    const preflight = await fetch(`${url}/v1/stop`, {
      method: "OPTIONS",
      headers: {
        host,
        origin: HOST_BROKER_COMPANION_ORIGIN,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type,x-qm-request-id",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), HOST_BROKER_COMPANION_ORIGIN);
    assert.equal(preflight.headers.get("access-control-allow-methods"), "GET, POST, OPTIONS");
    assert.equal(
      preflight.headers.get("access-control-allow-headers"),
      "content-type, x-qm-readiness-nonce, x-qm-request-id",
    );

    const wrongOrigin = await fetch(`${url}/v1/status`, {
      headers: {
        host,
        origin: "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "x-qm-request-id": "wrong-origin-request",
        "x-qm-readiness-nonce": "wrong-origin-nonce",
      },
    });
    assert.equal(wrongOrigin.status, 403);

    const wrongHostStatus = await new Promise<number>((resolve, reject) => {
      const req = request(`${url}/v1/status`, {
        headers: {
          host: `localhost:${port}`,
          origin: HOST_BROKER_COMPANION_ORIGIN,
          "x-qm-request-id": "wrong-host-request",
          "x-qm-readiness-nonce": "wrong-host-nonce",
        },
      }, (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode ?? 0));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(wrongHostStatus, 403);

    const credentialed = await fetch(`${url}/v1/status`, {
      headers: {
        host,
        origin: HOST_BROKER_COMPANION_ORIGIN,
        authorization: "Bearer forbidden",
        "x-qm-request-id": "credential-request",
        "x-qm-readiness-nonce": "credential-nonce",
      },
    });
    assert.equal(credentialed.status, 403);

    const nonJson = await fetch(`${url}/v1/stop`, {
      method: "POST",
      headers: { host, origin: HOST_BROKER_COMPANION_ORIGIN, "x-qm-request-id": "non-json-request" },
      body: "stop",
    });
    assert.equal(nonJson.status, 415);

    const oversized = await fetch(`${url}/v1/stop`, {
      method: "POST",
      headers: {
        host,
        origin: HOST_BROKER_COMPANION_ORIGIN,
        "content-type": "application/json",
        "x-qm-request-id": "oversized-request",
      },
      body: JSON.stringify({ stopNonce: "x".repeat(5_000) }),
    });
    assert.equal(oversized.status, 413);
  } finally {
    await runtime.close();
  }
});

test("Ticket 10 failed local cancellation keeps a requested receipt and active operation", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-broker-companion-cancel-failure-"));
  const control = createHostBrokerLocalControl({
    dataDir,
    processEpoch: 44,
    now: () => 40_000,
    createNonce: () => "cancel-failure-nonce",
  });
  control.beginOperation({
    taskId: "task-cancel-failure",
    attemptId: "attempt-cancel-failure",
    operationId: "operation-cancel-failure",
    category: "browser_effect",
    startedAt: 39_000,
    cancel: async () => {
      throw new Error("child did not exit");
    },
  });
  const status = control.status(HOST_BROKER_COMPANION_ORIGIN);

  await assert.rejects(
    control.stop(HOST_BROKER_COMPANION_ORIGIN, status.stopNonce!),
    /child did not exit/,
  );
  assert.equal(control.status(HOST_BROKER_COMPANION_ORIGIN).currentTaskPresent, true);
  assert.equal(listHostBrokerLocalStopReceipts(dataDir)[0]?.status, "requested");
});

test("Ticket 10 expired Stop nonce returns task_changed without a receipt", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-broker-companion-expired-stop-"));
  let now = 50_000;
  let canceled = false;
  const control = createHostBrokerLocalControl({
    dataDir,
    processEpoch: 45,
    now: () => now,
    createNonce: () => "expired-stop-nonce",
  });
  control.beginOperation({
    taskId: "task-expired",
    attemptId: "attempt-expired",
    operationId: "operation-expired",
    category: "observation",
    startedAt: 49_000,
    cancel: async () => {
      canceled = true;
    },
  });
  const nonce = control.status(HOST_BROKER_COMPANION_ORIGIN).stopNonce!;
  now += 30_001;

  assert.equal(await control.stop(HOST_BROKER_COMPANION_ORIGIN, nonce), "task_changed");
  assert.equal(canceled, false);
  assert.deepEqual(listHostBrokerLocalStopReceipts(dataDir), []);
});

test("Ticket 10 concurrent Stop requests cancel one operation exactly once", async () => {
  const dataDir = mkdtempSync(join(tmpdir(), "host-broker-companion-concurrent-stop-"));
  const nonces = ["concurrent-stop-one", "concurrent-stop-two"];
  let cancelCalls = 0;
  let finishCancel!: () => void;
  const cancelPending = new Promise<void>((resolve) => {
    finishCancel = resolve;
  });
  const control = createHostBrokerLocalControl({
    dataDir,
    processEpoch: 46,
    now: () => 60_000,
    createNonce: () => nonces.shift()!,
  });
  control.beginOperation({
    taskId: "task-concurrent",
    attemptId: "attempt-concurrent",
    operationId: "operation-concurrent",
    category: "browser_effect",
    startedAt: 59_000,
    cancel: async () => {
      cancelCalls += 1;
      await cancelPending;
    },
  });
  const firstNonce = control.status(HOST_BROKER_COMPANION_ORIGIN).stopNonce!;
  const secondNonce = control.status(HOST_BROKER_COMPANION_ORIGIN).stopNonce!;

  const first = control.stop(HOST_BROKER_COMPANION_ORIGIN, firstNonce);
  const second = control.stop(HOST_BROKER_COMPANION_ORIGIN, secondNonce);
  assert.equal(await second, "task_changed");
  finishCancel();
  assert.equal(await first, "stopped");
  assert.equal(cancelCalls, 1);
  assert.equal(listHostBrokerLocalStopReceipts(dataDir).length, 1);
});

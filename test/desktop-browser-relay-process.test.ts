import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
  computeDesktopBrowserRequestHash,
  encodeHostChallengeResponseSigningBytes,
  type HostChallengeResponseMessage,
  type RelayChallengeMessage,
} from "qm-desktop-browser-contracts";
import WebSocket from "ws";
import pg from "pg";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayBinding,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
} from "../packages/qm-broker-relay/src/index.ts";
import {
  CoreHttpDesktopBrowserRelayRegistryAdapter,
  createDesktopBrowserRelayRuntime,
  deliverDesktopBrowserRelayCallbacks,
  deliverDesktopBrowserLocalStopCallbacks,
  loadDesktopBrowserRelayConfig,
  waitForDesktopBrowserRelayShutdown,
} from "../packages/qm-broker-relay/src/process.ts";
import {
  createDesktopBrowserRelayServer,
  type DesktopBrowserRelayReadinessProbe,
} from "../packages/qm-broker-relay/src/server.ts";
import { canonicalPayload } from "../src/api/http.ts";
import { createSourceAuth } from "../src/auth/source-auth.ts";
import { signedRequestHeaders } from "../src/auth/source-auth-sign.ts";
import {
  createDesktopBrowserRelayOperationStore,
  createMemoryDesktopBrowserRelayOperationBacking,
} from "../packages/qm-broker-relay/src/operation-store.ts";
import {
  desktopBrowserRelayInvocationFixture,
  desktopBrowserSessionStartAcceptedFixture,
  desktopBrowserSessionStartCompletedResultFixture,
} from "../packages/desktop-browser-contracts/src/fixtures.ts";
import { createHttpDesktopBrowserRelayDispatcher } from "../src/desktop-browser/relay-dispatcher.ts";
import {
  createPostgresDesktopBrowserRelayOperationStore,
  migratePostgresDesktopBrowserRelayOperationStore,
} from "../packages/qm-broker-relay/src/operation-postgres.ts";

const POSTGRES_URL = process.env.DATABASE_URL;
const postgresSkip = POSTGRES_URL ? false : "set DATABASE_URL to run Relay PostgreSQL ownership tests";

class Probe implements DesktopBrowserRelayReadinessProbe {
  error: string | null = null;

  async check(): Promise<void> {
    if (this.error) throw new Error(this.error);
  }
}

test("Ticket 14 PostgreSQL owner claims have one monotonic concurrent winner", { skip: postgresSkip }, async () => {
  const schema = `desktop_relay_test_${process.pid}_${Date.now()}`;
  await migratePostgresDesktopBrowserRelayOperationStore({
    connectionString: POSTGRES_URL!,
    schema,
    runtimeRole: "postgres",
  });
  const store = createPostgresDesktopBrowserRelayOperationStore({ connectionString: POSTGRES_URL!, schema });
  try {
    await store.check();
    const firstClaims = await Promise.all([
      store.claimConnectionOwner({
        devicePublicKey: "device-first",
        brokerInstanceId: "broker-first",
        connectionId: "connection-first-a",
        connectionEpoch: 7,
        initialEpoch: 7,
      }),
      store.claimConnectionOwner({
        devicePublicKey: "device-first",
        brokerInstanceId: "broker-first",
        connectionId: "connection-first-b",
        connectionEpoch: 7,
        initialEpoch: 7,
      }),
    ]);
    assert.deepEqual(firstClaims.sort(), [false, true]);
    assert.equal(
      await store.claimConnectionOwner({
        devicePublicKey: "device-1",
        brokerInstanceId: "broker-1",
        connectionId: "connection-1",
        connectionEpoch: 7,
        initialEpoch: 7,
      }),
      true,
    );
    const raced = await Promise.all([
      store.claimConnectionOwner({
        devicePublicKey: "device-1",
        brokerInstanceId: "broker-1",
        connectionId: "connection-2",
        connectionEpoch: 8,
        initialEpoch: 7,
      }),
      store.claimConnectionOwner({
        devicePublicKey: "device-1",
        brokerInstanceId: "broker-1",
        connectionId: "connection-3",
        connectionEpoch: 8,
        initialEpoch: 7,
      }),
    ]);
    assert.deepEqual(raced.sort(), [false, true]);
    assert.equal((await store.connectionOwner({ devicePublicKey: "device-1", brokerInstanceId: "broker-1" }))?.connectionEpoch, 8);
  } finally {
    await store.close();
  }
});

test("Ticket 16 Relay migration scrubs historical delivered browser payloads", { skip: postgresSkip }, async () => {
  const schema = `desktop_relay_scrub_test_${process.pid}_${Date.now()}`;
  const migration = {
    connectionString: POSTGRES_URL!,
    schema,
    runtimeRole: "postgres",
  };
  await migratePostgresDesktopBrowserRelayOperationStore(migration);
  const pool = new pg.Pool({ connectionString: POSTGRES_URL! });
  try {
    await pool.query(
      `INSERT INTO ${schema}.operations(
        operation_id, attempt_id, task_id, protocol_version, operation_sequence,
        lease_version, lease_id, request_hash, state, terminal_result,
        device_id, browser_instance_id, effect_class
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      ["op-scrub", "attempt-scrub", "task-scrub", "1.2", 1, 1, "lease-scrub", "request-hash", "completed", { text: "secret observation" }, "device-scrub", "browser-primary", "browser_observation"],
    );
    await pool.query(
      `INSERT INTO ${schema}.terminal_evidence(
        operation_id, dispatch_id, result_hash, outcome, result, terminal_at
      ) VALUES ($1, $2, $3, $4, $5, $6)`,
      ["op-scrub", "dispatch-scrub", "result-hash", "completed", { text: "secret observation" }, 2],
    );
    await pool.query(
      `INSERT INTO ${schema}.callback_outbox(
        operation_id, callback_type, task_id, accepted, result, created_at, delivered_at, next_attempt_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      ["op-scrub", "terminal", "task-scrub", {}, { text: "secret observation" }, 2, 3, 2],
    );

    await migratePostgresDesktopBrowserRelayOperationStore(migration);

    const rows = await pool.query(
      `SELECT o.terminal_result, e.result AS evidence_result, c.result AS callback_result,
              e.result_hash, c.delivered_at
       FROM ${schema}.operations o
       JOIN ${schema}.terminal_evidence e USING (operation_id)
       JOIN ${schema}.callback_outbox c USING (operation_id)`,
    );
    assert.deepEqual(rows.rows, [
      {
        terminal_result: null,
        evidence_result: null,
        callback_result: null,
        result_hash: "result-hash",
        delivered_at: "3",
      },
    ]);
  } finally {
    await pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await pool.end();
  }
});

class MemoryRegistry implements DesktopBrowserRelayRegistryAdapter, DesktopBrowserRelayReadinessProbe {
  error: string | null = null;
  binding: DesktopBrowserRelayBinding | null = null;
  owner: { connectionId: string; connectionEpoch: number } | null = null;
  published: DesktopBrowserRelayProjection[] = [];
  cleared: string[] = [];

  async check(): Promise<void> {
    if (this.error) throw new Error(this.error);
  }

  async resolveBinding(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
  }): Promise<DesktopBrowserRelayBinding | null> {
    if (!this.binding) return null;
    if (this.binding.devicePublicKey !== input.devicePublicKey || this.binding.brokerInstanceId !== input.brokerInstanceId) return null;
    return this.owner
      ? { ...this.binding, connectionEpoch: this.owner.connectionEpoch, ownerConnectionId: this.owner.connectionId }
      : this.binding;
  }

  async claimConnection(input: { connectionId: string; connectionEpoch: number }): Promise<DesktopBrowserRelayBinding | null> {
    let expected = this.binding?.connectionEpoch;
    if (this.owner?.connectionId === input.connectionId) expected = this.owner.connectionEpoch;
    else if (this.owner) expected = this.owner.connectionEpoch + 1;
    if (!this.binding || input.connectionEpoch !== expected) return null;
    this.owner = { connectionId: input.connectionId, connectionEpoch: input.connectionEpoch };
    return { ...this.binding, connectionEpoch: input.connectionEpoch, ownerConnectionId: input.connectionId };
  }

  async isConnectionOwner(input: { connectionId: string; connectionEpoch: number }): Promise<boolean> {
    return this.owner?.connectionId === input.connectionId && this.owner.connectionEpoch === input.connectionEpoch;
  }

  async publishConnection(projection: DesktopBrowserRelayProjection): Promise<void> {
    this.published.push(projection);
  }

  async clearConnection(connectionId: string): Promise<void> {
    this.cleared.push(connectionId);
  }
}

function createDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;
  return {
    devicePublicKey,
    signResponse(payload: Omit<HostChallengeResponseMessage["payload"], "signatureAlgorithm" | "signature">): string {
      return Buffer.from(
        sign(
          null,
          Buffer.from(encodeHostChallengeResponseSigningBytes({ protocolVersion: "1.2", payload })),
          privateKey,
        ),
      ).toString("base64url");
    },
  };
}

function hostHello(devicePublicKey: string, brokerInstanceId: string): string {
  return JSON.stringify({
    protocolVersion: "1.7",
    kind: "host.hello",
    payload: {
      devicePublicKey,
      brokerInstanceId,
      brokerVersion: "0.0.0-test",
      supportedProtocolVersions: ["1.7", "1.2"],
      supportedPolicyGrammarVersions: ["1.1"],
      bskVersion: "bsk-1",
      extensionVersion: "extension-1",
      cliShapeHash: "shape-1",
    },
  });
}

function relayProcessEnv(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    QM_RELAY_HOST: "127.0.0.1",
    QM_RELAY_PORT: "0",
    QM_RELAY_INSTANCE_ID: "relay-a",
    QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
    QM_RELAY_CORE_API_URL: "http://127.0.0.1:8080",
    QM_RELAY_SOURCE_AUTH_SECRET: "relay-source-auth-secret-for-tests-0001",
    QM_RELAY_CORE_AUTH_SECRET: "relay-core-auth-secret-for-tests-0000001",
    QM_RELAY_DATABASE_URL: "postgres://relay:relay@127.0.0.1/qm_relay",
    ...overrides,
  };
}

function memoryOperationStore() {
  return createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking());
}

function challengeResponse(
  challenge: RelayChallengeMessage,
  devicePublicKey: string,
  signResponse: (payload: Omit<HostChallengeResponseMessage["payload"], "signatureAlgorithm" | "signature">) => string,
): string {
  const payload = {
    relayInstanceId: challenge.payload.relayInstanceId,
    deploymentCanonicalId: challenge.payload.deploymentCanonicalId,
    devicePublicKey,
    brokerInstanceId: challenge.payload.brokerInstanceId,
    browserInstanceId: challenge.payload.browserInstanceId,
    connectionEpoch: challenge.payload.connectionEpoch,
    challengeNonce: challenge.payload.challengeNonce,
  };
  return JSON.stringify({
    protocolVersion: "1.2",
    kind: "host.challenge-response",
    payload: {
      ...payload,
      signatureAlgorithm: "ed25519",
      signature: signResponse(payload),
    },
  });
}

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

test("relay adapter signs resolve, publish, and clear requests with the expected shape", async () => {
  const seen: Array<{ method: string; url: string; headers: IncomingMessage["headers"]; body: string }> = [];
  const fixedNow = 1_762_500_000_000;
  const sourceAuthSecret = "relay-source-auth-secret-for-tests-0001";
  const auth = createSourceAuth({ signingSecret: sourceAuthSecret, now: () => fixedNow });
  const core = createServer((req, res) => {
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", async () => {
      seen.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body });
      const url = new URL(req.url ?? "/", "http://core.local");
      const verified = await auth.verify({
        signature: String(req.headers["x-signature"] ?? ""),
        timestamp: Number(req.headers["x-timestamp"] ?? Number.NaN),
        body: canonicalPayload(req.method ?? "", `${url.pathname}${url.search}`, body),
        eventId: String(req.headers["x-signature"] ?? ""),
      });
      if (!verified.ok) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: verified.reason }));
        return;
      }
      if (url.pathname === "/v1/desktop-browser/relay/ready") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname === "/v1/desktop-browser/relay/bindings/resolve") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            binding: {
              registrationId: "reg-1",
              registrationState: "pending",
              devicePublicKey: "ed25519:device-public-key-abc",
              brokerInstanceId: "broker-1",
              browserInstanceId: "browser-1",
              connectionEpoch: 7,
            },
          }),
        );
        return;
      }
      res.writeHead(204);
      res.end();
    });
  });
  const base = await listen(core);
  const realDateNow = Date.now;
  const realMathRandom = Math.random;
  let randomCalls = 0;
  Date.now = () => fixedNow;
  Math.random = () => (randomCalls += 1) / 16;

  try {
    const adapter = new CoreHttpDesktopBrowserRelayRegistryAdapter({
      baseUrl: base,
      sourceAuthSecret,
    });
    await adapter.check();
    await adapter.resolveBinding({ devicePublicKey: "ed25519:device-public-key-abc", brokerInstanceId: "broker-1" });
    await adapter.resolveBinding({ devicePublicKey: "ed25519:device-public-key-abc", brokerInstanceId: "broker-1" });
    await adapter.publishConnection({
      connectionId: "connection-1",
      publicDeviceFingerprint: "fp-1",
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
    });
    await adapter.clearConnection("connection-1");

    assert.equal(seen[0]?.method, "GET");
    assert.match(String(seen[0]?.url ?? ""), /^\/v1\/desktop-browser\/relay\/ready\?_sourceAuthNonce=/);

    assert.equal(seen[1]?.method, "POST");
    assert.match(String(seen[1]?.url ?? ""), /^\/v1\/desktop-browser\/relay\/bindings\/resolve\?_sourceAuthNonce=/);
    assert.match(String(seen[2]?.url ?? ""), /^\/v1\/desktop-browser\/relay\/bindings\/resolve\?_sourceAuthNonce=/);
    assert.notEqual(seen[1]?.url, seen[2]?.url);
    assert.match(String(seen[1]?.headers["x-signature"] ?? ""), /^v0=/);
    assert.match(String(seen[2]?.headers["x-signature"] ?? ""), /^v0=/);
    assert.notEqual(seen[1]?.headers["x-signature"], seen[2]?.headers["x-signature"]);
    assert.deepEqual(JSON.parse(seen[1]!.body), {
      devicePublicKey: "ed25519:device-public-key-abc",
      brokerInstanceId: "broker-1",
    });
    assert.equal(seen[3]?.method, "PUT");
    assert.match(
      String(seen[3]?.url ?? ""),
      /^\/v1\/desktop-browser\/relay\/connections\/connection-1\?_sourceAuthNonce=/,
    );
    assert.equal(JSON.parse(seen[3]!.body).projection.connectionId, "connection-1");
    assert.equal(seen[4]?.method, "DELETE");
    assert.match(
      String(seen[4]?.url ?? ""),
      /^\/v1\/desktop-browser\/relay\/connections\/connection-1\?_sourceAuthNonce=/,
    );
    assert.equal(seen[4]?.body, "");
  } finally {
    Date.now = realDateNow;
    Math.random = realMathRandom;
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
});

test("relay server separates health from readiness and only upgrades the configured websocket path", async () => {
  const registry = new MemoryRegistry();
  const probe = new Probe();
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry,
  });
  const runtime = createDesktopBrowserRelayServer({
    host: "127.0.0.1",
    port: 0,
    path: "/relay",
    service,
    adapterReadiness: probe,
    storageReadiness: probe,
    shutdownDrainMs: 50,
  });
  await runtime.listen();
  const port = (runtime.server.address() as AddressInfo).port;

  try {
    assert.deepEqual(await fetch(`http://127.0.0.1:${port}/healthz`).then((response) => response.json()), { ok: true });
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ready.status, 200);
    probe.error = "adapter unavailable";
    const notReady = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(notReady.status, 503);
    assert.match(JSON.stringify(await notReady.json()), /adapter unavailable/);

    const wrongPath = new Promise<void>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/wrong`);
      ws.once("unexpected-response", () => resolve());
    });
    await wrongPath;

    registry.binding = {
      registrationId: "reg-1",
      registrationState: "pending",
      devicePublicKey: createDeviceIdentity().devicePublicKey,
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-1",
      connectionEpoch: 7,
    };
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await once(ws, "open");
    ws.close();
    await once(ws, "close");

    service.beginDrain();
    const draining = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(draining.status, 503);
    assert.match(JSON.stringify(await draining.json()), /draining/);
    const metrics = (await fetch(`http://127.0.0.1:${port}/metrics`).then((response) => response.json())) as {
      draining: boolean;
      healthChecks: number;
    };
    assert.equal(metrics.draining, true);
    assert.equal(metrics.healthChecks >= 1, true);
    const rejectedDuringDrain = new Promise<void>((resolve) => {
      const drainingWs = new WebSocket(`ws://127.0.0.1:${port}/relay`);
      drainingWs.once("unexpected-response", () => resolve());
    });
    await rejectedDuringDrain;
  } finally {
    await runtime.shutdown();
  }
});

test("Core dispatcher signs the bounded Relay invocation endpoint", async () => {
  const authSecret = "relay-core-auth-secret-for-tests-0000001";
  const seen: unknown[] = [];
  const consumedNonces = new Set<string>();
  const service = {
    async consumeCoreNonce(nonce: string) {
      if (consumedNonces.has(nonce)) return false;
      consumedNonces.add(nonce);
      return true;
    },
    async dispatchProjectedInvocation(input: unknown) {
      seen.push(input);
      return {
        kind: "not_accepted_or_unknown",
        dispatchId: desktopBrowserRelayInvocationFixture.payload.dispatchId,
        operationId: desktopBrowserRelayInvocationFixture.payload.authority.operationId,
        requestHash: desktopBrowserRelayInvocationFixture.payload.requestHash,
        error: { code: "host_not_accepted", message: "Host did not accept the operation" },
      };
    },
    async revokeProjectedLease(input: unknown) {
      seen.push({ revoke: input });
    },
    async projectedAttemptStatus(attemptId: string) {
      seen.push({ attemptStatus: attemptId });
      return {
        checkpoint: { attemptId, operationId: desktopBrowserRelayInvocationFixture.payload.authority.operationId, state: "terminal" },
        accepted: desktopBrowserSessionStartAcceptedFixture,
        result: desktopBrowserSessionStartCompletedResultFixture,
      };
    },
    beginDrain() {},
    isDraining() {
      return false;
    },
    metrics() {
      return { draining: false };
    },
    async drain() {},
  } as unknown as DesktopBrowserRelayService;
  const runtime = createDesktopBrowserRelayServer({
    host: "127.0.0.1",
    port: 0,
    path: "/relay",
    service,
    adapterReadiness: new Probe(),
    coreAuthSecret: authSecret,
    shutdownDrainMs: 50,
  });
  await runtime.listen();
  const port = (runtime.server.address() as AddressInfo).port;
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    const unsigned = await fetch(`${baseUrl}/v1/invocations?_sourceAuthNonce=unsigned`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(unsigned.status, 401);

    const replayBody = JSON.stringify({
      publicDeviceFingerprint: "0123456789abcdef",
      browserInstanceId: "browser-primary",
      invocation: desktopBrowserRelayInvocationFixture,
    });
    const replayPath = "/v1/invocations?_sourceAuthNonce=replay-once";
    const replayHeaders = signedRequestHeaders(authSecret, "POST", replayPath, replayBody, {
      "content-type": "application/json",
    });
    const firstSigned = await fetch(`${baseUrl}${replayPath}`, {
      method: "POST",
      headers: replayHeaders,
      body: replayBody,
    });
    assert.equal(firstSigned.status, 200);
    const replayed = await fetch(`${baseUrl}${replayPath}`, {
      method: "POST",
      headers: replayHeaders,
      body: replayBody,
    });
    assert.equal(replayed.status, 409);
    assert.deepEqual(await replayed.json(), { error: "replayed_request" });

    const dispatcher = createHttpDesktopBrowserRelayDispatcher({ baseUrl, authSecret });
    const result = await dispatcher.dispatch({
      publicDeviceFingerprint: "0123456789abcdef",
      browserInstanceId: "browser-primary",
      invocation: desktopBrowserRelayInvocationFixture,
    });
    assert.equal(result.kind, "not_accepted_or_unknown");
    const attemptStatus = await dispatcher.attemptStatus(
      desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
    );
    assert.equal(attemptStatus?.checkpoint.state, "terminal");
    assert.equal(attemptStatus?.result?.payload.resultHash, desktopBrowserSessionStartCompletedResultFixture.payload.resultHash);
    await dispatcher.revoke({
      publicDeviceFingerprint: "0123456789abcdef",
      browserInstanceId: "browser-primary",
      taskId: "task-1",
      attemptId: "attempt-1",
      leaseId: "lease-1",
      leaseVersion: 4,
    });
    assert.deepEqual(seen, [
      {
        publicDeviceFingerprint: "0123456789abcdef",
        browserInstanceId: "browser-primary",
        invocation: desktopBrowserRelayInvocationFixture,
      },
      {
        publicDeviceFingerprint: "0123456789abcdef",
        browserInstanceId: "browser-primary",
        invocation: desktopBrowserRelayInvocationFixture,
      },
      {
        attemptStatus: desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
      },
      {
        revoke: {
          publicDeviceFingerprint: "0123456789abcdef",
          browserInstanceId: "browser-primary",
          taskId: "task-1",
          attemptId: "attempt-1",
          leaseId: "lease-1",
          leaseVersion: 4,
        },
      },
    ]);
  } finally {
    await runtime.shutdown();
  }
});

test("Core Relay dispatcher rejects unsafe URLs, crossed responses, redirects, and oversized bodies", async () => {
  const authSecret = "relay-core-auth-secret-for-tests-0000001";
  for (const baseUrl of [
    "http://relay.example.com",
    "https://user:secret@relay.example.com",
    "https://relay.example.com/base",
    "https://relay.example.com?target=other",
    "https://relay.example.com#fragment",
  ]) {
    assert.throws(() => createHttpDesktopBrowserRelayDispatcher({ baseUrl, authSecret }), /Relay URL/);
  }
  const input = {
    publicDeviceFingerprint: "0123456789abcdef",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  };
  const crossed = createHttpDesktopBrowserRelayDispatcher({
    baseUrl: "https://relay.example.com",
    authSecret,
    fetch: async (_url, init) => {
      assert.equal(init?.redirect, "manual");
      return new Response(
        JSON.stringify({
          kind: "not_accepted_or_unknown",
          dispatchId: "crossed-dispatch",
          operationId: desktopBrowserRelayInvocationFixture.payload.authority.operationId,
          requestHash: desktopBrowserRelayInvocationFixture.payload.requestHash,
          error: { code: "delivery_unknown", message: "unknown" },
        }),
        { status: 200 },
      );
    },
  });
  await assert.rejects(crossed.dispatch(input), /does not match the submitted operation/);
  const oversized = createHttpDesktopBrowserRelayDispatcher({
    baseUrl: "https://relay.example.com",
    authSecret,
    fetch: async () => new Response("x".repeat(128 * 1024 + 1), { status: 200 }),
  });
  await assert.rejects(oversized.dispatch(input), /response exceeded the maximum size/);
  const redirected = createHttpDesktopBrowserRelayDispatcher({
    baseUrl: "https://relay.example.com",
    authSecret,
    fetch: async () => new Response(null, { status: 302, headers: { location: "https://other.example.com" } }),
  });
  await assert.rejects(redirected.dispatch(input), /status 302/);
});

test("Relay callback worker retains failures and acknowledges one signed terminal delivery", async () => {
  let now = 10_000;
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking(), {
    now: () => now,
  });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  await store.markDeliveryStarted(
    desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
    desktopBrowserRelayInvocationFixture.payload.dispatchId,
  );
  await store.recordAccepted(desktopBrowserSessionStartAcceptedFixture);
  await store.recordTerminal(desktopBrowserSessionStartCompletedResultFixture);
  const config = {
    coreApiUrl: "https://core.example.test",
    sourceAuthSecret: "relay-source-auth-secret-for-tests-0001",
  };
  await deliverDesktopBrowserRelayCallbacks(store, config, async () => new Response("unavailable", { status: 503 }), {
    now: () => now,
    owner: "worker-1",
  });
  assert.equal((await store.pendingCallbacks()).length, 1);
  now += 1_000;
  let deliveries = 0;
  await deliverDesktopBrowserRelayCallbacks(
    store,
    config,
    async (url, init) => {
      deliveries += 1;
      assert.ok(init?.signal);
      const parsed = new URL(String(url));
      const body = String(init?.body ?? "");
      const headers = (init?.headers ?? {}) as Record<string, string>;
      const auth = createSourceAuth({ signingSecret: config.sourceAuthSecret });
      const verified = await auth.verify({
        signature: String(headers["x-signature"]),
        timestamp: Number(headers["x-timestamp"]),
        body: canonicalPayload("POST", `${parsed.pathname}${parsed.search}`, body),
        eventId: String(headers["x-signature"]),
      });
      assert.equal(verified.ok, true);
      assert.deepEqual(JSON.parse(body), {
        taskId: desktopBrowserRelayInvocationFixture.payload.authority.taskId,
        accepted: desktopBrowserSessionStartAcceptedFixture,
        result: desktopBrowserSessionStartCompletedResultFixture,
      });
      return new Response(null, { status: 204 });
    },
    { now: () => now, owner: "worker-2" },
  );
  assert.equal(deliveries, 1);
  assert.deepEqual(await store.pendingCallbacks(), []);
});

test("Ticket 11 Relay retries and delivers one signed Local Stop callback", async () => {
  let now = 30_000;
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking(), {
    now: () => now,
  });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  const authority = desktopBrowserRelayInvocationFixture.payload.authority;
  const receipt = {
    protocolVersion: "1.3",
    kind: "host.local-stop-receipt",
    payload: {
      receiptId: "local-stop-42-operation-1-20000",
      processEpoch: 42,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      operationId: authority.operationId,
      operationCategory: "session_start",
      requestedAt: 20_000,
      status: "canceled",
    },
  } as const;
  await store.recordLocalStopReceipt(receipt, {
    publicDeviceFingerprint: authority.deviceId,
    browserInstanceId: authority.browserInstanceId,
  });
  const config = { coreApiUrl: "https://core.example.test", sourceAuthSecret: "relay-source-auth-secret-for-tests-0001" };
  await deliverDesktopBrowserLocalStopCallbacks(
    store,
    config,
    async () => new Response("unavailable", { status: 503 }),
    { now: () => now, owner: "local-stop-worker-1" },
  );
  assert.equal((await store.pendingLocalStopCallbacks()).length, 1);

  now += 1_000;
  await deliverDesktopBrowserLocalStopCallbacks(
    store,
    config,
    async (url, init) => {
      assert.equal(new URL(String(url)).pathname, "/v1/desktop-browser/relay/callbacks/local-stop");
      assert.deepEqual(JSON.parse(String(init?.body)), { receipt });
      return new Response(null, { status: 204 });
    },
    { now: () => now, owner: "local-stop-worker-2" },
  );
  assert.deepEqual(await store.pendingLocalStopCallbacks(), []);
  assert.equal((await store.localStopReceipts()).length, 1);
});

test("Ticket 11 Local Stop callback remains replayable after a prolonged Core outage", async () => {
  let now = 1;
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking(), {
    now: () => now,
  });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  const authority = desktopBrowserRelayInvocationFixture.payload.authority;
  await store.recordLocalStopReceipt({
    protocolVersion: "1.3",
    kind: "host.local-stop-receipt",
    payload: {
      receiptId: "local-stop-dead-letter",
      processEpoch: 42,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      operationId: authority.operationId,
      operationCategory: "session_start",
      requestedAt: 1,
      status: "canceled",
    },
  }, {
    publicDeviceFingerprint: authority.deviceId,
    browserInstanceId: authority.browserInstanceId,
  });
  now += 24 * 60 * 60_000;

  await deliverDesktopBrowserLocalStopCallbacks(
    store,
    { coreApiUrl: "https://core.example.test", sourceAuthSecret: "relay-source-auth-secret-for-tests-0001" },
    async () => new Response("unavailable", { status: 503 }),
    { now: () => now, owner: "local-stop-dead-letter-worker" },
  );

  assert.equal((await store.pendingLocalStopCallbacks()).length, 1);
  assert.equal((await store.localStopReceipts()).length, 1);
});

test("Relay callback worker continues past poison entries and dead-letters after 24 hours", async () => {
  let now = 0;
  const backing = createMemoryDesktopBrowserRelayOperationBacking();
  const store = createDesktopBrowserRelayOperationStore(backing, {
    now: () => now,
  });
  const prepareTerminal = async (suffix: string) => {
    const authority = {
      ...desktopBrowserRelayInvocationFixture.payload.authority,
      taskId: `task-${suffix}`,
      attemptId: `attempt-${suffix}`,
      operationId: `operation-${suffix}`,
      nonce: `nonce-${suffix}`,
    };
    const invocation = {
      ...desktopBrowserRelayInvocationFixture,
      payload: {
        dispatchId: `dispatch-${suffix}`,
        requestHash: computeDesktopBrowserRequestHash(authority),
        authority,
      },
    };
    const accepted = {
      ...desktopBrowserSessionStartAcceptedFixture,
      payload: {
        dispatchId: invocation.payload.dispatchId,
        operationId: authority.operationId,
        requestHash: invocation.payload.requestHash,
      },
    };
    const result = {
      ...desktopBrowserSessionStartCompletedResultFixture,
      payload: {
        ...desktopBrowserSessionStartCompletedResultFixture.payload,
        dispatchId: invocation.payload.dispatchId,
        operationId: authority.operationId,
        resultHash: `sha256:result-${suffix}`,
      },
    };
    await store.prepare(invocation);
    await store.markDeliveryStarted(authority.attemptId, invocation.payload.dispatchId);
    await store.recordAccepted(accepted);
    await store.recordTerminal(result);
  };
  await prepareTerminal("poison");
  await prepareTerminal("healthy");
  const config = {
    coreApiUrl: "https://core.example.test",
    sourceAuthSecret: "relay-source-auth-secret-for-tests-0001",
  };
  const deliveredTasks: string[] = [];
  await deliverDesktopBrowserRelayCallbacks(
    store,
    config,
    async (_url, init) => {
      const body = JSON.parse(String(init?.body)) as { taskId: string };
      if (body.taskId === "task-poison") return new Response("unavailable", { status: 503 });
      deliveredTasks.push(body.taskId);
      return new Response(null, { status: 204 });
    },
    { now: () => now, owner: "worker-poison" },
  );
  assert.deepEqual(deliveredTasks, ["task-healthy"]);
  assert.deepEqual(
    (await store.pendingCallbacks()).map((entry) => entry.taskId),
    ["task-poison"],
  );

  now = 24 * 60 * 60_000;
  await deliverDesktopBrowserRelayCallbacks(
    store,
    config,
    async () => new Response("still unavailable", { status: 503 }),
    { now: () => now, owner: "worker-dead-letter" },
  );
  assert.deepEqual(await store.pendingCallbacks(), []);
  assert.deepEqual(
    (await store.deadLetters()).map((entry) => entry.taskId),
    ["task-poison"],
  );
  const deadLetter = (await store.deadLetters())[0]!;
  assert.equal(deadLetter.result, undefined);
  assert.equal((await backing.snapshot()).operations["operation-poison"]?.terminalResult, undefined);
});

test("Relay shutdown returns at the configured deadline when cleanup stalls", async () => {
  const startedAt = Date.now();
  await waitForDesktopBrowserRelayShutdown(new Promise(() => undefined), 20);
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed >= 15);
  assert.ok(elapsed < 500);
});

test("relay shutdown drains an upgraded websocket session with 1012", async () => {
  const registry = new MemoryRegistry();
  const identity = createDeviceIdentity();
  registry.binding = {
    registrationId: "reg-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
  };
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry,
  });
  const runtime = createDesktopBrowserRelayServer({
    host: "127.0.0.1",
    port: 0,
    path: "/relay",
    service,
    adapterReadiness: registry,
    storageReadiness: registry,
    shutdownDrainMs: 50,
  });
  await runtime.listen();
  const port = (runtime.server.address() as AddressInfo).port;

  const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
  await once(ws, "open");
  ws.send(hostHello(identity.devicePublicKey, "broker-1"));
  const [rawChallenge] = (await once(ws, "message")) as [Buffer];
  const challenge = JSON.parse(rawChallenge.toString("utf8")) as RelayChallengeMessage;
  ws.send(challengeResponse(challenge, identity.devicePublicKey, identity.signResponse));

  const closed = once(ws, "close");
  await runtime.shutdown();
  const [code, reason] = (await closed) as [number, Buffer];
  assert.equal(code, 1012);
  assert.match(reason.toString("utf8"), /service restart/i);
});

test("relay process runtime loads dedicated config and starts independently", async () => {
  const sourceAuthSecret = "relay-source-auth-secret-for-tests-0001";
  const auth = createSourceAuth({ signingSecret: sourceAuthSecret });
  const core = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://core.local");
    const verified = await auth.verify({
      signature: String(req.headers["x-signature"] ?? ""),
      timestamp: Number(req.headers["x-timestamp"] ?? Number.NaN),
      body: canonicalPayload(req.method ?? "", `${url.pathname}${url.search}`, ""),
      eventId: String(req.headers["x-signature"] ?? ""),
    });
    if (url.pathname !== "/v1/desktop-browser/relay/ready") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing route" }));
      return;
    }
    if (!verified.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verified.reason }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const base = await listen(core);

  try {
    const config = loadDesktopBrowserRelayConfig({
      QM_RELAY_HOST: "127.0.0.1",
      QM_RELAY_PORT: "0",
      QM_RELAY_INSTANCE_ID: "relay-a",
      QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
      QM_RELAY_CORE_API_URL: base,
      QM_RELAY_SOURCE_AUTH_SECRET: sourceAuthSecret,
      QM_RELAY_CORE_AUTH_SECRET: "relay-core-auth-secret-for-tests-0000001",
      QM_RELAY_DATABASE_URL: "postgres://relay:relay@127.0.0.1/qm_relay",
      QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2,1.0",
      QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
      QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
    });
    assert.equal(config.wssPath, DESKTOP_BROWSER_RELAY_WSS_PATH);
    const runtime = createDesktopBrowserRelayRuntime(config, {
      operationStore: memoryOperationStore(),
    });
    await runtime.start();
    const port = (runtime.server.server.address() as AddressInfo).port;
    const ready = await fetch(`http://127.0.0.1:${port}/readyz`);
    assert.equal(ready.status, 200);
    const ws = new WebSocket(`ws://127.0.0.1:${port}${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
    await runtime.shutdown();
  } finally {
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
});

test("relay process config defaults to the shared Phase F protocol and policy grammar support", () => {
  const config = loadDesktopBrowserRelayConfig(relayProcessEnv());

  assert.deepEqual(config.supportedProtocolVersions, [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS]);
  assert.deepEqual(config.supportedPolicyGrammarVersions, [
    ...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  ]);
  assert.equal(config.maxSettledDispatchHistory, 1_024);
  assert.equal(config.settledDispatchHistoryTtlMs, 300_000);
  assert.equal(config.databaseUrl, "postgres://relay:relay@127.0.0.1/qm_relay");
  assert.equal(config.databaseSchema, "qm_broker_relay");
});

test("relay process requires its own durable database and validates the isolated schema", () => {
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_DATABASE_URL: "" })),
    /QM_RELAY_DATABASE_URL is required/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_DATABASE_SCHEMA: "public;drop" })),
    /QM_RELAY_DATABASE_SCHEMA/,
  );
  for (const coreApiUrl of [
    "http://core.example.test",
    "https://user:secret@core.example.test",
    "https://core.example.test/base",
    "https://core.example.test?other=1",
    "https://core.example.test#fragment",
  ]) {
    assert.throws(
      () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_CORE_API_URL: coreApiUrl })),
      /QM_RELAY_CORE_API_URL/,
    );
  }
  assert.throws(
    () =>
      loadDesktopBrowserRelayConfig(
        relayProcessEnv({ QM_RELAY_CORE_AUTH_SECRET: relayProcessEnv().QM_RELAY_SOURCE_AUTH_SECRET }),
      ),
    /must differ/,
  );
  assert.equal(
    loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_DATABASE_SCHEMA: "desktop_relay" })).databaseSchema,
    "desktop_relay",
  );
});

test("relay process config accepts explicit settled dispatch history bounds", () => {
  const config = loadDesktopBrowserRelayConfig(
    relayProcessEnv({
      QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY: "1",
      QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS: "9007199254740991",
    }),
  );

  assert.equal(config.maxSettledDispatchHistory, 1);
  assert.equal(config.settledDispatchHistoryTtlMs, Number.MAX_SAFE_INTEGER);
});

test("relay process config rejects invalid settled dispatch history bounds directly", () => {
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY: "0" })),
    /QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY must be a positive safe integer/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY: "-1" })),
    /QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY must be a positive safe integer/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY: "1.5" })),
    /QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY must be a positive safe integer/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY: "9007199254740992" })),
    /QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY must be a positive safe integer/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS: "0" })),
    /QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS must be a positive safe integer/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS: "-1" })),
    /QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS must be a positive safe integer/,
  );
  assert.throws(
    () => loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS: "1.5" })),
    /QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS must be a positive safe integer/,
  );
  assert.throws(
    () =>
      loadDesktopBrowserRelayConfig(relayProcessEnv({ QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS: "9007199254740992" })),
    /QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS must be a positive safe integer/,
  );
});

test("relay process runtime preserves an explicit websocket path override", async () => {
  const sourceAuthSecret = "relay-source-auth-secret-for-tests-0001";
  const auth = createSourceAuth({ signingSecret: sourceAuthSecret });
  const core = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://core.local");
    const verified = await auth.verify({
      signature: String(req.headers["x-signature"] ?? ""),
      timestamp: Number(req.headers["x-timestamp"] ?? Number.NaN),
      body: canonicalPayload(req.method ?? "", `${url.pathname}${url.search}`, ""),
      eventId: String(req.headers["x-signature"] ?? ""),
    });
    if (url.pathname !== "/v1/desktop-browser/relay/ready") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing route" }));
      return;
    }
    if (!verified.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verified.reason }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const base = await listen(core);

  try {
    const config = loadDesktopBrowserRelayConfig({
      QM_RELAY_HOST: "127.0.0.1",
      QM_RELAY_PORT: "0",
      QM_RELAY_WSS_PATH: "/relay",
      QM_RELAY_INSTANCE_ID: "relay-a",
      QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
      QM_RELAY_CORE_API_URL: base,
      QM_RELAY_SOURCE_AUTH_SECRET: sourceAuthSecret,
      QM_RELAY_CORE_AUTH_SECRET: "relay-core-auth-secret-for-tests-0000001",
      QM_RELAY_DATABASE_URL: "postgres://relay:relay@127.0.0.1/qm_relay",
      QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2,1.0",
      QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
      QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
    });
    assert.equal(config.wssPath, "/relay");
    const runtime = createDesktopBrowserRelayRuntime(config, {
      operationStore: memoryOperationStore(),
    });
    await runtime.start();
    const port = (runtime.server.server.address() as AddressInfo).port;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/relay`);
    await once(ws, "open");
    ws.close();
    await once(ws, "close");
    await runtime.shutdown();
  } finally {
    await new Promise<void>((resolve) => core.close(() => resolve()));
  }
});

test("relay process readiness fails when source auth is rejected or the readiness route is missing", async () => {
  const sourceAuthSecret = "relay-source-auth-secret-for-tests-0001";
  const auth = createSourceAuth({ signingSecret: sourceAuthSecret });
  const core = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://core.local");
    if (url.pathname !== "/v1/desktop-browser/relay/ready") {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "missing route" }));
      return;
    }
    const verified = await auth.verify({
      signature: String(req.headers["x-signature"] ?? ""),
      timestamp: Number(req.headers["x-timestamp"] ?? Number.NaN),
      body: canonicalPayload(req.method ?? "", `${url.pathname}${url.search}`, ""),
      eventId: String(req.headers["x-signature"] ?? ""),
    });
    if (!verified.ok) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: verified.reason }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  const missingRouteCore = createServer((_req: IncomingMessage, res: ServerResponse) => {
    res.writeHead(404, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "missing route" }));
  });
  const rejectingBase = await listen(core);
  const missingRouteBase = await listen(missingRouteCore);

  try {
    const badSecretRuntime = createDesktopBrowserRelayRuntime(
      loadDesktopBrowserRelayConfig({
        QM_RELAY_HOST: "127.0.0.1",
        QM_RELAY_PORT: "0",
        QM_RELAY_WSS_PATH: "/relay",
        QM_RELAY_INSTANCE_ID: "relay-a",
        QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
        QM_RELAY_CORE_API_URL: rejectingBase,
        QM_RELAY_SOURCE_AUTH_SECRET: "relay-source-auth-secret-for-tests-9999",
        QM_RELAY_CORE_AUTH_SECRET: "relay-core-auth-secret-for-tests-0000001",
        QM_RELAY_DATABASE_URL: "postgres://relay:relay@127.0.0.1/qm_relay",
        QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2",
        QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
        QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
      }),
      { operationStore: memoryOperationStore() },
    );
    await badSecretRuntime.start();
    const badSecretPort = (badSecretRuntime.server.server.address() as AddressInfo).port;
    const badSecretReady = await fetch(`http://127.0.0.1:${badSecretPort}/readyz`);
    assert.equal(badSecretReady.status, 503);
    assert.match(
      JSON.stringify(await badSecretReady.json()),
      /signature mismatch|duplicate event|stale timestamp|invalid timestamp/,
    );
    await badSecretRuntime.shutdown();

    const missingRouteRuntime = createDesktopBrowserRelayRuntime(
      loadDesktopBrowserRelayConfig({
        QM_RELAY_HOST: "127.0.0.1",
        QM_RELAY_PORT: "0",
        QM_RELAY_WSS_PATH: "/relay",
        QM_RELAY_INSTANCE_ID: "relay-a",
        QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
        QM_RELAY_CORE_API_URL: missingRouteBase,
        QM_RELAY_SOURCE_AUTH_SECRET: sourceAuthSecret,
        QM_RELAY_CORE_AUTH_SECRET: "relay-core-auth-secret-for-tests-0000001",
        QM_RELAY_DATABASE_URL: "postgres://relay:relay@127.0.0.1/qm_relay",
        QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2",
        QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
        QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
      }),
      { operationStore: memoryOperationStore() },
    );
    await missingRouteRuntime.start();
    const missingRoutePort = (missingRouteRuntime.server.server.address() as AddressInfo).port;
    const missingRouteReady = await fetch(`http://127.0.0.1:${missingRoutePort}/readyz`);
    assert.equal(missingRouteReady.status, 503);
    assert.match(JSON.stringify(await missingRouteReady.json()), /404|missing route/);
    await missingRouteRuntime.shutdown();
  } finally {
    await new Promise<void>((resolve) => core.close(() => resolve()));
    await new Promise<void>((resolve) => missingRouteCore.close(() => resolve()));
  }
});

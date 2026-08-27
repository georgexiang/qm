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
  encodeHostChallengeResponseSigningBytes,
  type HostChallengeResponseMessage,
  type RelayChallengeMessage,
} from "qm-desktop-browser-contracts";
import WebSocket from "ws";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayBinding,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
} from "../packages/qm-broker-relay/src/index.ts";
import {
  CoreHttpDesktopBrowserRelayRegistryAdapter,
  createDesktopBrowserRelayRuntime,
  loadDesktopBrowserRelayConfig,
} from "../packages/qm-broker-relay/src/process.ts";
import {
  createDesktopBrowserRelayServer,
  type DesktopBrowserRelayReadinessProbe,
} from "../packages/qm-broker-relay/src/server.ts";
import { canonicalPayload } from "../src/api/http.ts";
import { createSourceAuth } from "../src/auth/source-auth.ts";

class Probe implements DesktopBrowserRelayReadinessProbe {
  error: string | null = null;

  async check(): Promise<void> {
    if (this.error) throw new Error(this.error);
  }
}

class MemoryRegistry implements DesktopBrowserRelayRegistryAdapter, DesktopBrowserRelayReadinessProbe {
  error: string | null = null;
  binding: DesktopBrowserRelayBinding | null = null;
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
    return this.binding.devicePublicKey === input.devicePublicKey &&
      this.binding.brokerInstanceId === input.brokerInstanceId
      ? this.binding
      : null;
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
  } finally {
    await runtime.shutdown();
  }
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
      QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2,1.0",
      QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
      QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
    });
    assert.equal(config.wssPath, DESKTOP_BROWSER_RELAY_WSS_PATH);
    const runtime = createDesktopBrowserRelayRuntime(config);
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
  const sourceAuthSecret = "relay-source-auth-secret-for-tests-0001";
  const config = loadDesktopBrowserRelayConfig({
    QM_RELAY_HOST: "127.0.0.1",
    QM_RELAY_PORT: "0",
    QM_RELAY_INSTANCE_ID: "relay-a",
    QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
    QM_RELAY_CORE_API_URL: "http://127.0.0.1:8080",
    QM_RELAY_SOURCE_AUTH_SECRET: sourceAuthSecret,
  });

  assert.deepEqual(config.supportedProtocolVersions, [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS]);
  assert.deepEqual(config.supportedPolicyGrammarVersions, [
    ...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  ]);
  assert.equal(config.maxSettledDispatchHistory, 1_024);
  assert.equal(config.settledDispatchHistoryTtlMs, 300_000);
});

test("relay process config accepts explicit settled dispatch history bounds", () => {
  const sourceAuthSecret = "relay-source-auth-secret-for-tests-0001";
  const config = loadDesktopBrowserRelayConfig({
    QM_RELAY_HOST: "127.0.0.1",
    QM_RELAY_PORT: "0",
    QM_RELAY_INSTANCE_ID: "relay-a",
    QM_RELAY_DEPLOYMENT_CANONICAL_ID: "qm://deployments/example",
    QM_RELAY_CORE_API_URL: "http://127.0.0.1:8080",
    QM_RELAY_SOURCE_AUTH_SECRET: sourceAuthSecret,
    QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY: "64",
    QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS: "90000",
  });

  assert.equal(config.maxSettledDispatchHistory, 64);
  assert.equal(config.settledDispatchHistoryTtlMs, 90_000);
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
      QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2,1.0",
      QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
      QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
    });
    assert.equal(config.wssPath, "/relay");
    const runtime = createDesktopBrowserRelayRuntime(config);
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
        QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2",
        QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
        QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
      }),
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
        QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS: "1.2",
        QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS: "1.1",
        QM_RELAY_SHUTDOWN_DRAIN_MS: "50",
      }),
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

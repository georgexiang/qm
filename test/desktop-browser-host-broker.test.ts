import assert from "node:assert/strict";
import { once } from "node:events";
import { chmodSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  decodeDesktopBrowserMessage,
  projectDesktopBrowserPublicIdentity,
  type HostChallengeResponseMessage,
} from "../packages/desktop-browser-contracts/src/index.ts";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayBinding,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
  type DesktopBrowserRelaySocket,
} from "../packages/qm-broker-relay/src/index.ts";
import { createDesktopBrowserRelayServer } from "../packages/qm-broker-relay/src/server.ts";
import { desktopBrowserRegistrationReservationTupleFixture } from "../packages/desktop-browser-contracts/src/fixtures.ts";
import {
  HOST_BROKER_CONTROL_NOTICE,
  HostBrokerConnection,
  loadOrCreateDeviceIdentity,
  createRegistrationConfirmationPreview,
  confirmRegistration,
  runHostBrokerCli,
  resolveRelayUrlFromEnv,
  verifyHostChallengeResponseMessage,
  verifyRegistrationConfirmationEnvelopeSignature,
  type BrowserRuntimeMetadata,
  type HostBrokerScheduler,
  type HostBrokerSocket,
  type HostBrokerTransport,
} from "../packages/qm-host-broker/src/index.ts";
import WebSocket from "ws";

class FakeSocket implements HostBrokerSocket {
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;
  closeCalls = 0;
  closed = false;

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  removeEventListener(type: "open" | "message" | "close" | "error", listener: (event?: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    this.listeners.set(
      type,
      current.filter((entry) => entry !== listener),
    );
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCalls += 1;
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
  }

  open(): void {
    if (this.closed) return;
    this.emit("open");
  }

  message(data: string): void {
    if (this.closed) return;
    this.emit("message", { data });
  }

  fail(): void {
    if (this.closed) return;
    this.emit("error", new Error("socket failed"));
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeTransport implements HostBrokerTransport {
  readonly socket: FakeSocket;
  readonly expectedUrl: string;

  constructor(socket: FakeSocket, expectedUrl: string) {
    this.socket = socket;
    this.expectedUrl = expectedUrl;
  }

  connect(url: string): HostBrokerSocket {
    assert.equal(url, this.expectedUrl);
    return this.socket;
  }
}

class FakeScheduler implements HostBrokerScheduler {
  nowMs = 0;
  randomValues: number[] = [];
  private nextId = 1;
  private readonly timers = new Map<number, { runAt: number; callback: () => void }>();

  now(): number {
    return this.nowMs;
  }

  random(): number {
    return this.randomValues.shift() ?? 0;
  }

  setTimeout(callback: () => void, ms: number): ReturnType<typeof setTimeout> {
    const id = this.nextId++;
    this.timers.set(id, { runAt: this.nowMs + ms, callback });
    return id as unknown as ReturnType<typeof setTimeout>;
  }

  clearTimeout(timer: ReturnType<typeof setTimeout>): void {
    this.timers.delete(timer as unknown as number);
  }

  advance(ms: number): void {
    this.nowMs += ms;
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.runAt <= this.nowMs)
        .sort((a, b) => a[1].runAt - b[1].runAt || a[0] - b[0])[0];
      if (!due) return;
      this.timers.delete(due[0]);
      due[1].callback();
    }
  }
}

class MemoryRegistryAdapter implements DesktopBrowserRelayRegistryAdapter {
  readonly published = new Map<string, DesktopBrowserRelayProjection>();
  readonly cleared: string[] = [];
  readonly bindings = new Map<string, DesktopBrowserRelayBinding>();

  async resolveBinding(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
  }): Promise<DesktopBrowserRelayBinding | null> {
    return this.bindings.get(`${input.devicePublicKey}\u0000${input.brokerInstanceId}`) ?? null;
  }

  async publishConnection(projection: DesktopBrowserRelayProjection): Promise<void> {
    this.published.set(projection.connectionId, projection);
  }

  async clearConnection(connectionId: string): Promise<void> {
    this.cleared.push(connectionId);
    this.published.delete(connectionId);
  }

  setBinding(binding: DesktopBrowserRelayBinding): void {
    this.bindings.set(`${binding.devicePublicKey}\u0000${binding.brokerInstanceId}`, binding);
  }
}

class LinkedSocket implements HostBrokerSocket, DesktopBrowserRelaySocket {
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  private readonly transformOutbound: ((data: string) => string) | null;
  private peer: LinkedSocket | null = null;
  private closed = false;

  closeCode: number | undefined;
  closeReason: string | undefined;

  constructor(transformOutbound?: (data: string) => string) {
    this.transformOutbound = transformOutbound ?? null;
  }

  attachPeer(peer: LinkedSocket): void {
    this.peer = peer;
  }

  addEventListener(type: "open" | "message" | "close" | "error" | "pong", listener: (event?: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(data: string): void {
    this.peer?.emit("message", { data: this.transformOutbound ? this.transformOutbound(data) : data });
  }

  close(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
    this.peer?.closeFromPeer(code, reason);
  }

  ping(): void {
    this.emit("pong");
  }

  open(): void {
    this.emit("open");
  }

  private closeFromPeer(code?: number, reason?: string): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

function createLinkedSocketPair(input?: {
  hostToRelay?: (data: string) => string;
  relayToHost?: (data: string) => string;
}): { host: LinkedSocket; relay: LinkedSocket } {
  const host = new LinkedSocket(input?.hostToRelay);
  const relay = new LinkedSocket(input?.relayToHost);
  host.attachPeer(relay);
  relay.attachPeer(host);
  return { host, relay };
}
function runtime(): BrowserRuntimeMetadata {
  return {
    browserInstanceId: "browser-primary",
    browserSkillStatus: "ready",
    bskVersion: "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c",
    extensionVersion: "0.1.6",
    cliShapeHash: "shape-123",
  };
}

function tupleForIdentity(devicePublicKey: string) {
  return {
    ...desktopBrowserRegistrationReservationTupleFixture,
    devicePublicKey,
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
  };
}

async function flushAsyncWork(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitFor<T>(read: () => T | undefined, label: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await flushAsyncWork();
    await delay(10);
  }
  throw new Error(`${label} did not become available`);
}

test("connect defaults the relay URL to the shared QM device websocket path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-default-relay-url-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const socket = new FakeSocket();

  const running = runHostBrokerCli(["connect", "https://qm.example.com"], {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: new FakeTransport(socket, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`),
    brokerInstanceId: "broker-default",
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  });

  await new Promise((resolve) => setImmediate(resolve));
  socket.open();
  socket.close(1000, "done");
  assert.equal(await running, 0);
  assert.equal(stderrChunks.length, 0);
  assert.match(stdoutChunks.join(""), /Relay URL: wss:\/\/qm\.example\.com\/v1\/device/);
});

test("host relay URL override accepts a safe wss URL with a custom path and host connects", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-relay-url-override-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const socket = new FakeSocket();
  const relayUrl = "wss://relay.example.com/custom/device";

  const running = runHostBrokerCli(["connect", "https://qm.example.com"], {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: new FakeTransport(socket, relayUrl),
    resolveRelayUrl: (qmUrl) =>
      resolveRelayUrlFromEnv(qmUrl, {
        QM_HOST_BROKER_RELAY_URL: relayUrl,
      }),
    brokerInstanceId: "broker-default",
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  });

  await new Promise((resolve) => setImmediate(resolve));
  socket.open();
  socket.close(1000, "done");
  assert.equal(await running, 0);
  assert.equal(stderrChunks.length, 0);
  assert.match(stdoutChunks.join(""), /Relay URL: wss:\/\/relay\.example\.com\/custom\/device/);
});

test("host relay URL override rejects credentials, query, fragment, and insecure non-loopback ws targets", () => {
  assert.throws(
    () =>
      resolveRelayUrlFromEnv("https://qm.example.com", {
        QM_HOST_BROKER_RELAY_URL: "wss://user:pass@relay.example.com/custom/device",
      }),
    /QM_HOST_BROKER_RELAY_URL must not include credentials/,
  );
  assert.throws(
    () =>
      resolveRelayUrlFromEnv("https://qm.example.com", {
        QM_HOST_BROKER_RELAY_URL: "wss://relay.example.com/custom/device?debug=1",
      }),
    /QM_HOST_BROKER_RELAY_URL must not include query or fragment components/,
  );
  assert.throws(
    () =>
      resolveRelayUrlFromEnv("https://qm.example.com", {
        QM_HOST_BROKER_RELAY_URL: "wss://relay.example.com/custom/device#fragment",
      }),
    /QM_HOST_BROKER_RELAY_URL must not include query or fragment components/,
  );
  assert.throws(
    () =>
      resolveRelayUrlFromEnv("https://qm.example.com", {
        QM_HOST_BROKER_RELAY_URL: "ws://relay.example.com/custom/device",
      }),
    /QM_HOST_BROKER_RELAY_URL may use ws:\/\/ only for loopback hosts/,
  );
});

test("default host support interoperates with the default relay handshake through the socket seam", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-default-relay-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-default-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS],
    supportedPolicyGrammarVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS],
    registry,
    createNonce: () => "nonce-default-1",
    createConnectionId: () => "connection-default-1",
  });
  const sockets = createLinkedSocketPair();
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS],
    supportedPolicyGrammarVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();
  await flushAsyncWork();
  const published = await waitFor(() => registry.published.get("connection-default-1"), "default relay publication");

  assert.deepEqual(published, {
    connectionId: "connection-default-1",
    publicDeviceFingerprint: computeDesktopBrowserPublicDeviceFingerprint(
      projectDesktopBrowserPublicIdentity({
        registrationProtocolVersion: published.protocolVersion as `${number}.${number}`,
        deploymentCanonicalId: "qm://deployments/example",
        registrationId: published.connectionId,
        actorId: "projection",
        originatingProjectId: "projection",
        membershipEpoch: 0,
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: published.brokerInstanceId,
        browserInstanceId: published.browserInstanceId,
        connectionEpoch: published.connectionEpoch,
        expiresAt: published.lastSeenAt,
      }),
    ),
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    registrationState: "registered",
    protocolVersion: DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS[0],
    policyGrammarVersion: DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS[0],
    brokerVersion: "0.0.0-test",
    bskVersion: runtime().bskVersion,
    extensionVersion: runtime().extensionVersion,
    cliShapeHash: runtime().cliShapeHash,
    lastSeenAt: published.lastSeenAt,
  });

  sockets.host.close(1000, "done");
  await running;
});

test("host and relay prefer protocol 1.2 during handshake interop and publish the negotiated version", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-preferred-minor-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-preferred-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2", "1.0"],
    supportedPolicyGrammarVersions: ["1.1", "1.0"],
    registry,
    createNonce: () => "nonce-preferred-1",
    createConnectionId: () => "connection-preferred-1",
  });
  const sockets = createLinkedSocketPair();
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0", "1.2"],
    supportedPolicyGrammarVersions: ["1.0", "1.1"],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();
  await flushAsyncWork();
  const published = await waitFor(
    () => registry.published.get("connection-preferred-1"),
    "preferred relay publication",
  );

  assert.equal(published.protocolVersion, "1.2");
  assert.equal(published.policyGrammarVersion, "1.1");

  sockets.host.close(1000, "done");
  await running;
});

test("host and relay fall back to protocol 1.0 during handshake interop when relay only supports 1.0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-fallback-minor-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-fallback-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.0"],
    supportedPolicyGrammarVersions: ["1.0"],
    registry,
    createNonce: () => "nonce-fallback-1",
    createConnectionId: () => "connection-fallback-1",
  });
  const sockets = createLinkedSocketPair();
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0", "1.2"],
    supportedPolicyGrammarVersions: ["1.0", "1.1"],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();
  await flushAsyncWork();
  const published = await waitFor(() => registry.published.get("connection-fallback-1"), "fallback relay publication");

  assert.equal(published.protocolVersion, "1.0");
  assert.equal(published.policyGrammarVersion, "1.0");

  sockets.host.close(1000, "done");
  await running;
});

test("host and relay fall back to protocol 1.0 during handshake interop when the host only supports 1.0", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-mirror-fallback-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-mirror-fallback-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2", "1.0"],
    supportedPolicyGrammarVersions: ["1.1", "1.0"],
    registry,
    createNonce: () => "nonce-mirror-fallback-1",
    createConnectionId: () => "connection-mirror-fallback-1",
  });
  const sockets = createLinkedSocketPair();
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0"],
    supportedPolicyGrammarVersions: ["1.0", "1.1"],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();
  await flushAsyncWork();
  const published = await waitFor(
    () => registry.published.get("connection-mirror-fallback-1"),
    "mirror fallback relay publication",
  );

  assert.equal(published.protocolVersion, "1.0");
  assert.equal(published.policyGrammarVersion, "1.1");

  sockets.host.close(1000, "done");
  await running;
});

test("host and relay reject same-major protocol versions without an exact shared version during handshake interop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-same-major-no-exact-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-same-major-no-exact-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry,
    createNonce: () => "nonce-same-major-no-exact-1",
    createConnectionId: () => "connection-same-major-no-exact-1",
  });
  const sockets = createLinkedSocketPair();
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.1"],
    supportedPolicyGrammarVersions: ["1.1"],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();

  await assert.rejects(running, /no compatible desktop browser protocol version available/);
  assert.equal(registry.published.size, 0);
  assert.equal(sockets.host.closeCode, 1008);
  assert.match(sockets.host.closeReason ?? "", /no compatible desktop browser protocol version available/);
});

test("host and relay reject incompatible protocol majors during handshake interop", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-incompatible-major-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-incompatible-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["2.0"],
    supportedPolicyGrammarVersions: ["1.0"],
    registry,
    createNonce: () => "nonce-incompatible-1",
    createConnectionId: () => "connection-incompatible-1",
  });
  const sockets = createLinkedSocketPair();
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0", "1.2"],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();

  await assert.rejects(
    running,
    /protocol major 1 is incompatible with supported major 2|no compatible desktop browser protocol version available/,
  );
  assert.equal(registry.published.size, 0);
  assert.equal(sockets.host.closeCode, 1008);
  assert.match(
    sockets.host.closeReason ?? "",
    /protocol major 1 is incompatible with supported major 2|no compatible desktop browser protocol version available/,
  );
});

test("host challenge-response signature fails and relay rejects the frame if the protocol version is mutated on the wire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-mutated-version-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-mutated-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2", "1.0"],
    supportedPolicyGrammarVersions: ["1.1", "1.0"],
    registry,
    createNonce: () => "nonce-mutated-1",
    createConnectionId: () => "connection-mutated-1",
  });
  let originalResponse: HostChallengeResponseMessage | null = null;
  const sockets = createLinkedSocketPair({
    hostToRelay(data: string): string {
      const message = decodeDesktopBrowserMessage(data);
      if (message.kind !== "host.challenge-response") return data;
      originalResponse = message as HostChallengeResponseMessage;
      return JSON.stringify({ ...message, protocolVersion: "1.0" });
    },
  });
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0", "1.2"],
    supportedPolicyGrammarVersions: ["1.0", "1.1"],
    identity,
    runtime: runtime(),
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const running = connection.start();
  sockets.host.open();

  await assert.rejects(running, /protocol version does not match the negotiated version/);
  if (!originalResponse) throw new Error("expected the host to emit a challenge response before relay rejection");
  const capturedResponse = originalResponse as HostChallengeResponseMessage;
  assert.equal(capturedResponse.protocolVersion, "1.2");
  assert.equal(verifyHostChallengeResponseMessage({ ...capturedResponse, protocolVersion: "1.0" }), false);
  assert.equal(registry.published.size, 0);
  assert.equal(sockets.host.closeCode, 1008);
  assert.match(sockets.host.closeReason ?? "", /protocol version does not match the negotiated version/);
});

test("host relay path override validates and interoperates with a custom relay websocket path", async () => {
  assert.throws(
    () => resolveRelayUrlFromEnv("https://qm.example.com", { QM_HOST_BROKER_RELAY_WSS_PATH: "relay" }),
    /QM_HOST_BROKER_RELAY_WSS_PATH must start with \//,
  );

  const dir = mkdtempSync(join(tmpdir(), "host-broker-relay-path-override-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-override-1",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS],
    supportedPolicyGrammarVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS],
    registry,
    createNonce: () => "nonce-override-1",
    createConnectionId: () => "connection-override-1",
  });
  const server = createDesktopBrowserRelayServer({
    host: "127.0.0.1",
    port: 0,
    path: "/relay",
    service,
    adapterReadiness: { check: async () => {} },
    storageReadiness: { check: async () => {} },
    shutdownDrainMs: 50,
  });
  await server.listen();

  try {
    const port = (server.server.address() as AddressInfo).port;
    const qmUrl = `http://127.0.0.1:${port}`;
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    let liveSocket: WebSocket | null = null;
    const connectionOpened = once(server.wsServer, "connection");
    const priorNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "test";
    const running = runHostBrokerCli(["connect", qmUrl], {
      dataDir: dir,
      stdout: {
        write(chunk: string) {
          stdoutChunks.push(chunk);
        },
      },
      stderr: {
        write(chunk: string) {
          stderrChunks.push(chunk);
        },
      },
      transport: {
        connect(url: string): HostBrokerSocket {
          liveSocket = new WebSocket(url);
          return liveSocket as unknown as HostBrokerSocket;
        },
      },
      resolveRelayUrl: (nextQmUrl) =>
        resolveRelayUrlFromEnv(nextQmUrl, {
          QM_HOST_BROKER_RELAY_WSS_PATH: "/relay",
        }),
      brokerInstanceId: "broker-local-1",
      brokerVersion: "0.0.0-test",
      runtime: runtime(),
    }).finally(() => {
      if (priorNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = priorNodeEnv;
    });

    await connectionOpened;
    const published = await waitFor(() => registry.published.get("connection-override-1"), "custom relay publication");
    assert.equal(published.policyGrammarVersion, "1.0");
    assert.match(stdoutChunks.join(""), new RegExp(`Relay URL: ws://127\\.0\\.0\\.1:${port}/relay`));
    assert.equal(stderrChunks.length, 0);

    const socketToClose = liveSocket as WebSocket | null;
    socketToClose?.close(1000, "done");
    assert.equal(await running, 0);
  } finally {
    await server.shutdown();
  }
});

test("device identity creates atomically with mode 0600 and reloads the same key", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-id-"));

  const first = await loadOrCreateDeviceIdentity(dir);
  const second = await loadOrCreateDeviceIdentity(dir);

  assert.equal(second.devicePublicKey, first.devicePublicKey);
  assert.deepEqual(readdirSync(dir), ["device-key.json"]);
  assert.equal(statSync(join(dir, "device-key.json")).mode & 0o777, 0o600);
  const payload = new TextEncoder().encode("qm-host-broker");
  const signature = first.sign(payload);
  assert.equal(second.verify(payload, signature), true);
});

test("registration confirmation signs the exact shared reservation tuple only after explicit fingerprint confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-confirm-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);

  const preview = createRegistrationConfirmationPreview(identity, tuple);

  assert.equal(preview.confirmationFingerprint, computeDesktopBrowserRegistrationConfirmationFingerprint(tuple));
  assert.equal(preview.publicIdentity.browserInstanceId, tuple.browserInstanceId);
  assert.throws(() => confirmRegistration(identity, tuple, "ffffffffffffffff"), /confirmation fingerprint mismatch/);

  const envelope = confirmRegistration(identity, tuple, preview.confirmationFingerprint);

  assert.equal(envelope.confirmationFingerprint, preview.confirmationFingerprint);
  assert.equal(verifyRegistrationConfirmationEnvelopeSignature(envelope), true);
  assert.equal(
    verifyRegistrationConfirmationEnvelopeSignature({
      ...envelope,
      registrationTuple: {
        ...envelope.registrationTuple,
        connectionEpoch: envelope.registrationTuple.connectionEpoch + 1,
      },
    }),
    false,
  );
});

test("registration confirmation refuses expired tuples", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-expired-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = {
    ...tupleForIdentity(identity.devicePublicKey),
    expiresAt: "2020-01-01T00:00:00.000Z",
  };

  assert.throws(() => createRegistrationConfirmationPreview(identity, tuple), /expired/);
  assert.throws(
    () => confirmRegistration(identity, tuple, computeDesktopBrowserRegistrationConfirmationFingerprint(tuple)),
    /expired/,
  );
});

test("confirmation CLI refuses tuples that mutate the bound broker browser or connection epoch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-binding-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  };

  await runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple)], baseDeps);

  await assert.rejects(
    () =>
      runHostBrokerCli(
        [
          "confirmation",
          "--tuple-json",
          JSON.stringify({
            ...tuple,
            browserInstanceId: "browser-secondary",
            connectionEpoch: tuple.connectionEpoch + 1,
          }),
        ],
        baseDeps,
      ),
    /local.*browser|local.*connection epoch|binding/i,
  );
  assert.equal(stderrChunks.length, 0);
});

test("device identity refuses insecure existing files and symlinks", async () => {
  const insecureDir = mkdtempSync(join(tmpdir(), "host-broker-insecure-"));
  writeFileSync(
    join(insecureDir, "device-key.json"),
    JSON.stringify({
      privateKeyPem: "not-a-key",
      devicePublicKey: "ed25519:not-a-key",
    }),
  );
  chmodSync(join(insecureDir, "device-key.json"), 0o644);
  await assert.rejects(() => loadOrCreateDeviceIdentity(insecureDir), /permissions|0600/);

  const symlinkDir = mkdtempSync(join(tmpdir(), "host-broker-symlink-"));
  const symlinkTarget = join(tmpdir(), `host-broker-symlink-target-${Date.now().toString(36)}.json`);
  writeFileSync(
    symlinkTarget,
    JSON.stringify({
      privateKeyPem: "not-a-key",
      devicePublicKey: "ed25519:not-a-key",
    }),
  );
  symlinkSync(symlinkTarget, join(symlinkDir, "device-key.json"));
  await assert.rejects(() => loadOrCreateDeviceIdentity(symlinkDir), /symlink|regular file/);
});

test("connect handshake sends shared hello and signed challenge response through the injected transport seam", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-transport-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const socket = new FakeSocket();
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: "wss://relay.example.com/v1/device",
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0"],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
  });

  const running = connection.start();
  socket.open();

  const hello = decodeDesktopBrowserMessage(socket.sent[0] ?? "");
  assert.equal(hello.kind, "host.hello");
  if (hello.kind === "host.hello") {
    assert.equal(hello.payload.devicePublicKey, identity.devicePublicKey);
    assert.equal(hello.payload.brokerInstanceId, "broker-local-1");
    assert.deepEqual(hello.payload.supportedProtocolVersions, ["1.0"]);
  }

  socket.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: "qm://deployments/example",
        brokerInstanceId: "broker-local-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
      },
    }),
  );

  const response = decodeDesktopBrowserMessage(socket.sent[1] ?? "");
  assert.equal(response.kind, "host.challenge-response");
  assert.equal(verifyHostChallengeResponseMessage(response as HostChallengeResponseMessage), true);
  assert.deepEqual((response as HostChallengeResponseMessage).payload, {
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    challengeNonce: "nonce-1",
    signatureAlgorithm: "ed25519",
    signature: (response as HostChallengeResponseMessage).payload.signature,
  });
  assert.deepEqual(connection.snapshot(), {
    qmUrl: "https://qm.example.com",
    relayUrl: "wss://relay.example.com/v1/device",
    deploymentCanonicalId: "qm://deployments/example",
    brokerStatus: "ready",
    browserSkillStatus: "ready",
    currentTaskPresent: false,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    processEpoch: null,
    connectionEpoch: 7,
    devicePublicKey: identity.devicePublicKey,
    publicDeviceFingerprint: null,
    confirmationFingerprint: null,
    notice: HOST_BROKER_CONTROL_NOTICE,
  });

  socket.close(1000, "done");
  assert.deepEqual(await running, { reason: "settled", ready: true });
  assert.equal(connection.snapshot().brokerStatus, "disconnected");
});

test("connect rejects present but mismatched authoritative deployment broker or browser bindings", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-mismatched-challenge-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  for (const [field, value, pattern] of [
    ["deploymentCanonicalId", "qm://deployments/other", /deployment/i],
    ["brokerInstanceId", "broker-local-2", /broker/i],
    ["browserInstanceId", "browser-secondary", /browser/i],
  ] as const) {
    const socket1 = new FakeSocket();
    const socket2 = new FakeSocket();
    let transportCall = 0;
    const baseDeps = {
      dataDir: dir,
      stdout: {
        write(chunk: string) {
          stdoutChunks.push(chunk);
        },
      },
      stderr: {
        write(chunk: string) {
          stderrChunks.push(chunk);
        },
      },
      transport: {
        connect(url: string): HostBrokerSocket {
          assert.equal(url, "wss://relay.example.com/v1/device");
          transportCall += 1;
          return transportCall === 1 ? socket1 : socket2;
        },
      } satisfies HostBrokerTransport,
      resolveRelayUrl: () => "wss://relay.example.com/v1/device",
      brokerInstanceId: tuple.brokerInstanceId,
      brokerVersion: "0.0.0-test",
      runtime: runtime(),
    };

    stdoutChunks.length = 0;
    stderrChunks.length = 0;
    const firstConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
    await new Promise((resolve) => setImmediate(resolve));
    socket1.open();
    socket1.message(
      JSON.stringify({
        protocolVersion: "1.0",
        kind: "relay.challenge",
        payload: {
          relayInstanceId: "relay-a",
          challengeNonce: "nonce-1",
          deploymentCanonicalId: tuple.deploymentCanonicalId,
          brokerInstanceId: tuple.brokerInstanceId,
          browserInstanceId: tuple.browserInstanceId,
          connectionEpoch: tuple.connectionEpoch,
        },
      }),
    );
    socket1.close(1000, "seed");
    assert.equal(await firstConnect, 0);

    const secondConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
    await new Promise((resolve) => setImmediate(resolve));
    socket2.open();
    socket2.message(
      JSON.stringify({
        protocolVersion: "1.0",
        kind: "relay.challenge",
        payload: {
          relayInstanceId: "relay-b",
          challengeNonce: "nonce-2",
          deploymentCanonicalId: tuple.deploymentCanonicalId,
          brokerInstanceId: tuple.brokerInstanceId,
          browserInstanceId: tuple.browserInstanceId,
          connectionEpoch: tuple.connectionEpoch + 1,
          [field]: value,
        },
      }),
    );

    assert.equal(await secondConnect, 1);
    assert.match(stderrChunks.join(""), pattern);
    stdoutChunks.length = 0;
    await runHostBrokerCli(["status", "--json"], baseDeps);
    const statusPayload = JSON.parse(stdoutChunks.join("")) as {
      deploymentCanonicalId: string;
      brokerInstanceId: string;
      browserInstanceId: string;
      connectionEpoch: number;
      brokerStatus: string;
    };
    assert.equal(statusPayload.deploymentCanonicalId, tuple.deploymentCanonicalId);
    assert.equal(statusPayload.brokerInstanceId, tuple.brokerInstanceId);
    assert.equal(statusPayload.browserInstanceId, tuple.browserInstanceId);
    assert.equal(statusPayload.connectionEpoch, tuple.connectionEpoch);
    assert.equal(statusPayload.brokerStatus, "disconnected");
  }
});

test("host challenge response signature fails if any signed binding field is mutated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-challenge-signature-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const socket = new FakeSocket();
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: "wss://relay.example.com/v1/device",
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0"],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
  });

  const running = connection.start();
  socket.open();
  socket.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: "qm://deployments/example",
        brokerInstanceId: "broker-local-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
      },
    }),
  );

  const response = decodeDesktopBrowserMessage(socket.sent[1] ?? "") as HostChallengeResponseMessage;
  for (const [field, value] of [
    ["protocolVersion", "1.1"],
    ["relayInstanceId", "relay-b"],
    ["deploymentCanonicalId", "qm://deployments/other"],
    ["devicePublicKey", "ed25519:other-device"],
    ["brokerInstanceId", "broker-local-2"],
    ["browserInstanceId", "browser-secondary"],
    ["connectionEpoch", 8],
    ["challengeNonce", "nonce-2"],
  ] as const) {
    const mutated =
      field === "protocolVersion"
        ? { ...response, protocolVersion: value }
        : { ...response, payload: { ...response.payload, [field]: value } };
    assert.equal(verifyHostChallengeResponseMessage(mutated as HostChallengeResponseMessage), false, String(field));
  }

  socket.close(1000, "done");
  assert.deepEqual(await running, { reason: "settled", ready: true });
});

test("connect clears the handshake timeout after the validated challenge and keeps the WSS open", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-timeout-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const socket = new FakeSocket();
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: "wss://relay.example.com/v1/device",
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0"],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
    handshakeTimeoutMs: 15,
  });

  let settled: string | null = null;
  const running = connection.start().then(
    () => {
      settled = "resolved";
    },
    (error: unknown) => {
      settled = error instanceof Error ? error.message : String(error);
    },
  );
  socket.open();
  socket.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: "qm://deployments/example",
        brokerInstanceId: "broker-local-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
      },
    }),
  );

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(settled, null);
  assert.equal(connection.snapshot().brokerStatus, "ready");

  socket.close(1000, "done");
  await running;
  assert.equal(settled, "resolved");
});

test("connect fails closed for insecure relay transport and unusable runtime metadata", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-connect-guards-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const insecureTransportExit = await runHostBrokerCli(["connect", "https://qm.example.com"], {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    resolveRelayUrl: () => "ws://relay.example.com/v1/device",
    runtime: runtime(),
  });

  assert.equal(insecureTransportExit, 1);
  assert.match(stderrChunks.join(""), /wss/i);

  stdoutChunks.length = 0;
  stderrChunks.length = 0;
  const offlineRuntimeExit = await runHostBrokerCli(["connect", "https://qm.example.com"], {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    transport: new FakeTransport(new FakeSocket(), "wss://relay.example.com/v1/device"),
    runtime: {
      browserInstanceId: "unbound",
      browserSkillStatus: "offline",
      bskVersion: "unavailable",
      extensionVersion: "unavailable",
      cliShapeHash: "unavailable",
    },
  });

  assert.equal(offlineRuntimeExit, 1);
  assert.match(stderrChunks.join(""), /runtime|browser skill|unbound|offline/i);
});

test("connect fails closed when a relay message exceeds the configured message bound", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-message-cap-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const socket = new FakeSocket();
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: "wss://relay.example.com/v1/device",
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0"],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
    maxMessageBytes: 32,
  });

  const running = connection.start();
  socket.open();
  socket.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1-abcdefghijklmnopqrstuvwxyz",
      },
    }),
  );

  await assert.rejects(running, /maximum allowed size/);
  assert.equal(connection.snapshot().brokerStatus, "disconnected");
});

test("connect never accepts a relay challenge missing any authoritative binding field", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-partial-challenge-"));
  const identity = await loadOrCreateDeviceIdentity(dir);

  for (const field of [
    "relayInstanceId",
    "challengeNonce",
    "deploymentCanonicalId",
    "brokerInstanceId",
    "browserInstanceId",
    "connectionEpoch",
  ] as const) {
    const socket = new FakeSocket();
    const connection = new HostBrokerConnection({
      qmUrl: "https://qm.example.com",
      relayUrl: "wss://relay.example.com/v1/device",
      brokerInstanceId: "broker-local-1",
      brokerVersion: "0.0.0-test",
      supportedProtocolVersions: ["1.0"],
      supportedPolicyGrammarVersions: ["1.0"],
      identity,
      runtime: runtime(),
      transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
    });

    const running = connection.start();
    socket.open();
    const payload = {
      relayInstanceId: "relay-a",
      challengeNonce: "nonce-1",
      deploymentCanonicalId: "qm://deployments/example",
      brokerInstanceId: "broker-local-1",
      browserInstanceId: "browser-primary",
      connectionEpoch: 7,
    } as Record<string, unknown>;
    delete payload[field];
    socket.message(
      JSON.stringify({
        protocolVersion: "1.0",
        kind: "relay.challenge",
        payload,
      }),
    );

    await assert.rejects(running, /relay\.challenge message does not match its schema/);
    assert.equal(connection.snapshot().brokerStatus, "disconnected");
    assert.equal(socket.sent.length, 1);
    assert.equal(connection.snapshot().deploymentCanonicalId, null);
    assert.equal(connection.snapshot().browserInstanceId, "browser-primary");
    assert.equal(connection.snapshot().connectionEpoch, null);
  }
});

test("connect, status, and confirmation outputs all state that QM controls the shared deployment browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-cli-"));
  const socket = new FakeSocket();
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  };

  const connectPromise = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket.open();
  socket.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  socket.close(1000, "done");
  await connectPromise;

  assert.match(stdoutChunks.join(""), /QM controls the browser on this device/);
  assert.match(stdoutChunks.join(""), /shared across this deployment/);

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const statusPayload = JSON.parse(stdoutChunks.join("")) as { notice: string };
  assert.equal(statusPayload.notice, HOST_BROKER_CONTROL_NOTICE);

  stdoutChunks.length = 0;
  await runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple), "--json"], baseDeps);
  const confirmationPayload = JSON.parse(stdoutChunks.join("")) as { notice: string; confirmationFingerprint: string };
  assert.equal(confirmationPayload.notice, HOST_BROKER_CONTROL_NOTICE);
  assert.equal(
    confirmationPayload.confirmationFingerprint,
    computeDesktopBrowserRegistrationConfirmationFingerprint(tuple),
  );
  assert.equal(stderrChunks.length, 0);
});

test("connect preserves a newer authoritative epoch after a post-handshake transport error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-reconnect-error-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  let transportCall = 0;
  const transport: HostBrokerTransport = {
    connect(url: string): HostBrokerSocket {
      assert.equal(url, "wss://relay.example.com/v1/device");
      transportCall += 1;
      return transportCall === 1 ? socket1 : socket2;
    },
  };
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  };

  const firstConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple), "--json"], baseDeps);
  const previewPayload = JSON.parse(stdoutChunks.join("")) as { confirmationFingerprint: string };

  socket1.close(1012, "service restart");
  await firstConnect;

  const secondConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch + 1,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  socket2.fail();
  assert.equal(await secondConnect, 1);

  await assert.rejects(
    () => runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple)], baseDeps),
    /connection epoch does not match the local binding/,
  );
  await assert.rejects(
    () =>
      runHostBrokerCli(
        ["confirmation", "--tuple-json", JSON.stringify(tuple), "--confirm", previewPayload.confirmationFingerprint],
        baseDeps,
      ),
    /connection epoch does not match the local binding/,
  );

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const statusPayload = JSON.parse(stdoutChunks.join("")) as {
    brokerStatus: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
  };
  assert.equal(statusPayload.brokerStatus, "disconnected");
  assert.equal(statusPayload.brokerInstanceId, tuple.brokerInstanceId);
  assert.equal(statusPayload.browserInstanceId, tuple.browserInstanceId);
  assert.equal(statusPayload.connectionEpoch, tuple.connectionEpoch + 1);
  assert.match(stderrChunks.join(""), /host broker transport failed/);
});

test("connect supervisor reconnects after 1012 service restart, keeps only one socket active, and advances the authoritative epoch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-supervisor-reconnect-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  const scheduler = new FakeScheduler();
  scheduler.randomValues = [0, 0];
  let transportCall = 0;
  const controller = new AbortController();
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, "wss://relay.example.com/v1/device");
        transportCall += 1;
        return transportCall === 1 ? socket1 : socket2;
      },
    } satisfies HostBrokerTransport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
    signal: controller.signal,
    scheduler,
    reconnectBaseMs: 200,
    reconnectMaxMs: 1_000,
  };

  const connectPromise = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCall, 1);

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const disconnectedStatus = JSON.parse(stdoutChunks.join("")) as {
    brokerStatus: string;
    processEpoch: number;
    connectionEpoch: number | null;
  };
  assert.equal(disconnectedStatus.brokerStatus, "disconnected");
  assert.equal(typeof disconnectedStatus.processEpoch, "number");
  assert.equal(disconnectedStatus.connectionEpoch, null);

  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const readyStatus = JSON.parse(stdoutChunks.join("")) as {
    brokerStatus: string;
    processEpoch: number;
    connectionEpoch: number;
  };
  assert.equal(readyStatus.brokerStatus, "ready");
  assert.equal(readyStatus.processEpoch, disconnectedStatus.processEpoch);
  assert.equal(readyStatus.connectionEpoch, tuple.connectionEpoch);

  socket1.close(1012, "service restart");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCall, 1);
  assert.equal(socket1.closeCode, 1012);

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const backoffStatus = JSON.parse(stdoutChunks.join("")) as { brokerStatus: string; connectionEpoch: number };
  assert.equal(backoffStatus.brokerStatus, "disconnected");
  assert.equal(backoffStatus.connectionEpoch, tuple.connectionEpoch);

  scheduler.advance(99);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCall, 1);
  scheduler.advance(1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCall, 2);

  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch + 1,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const reconnectedStatus = JSON.parse(stdoutChunks.join("")) as {
    brokerStatus: string;
    connectionEpoch: number;
    processEpoch: number;
  };
  assert.equal(reconnectedStatus.brokerStatus, "ready");
  assert.equal(reconnectedStatus.connectionEpoch, tuple.connectionEpoch + 1);
  assert.equal(reconnectedStatus.processEpoch, disconnectedStatus.processEpoch);

  controller.abort();
  assert.equal(await connectPromise, 0);
  assert.equal(stderrChunks.length, 0);
});

test("connect supervisor aborts during backoff without opening a duplicate socket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-supervisor-abort-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const scheduler = new FakeScheduler();
  scheduler.randomValues = [0];
  let transportCall = 0;
  const controller = new AbortController();
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, "wss://relay.example.com/v1/device");
        transportCall += 1;
        return socket1;
      },
    } satisfies HostBrokerTransport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
    signal: controller.signal,
    scheduler,
    reconnectBaseMs: 200,
    reconnectMaxMs: 1_000,
  };

  const connectPromise = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.fail();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCall, 1);
  assert.equal(socket1.closeCode, 1000);
  assert.equal(socket1.closeReason, "local cleanup");

  controller.abort();
  assert.equal(await connectPromise, 0);
  assert.equal(transportCall, 1);

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const statusPayload = JSON.parse(stdoutChunks.join("")) as { brokerStatus: string };
  assert.equal(statusPayload.brokerStatus, "disconnected");
  assert.equal(stderrChunks.length, 0);
});

test("connect supervisor fails closed on fatal close code without retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-supervisor-fatal-close-"));
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  const scheduler = new FakeScheduler();
  let transportCall = 0;
  const controller = new AbortController();
  const baseDeps = {
    dataDir: dir,
    stdout: { write() {} },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, "wss://relay.example.com/v1/device");
        transportCall += 1;
        return transportCall === 1 ? socket1 : socket2;
      },
    } satisfies HostBrokerTransport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
    signal: controller.signal,
    scheduler,
    reconnectBaseMs: 200,
    reconnectMaxMs: 1_000,
  };

  const connectPromise = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  socket1.close(1008, "policy violation");
  assert.equal(await connectPromise, 1);
  assert.equal(transportCall, 1);
  assert.equal(socket2.sent.length, 0);
  assert.match(stderrChunks.join(""), /nonretryable code \(code 1008, reason "policy violation"\)/);
});

test("connect supervisor fails closed on a nonretryable lower-epoch challenge after reconnect", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-supervisor-nonretryable-"));
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  const scheduler = new FakeScheduler();
  scheduler.randomValues = [0, 0];
  let transportCall = 0;
  const controller = new AbortController();
  const baseDeps = {
    dataDir: dir,
    stdout: { write() {} },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, "wss://relay.example.com/v1/device");
        transportCall += 1;
        return transportCall === 1 ? socket1 : socket2;
      },
    } satisfies HostBrokerTransport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
    signal: controller.signal,
    scheduler,
    reconnectBaseMs: 200,
    reconnectMaxMs: 1_000,
  };

  const connectPromise = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch + 1,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));
  socket1.close(1012, "service restart");
  await new Promise((resolve) => setImmediate(resolve));

  scheduler.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transportCall, 2);

  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );

  assert.equal(await connectPromise, 1);
  assert.equal(transportCall, 2);
  assert.match(stderrChunks.join(""), /connection epoch.*older|older.*connection epoch/i);
});

test("live connect stores authoritative binding and stale preview then confirm both fail after reconnect epoch change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-reconnect-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  let transportCall = 0;
  const transport: HostBrokerTransport = {
    connect(url: string): HostBrokerSocket {
      assert.equal(url, "wss://relay.example.com/v1/device");
      transportCall += 1;
      return transportCall === 1 ? socket1 : socket2;
    },
  };
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  };

  const firstConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple), "--json"], baseDeps);
  const previewPayload = JSON.parse(stdoutChunks.join("")) as { confirmationFingerprint: string };

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const firstStatusPayload = JSON.parse(stdoutChunks.join("")) as {
    qmUrl: string;
    relayUrl: string;
    deploymentCanonicalId: string;
    brokerStatus: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
    confirmationFingerprint: string;
  };
  assert.equal(firstStatusPayload.qmUrl, "https://qm.example.com");
  assert.equal(firstStatusPayload.relayUrl, "wss://relay.example.com/v1/device");
  assert.equal(firstStatusPayload.deploymentCanonicalId, tuple.deploymentCanonicalId);
  assert.equal(firstStatusPayload.brokerStatus, "ready");
  assert.equal(firstStatusPayload.brokerInstanceId, tuple.brokerInstanceId);
  assert.equal(firstStatusPayload.browserInstanceId, tuple.browserInstanceId);
  assert.equal(firstStatusPayload.connectionEpoch, tuple.connectionEpoch);
  assert.equal(firstStatusPayload.confirmationFingerprint, previewPayload.confirmationFingerprint);

  socket1.close(1012, "service restart");
  await firstConnect;

  const secondConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch + 1,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  await assert.rejects(
    () => runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple)], baseDeps),
    /connection epoch does not match the local binding/,
  );
  await assert.rejects(
    () =>
      runHostBrokerCli(
        ["confirmation", "--tuple-json", JSON.stringify(tuple), "--confirm", previewPayload.confirmationFingerprint],
        baseDeps,
      ),
    /connection epoch does not match the local binding/,
  );

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const statusPayload = JSON.parse(stdoutChunks.join("")) as { connectionEpoch: number; brokerInstanceId: string };
  assert.equal(statusPayload.connectionEpoch, tuple.connectionEpoch + 1);
  assert.equal(statusPayload.brokerInstanceId, tuple.brokerInstanceId);

  socket2.close(1000, "done");
  await secondConnect;
  assert.equal(stderrChunks.length, 0);
});

test("live connect accepts an identical reconnect idempotently without altering stored confirmation preview state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-reconnect-idempotent-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  let transportCall = 0;
  const transport: HostBrokerTransport = {
    connect(url: string): HostBrokerSocket {
      assert.equal(url, "wss://relay.example.com/v1/device");
      transportCall += 1;
      return transportCall === 1 ? socket1 : socket2;
    },
  };
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  };

  const firstConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple), "--json"], baseDeps);
  const previewPayload = JSON.parse(stdoutChunks.join("")) as {
    confirmationFingerprint: string;
    publicDeviceFingerprint: string;
  };

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const firstStatusPayload = JSON.parse(stdoutChunks.join("")) as {
    deploymentCanonicalId: string;
    brokerStatus: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
    confirmationFingerprint: string;
    publicDeviceFingerprint: string;
  };
  assert.equal(firstStatusPayload.deploymentCanonicalId, tuple.deploymentCanonicalId);
  assert.equal(firstStatusPayload.brokerStatus, "ready");
  assert.equal(firstStatusPayload.brokerInstanceId, tuple.brokerInstanceId);
  assert.equal(firstStatusPayload.browserInstanceId, tuple.browserInstanceId);
  assert.equal(firstStatusPayload.connectionEpoch, tuple.connectionEpoch);
  assert.equal(firstStatusPayload.confirmationFingerprint, previewPayload.confirmationFingerprint);
  assert.equal(firstStatusPayload.publicDeviceFingerprint, previewPayload.publicDeviceFingerprint);

  socket1.close(1012, "service restart");
  await firstConnect;

  const secondConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const secondStatusPayload = JSON.parse(stdoutChunks.join("")) as {
    deploymentCanonicalId: string;
    brokerStatus: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
    confirmationFingerprint: string;
    publicDeviceFingerprint: string;
  };
  assert.equal(secondStatusPayload.deploymentCanonicalId, firstStatusPayload.deploymentCanonicalId);
  assert.equal(secondStatusPayload.brokerStatus, "ready");
  assert.equal(secondStatusPayload.brokerInstanceId, firstStatusPayload.brokerInstanceId);
  assert.equal(secondStatusPayload.browserInstanceId, firstStatusPayload.browserInstanceId);
  assert.equal(secondStatusPayload.connectionEpoch, firstStatusPayload.connectionEpoch);
  assert.equal(secondStatusPayload.confirmationFingerprint, firstStatusPayload.confirmationFingerprint);
  assert.equal(secondStatusPayload.publicDeviceFingerprint, firstStatusPayload.publicDeviceFingerprint);

  socket2.close(1000, "done");
  assert.equal(await secondConnect, 0);
  assert.equal(stderrChunks.length, 0);
});

test("replayed lower-epoch relay challenges are rejected and cannot roll back stale reservation confirmation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-lower-epoch-replay-"));
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  const socket3 = new FakeSocket();
  let transportCall = 0;
  const transport: HostBrokerTransport = {
    connect(url: string): HostBrokerSocket {
      assert.equal(url, "wss://relay.example.com/v1/device");
      transportCall += 1;
      if (transportCall === 1) return socket1;
      if (transportCall === 2) return socket2;
      return socket3;
    },
  };
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderrChunks.push(chunk);
      },
    },
    transport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
  };

  const firstConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple), "--json"], baseDeps);
  const previewPayload = JSON.parse(stdoutChunks.join("")) as { confirmationFingerprint: string };

  socket1.close(1012, "service restart");
  await firstConnect;

  const higherEpochTuple = { ...tuple, connectionEpoch: tuple.connectionEpoch + 1 };
  const secondConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: higherEpochTuple.connectionEpoch,
      },
    }),
  );
  socket2.close(1012, "service restart");
  assert.equal(await secondConnect, 0);

  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b-stale",
        challengeNonce: "nonce-stale",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: higherEpochTuple.connectionEpoch + 1,
      },
    }),
  );

  const replayedLowerEpochConnect = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket3.open();
  socket3.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-c",
        challengeNonce: "nonce-3",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );

  assert.equal(await replayedLowerEpochConnect, 1);
  assert.match(stderrChunks.join(""), /connection epoch.*older|older.*connection epoch/i);

  await assert.rejects(
    () => runHostBrokerCli(["confirmation", "--tuple-json", JSON.stringify(tuple)], baseDeps),
    /connection epoch does not match the local binding/,
  );
  await assert.rejects(
    () =>
      runHostBrokerCli(
        ["confirmation", "--tuple-json", JSON.stringify(tuple), "--confirm", previewPayload.confirmationFingerprint],
        baseDeps,
      ),
    /connection epoch does not match the local binding/,
  );

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const statusPayload = JSON.parse(stdoutChunks.join("")) as {
    brokerStatus: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
  };
  assert.equal(statusPayload.brokerStatus, "disconnected");
  assert.equal(statusPayload.brokerInstanceId, tuple.brokerInstanceId);
  assert.equal(statusPayload.browserInstanceId, tuple.browserInstanceId);
  assert.equal(statusPayload.connectionEpoch, higherEpochTuple.connectionEpoch);
});

test("late stale frames after a retryable close are ignored and do not mutate persisted state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-stale-frame-ignored-"));
  const stdoutChunks: string[] = [];
  const identity = await loadOrCreateDeviceIdentity(dir);
  const tuple = tupleForIdentity(identity.devicePublicKey);
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();
  const scheduler = new FakeScheduler();
  scheduler.randomValues = [0, 0];
  let transportCall = 0;
  const controller = new AbortController();
  const baseDeps = {
    dataDir: dir,
    stdout: {
      write(chunk: string) {
        stdoutChunks.push(chunk);
      },
    },
    stderr: { write() {} },
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, "wss://relay.example.com/v1/device");
        transportCall += 1;
        return transportCall === 1 ? socket1 : socket2;
      },
    } satisfies HostBrokerTransport,
    resolveRelayUrl: () => "wss://relay.example.com/v1/device",
    brokerInstanceId: tuple.brokerInstanceId,
    brokerVersion: "0.0.0-test",
    runtime: runtime(),
    signal: controller.signal,
    scheduler,
    reconnectBaseMs: 200,
    reconnectMaxMs: 1_000,
  };

  const connectPromise = runHostBrokerCli(["connect", "https://qm.example.com"], baseDeps);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.open();
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  socket1.close(1012, "service restart");
  await new Promise((resolve) => setImmediate(resolve));
  scheduler.advance(100);
  await new Promise((resolve) => setImmediate(resolve));
  socket1.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a-stale",
        challengeNonce: "nonce-stale",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch + 9,
      },
    }),
  );
  assert.equal(transportCall, 2);

  socket2.open();
  socket2.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-b",
        challengeNonce: "nonce-2",
        deploymentCanonicalId: tuple.deploymentCanonicalId,
        brokerInstanceId: tuple.brokerInstanceId,
        browserInstanceId: tuple.browserInstanceId,
        connectionEpoch: tuple.connectionEpoch + 1,
      },
    }),
  );
  await new Promise((resolve) => setImmediate(resolve));

  stdoutChunks.length = 0;
  await runHostBrokerCli(["status", "--json"], baseDeps);
  const statusPayload = JSON.parse(stdoutChunks.join("")) as { connectionEpoch: number; brokerStatus: string };
  assert.equal(statusPayload.brokerStatus, "ready");
  assert.equal(statusPayload.connectionEpoch, tuple.connectionEpoch + 1);

  controller.abort();
  assert.equal(await connectPromise, 0);
});

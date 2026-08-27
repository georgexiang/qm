import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  encodeHostChallengeResponseSigningBytes,
  type HostChallengeResponseMessage,
  type RelayChallengeMessage,
} from "../packages/desktop-browser-contracts/src/index.ts";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayBinding,
  type DesktopBrowserRelayClock,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
  type DesktopBrowserRelaySocket,
} from "../packages/qm-broker-relay/src/index.ts";

class ManualClock implements DesktopBrowserRelayClock {
  private nowMs = 1_725_000_000_000;
  private nextId = 1;
  private readonly timeouts = new Map<number, { at: number; callback: () => void }>();
  private readonly intervals = new Map<number, { at: number; every: number; callback: () => void }>();

  now(): number {
    return this.nowMs;
  }

  setTimeout(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.timeouts.set(id, { at: this.nowMs + ms, callback });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timeouts.delete(handle as number);
  }

  setInterval(callback: () => void, ms: number): number {
    const id = this.nextId++;
    this.intervals.set(id, { at: this.nowMs + ms, every: ms, callback });
    return id;
  }

  clearInterval(handle: unknown): void {
    this.intervals.delete(handle as number);
  }

  tick(ms: number): void {
    const target = this.nowMs + ms;
    while (true) {
      let nextAt = target;
      let timeoutId: number | null = null;
      let intervalId: number | null = null;
      for (const [id, timer] of this.timeouts) {
        if (timer.at <= nextAt) {
          nextAt = timer.at;
          timeoutId = id;
          intervalId = null;
        }
      }
      for (const [id, timer] of this.intervals) {
        if (timer.at <= nextAt) {
          nextAt = timer.at;
          timeoutId = null;
          intervalId = id;
        }
      }
      if (timeoutId === null && intervalId === null) break;
      this.nowMs = nextAt;
      if (timeoutId !== null) {
        const timer = this.timeouts.get(timeoutId);
        if (!timer) continue;
        this.timeouts.delete(timeoutId);
        timer.callback();
        continue;
      }
      const interval = this.intervals.get(intervalId!);
      if (!interval) continue;
      interval.at += interval.every;
      interval.callback();
    }
    this.nowMs = target;
  }
}

class FakeSocket implements DesktopBrowserRelaySocket {
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  readonly pings: number[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  addEventListener(type: "message" | "close" | "error" | "pong", listener: (event?: unknown) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closeCode = code;
    this.closeReason = reason;
    this.emit("close", { code, reason });
  }

  ping(): void {
    this.pings.push(this.pings.length + 1);
  }

  message(data: string): void {
    this.emit("message", { data });
  }

  pong(): void {
    this.emit("pong");
  }

  fail(): void {
    this.emit("error", new Error("socket failed"));
  }

  private emit(type: string, event?: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
}

class FakeRegistryAdapter implements DesktopBrowserRelayRegistryAdapter {
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

  setBinding(
    binding: Omit<DesktopBrowserRelayBinding, "registrationId"> &
      Partial<Pick<DesktopBrowserRelayBinding, "registrationId">>,
  ): void {
    this.bindings.set(`${binding.devicePublicKey}\u0000${binding.brokerInstanceId}`, {
      registrationId: binding.registrationId ?? `reg-${binding.browserInstanceId}-${binding.connectionEpoch}`,
      ...binding,
    });
  }
}

function createDeviceIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const exported = publicKey.export({ format: "der", type: "spki" });
  const devicePublicKey = `ed25519:${Buffer.from(exported).toString("base64")}`;
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

function hostHello(devicePublicKey: string, brokerInstanceId: string) {
  return JSON.stringify({
    protocolVersion: "1.2",
    kind: "host.hello",
    payload: {
      devicePublicKey,
      brokerInstanceId,
      brokerVersion: "0.0.0-test",
      supportedProtocolVersions: ["1.2"],
      supportedPolicyGrammarVersions: ["1.1", "1.0"],
      bskVersion: "bsk-1",
      extensionVersion: "extension-1",
      cliShapeHash: "shape-1",
    },
  });
}

function challengeAt(socket: FakeSocket, index = 0): RelayChallengeMessage {
  return JSON.parse(socket.sent[index] ?? "") as RelayChallengeMessage;
}

async function flushMessages(): Promise<void> {
  await new Promise((resolve) => setImmediate(resolve));
}

function hostChallengeResponse(
  challenge: RelayChallengeMessage,
  input: {
    devicePublicKey: string;
    browserInstanceId?: string;
    connectionEpoch?: number;
    challengeNonce?: string;
    brokerInstanceId?: string;
    deploymentCanonicalId?: string;
    signResponse: (
      payload: Omit<HostChallengeResponseMessage["payload"], "signatureAlgorithm" | "signature">,
    ) => string;
  },
): string {
  const payload = {
    relayInstanceId: challenge.payload.relayInstanceId,
    deploymentCanonicalId: input.deploymentCanonicalId ?? challenge.payload.deploymentCanonicalId,
    devicePublicKey: input.devicePublicKey,
    brokerInstanceId: input.brokerInstanceId ?? challenge.payload.brokerInstanceId,
    browserInstanceId: input.browserInstanceId ?? challenge.payload.browserInstanceId,
    connectionEpoch: input.connectionEpoch ?? challenge.payload.connectionEpoch,
    challengeNonce: input.challengeNonce ?? challenge.payload.challengeNonce,
  };
  return JSON.stringify({
    protocolVersion: challenge.protocolVersion,
    kind: "host.challenge-response",
    payload: {
      ...payload,
      signatureAlgorithm: "ed25519",
      signature: input.signResponse(payload),
    },
  });
}

test("relay keeps a verified host pending until registration refresh promotes it and blocks invocation while pending", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "pending",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.0", "1.2"],
    supportedPolicyGrammarVersions: ["1.0", "1.1"],
    registry: adapter,
    clock,
    createNonce: () => "nonce-1",
    createConnectionId: () => "connection-1",
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge = challengeAt(socket);
  assert.equal(challenge.protocolVersion, "1.2");

  socket.message(
    hostChallengeResponse(challenge, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  const published = adapter.published.get("connection-1");
  assert.ok(published);
  assert.equal(published.registrationState, "pending");
  assert.equal(published.protocolVersion, "1.2");
  assert.equal(published.policyGrammarVersion, "1.1");

  await assert.rejects(
    () =>
      service.dispatchInvocation({
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        browserInstanceId: "browser-a",
      }),
    /pending registration/,
  );

  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  await service.refreshBinding({ devicePublicKey: identity.devicePublicKey, brokerInstanceId: "broker-a" });
  assert.equal(adapter.published.get("connection-1")?.registrationState, "registered");

  await assert.rejects(
    () =>
      service.dispatchInvocation({
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        browserInstanceId: "browser-a",
      }),
    /not implemented/,
  );
});

test("relay negotiates the highest exact shared protocol version during hello", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2", "1.0"],
    supportedPolicyGrammarVersions: ["1.1", "1.0"],
    registry: adapter,
    clock,
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(
    JSON.stringify({
      protocolVersion: "1.0",
      kind: "host.hello",
      payload: {
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        brokerVersion: "0.0.0-test",
        supportedProtocolVersions: ["1.0"],
        supportedPolicyGrammarVersions: ["1.1", "1.0"],
        bskVersion: "bsk-1",
        extensionVersion: "extension-1",
        cliShapeHash: "shape-1",
      },
    }),
  );
  await flushMessages();

  assert.equal(challengeAt(socket).protocolVersion, "1.0");
});

test("relay rejects same-major protocol versions when there is no exact overlap", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(
    JSON.stringify({
      protocolVersion: "1.1",
      kind: "host.hello",
      payload: {
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        brokerVersion: "0.0.0-test",
        supportedProtocolVersions: ["1.1"],
        supportedPolicyGrammarVersions: ["1.1"],
        bskVersion: "bsk-1",
        extensionVersion: "extension-1",
        cliShapeHash: "shape-1",
      },
    }),
  );
  await flushMessages();

  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /no compatible desktop browser protocol version available/);
});

test("relay rejects a stale challenge nonce after the response timeout elapses", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
    challengeTimeoutMs: 50,
    createNonce: () => "nonce-1",
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge = challengeAt(socket);
  clock.tick(51);
  socket.message(
    hostChallengeResponse(challenge, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /timed out|no longer current|stale/i);
});

test("relay lets a newer epoch replace an in-flight stale epoch and fences the older response", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
    createConnectionId: (() => {
      let current = 0;
      return () => `connection-${++current}`;
    })(),
  });
  const socket1 = new FakeSocket();
  const socket2 = new FakeSocket();

  service.acceptSocket(socket1);
  socket1.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge1 = challengeAt(socket1);

  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 8,
  });

  service.acceptSocket(socket2);
  socket2.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge2 = challengeAt(socket2);
  socket2.message(
    hostChallengeResponse(challenge2, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();
  assert.equal(adapter.published.get("connection-2")?.connectionEpoch, 8);

  socket1.message(
    hostChallengeResponse(challenge1, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  assert.equal(socket1.closeCode, 1008);
  assert.match(socket1.closeReason ?? "", /stale connection epoch/i);
  assert.equal(adapter.published.get("connection-2")?.connectionEpoch, 8);
  assert.equal(adapter.published.has("connection-1"), false);
});

test("relay refresh fences an old socket when the current binding moves to a new browser instance", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
    createConnectionId: (() => {
      let current = 0;
      return () => `connection-${++current}`;
    })(),
  });
  const socket1 = new FakeSocket();

  service.acceptSocket(socket1);
  socket1.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge1 = challengeAt(socket1);
  socket1.message(
    hostChallengeResponse(challenge1, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();
  assert.equal(adapter.published.get("connection-1")?.browserInstanceId, "browser-a");

  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-b",
    connectionEpoch: 8,
  });
  await service.refreshBinding({ devicePublicKey: identity.devicePublicKey, brokerInstanceId: "broker-a" });
  assert.equal(socket1.closeCode, 1008);
  assert.match(socket1.closeReason ?? "", /replaced by a newer registration/i);
  assert.equal(adapter.published.has("connection-1"), false);

  const socket2 = new FakeSocket();
  service.acceptSocket(socket2);
  socket2.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge2 = challengeAt(socket2);
  socket2.message(
    hostChallengeResponse(challenge2, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  assert.equal(socket2.closeCode, undefined);
  assert.equal(adapter.published.get("connection-2")?.browserInstanceId, "browser-b");
  assert.equal(adapter.published.get("connection-2")?.connectionEpoch, 8);
});

test("relay heartbeats a registered connection, refreshes lastSeenAt on pong, and drops liveness on a missed heartbeat", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
    heartbeatIntervalMs: 100,
    heartbeatGraceMs: 50,
    createConnectionId: () => "connection-1",
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  const challenge = challengeAt(socket);
  socket.message(
    hostChallengeResponse(challenge, {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  const firstSeenAt = adapter.published.get("connection-1")?.lastSeenAt;
  clock.tick(100);
  assert.equal(socket.pings.length, 1);
  clock.tick(25);
  socket.pong();
  await flushMessages();
  assert.notEqual(adapter.published.get("connection-1")?.lastSeenAt, firstSeenAt);
  clock.tick(100);
  assert.equal(socket.pings.length, 2);
  clock.tick(51);
  await flushMessages();
  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /heartbeat timed out/i);
});

test("relay drains active connections with 1012 and rejects new sockets while draining", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
    createConnectionId: () => "connection-1",
  });
  const live = new FakeSocket();

  service.acceptSocket(live);
  live.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  live.message(
    hostChallengeResponse(challengeAt(live), {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  await service.drain();
  assert.equal(live.closeCode, 1012);
  assert.match(live.closeReason ?? "", /service restart/i);

  const fresh = new FakeSocket();
  service.acceptSocket(fresh);
  assert.equal(fresh.closeCode, 1012);
  assert.match(fresh.closeReason ?? "", /service restart/i);
});

test("relay rejects unexpected invocation frames from the host after registration", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-a",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.1"],
    registry: adapter,
    clock,
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  socket.message(
    hostChallengeResponse(challengeAt(socket), {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-1",
        operationId: "operation-1",
        requestHash: "sha256:request-1",
        argv: ["--json", "session", "start"],
      },
    }),
  );
  await flushMessages();

  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /unexpected relay\.invoke/i);
});

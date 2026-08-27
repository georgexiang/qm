import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  computeDesktopBrowserRequestHash,
  encodeHostChallengeResponseSigningBytes,
  type HostChallengeResponseMessage,
  type RelayChallengeMessage,
} from "../packages/desktop-browser-contracts/src/index.ts";
import {
  desktopBrowserRelayInvocationFixture,
  desktopBrowserSessionStartCompletedResultFixture,
} from "../packages/desktop-browser-contracts/src/fixtures.ts";
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
    signResponse(
      payload: Omit<HostChallengeResponseMessage["payload"], "signatureAlgorithm" | "signature">,
      protocolVersion: `${number}.${number}` = "1.2",
    ): string {
      return Buffer.from(
        sign(null, Buffer.from(encodeHostChallengeResponseSigningBytes({ protocolVersion, payload })), privateKey),
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

function assertUnknownResult(
  message: { kind: string; payload: HostResultMessage["payload"] },
  expectedOperationId: string,
  expectedMessage: RegExp,
): void {
  assert.equal(message.kind, "host.result");
  if (!message.payload.accepted || message.payload.outcome !== "unknown") {
    assert.fail(`expected unknown host.result, received ${JSON.stringify(message)}`);
  }
  assert.equal(message.payload.operationId, expectedOperationId);
  assert.match(message.payload.resultHash, /^sha256:/);
  assert.equal(message.payload.error?.code, "relay_delivery_unknown");
  assert.match(message.payload.error?.message ?? "", expectedMessage);
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
      protocolVersion?: `${number}.${number}`,
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
      signature: input.signResponse(payload, challenge.protocolVersion),
    },
  });
}

async function createRegisteredTicket05Relay(
  options: { invocationTimeoutMs?: number; protocolVersion?: `${number}.${number}` } = {},
) {
  const protocolVersion = options.protocolVersion ?? "1.2";
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: [protocolVersion],
    supportedPolicyGrammarVersions: ["1.0"],
    registry: adapter,
    clock,
    createNonce: () => "nonce-1",
    createConnectionId: (() => {
      let current = 0;
      return () => `connection-${++current}`;
    })(),
    invocationTimeoutMs: options.invocationTimeoutMs,
  });
  const socket = new FakeSocket();
  service.acceptSocket(socket);
  socket.message(
    JSON.stringify({
      protocolVersion,
      kind: "host.hello",
      payload: {
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        brokerVersion: "0.0.0-test",
        supportedProtocolVersions: [protocolVersion],
        supportedPolicyGrammarVersions: ["1.0"],
        bskVersion: desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet.bskVersion,
        extensionVersion: desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet.extensionVersion,
        cliShapeHash: desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet.cliShapeHash,
      },
    }),
  );
  await flushMessages();
  socket.message(
    hostChallengeResponse(challengeAt(socket), {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();
  return { adapter, clock, identity, service, socket };
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
        invocation: desktopBrowserRelayInvocationFixture,
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
});

test("relay delivers one session-start invocation to the current registered socket and resolves its result", async () => {
  const clock = new ManualClock();
  const adapter = new FakeRegistryAdapter();
  const identity = createDeviceIdentity();
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: ["1.2"],
    supportedPolicyGrammarVersions: ["1.0"],
    registry: adapter,
    clock,
    createNonce: () => "nonce-1",
    createConnectionId: () => "connection-1",
  });
  const socket = new FakeSocket();

  service.acceptSocket(socket);
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "host.hello",
      payload: {
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        brokerVersion: "0.0.0-test",
        supportedProtocolVersions: ["1.2"],
        supportedPolicyGrammarVersions: ["1.0"],
        bskVersion: desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet.bskVersion,
        extensionVersion: desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet.extensionVersion,
        cliShapeHash: desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet.cliShapeHash,
      },
    }),
  );
  await flushMessages();
  socket.message(
    hostChallengeResponse(challengeAt(socket), {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );
  await flushMessages();

  const result = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  await flushMessages();
  assert.equal(socket.sent.length, 2);
  assert.deepEqual(JSON.parse(socket.sent[1]!), desktopBrowserRelayInvocationFixture);

  socket.message(JSON.stringify(desktopBrowserSessionStartCompletedResultFixture));
  assert.deepEqual(await result, desktopBrowserSessionStartCompletedResultFixture);
});

test("relay surfaces unknown when a delivered session-start dispatch times out", async () => {
  const { clock, identity, service, socket } = await createRegisteredTicket05Relay({
    invocationTimeoutMs: 50,
  });

  const result = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  await flushMessages();
  assert.equal(socket.sent.length, 2);

  clock.tick(51);
  const unknown = await result;
  assertUnknownResult(
    unknown,
    desktopBrowserRelayInvocationFixture.payload.authority.operationId,
    /timed out waiting for host\.result/i,
  );
  assert.equal(socket.sent.length, 2);
  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /timed out waiting for host\.result/i);
});

test("relay surfaces unknown when an in-flight session-start dispatch loses its socket", async () => {
  const { identity, service, socket } = await createRegisteredTicket05Relay();
  const result = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  await flushMessages();

  socket.close(1006, "connection lost");
  const unknown = await result;
  assertUnknownResult(
    unknown,
    desktopBrowserRelayInvocationFixture.payload.authority.operationId,
    /connection lost|closed before host\.result/i,
  );
});

test("relay rejects a session-start dispatch unless the socket negotiated exactly protocol 1.2", async () => {
  const { identity, service, socket } = await createRegisteredTicket05Relay({ protocolVersion: "1.3" });

  await assert.rejects(
    () =>
      service.dispatchInvocation({
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        browserInstanceId: "browser-primary",
        invocation: desktopBrowserRelayInvocationFixture,
      }),
    /requires negotiated protocol version 1\.2/,
  );
  assert.equal(socket.sent.length, 1);
});

test("relay independently rejects mismatched capability identity and request hash before delivery", async () => {
  const { identity, service, socket } = await createRegisteredTicket05Relay();
  const authority = {
    ...desktopBrowserRelayInvocationFixture.payload.authority,
    capabilitySet: {
      ...desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet,
      bskVersion: "different-bsk-version",
    },
  };

  await assert.rejects(
    () =>
      service.dispatchInvocation({
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        browserInstanceId: "browser-primary",
        invocation: {
          ...desktopBrowserRelayInvocationFixture,
          payload: {
            ...desktopBrowserRelayInvocationFixture.payload,
            authority,
            requestHash: computeDesktopBrowserRequestHash(authority),
          },
        },
      }),
    /capability set does not match/,
  );
  await assert.rejects(
    () =>
      service.dispatchInvocation({
        devicePublicKey: identity.devicePublicKey,
        brokerInstanceId: "broker-a",
        browserInstanceId: "browser-primary",
        invocation: {
          ...desktopBrowserRelayInvocationFixture,
          payload: { ...desktopBrowserRelayInvocationFixture.payload, requestHash: "sha256:wrong" },
        },
      }),
    /requestHash .* does not match canonical request hash/,
  );
  assert.equal(socket.sent.length, 1);
});

test("relay surfaces unknown and fences the socket when host.result names the wrong operation", async () => {
  const { identity, service, socket } = await createRegisteredTicket05Relay();
  const result = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  await flushMessages();
  socket.message(
    JSON.stringify({
      ...desktopBrowserSessionStartCompletedResultFixture,
      payload: {
        ...desktopBrowserSessionStartCompletedResultFixture.payload,
        operationId: "0198f3d2-1950-7000-8000-000000000099",
      },
    }),
  );

  const unknown = await result;
  assertUnknownResult(
    unknown,
    desktopBrowserRelayInvocationFixture.payload.authority.operationId,
    /operation does not match the in-flight invocation/i,
  );
  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /operation does not match/i);
});

test("relay rejects a duplicate result after resolving the correlated dispatch once", async () => {
  const { identity, service, socket } = await createRegisteredTicket05Relay();
  const result = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  await flushMessages();
  socket.message(JSON.stringify(desktopBrowserSessionStartCompletedResultFixture));
  assert.deepEqual(await result, desktopBrowserSessionStartCompletedResultFixture);

  socket.message(JSON.stringify(desktopBrowserSessionStartCompletedResultFixture));
  await flushMessages();
  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /without an in-flight invocation/i);
});

test("relay rejects repeated dispatch identities and operation hash conflicts without redelivery", async () => {
  const { identity, service, socket } = await createRegisteredTicket05Relay();
  const dispatch = (invocation: typeof desktopBrowserRelayInvocationFixture) =>
    service.dispatchInvocation({
      devicePublicKey: identity.devicePublicKey,
      brokerInstanceId: "broker-a",
      browserInstanceId: "browser-primary",
      invocation,
    });
  const first = dispatch(desktopBrowserRelayInvocationFixture);
  await flushMessages();
  socket.message(JSON.stringify(desktopBrowserSessionStartCompletedResultFixture));
  await first;

  await assert.rejects(() => dispatch(desktopBrowserRelayInvocationFixture), /operation was already dispatched/i);
  const conflictingAuthority = {
    ...desktopBrowserRelayInvocationFixture.payload.authority,
    taskId: "task-conflict",
  };
  await assert.rejects(
    () =>
      dispatch({
        ...desktopBrowserRelayInvocationFixture,
        payload: {
          dispatchId: "0198f3d2-1950-7000-8000-000000000003",
          authority: conflictingAuthority,
          requestHash: computeDesktopBrowserRequestHash(conflictingAuthority),
        },
      }),
    /operationId .* different requestHash/i,
  );
  const newOperationAuthority = {
    ...desktopBrowserRelayInvocationFixture.payload.authority,
    operationId: "0198f3d2-1950-7000-8000-000000000004",
    operationSequence: 2,
  };
  await assert.rejects(
    () =>
      dispatch({
        ...desktopBrowserRelayInvocationFixture,
        payload: {
          dispatchId: desktopBrowserRelayInvocationFixture.payload.dispatchId,
          authority: newOperationAuthority,
          requestHash: computeDesktopBrowserRequestHash(newOperationAuthority),
        },
      }),
    /dispatchId .* already used/i,
  );
  assert.equal(socket.sent.length, 2);
});

test("relay surfaces unknown for a delivered stale dispatch when a newer connection epoch supersedes its socket", async () => {
  const { adapter, identity, service, socket: staleSocket } = await createRegisteredTicket05Relay();
  const staleResult = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  adapter.setBinding({
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    connectionEpoch: 8,
  });
  const currentSocket = new FakeSocket();
  service.acceptSocket(currentSocket);
  currentSocket.message(hostHello(identity.devicePublicKey, "broker-a"));
  await flushMessages();
  currentSocket.message(
    hostChallengeResponse(challengeAt(currentSocket), {
      devicePublicKey: identity.devicePublicKey,
      signResponse: identity.signResponse,
    }),
  );

  const unknown = await staleResult;
  assertUnknownResult(
    unknown,
    desktopBrowserRelayInvocationFixture.payload.authority.operationId,
    /replaced by a newer relay registration/i,
  );
  assert.equal(staleSocket.closeCode, 1008);
  assert.match(staleSocket.closeReason ?? "", /replaced by a newer relay registration/i);

  staleSocket.message(JSON.stringify(desktopBrowserSessionStartCompletedResultFixture));
  await flushMessages();
  assert.equal(currentSocket.closeCode, undefined);
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

test("relay drains active connections with 1012, surfaces unknown for delivered work, and rejects new sockets", async () => {
  const { identity, service, socket: live } = await createRegisteredTicket05Relay();
  const result = service.dispatchInvocation({
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-a",
    browserInstanceId: "browser-primary",
    invocation: desktopBrowserRelayInvocationFixture,
  });
  await flushMessages();

  await service.drain();
  const unknown = await result;
  assertUnknownResult(unknown, desktopBrowserRelayInvocationFixture.payload.authority.operationId, /service restart/i);
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
  socket.message(JSON.stringify(desktopBrowserRelayInvocationFixture));
  await flushMessages();

  assert.equal(socket.closeCode, 1008);
  assert.match(socket.closeReason ?? "", /unexpected relay\.invoke/i);
});

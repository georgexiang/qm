import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  decodeDesktopBrowserMessage,
  type HostChallengeResponseMessage,
} from "../packages/desktop-browser-contracts/src/index.ts";
import { desktopBrowserRegistrationReservationTupleFixture } from "../packages/desktop-browser-contracts/src/fixtures.ts";
import {
  HOST_BROKER_CONTROL_NOTICE,
  HostBrokerConnection,
  loadOrCreateDeviceIdentity,
  createRegistrationConfirmationPreview,
  confirmRegistration,
  runHostBrokerCli,
  verifyHostChallengeResponseMessage,
  verifyRegistrationConfirmationEnvelopeSignature,
  type BrowserRuntimeMetadata,
  type HostBrokerSocket,
  type HostBrokerTransport,
} from "../packages/qm-host-broker/src/index.ts";

class FakeSocket implements HostBrokerSocket {
  private readonly listeners = new Map<string, Array<(event?: unknown) => void>>();
  readonly sent: string[] = [];
  closeCode: number | undefined;
  closeReason: string | undefined;

  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: unknown) => void): void {
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

  open(): void {
    this.emit("open");
  }

  message(data: string): void {
    this.emit("message", { data });
  }

  fail(): void {
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
    connectionEpoch: 7,
    devicePublicKey: identity.devicePublicKey,
    publicDeviceFingerprint: null,
    confirmationFingerprint: null,
    notice: HOST_BROKER_CONTROL_NOTICE,
  });

  socket.close(1000, "done");
  await running;
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
  await running;
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

  socket1.close(1000, "rotate");
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

  socket1.close(1000, "rotate");
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

  socket1.close(1000, "rotate");
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

  socket1.close(1000, "rotate");
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
  socket2.close(1000, "rotate");
  assert.equal(await secondConnect, 0);

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

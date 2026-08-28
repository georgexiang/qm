import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  accessSync,
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
  DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  buildDesktopBrowserNavigateArgv,
  buildDesktopBrowserObserveArgv,
  buildDesktopBrowserSessionStopArgv,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  computeDesktopBrowserRequestHash,
  decodeDesktopBrowserMessage,
  projectDesktopBrowserPublicIdentity,
  type DesktopBrowserOperationAuthorityEnvelope,
  type DesktopBrowserSessionStartAuthorityEnvelope,
  type HostAcceptedMessage,
  type HostChallengeResponseMessage,
  type HostResultMessage,
} from "../packages/desktop-browser-contracts/src/index.ts";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayBinding,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
  type DesktopBrowserRelaySocket,
} from "../packages/qm-broker-relay/src/index.ts";
import { createDesktopBrowserRelayServer } from "../packages/qm-broker-relay/src/server.ts";
import {
  createDesktopBrowserRelayOperationStore,
  createMemoryDesktopBrowserRelayOperationBacking,
} from "../packages/qm-broker-relay/src/operation-store.ts";
import { desktopBrowserRegistrationReservationTupleFixture } from "../packages/desktop-browser-contracts/src/fixtures.ts";
import { createDesktopBrowserTaskStore, type DesktopBrowserTask } from "../src/desktop-browser/browser-task-store.ts";
import { createDesktopBrowserOperationCoordinator } from "../src/desktop-browser/operation-coordinator.ts";
import { projectDesktopBrowserTaskActivity } from "../src/desktop-browser/task-activity.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { createAuditLog } from "../src/audit/audit-log.ts";
import { createHttpDesktopBrowserRelayDispatcher } from "../src/desktop-browser/relay-dispatcher.ts";
import { createPiTools, type ToolContextRef } from "../src/harness/pi-tools.ts";
import {
  HOST_BROKER_CONTROL_NOTICE,
  HostBrokerSpawnRejectedError,
  HostBrokerConnection,
  createDefaultHostBrokerSessionRunner,
  loadOrCreateDeviceIdentity,
  createRegistrationConfirmationPreview,
  confirmRegistration,
  resolveInstalledBrowserSkillExecutable,
  runHostBrokerCli,
  resolveRelayUrlFromEnv,
  verifyHostChallengeResponseMessage,
  verifyRegistrationConfirmationEnvelopeSignature,
  type BrowserRuntimeMetadata,
  type HostBrokerScheduler,
  type HostBrokerSessionRunner,
  type HostBrokerSocket,
  type HostBrokerTransport,
  type HostBrokerWriteObserver,
} from "../packages/qm-host-broker/src/index.ts";
import WebSocket from "ws";
import {
  HOST_BROKER_COMPANION_ORIGIN,
  createHostBrokerLocalControl,
  listHostBrokerLocalStopReceipts,
  type HostBrokerLocalControl,
} from "../packages/qm-host-broker/src/companion-control.ts";

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

function writeExecutable(path: string, body: string = "#!/bin/sh\nexit 0\n"): string {
  writeFileSync(path, body, "utf8");
  chmodSync(path, 0o755);
  accessSync(path);
  return path;
}

const TEST_BROWSER_SKILL_EXECUTABLE = writeExecutable(
  join(mkdtempSync(join(tmpdir(), "host-broker-test-executable-")), "bsk"),
);

class FakeChildProcess extends EventEmitter {
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly killSignals: string[] = [];

  kill(signal: string): boolean {
    this.killSignals.push(signal);
    return true;
  }

  close(exitCode: number | null = null): void {
    this.emit("close", exitCode);
  }

  fail(error: Error): void {
    this.emit("error", error);
  }
}

function sessionStartAuthority(
  operationId: string,
  now: number = Date.now(),
): DesktopBrowserSessionStartAuthorityEnvelope {
  const issuedAt = new Date(now - 1_000).toISOString();
  return {
    authorityVersion: "1.0",
    audience: DESKTOP_BROWSER_RELAY_AUDIENCE,
    deploymentCanonicalId: "qm://deployments/example",
    actorId: "actor-1",
    actorSnapshotHash: "sha256:actor-snapshot-1",
    projectId: "project-1",
    projectSnapshotHash: "sha256:project-snapshot-1",
    membershipEpoch: 42,
    taskId: "task-1",
    attemptId: "attempt-1",
    deviceId: "device-1",
    browserInstanceId: "browser-primary",
    leaseId: "lease-1",
    leaseVersion: 3,
    leaseExpiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
    operationId,
    operationSequence: 1,
    capabilitySet: {
      protocolVersion: "1.2",
      policyGrammarVersion: "1.0",
      bskVersion: runtime().bskVersion,
      extensionVersion: runtime().extensionVersion,
      cliShapeHash: runtime().cliShapeHash,
    },
    argv: ["--json", "session", "start", "--browser", "browser-primary"],
    brokerOptions: { forceSharedRuntime: false },
    effectClass: "local_effect",
    nonce: "nonce-operation-1",
    issuedAt,
  };
}

async function connectOperationHost(input: {
  dataDir: string;
  sessionRunner: HostBrokerSessionRunner;
  browserSkillTimeoutMs?: number;
  browserSkillExecutable?: string;
  now?: number;
  supportedPolicyGrammarVersions?: string[];
  challengePolicyGrammarVersion?: string;
  protocolVersion?: "1.2" | "1.3";
  localControl?: HostBrokerLocalControl;
}): Promise<{ socket: FakeSocket; running: Promise<unknown> }> {
  const identity = await loadOrCreateDeviceIdentity(input.dataDir);
  const socket = new FakeSocket();
  const scheduler = new FakeScheduler();
  scheduler.nowMs = input.now ?? Date.now();
  const protocolVersion = input.protocolVersion ?? "1.2";
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: "wss://relay.example.com/v1/device",
    deploymentCanonicalId: "qm://deployments/example",
    deviceId: "device-1",
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0", protocolVersion],
    supportedPolicyGrammarVersions: input.supportedPolicyGrammarVersions ?? ["1.0"],
    identity,
    runtime: runtime(),
    dataDir: input.dataDir,
    browserSkillExecutable: input.browserSkillExecutable ?? TEST_BROWSER_SKILL_EXECUTABLE,
    sessionRunner: input.sessionRunner,
    localControl: input.localControl,
    browserSkillTimeoutMs: input.browserSkillTimeoutMs,
    scheduler,
    transport: new FakeTransport(socket, "wss://relay.example.com/v1/device"),
  });
  const running = connection.start();
  socket.open();
  socket.message(
    JSON.stringify({
      protocolVersion,
      kind: "relay.challenge",
      payload: {
        relayInstanceId: "relay-a",
        challengeNonce: "nonce-1",
        deploymentCanonicalId: "qm://deployments/example",
        brokerInstanceId: "broker-local-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
        ...(input.challengePolicyGrammarVersion ? { policyGrammarVersion: input.challengePolicyGrammarVersion } : {}),
      },
    }),
  );
  await waitFor(() => (socket.sent.length >= 2 ? true : undefined), "host challenge response");
  return { socket, running };
}

test("Ticket 10 local Companion Stop cancels the real Host operation and persists a receipt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-local-companion-stop-"));
  let rejectRun!: (reason: Error) => void;
  let cancelReason = "";
  const sessionRunner: HostBrokerSessionRunner = {
    run() {
      return {
        result: new Promise((_resolve, reject) => {
          rejectRun = reject;
        }),
        async cancel(reason) {
          cancelReason = reason?.message ?? "";
          rejectRun(reason ?? new Error("canceled"));
        },
      };
    },
  };
  const control = createHostBrokerLocalControl({
    dataDir: dir,
    processEpoch: 99,
    now: () => 30_000,
    createNonce: () => "host-stop-nonce",
  });
  const authority = sessionStartAuthority("operation-local-companion-stop");
  const { socket, running } = await connectOperationHost({ dataDir: dir, sessionRunner, localControl: control });
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-local-companion-stop",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
        authority,
      },
    }),
  );
  await waitFor(() => socket.sent[2], "local Companion Host acceptance");
  const status = control.status(HOST_BROKER_COMPANION_ORIGIN);
  assert.equal(status.currentTaskPresent, true);
  assert.equal(status.operationCategory, "session_start");

  assert.equal(await control.stop(HOST_BROKER_COMPANION_ORIGIN, status.stopNonce!), "stopped");
  const terminal = decodeDesktopBrowserMessage(
    await waitFor(() => socket.sent[3], "local Companion Host terminal"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(terminal.payload.outcome, "unknown");
  assert.match(cancelReason, /local Companion/);
  assert.equal(listHostBrokerLocalStopReceipts(dir).length, 1);

  socket.close(1000, "done");
  await running;
});

test("Ticket 11 Host replays a Local Stop Receipt after reconnect until Relay acknowledgement", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-local-stop-replay-"));
  const control = createHostBrokerLocalControl({
    dataDir: dir,
    processEpoch: 101,
    now: () => 35_000,
    createNonce: () => "receipt-replay-nonce",
  });
  control.beginOperation({
    taskId: "task-receipt-replay",
    attemptId: "attempt-receipt-replay",
    operationId: "operation-receipt-replay",
    category: "browser_effect",
    startedAt: 34_000,
    cancel: async () => {
      throw new Error("Host crashed before cancellation confirmation");
    },
  });
  const nonce = control.status(HOST_BROKER_COMPANION_ORIGIN).stopNonce!;
  await assert.rejects(control.stop(HOST_BROKER_COMPANION_ORIGIN, nonce), /crashed/);
  const receipt = listHostBrokerLocalStopReceipts(dir)[0]!;
  assert.equal(receipt.status, "requested");
  const sessionRunner: HostBrokerSessionRunner = { run: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }) };

  const first = await connectOperationHost({ dataDir: dir, sessionRunner, protocolVersion: "1.3" });
  const firstReceipt = decodeDesktopBrowserMessage(
    await waitFor(() => first.socket.sent[2], "Local Stop Receipt first replay"),
    "1.3",
    "1.0",
  );
  assert.equal(firstReceipt.kind, "host.local-stop-receipt");
  first.socket.close(1000, "reconnect");
  await first.running;
  assert.equal(listHostBrokerLocalStopReceipts(dir).length, 1);

  const second = await connectOperationHost({ dataDir: dir, sessionRunner, protocolVersion: "1.3" });
  await waitFor(() => second.socket.sent[2], "Local Stop Receipt second replay");
  second.socket.message(
    JSON.stringify({
      protocolVersion: "1.3",
      kind: "relay.local-stop-ack",
      payload: { receiptId: receipt.receiptId },
    }),
  );
  await waitFor(() => (listHostBrokerLocalStopReceipts(dir).length === 0 ? true : undefined), "receipt acknowledgement");
  second.socket.close(1000, "done");
  await second.running;
});

test("Ticket 06 runs and cleans up the Task-owned session with Host-filtered output", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-ticket-06-navigate-"));
  const spawnArgv: Array<readonly string[]> = [];
  const sessionRunner: HostBrokerSessionRunner = {
    async run(_executable, argv) {
      spawnArgv.push(argv);
      if (argv[1] === "session" && argv[2] === "start") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            session_id: "session-1",
            browser_instance_id: "browser-primary",
            agent_window_id: 42,
          }),
          stderr: "",
        };
      }
      if (argv[1] === "session" && argv[2] === "stop") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            returned_tab_ids: [7],
            return_failures: [{ tab_id: 8, code: "permission_denied", message: "token=secret" }],
          }),
          stderr: "",
        };
      }
      if (argv[1] === "observe") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            tab_id: 7,
            text: "Welcome\nAuthorization: Bearer secret\npassword=hidden\neyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.signature123\nhttps://alice:secret@example.test/private\nVisible content",
            ref_count: 2,
            truncated: false,
            debug: { hidden_dom: "must-not-leave-host" },
          }),
          stderr: "",
        };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          tab_id: 7,
          reached: "load",
          url: "https://example.test/?token=secret",
          error_text: "Authorization: Bearer secret",
          future_field: "must-not-leave-host",
        }),
        stderr: "",
      };
    },
  };
  const { socket, running } = await connectOperationHost({
    dataDir: dir,
    sessionRunner,
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  });
  const startAuthority: DesktopBrowserOperationAuthorityEnvelope = {
    ...sessionStartAuthority("0198f3d2-1950-7000-8000-000000000061"),
    capabilitySet: {
      ...sessionStartAuthority("ignored").capabilitySet,
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    },
  };
  socket.message(
    JSON.stringify({
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-start",
        requestHash: computeDesktopBrowserRequestHash(startAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
        authority: startAuthority,
      },
    }),
  );
  await waitFor(() => socket.sent[3], "Ticket 06 session-start result");

  const navigateAuthority: DesktopBrowserOperationAuthorityEnvelope = {
    ...startAuthority,
    operationId: "0198f3d2-1950-7000-8000-000000000062",
    operationSequence: 2,
    leaseVersion: 4,
    argv: buildDesktopBrowserNavigateArgv("https://example.test", "session-1"),
    effectClass: "browser_effect",
    nonce: "nonce-navigate",
  };
  socket.message(
    JSON.stringify({
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-navigate",
        requestHash: computeDesktopBrowserRequestHash(navigateAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
        authority: navigateAuthority,
      },
    }),
  );
  const navigateResult = decodeDesktopBrowserMessage(
    await waitFor(() => socket.sent[5], "Ticket 06 navigate result"),
    DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  ) as HostResultMessage;
  assert.equal(navigateResult.payload.outcome, "completed");
  if (
    navigateResult.payload.outcome !== "completed" ||
    !("schemaVersion" in navigateResult.payload.result) ||
    navigateResult.payload.result.command !== "navigate"
  ) {
    assert.fail("Host did not return a sanitized navigate result");
  }
  assert.deepEqual(navigateResult.payload, {
    dispatchId: "dispatch-navigate",
    operationId: navigateAuthority.operationId,
    outcome: "completed",
    resultHash: navigateResult.payload.resultHash,
    result: {
      schemaVersion: "1.0",
      command: "navigate",
      completedAt: navigateResult.payload.result.completedAt,
      data: { tab_id: 7, reached: "load" },
    },
  });

  const observeAuthority: DesktopBrowserOperationAuthorityEnvelope = {
    ...startAuthority,
    operationId: "0198f3d2-1950-7000-8000-000000000063",
    operationSequence: 3,
    leaseVersion: 5,
    argv: buildDesktopBrowserObserveArgv("session-1"),
    effectClass: "observation",
    nonce: "nonce-observe",
  };
  socket.message(
    JSON.stringify({
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-observe",
        requestHash: computeDesktopBrowserRequestHash(observeAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
        authority: observeAuthority,
      },
    }),
  );
  const observeResult = decodeDesktopBrowserMessage(
    await waitFor(() => socket.sent[7], "Ticket 06 observe result"),
    DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  ) as HostResultMessage;
  assert.equal(observeResult.payload.outcome, "completed");
  if (
    observeResult.payload.outcome !== "completed" ||
    !("schemaVersion" in observeResult.payload.result) ||
    observeResult.payload.result.command !== "observe"
  ) {
    assert.fail("Host did not return a sanitized observation result");
  }
  assert.deepEqual(observeResult.payload.result, {
    schemaVersion: "1.0",
    command: "observe",
    completedAt: observeResult.payload.result.completedAt,
    data: {
      tab_id: 7,
      text: "Welcome\n[REDACTED]\n[REDACTED]\n[REDACTED]\n[REDACTED]\nVisible content",
      ref_count: 2,
      truncated: false,
    },
  });

  assert.equal(readdirSync(join(dir, "sessions")).length, 1);
  const stopAuthority: DesktopBrowserOperationAuthorityEnvelope = {
    ...startAuthority,
    operationId: "0198f3d2-1950-7000-8000-000000000064",
    operationSequence: 4,
    leaseVersion: 6,
    argv: buildDesktopBrowserSessionStopArgv("session-1"),
    effectClass: "cleanup",
    nonce: "nonce-stop",
  };
  socket.message(
    JSON.stringify({
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-stop",
        requestHash: computeDesktopBrowserRequestHash(stopAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
        authority: stopAuthority,
      },
    }),
  );
  const stopResult = decodeDesktopBrowserMessage(
    await waitFor(() => socket.sent[9], "Ticket 06 session-stop result"),
    DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  ) as HostResultMessage;
  assert.equal(stopResult.payload.outcome, "completed");
  if (
    stopResult.payload.outcome !== "completed" ||
    !("schemaVersion" in stopResult.payload.result) ||
    stopResult.payload.result.command !== "session.stop"
  ) {
    assert.fail("Host did not return a sanitized session-stop result");
  }
  assert.deepEqual(stopResult.payload.result, {
    schemaVersion: "1.0",
    command: "session.stop",
    completedAt: stopResult.payload.result.completedAt,
    data: {
      returned_tab_ids: [7],
      return_failures: [{ tab_id: 8, code: "permission_denied" }],
    },
  });
  assert.equal(readdirSync(join(dir, "sessions")).length, 0);

  const fenceCount = readdirSync(join(dir, "operations")).length;
  const foreignAuthority: DesktopBrowserOperationAuthorityEnvelope = {
    ...navigateAuthority,
    operationId: "0198f3d2-1950-7000-8000-000000000065",
    operationSequence: 5,
    argv: buildDesktopBrowserNavigateArgv("https://example.test", "session-2"),
    nonce: "nonce-foreign-session",
  };
  socket.message(
    JSON.stringify({
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-foreign",
        requestHash: computeDesktopBrowserRequestHash(foreignAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
        authority: foreignAuthority,
      },
    }),
  );
  await assert.rejects(running, /Task-owned session/);
  assert.equal(readdirSync(join(dir, "operations")).length, fenceCount);
  assert.deepEqual(spawnArgv, [startAuthority.argv, navigateAuthority.argv, observeAuthority.argv, stopAuthority.argv]);
});

test("Ticket 06 rejects stale attempts and operation ordering before fencing or spawning", async () => {
  for (const mutation of [
    { attemptId: "attempt-stale", operationSequence: 2, leaseVersion: 4 },
    { attemptId: "attempt-1", operationSequence: 3, leaseVersion: 4 },
    { attemptId: "attempt-1", operationSequence: 2, leaseVersion: 5 },
  ]) {
    const dir = mkdtempSync(join(tmpdir(), "host-broker-ticket-06-ordering-"));
    let spawnCalls = 0;
    const { socket, running } = await connectOperationHost({
      dataDir: dir,
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      sessionRunner: {
        async run() {
          spawnCalls += 1;
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              session_id: "session-1",
              browser_instance_id: "browser-primary",
              agent_window_id: 42,
            }),
            stderr: "",
          };
        },
      },
    });
    const startAuthority: DesktopBrowserOperationAuthorityEnvelope = {
      ...sessionStartAuthority("start-ordering"),
      capabilitySet: {
        ...sessionStartAuthority("ignored").capabilitySet,
        protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      },
    };
    socket.message(
      JSON.stringify({
        protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
        kind: "relay.invoke",
        payload: {
          dispatchId: "dispatch-start",
          requestHash: computeDesktopBrowserRequestHash(startAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
          authority: startAuthority,
        },
      }),
    );
    await waitFor(() => socket.sent[3], "ordered session start");
    const fenceCount = readdirSync(join(dir, "operations")).length;
    const invalidAuthority: DesktopBrowserOperationAuthorityEnvelope = {
      ...startAuthority,
      ...mutation,
      operationId: "invalid-ordering",
      argv: buildDesktopBrowserNavigateArgv("https://example.test", "session-1"),
      effectClass: "browser_effect",
      nonce: "nonce-invalid-ordering",
    };
    socket.message(
      JSON.stringify({
        protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
        kind: "relay.invoke",
        payload: {
          dispatchId: "dispatch-invalid",
          requestHash: computeDesktopBrowserRequestHash(invalidAuthority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
          authority: invalidAuthority,
        },
      }),
    );
    await assert.rejects(running, /attempt|sequence|lease version/);
    assert.equal(readdirSync(join(dir, "operations")).length, fenceCount);
    assert.equal(spawnCalls, 1);
  }
});

test("Ticket 06 product seam reaches a visible window, sanitized observation, cleanup, and Core outcome", async () => {
  const dir = mkdtempSync(join(tmpdir(), "desktop-browser-ticket-06-product-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const publicDeviceFingerprint = computeDesktopBrowserPublicDeviceFingerprint({
    publicIdentityVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    deploymentCanonicalId: "qm://deployments/example",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-product",
    browserInstanceId: "browser-primary",
  });
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "registration-product",
    registrationState: "registered",
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: "broker-product",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
  });
  const relay = new DesktopBrowserRelayService({
    relayInstanceId: "relay-product",
    deploymentCanonicalId: "qm://deployments/example",
    supportedProtocolVersions: [DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION],
    supportedPolicyGrammarVersions: ["1.0"],
    registry,
    operationStore: createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking()),
    createNonce: () => "relay-nonce-product",
    createConnectionId: () => "connection-product",
  });
  const relayHttp = createDesktopBrowserRelayServer({
    host: "127.0.0.1",
    port: 0,
    path: DESKTOP_BROWSER_RELAY_WSS_PATH,
    service: relay,
    adapterReadiness: { check: async () => undefined },
    coreAuthSecret: "relay-core-auth-secret-for-product-test-0001",
    shutdownDrainMs: 50,
  });
  await relayHttp.listen();
  const relayHttpPort = (relayHttp.server.address() as AddressInfo).port;
  const sockets = createLinkedSocketPair();
  relay.acceptSocket(sockets.relay);
  const host = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    deploymentCanonicalId: "qm://deployments/example",
    deviceId: publicDeviceFingerprint,
    brokerInstanceId: "broker-product",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: [DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    dataDir: dir,
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
    sessionRunner: {
      async run(_executable, argv) {
        if (argv[1] === "session" && argv[2] === "start") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              session_id: "browser-session-product",
              browser_instance_id: "browser-primary",
              agent_window_id: 42,
            }),
            stderr: "",
          };
        }
        if (argv[1] === "navigate") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({ tab_id: 7, reached: "load", url: "https://example.test/?token=secret" }),
            stderr: "",
          };
        }
        if (argv[1] === "observe") {
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              tab_id: 7,
              text: "Heading: Example\nAuthorization: Bearer secret",
              ref_count: 1,
              truncated: false,
            }),
            stderr: "",
          };
        }
        return {
          exitCode: 0,
          stdout: JSON.stringify({ returned_tab_ids: [7], return_failures: [] }),
          stderr: "",
        };
      },
    },
    transport: {
      connect() {
        return sockets.host;
      },
    },
  });
  const running = host.start().catch(() => undefined);
  sockets.host.open();
  const projection = await waitFor(() => registry.published.get("connection-product"), "product relay projection");
  assert.equal(projection.publicDeviceFingerprint, publicDeviceFingerprint);
  const now = Date.now();
  const authorityState = {
    registration: {
      deploymentCanonicalId: "qm://deployments/example",
      registrationId: "registration-product",
      waitingTaskId: "task-product",
      actorId: "actor-product",
      projectId: "project-product",
      membershipEpoch: 42,
      authorityId: "authority-product",
      authorityExpiresAt: now + 120_000,
      publicDeviceFingerprint: projection.publicDeviceFingerprint,
      browserInstanceId: "browser-primary",
      status: "online" as const,
      browserRuntimeStatus: "ready" as const,
    },
    relayConnection: projection,
  };
  const ids = [
    "task-product",
    "attempt-product",
    "lease-product",
    "operation-start-product",
    "nonce-start-product",
    "operation-navigate-product",
    "nonce-navigate-product",
    "operation-observe-product",
    "nonce-observe-product",
    "operation-stop-product",
    "nonce-stop-product",
  ];
  const tasks = createDesktopBrowserTaskStore(createMemoryMap<DesktopBrowserTask>(), {
    id: () => ids.shift()!,
    now: () => now,
    sessionStartAuthority: async () => structuredClone(authorityState),
  });
  const task = await tasks.createWaiting({
    goal: "Inspect the example page",
    actorId: "actor-product",
    projectId: "project-product",
    projectName: "Product Project",
    projectMembershipVersion: "42",
    authorityId: "authority-product",
    authorityExpiresAt: now + 120_000,
    sessionId: "session-product",
    threadRef: "thread-product",
  });
  const preparedStart = await tasks.prepareSessionStart(task.id);
  assert.equal(preparedStart.status, "ok");
  const startInvocation = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "relay.invoke" as const,
    payload: {
      dispatchId: "dispatch-start-product",
      requestHash: preparedStart.operation.requestHash,
      authority: preparedStart.operation.authority,
    },
  };
  const startDispatch = await relay.dispatchProjectedInvocation({
    publicDeviceFingerprint: projection.publicDeviceFingerprint,
    browserInstanceId: "browser-primary",
    invocation: startInvocation,
  });
  assert.equal(startDispatch.kind, "host.result");
  if (startDispatch.kind !== "host.result") assert.fail("session start did not reach Host");
  await tasks.consumeSessionStartAccepted(task.id, startDispatch.accepted);
  await tasks.consumeSessionStartResult(task.id, startDispatch.result, { status: "ok", authority: authorityState });

  let dispatchNumber = 0;
  const auditLog = createAuditLog();
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks,
    auditLog,
    createDispatchId: () => `dispatch-product-${++dispatchNumber}`,
    dispatcher: createHttpDesktopBrowserRelayDispatcher({
      baseUrl: `http://127.0.0.1:${relayHttpPort}`,
      authSecret: "relay-core-auth-secret-for-product-test-0001",
    }),
  });
  const scope = {
    sessionId: "session-product",
    actorId: "actor-product",
    projectScopeLabel: "group:web-project-project-product",
    projectMembershipVersion: "42",
  };
  const toolRef: ToolContextRef = {
    current: {
      browserTask: (
        request:
          | { action: "invoke"; argv: string[] }
          | { action: "finalize"; outcome: "completed" | "failed"; summary: string },
      ) =>
        request.action === "invoke"
          ? coordinator.invokeForSession({ ...scope, argv: request.argv })
          : coordinator.finalizeForSession({
              ...scope,
              outcome: request.outcome,
              summary: request.summary,
            }),
      mcpToolDefs: () => [],
      callMcpTool: async () => "",
    } as any,
    scopeLabel: scope.projectScopeLabel,
  };
  const browserTask = createPiTools(toolRef).find((tool) => tool.name === "browser_task");
  assert.ok(browserTask);
  const invokeTool = async (params: unknown) => {
    const executeTool = browserTask.execute as unknown as (callId: string, input: unknown) => Promise<unknown>;
    const response = (await executeTool("browser-task-call", params)) as {
      content: Array<{ type: string; text?: string }>;
    };
    return JSON.parse(response.content[0]!.text ?? "null") as Record<string, any>;
  };
  assert.equal(
    (
      await invokeTool({
        action: "invoke",
        argv: buildDesktopBrowserNavigateArgv("https://example.test", "browser-session-product"),
      })
    ).status,
    "ok",
  );
  const observed = await invokeTool({
    action: "invoke",
    argv: buildDesktopBrowserObserveArgv("browser-session-product"),
  });
  assert.equal(observed.status, "ok");
  assert.equal(observed.observation.data.text, "Heading: Example\n[REDACTED]");
  assert.equal(
    (
      await invokeTool({
        action: "invoke",
        argv: buildDesktopBrowserSessionStopArgv("browser-session-product"),
      })
    ).status,
    "ok",
  );
  assert.deepEqual(await invokeTool({ action: "finalize", outcome: "completed", summary: "Example page inspected" }), {
    status: "ok",
    taskId: "task-product",
  });
  assert.deepEqual(await invokeTool({ action: "finalize", outcome: "completed", summary: "Example page inspected" }), {
    status: "ok",
    taskId: "task-product",
  });
  const completed = await tasks.get(task.id);
  assert.ok(completed);
  assert.deepEqual(projectDesktopBrowserTaskActivity(completed, "https://qm.example.com", null).result, {
    outcome: "completed",
    summary: "Example page inspected",
    actorId: "actor-product",
    projectId: "project-product",
    browserSkillSessionId: "browser-session-product",
    browserInstanceId: "browser-primary",
    agentWindowId: 42,
    observation: observed.observation,
  });
  assert.deepEqual(await auditLog.events(), [
    {
      at: now,
      principalId: "actor-product",
      action: "desktop_browser.task.finalized",
      resource: "task-product",
      scopeLabel: "group:web-project-project-product",
      status: "completed",
    },
  ]);
  assert.deepEqual(ids, []);
  await relayHttp.shutdown();
  await running;
});

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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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

test("relay.invoke retains negotiated 1.2 and fences before one fixed BrowserSkill spawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-session-start-interop-"));
  const identity = await loadOrCreateDeviceIdentity(dir);
  const registry = new MemoryRegistryAdapter();
  registry.setBinding({
    registrationId: "reg-session-start-1",
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
    supportedPolicyGrammarVersions: ["1.0"],
    registry,
    createNonce: () => "nonce-session-start-1",
    createConnectionId: () => "connection-session-start-1",
  });
  let hostAccepted: HostAcceptedMessage | undefined;
  let hostResult: HostResultMessage | undefined;
  const eventLog: string[] = [];
  const sockets = createLinkedSocketPair({
    hostToRelay(data) {
      const raw = JSON.parse(data) as { kind?: string };
      if (raw.kind === "host.accepted") {
        eventLog.push("send:host.accepted");
        hostAccepted = decodeDesktopBrowserMessage(data, "1.2", "1.0") as HostAcceptedMessage;
      }
      if (raw.kind === "host.result") {
        eventLog.push("send:host.result");
        hostResult = decodeDesktopBrowserMessage(data, "1.2", "1.0") as HostResultMessage;
      }
      return data;
    },
  });
  const spawnCalls: Array<{ executable: string; argv: readonly string[]; options: unknown }> = [];
  const sessionRunner: HostBrokerSessionRunner = {
    async run(executable, argv, options) {
      const fenceFiles = readdirSync(join(dir, "operations"));
      assert.equal(fenceFiles.length, 1);
      const fence = JSON.parse(readFileSync(join(dir, "operations", fenceFiles[0]!), "utf8")) as {
        operationId: string;
        requestHash: string;
      };
      assert.equal(fence.operationId, "0198f3d2-1950-7000-8000-000000000011");
      assert.equal(fence.requestHash, authorityRequestHash);
      eventLog.push("spawn:browser-skill");
      spawnCalls.push({ executable, argv, options });
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "session-1",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
          ignored_remote_field: "filtered",
        }),
        stderr: "",
      };
    },
  };
  const writeObserver: HostBrokerWriteObserver = {
    onFenceCreated() {
      eventLog.push("durable:fence-created");
    },
    onSessionOwnershipSaved() {
      eventLog.push("durable:session-owned");
    },
    onFenceSaved(fence) {
      eventLog.push(`durable:fence-${fence.state}`);
    },
  };
  service.acceptSocket(sockets.relay);
  const connection = new HostBrokerConnection({
    qmUrl: "https://qm.example.com",
    relayUrl: `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`,
    deploymentCanonicalId: "qm://deployments/example",
    deviceId: "device-1",
    brokerInstanceId: "broker-local-1",
    brokerVersion: "0.0.0-test",
    supportedProtocolVersions: ["1.0", "1.2"],
    supportedPolicyGrammarVersions: ["1.0"],
    identity,
    runtime: runtime(),
    dataDir: dir,
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
    sessionRunner,
    writeObserver,
    transport: {
      connect(url: string): HostBrokerSocket {
        assert.equal(url, `wss://qm.example.com${DESKTOP_BROWSER_RELAY_WSS_PATH}`);
        return sockets.host;
      },
    },
  });

  const issuedAt = new Date(Date.now() - 1_000).toISOString();
  const authority: DesktopBrowserSessionStartAuthorityEnvelope = {
    authorityVersion: "1.0",
    audience: DESKTOP_BROWSER_RELAY_AUDIENCE,
    deploymentCanonicalId: "qm://deployments/example",
    actorId: "actor-1",
    actorSnapshotHash: "sha256:actor-snapshot-1",
    projectId: "project-1",
    projectSnapshotHash: "sha256:project-snapshot-1",
    membershipEpoch: 42,
    taskId: "task-1",
    attemptId: "attempt-1",
    deviceId: "device-1",
    browserInstanceId: "browser-primary",
    leaseId: "lease-1",
    leaseVersion: 3,
    leaseExpiresAt: new Date(Date.parse(issuedAt) + 60_000).toISOString(),
    operationId: "0198f3d2-1950-7000-8000-000000000011",
    operationSequence: 1,
    capabilitySet: {
      protocolVersion: "1.2",
      policyGrammarVersion: "1.0",
      bskVersion: runtime().bskVersion,
      extensionVersion: runtime().extensionVersion,
      cliShapeHash: runtime().cliShapeHash,
    },
    argv: ["--json", "session", "start", "--browser", "browser-primary"],
    brokerOptions: { forceSharedRuntime: false },
    effectClass: "local_effect",
    nonce: "nonce-operation-1",
    issuedAt,
  };
  const authorityRequestHash = computeDesktopBrowserRequestHash(authority, "1.2", "1.0");
  const running = connection.start().catch(() => undefined);
  sockets.host.open();
  await waitFor(() => registry.published.get("connection-session-start-1"), "session-start relay publication");

  sockets.relay.send(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "0198f3d2-1950-7000-8000-000000000012",
        requestHash: authorityRequestHash,
        authority,
      },
    }),
  );

  const accepted = await waitFor(() => hostAccepted, "accepted host result");
  const completed = await waitFor(() => hostResult, "completed host result");
  assert.equal(accepted.protocolVersion, "1.2");
  assert.deepEqual(accepted.payload, {
    dispatchId: "0198f3d2-1950-7000-8000-000000000012",
    operationId: authority.operationId,
    requestHash: authorityRequestHash,
  });
  assert.equal(completed.protocolVersion, "1.2");
  assert.deepEqual(completed.payload, {
    dispatchId: "0198f3d2-1950-7000-8000-000000000012",
    operationId: authority.operationId,
    outcome: "completed",
    resultHash: completed.payload.resultHash,
    result: {
      session_id: "session-1",
      browser_instance_id: "browser-primary",
      agent_window_id: 42,
    },
  });
  assert.deepEqual(eventLog, [
    "durable:fence-created",
    "send:host.accepted",
    "spawn:browser-skill",
    "durable:session-owned",
    "durable:fence-completed",
    "send:host.result",
  ]);
  assert.deepEqual(spawnCalls, [
    {
      executable: TEST_BROWSER_SKILL_EXECUTABLE,
      argv: ["--json", "session", "start", "--browser", "browser-primary"],
      options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    },
  ]);
  const operationFile = join(dir, "operations", readdirSync(join(dir, "operations"))[0]!);
  const sessionFile = join(dir, "sessions", readdirSync(join(dir, "sessions"))[0]!);
  assert.equal(statSync(join(dir, "operations")).mode & 0o777, 0o700);
  assert.equal(statSync(join(dir, "sessions")).mode & 0o777, 0o700);
  assert.equal(statSync(operationFile).mode & 0o777, 0o600);
  assert.equal(statSync(sessionFile).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(readFileSync(sessionFile, "utf8")), {
    taskId: authority.taskId,
    attemptId: authority.attemptId,
    operationId: authority.operationId,
    requestHash: authorityRequestHash,
    sessionId: "session-1",
    browserInstanceId: "browser-primary",
    agentWindowId: 42,
    latestOperationSequence: 1,
    latestLeaseVersion: 3,
  });

  await running;
});

test("relay.invoke rejects every authority mismatch before fencing or spawning", async () => {
  const base = sessionStartAuthority("0198f3d2-1950-7000-8000-000000000021");
  const futureIssuedAt = new Date(Date.now() + 30_000).toISOString();
  const cases: Array<{ name: string; authority: unknown; requestHash?: string }> = [
    { name: "request hash", authority: base, requestHash: `sha256:${"0".repeat(64)}` },
    { name: "audience", authority: { ...base, audience: "other-audience" } },
    { name: "deployment", authority: { ...base, deploymentCanonicalId: "qm://deployments/other" } },
    { name: "device", authority: { ...base, deviceId: "device-2" } },
    { name: "browser", authority: { ...base, browserInstanceId: "browser-secondary" } },
    {
      name: "runtime capability",
      authority: { ...base, capabilitySet: { ...base.capabilitySet, bskVersion: "different-bsk" } },
    },
    {
      name: "negotiated protocol",
      authority: { ...base, capabilitySet: { ...base.capabilitySet, protocolVersion: "1.0" } },
    },
    {
      name: "expired lease",
      authority: {
        ...base,
        issuedAt: "2020-01-01T00:00:00.000Z",
        leaseExpiresAt: "2020-01-01T00:01:00.000Z",
      },
    },
    {
      name: "future lease",
      authority: {
        ...base,
        issuedAt: futureIssuedAt,
        leaseExpiresAt: new Date(Date.parse(futureIssuedAt) + 60_000).toISOString(),
      },
    },
    { name: "argv", authority: { ...base, argv: ["--json", "session", "start"] } },
    {
      name: "argv includes executable",
      authority: { ...base, argv: ["bsk", "--json", "session", "start", "--browser", "browser-primary"] },
    },
    {
      name: "argv duplicates leading json",
      authority: {
        ...base,
        argv: ["--json", "--json", "session", "start", "--browser", "browser-primary"],
      },
    },
    {
      name: "argv misplaces global json",
      authority: { ...base, argv: ["session", "start", "--json", "--browser", "browser-primary"] },
    },
    { name: "shared runtime", authority: { ...base, brokerOptions: { forceSharedRuntime: true } } },
  ];

  for (const entry of cases) {
    const dir = mkdtempSync(join(tmpdir(), `host-broker-pre-fence-${entry.name.replaceAll(" ", "-")}-`));
    let spawnCalls = 0;
    const { socket, running } = await connectOperationHost({
      dataDir: dir,
      sessionRunner: {
        async run() {
          spawnCalls += 1;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    });
    let requestHash = entry.requestHash;
    if (!requestHash) {
      try {
        requestHash = computeDesktopBrowserRequestHash(entry.authority, "1.2", "1.0");
      } catch {
        requestHash = computeDesktopBrowserRequestHash(base, "1.2", "1.0");
      }
    }
    socket.message(
      JSON.stringify({
        protocolVersion: "1.2",
        kind: "relay.invoke",
        payload: {
          dispatchId: `dispatch-${entry.name.replaceAll(" ", "-")}`,
          requestHash,
          authority: entry.authority,
        },
      }),
    );
    await assert.rejects(running, () => true, entry.name);
    assert.equal(socket.sent.length, 2, entry.name);
    assert.equal(socket.closeCode, 1000, entry.name);
    assert.equal(spawnCalls, 0, entry.name);
    assert.equal(existsSync(join(dir, "operations")), false, entry.name);
  }
});

test("relay.invoke retains the authoritative policy grammar instead of supported list order", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-policy-grammar-"));
  let spawnCalls = 0;
  const { socket, running } = await connectOperationHost({
    dataDir: dir,
    supportedPolicyGrammarVersions: ["1.0", "1.1"],
    challengePolicyGrammarVersion: "1.1",
    sessionRunner: {
      async run() {
        spawnCalls += 1;
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            session_id: "session-grammar-1",
            browser_instance_id: "browser-primary",
            agent_window_id: 41,
          }),
          stderr: "",
        };
      },
    },
  });
  const base = sessionStartAuthority("0198f3d2-1950-7000-8000-000000000025");
  const authority = {
    ...base,
    capabilitySet: { ...base.capabilitySet, policyGrammarVersion: "1.1" as const },
  };
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-policy-grammar",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.1"),
        authority,
      },
    }),
  );

  const accepted = decodeDesktopBrowserMessage(
    await waitFor(() => socket.sent[2], "policy grammar accepted result"),
    "1.2",
    "1.1",
  ) as HostAcceptedMessage;
  const result = decodeDesktopBrowserMessage(
    await waitFor(() => socket.sent[3], "policy grammar completed result"),
    "1.2",
    "1.1",
  ) as HostResultMessage;
  assert.deepEqual(accepted.payload, {
    dispatchId: "dispatch-policy-grammar",
    operationId: authority.operationId,
    requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.1"),
  });
  assert.equal(result.payload.outcome, "completed");
  assert.equal(spawnCalls, 1);
  socket.close(1000, "done");
  await running;
});

test("a durable operation fence prevents duplicate and mismatched session-start spawns after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-durable-fence-"));
  let spawnCalls = 0;
  const sessionRunner: HostBrokerSessionRunner = {
    async run() {
      spawnCalls += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "session-1",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
        }),
        stderr: "",
      };
    },
  };
  const authority = sessionStartAuthority("0198f3d2-1950-7000-8000-000000000031");
  const requestHash = computeDesktopBrowserRequestHash(authority, "1.2", "1.0");
  const invocation = {
    protocolVersion: "1.2",
    kind: "relay.invoke",
    payload: { dispatchId: "dispatch-first", requestHash, authority },
  };
  const first = await connectOperationHost({ dataDir: dir, sessionRunner });
  first.socket.message(JSON.stringify(invocation));
  const firstAccepted = decodeDesktopBrowserMessage(
    await waitFor(() => first.socket.sent[2], "first accepted result"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const firstResult = decodeDesktopBrowserMessage(
    await waitFor(() => first.socket.sent[3], "first completed result"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(firstAccepted.payload.dispatchId, "dispatch-first");
  assert.equal(firstResult.payload.outcome, "completed");
  first.socket.close(1000, "restart");
  await first.running;

  const second = await connectOperationHost({ dataDir: dir, sessionRunner });
  second.socket.message(
    JSON.stringify({
      ...invocation,
      payload: { ...invocation.payload, dispatchId: "dispatch-replay" },
    }),
  );
  const duplicateAccepted = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[2], "duplicate accepted result"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const duplicateResult = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[3], "duplicate completed result"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(duplicateAccepted.payload.dispatchId, "dispatch-replay");
  assert.deepEqual(duplicateResult.payload, {
    dispatchId: "dispatch-replay",
    operationId: firstResult.payload.operationId,
    outcome: "completed",
    resultHash: duplicateResult.payload.resultHash,
    result: firstResult.payload.result,
  });
  assert.equal(spawnCalls, 1);
  const duplicateFenceFile = readdirSync(join(dir, "operations"))[0]!;
  const duplicateFence = JSON.parse(readFileSync(join(dir, "operations", duplicateFenceFile), "utf8")) as {
    terminalPayload?: { dispatchId?: string };
  };
  assert.equal(duplicateFence.terminalPayload?.dispatchId, "dispatch-first");

  const mismatchedAuthority = { ...authority, attemptId: "attempt-2" };
  second.socket.message(
    JSON.stringify({
      ...invocation,
      payload: {
        dispatchId: "dispatch-mismatch",
        requestHash: computeDesktopBrowserRequestHash(mismatchedAuthority, "1.2", "1.0"),
        authority: mismatchedAuthority,
      },
    }),
  );
  await assert.rejects(second.running, /different request hash/);
  assert.equal(spawnCalls, 1);

  const third = await connectOperationHost({ dataDir: dir, sessionRunner });
  third.socket.message(
    JSON.stringify({
      ...invocation,
      payload: { ...invocation.payload, dispatchId: "dispatch-preserved" },
    }),
  );
  const preservedAccepted = decodeDesktopBrowserMessage(
    await waitFor(() => third.socket.sent[2], "preserved accepted result"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const preservedResult = decodeDesktopBrowserMessage(
    await waitFor(() => third.socket.sent[3], "preserved completed result"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(preservedAccepted.payload.dispatchId, "dispatch-preserved");
  assert.deepEqual(preservedResult.payload, {
    dispatchId: "dispatch-preserved",
    operationId: firstResult.payload.operationId,
    outcome: "completed",
    resultHash: preservedResult.payload.resultHash,
    result: firstResult.payload.result,
  });
  assert.equal(spawnCalls, 1);

  third.socket.close(1000, "done");
  await third.running;
});

test("a matching terminal Host fence replays after lease expiry without respawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-expired-terminal-replay-"));
  let spawnCalls = 0;
  const sessionRunner: HostBrokerSessionRunner = {
    async run() {
      spawnCalls += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "session-expired-replay",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
        }),
        stderr: "",
      };
    },
  };
  const issuedAt = Date.now() - 1_000;
  const authority = sessionStartAuthority("operation-expired-replay", issuedAt + 1_000);
  const invocation = {
    protocolVersion: "1.2",
    kind: "relay.invoke",
    payload: {
      dispatchId: "dispatch-first",
      requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
      authority,
    },
  };
  const first = await connectOperationHost({ dataDir: dir, sessionRunner, now: issuedAt + 1_000 });
  first.socket.message(JSON.stringify(invocation));
  await waitFor(() => first.socket.sent[3], "terminal result before lease expiry");
  first.socket.close(1000, "restart");
  await first.running;

  const second = await connectOperationHost({ dataDir: dir, sessionRunner, now: issuedAt + 61_001 });
  second.socket.message(
    JSON.stringify({
      ...invocation,
      payload: { ...invocation.payload, dispatchId: "dispatch-after-expiry" },
    }),
  );
  const replayed = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[3], "terminal replay after lease expiry"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(replayed.payload.outcome, "completed");
  assert.equal(replayed.payload.dispatchId, "dispatch-after-expiry");
  assert.equal(spawnCalls, 1);
  second.socket.close(1000, "done");
  await second.running;
});

test("Ticket 08 Lease-revoked close cleans the durable Task-owned BrowserSkill session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-lease-revoke-cleanup-"));
  const argvCalls: Array<readonly string[]> = [];
  const sessionRunner: HostBrokerSessionRunner = {
    async run(_executable, argv) {
      argvCalls.push(argv);
      if (argv[1] === "session" && argv[2] === "stop") {
        return { exitCode: 0, stdout: JSON.stringify({ returned_tab_ids: [], return_failures: [] }), stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "session-revoked",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
        }),
        stderr: "",
      };
    },
  };
  const authority = sessionStartAuthority("operation-revoked");
  const { socket, running } = await connectOperationHost({ dataDir: dir, sessionRunner });
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-revoked",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
        authority,
      },
    }),
  );
  await waitFor(() => socket.sent[3], "Lease revoke session ownership");
  assert.equal(readdirSync(join(dir, "sessions")).length, 1);

  socket.close(1008, `desktop browser Task Lease revoked:${createHash("sha256").update(authority.taskId).digest("hex")}`);
  await assert.rejects(running);

  assert.deepEqual(argvCalls, [authority.argv, ["--json", "session", "stop", "session-revoked"]]);
  assert.equal(readdirSync(join(dir, "sessions")).length, 0);
});

test("Ticket 08 Lease-revoked close discovers durable session ownership after Host restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-restarted-lease-revoke-"));
  const argvCalls: Array<readonly string[]> = [];
  const sessionRunner: HostBrokerSessionRunner = {
    async run(_executable, argv) {
      argvCalls.push(argv);
      if (argv[1] === "session" && argv[2] === "stop") {
        return { exitCode: 0, stdout: JSON.stringify({ returned_tab_ids: [], return_failures: [] }), stderr: "" };
      }
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          session_id: "session-restarted-revoke",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
        }),
        stderr: "",
      };
    },
  };
  const authority = sessionStartAuthority("operation-restarted-revoke");
  const first = await connectOperationHost({ dataDir: dir, sessionRunner });
  first.socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-restarted-revoke",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
        authority,
      },
    }),
  );
  await waitFor(() => first.socket.sent[3], "session ownership before Host restart");
  first.socket.close(1000, "restart");
  await first.running;
  assert.equal(readdirSync(join(dir, "sessions")).length, 1);

  const second = await connectOperationHost({ dataDir: dir, sessionRunner });
  second.socket.close(
    1008,
    `desktop browser Task Lease revoked:${createHash("sha256").update(`${authority.taskId}-other`).digest("hex")}`,
  );
  await assert.rejects(second.running);
  assert.equal(readdirSync(join(dir, "sessions")).length, 1);
  assert.deepEqual(argvCalls, [authority.argv]);

  const third = await connectOperationHost({ dataDir: dir, sessionRunner });
  third.socket.close(
    1008,
    `desktop browser Task Lease revoked:${createHash("sha256").update(authority.taskId).digest("hex")}`,
  );
  await assert.rejects(third.running);

  assert.deepEqual(argvCalls, [authority.argv, ["--json", "session", "stop", "session-restarted-revoke"]]);
  assert.equal(readdirSync(join(dir, "sessions")).length, 0);
});

test("post-fence BrowserSkill output failures persist unknown without task ownership or retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-output-failure-"));
  const outputs = [
    JSON.stringify({
      session_id: "session-wrong-browser",
      browser_instance_id: "browser-secondary",
      agent_window_id: 42,
    }),
    JSON.stringify({
      session_id: "session-oversized",
      browser_instance_id: "browser-primary",
      agent_window_id: 43,
      padding: "x".repeat(70 * 1024),
    }),
  ];
  let spawnCalls = 0;
  const { socket, running } = await connectOperationHost({
    dataDir: dir,
    sessionRunner: {
      async run() {
        const stdout = outputs[spawnCalls];
        spawnCalls += 1;
        return { exitCode: 0, stdout: stdout ?? "", stderr: "" };
      },
    },
  });

  for (let index = 0; index < outputs.length; index += 1) {
    const authority = {
      ...sessionStartAuthority(`0198f3d2-1950-7000-8000-00000000004${index}`),
      taskId: `task-output-${index}`,
      attemptId: `attempt-output-${index}`,
    };
    const sentBefore = socket.sent.length;
    socket.message(
      JSON.stringify({
        protocolVersion: "1.2",
        kind: "relay.invoke",
        payload: {
          dispatchId: `dispatch-output-${index}`,
          requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
          authority,
        },
      }),
    );
    const accepted = decodeDesktopBrowserMessage(
      await waitFor(
        () => (socket.sent.length > sentBefore ? socket.sent[sentBefore] : undefined),
        `output accepted ${index}`,
      ),
      "1.2",
      "1.0",
    ) as HostAcceptedMessage;
    const result = decodeDesktopBrowserMessage(
      await waitFor(
        () => (socket.sent.length > sentBefore + 1 ? socket.sent[sentBefore + 1] : undefined),
        `output failure ${index}`,
      ),
      "1.2",
      "1.0",
    ) as HostResultMessage;
    assert.equal(accepted.payload.operationId, authority.operationId);
    assert.equal(result.payload.outcome, "unknown");
  }

  assert.equal(spawnCalls, 2);
  assert.equal(existsSync(join(dir, "sessions")), false);
  socket.close(1000, "done");
  await running;
});

test("post-fence BrowserSkill timeout persists unknown without task ownership or retry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-timeout-"));
  const child = new FakeChildProcess();
  const originalKill = child.kill.bind(child);
  child.kill = (signal: string): boolean => {
    const result = originalKill(signal);
    if (signal === "SIGKILL") setImmediate(() => child.close(null));
    return result;
  };
  const sessionRunner = createDefaultHostBrokerSessionRunner({
    spawn: () => child as never,
    defaultTimeoutMs: 5,
    killGraceMs: 5,
  });
  const { socket, running } = await connectOperationHost({
    dataDir: dir,
    browserSkillTimeoutMs: 5,
    sessionRunner,
  });
  const authority = {
    ...sessionStartAuthority("0198f3d2-1950-7000-8000-000000000060"),
    taskId: "task-timeout-1",
    attemptId: "attempt-timeout-1",
  };
  const sentBefore = socket.sent.length;
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-timeout-1",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
        authority,
      },
    }),
  );
  const accepted = decodeDesktopBrowserMessage(
    await waitFor(() => (socket.sent.length > sentBefore ? socket.sent[sentBefore] : undefined), "timeout accepted"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const result = decodeDesktopBrowserMessage(
    await waitFor(
      () => (socket.sent.length > sentBefore + 1 ? socket.sent[sentBefore + 1] : undefined),
      "timeout failure",
    ),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(accepted.payload.operationId, authority.operationId);
  assert.equal(result.payload.outcome, "unknown");
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  assert.equal(existsSync(join(dir, "sessions")), false);
  socket.close(1000, "done");
  await running;
});

test("disconnect waits for runner cancellation before settling and persisting unknown replay state", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-disconnect-cancel-"));
  let releaseCancel: (() => void) | undefined;
  let cancelCalls = 0;
  let settled = false;
  const { socket, running } = await connectOperationHost({
    dataDir: dir,
    sessionRunner: {
      run(_executable, _argv, _options, control) {
        assert.ok(control?.signal instanceof AbortSignal);
        let rejectRun: ((error: Error) => void) | undefined;
        return {
          result: new Promise<never>((_resolve, reject) => {
            rejectRun = reject;
          }),
          async cancel(reason) {
            cancelCalls += 1;
            assert.match(reason?.message ?? "", /disconnect|closed|stop/i);
            await new Promise<void>((resolve) => {
              releaseCancel = resolve;
            });
            rejectRun?.(reason ?? new Error("cancelled"));
          },
        };
      },
    },
  });
  void running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  const authority = {
    ...sessionStartAuthority("0198f3d2-1950-7000-8000-000000000061"),
    taskId: "task-disconnect-cancel-1",
    attemptId: "attempt-disconnect-cancel-1",
  };
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-disconnect-cancel-1",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
        authority,
      },
    }),
  );
  await waitFor(() => (cancelCalls === 0 ? true : undefined), "invoke accepted before disconnect");
  socket.close(1006, "connection lost");
  await flushAsyncWork();
  assert.equal(cancelCalls, 1);
  assert.equal(settled, false);
  releaseCancel?.();
  await assert.rejects(running, /retryable|transport|closed/i);
  const fenceFile = readdirSync(join(dir, "operations"))[0]!;
  const fence = JSON.parse(readFileSync(join(dir, "operations", fenceFile), "utf8")) as {
    state?: string;
    terminalPayload?: { outcome?: string };
  };
  assert.equal(fence.state, "unknown");
  assert.equal(fence.terminalPayload?.outcome, "unknown");
});

test("default runner timeout sends TERM then bounded KILL and waits for child close", async () => {
  const child = new FakeChildProcess();
  const runner = createDefaultHostBrokerSessionRunner({
    spawn: () => child as never,
    defaultTimeoutMs: 5,
    killGraceMs: 5,
    closeGraceMs: 5,
  });
  const run = runner.run("/opt/qm/browser-skill/bsk", ["--json", "session", "start", "--browser", "browser-primary"], {
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  assert.equal(typeof run, "object");
  assert.ok("result" in run);
  const handle = run;
  await delay(12);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
  let settled = false;
  void handle.result.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  assert.equal(settled, false);
  child.close(null);
  await assert.rejects(handle.result, /timed out/);
});

test("default runner cancellation fails after a second close deadline when SIGKILL never closes the child", async () => {
  const child = new FakeChildProcess();
  const runner = createDefaultHostBrokerSessionRunner({
    spawn: () => child as never,
    defaultTimeoutMs: 60_000,
    killGraceMs: 5,
    closeGraceMs: 5,
  });
  const run = runner.run(
    TEST_BROWSER_SKILL_EXECUTABLE,
    ["--json", "session", "start", "--browser", "browser-primary"],
    {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  assert.equal(typeof run, "object");
  assert.ok("result" in run);
  const handle = run;
  await assert.rejects(handle.cancel(new Error("disconnect")), /failed to terminate after SIGKILL/);
  await assert.rejects(handle.result, /failed to terminate after SIGKILL/);
  assert.deepEqual(child.killSignals, ["SIGTERM", "SIGKILL"]);
});

test("disconnect after durable completion preserves completed ownership and replays without respawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-disconnect-completed-"));
  let resolveRun: ((result: { exitCode: number; stdout: string; stderr: string }) => void) | undefined;
  let spawnCalls = 0;
  const sessionRunner: HostBrokerSessionRunner = {
    run() {
      spawnCalls += 1;
      return new Promise((resolve) => {
        resolveRun = resolve;
      });
    },
  };
  const authority = sessionStartAuthority("0198f3d2-1950-7000-8000-000000000051");
  const requestHash = computeDesktopBrowserRequestHash(authority, "1.2", "1.0");
  const invocation = {
    protocolVersion: "1.2",
    kind: "relay.invoke",
    payload: { dispatchId: "dispatch-disconnect", requestHash, authority },
  };
  const first = await connectOperationHost({ dataDir: dir, sessionRunner });
  first.socket.message(JSON.stringify(invocation));
  await waitFor(
    () => (existsSync(join(dir, "operations")) && spawnCalls === 1 ? true : undefined),
    "accepted operation fence",
  );
  resolveRun?.({
    exitCode: 0,
    stdout: JSON.stringify({
      session_id: "session-ambiguous",
      browser_instance_id: "browser-primary",
      agent_window_id: 42,
    }),
    stderr: "",
  });
  first.socket.close(1006, "connection lost");
  await assert.rejects(first.running, /retryable|transport|closed/i);
  await waitFor(() => {
    const fenceFile = readdirSync(join(dir, "operations"))[0];
    if (!fenceFile) return undefined;
    const fence = JSON.parse(readFileSync(join(dir, "operations", fenceFile), "utf8")) as { state?: string };
    return fence.state === "completed" ? true : undefined;
  }, "completed operation fence");
  const sessionFile = readdirSync(join(dir, "sessions"))[0];
  assert.ok(sessionFile);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "sessions", sessionFile!), "utf8")), {
    taskId: authority.taskId,
    attemptId: authority.attemptId,
    operationId: authority.operationId,
    requestHash,
    sessionId: "session-ambiguous",
    browserInstanceId: "browser-primary",
    agentWindowId: 42,
    latestOperationSequence: 1,
    latestLeaseVersion: 3,
  });

  const second = await connectOperationHost({ dataDir: dir, sessionRunner });
  second.socket.message(JSON.stringify(invocation));
  const accepted = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[2], "unknown replay accepted"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const replay = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[3], "completed replay result"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(accepted.payload.operationId, authority.operationId);
  assert.equal(accepted.payload.dispatchId, "dispatch-disconnect");
  assert.deepEqual(replay.payload, {
    dispatchId: "dispatch-disconnect",
    operationId: authority.operationId,
    outcome: "completed",
    resultHash: replay.payload.resultHash,
    result: {
      session_id: "session-ambiguous",
      browser_instance_id: "browser-primary",
      agent_window_id: 42,
    },
  });
  assert.equal(spawnCalls, 1);

  const replayFenceFile = readdirSync(join(dir, "operations"))[0]!;
  const replayFence = JSON.parse(readFileSync(join(dir, "operations", replayFenceFile), "utf8")) as {
    terminalPayload?: { dispatchId?: string };
  };
  assert.equal(replayFence.terminalPayload?.dispatchId, "dispatch-disconnect");

  second.socket.close(1000, "replayed");
  await second.running;

  const third = await connectOperationHost({ dataDir: dir, sessionRunner });
  third.socket.message(
    JSON.stringify({
      ...invocation,
      payload: { ...invocation.payload, dispatchId: "dispatch-replay-unknown" },
    }),
  );
  const replayAccepted = decodeDesktopBrowserMessage(
    await waitFor(() => third.socket.sent[2], "new dispatch accepted result"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const replayCompleted = decodeDesktopBrowserMessage(
    await waitFor(() => third.socket.sent[3], "new dispatch completed result"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(replayAccepted.payload.dispatchId, "dispatch-replay-unknown");
  assert.deepEqual(replayCompleted.payload, {
    dispatchId: "dispatch-replay-unknown",
    operationId: authority.operationId,
    outcome: "completed",
    resultHash: replayCompleted.payload.resultHash,
    result: {
      session_id: "session-ambiguous",
      browser_instance_id: "browser-primary",
      agent_window_id: 42,
    },
  });

  third.socket.close(1000, "done");
  await third.running;
});

test("explicit spawn rejection after acceptance persists failed and replays without respawn", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-spawn-rejected-"));
  let spawnCalls = 0;
  const authority = sessionStartAuthority("0198f3d2-1950-7000-8000-000000000052");
  const requestHash = computeDesktopBrowserRequestHash(authority, "1.2", "1.0");
  const invocation = {
    protocolVersion: "1.2",
    kind: "relay.invoke",
    payload: { dispatchId: "dispatch-spawn-rejected", requestHash, authority },
  };
  const sessionRunner: HostBrokerSessionRunner = {
    async run() {
      spawnCalls += 1;
      throw new HostBrokerSpawnRejectedError("spawn ENOENT");
    },
  };

  const first = await connectOperationHost({ dataDir: dir, sessionRunner });
  first.socket.message(JSON.stringify(invocation));
  const accepted = decodeDesktopBrowserMessage(
    await waitFor(() => first.socket.sent[2], "spawn rejected accepted result"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const failed = decodeDesktopBrowserMessage(
    await waitFor(() => first.socket.sent[3], "spawn rejected failed result"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.deepEqual(accepted.payload, {
    dispatchId: "dispatch-spawn-rejected",
    operationId: authority.operationId,
    requestHash,
  });
  assert.deepEqual(failed.payload, {
    dispatchId: "dispatch-spawn-rejected",
    operationId: authority.operationId,
    outcome: "failed",
    resultHash: failed.payload.resultHash,
    error: {
      code: "browser_cli_spawn_rejected",
      message: "BrowserSkill process creation was rejected before execution",
    },
  });
  assert.equal(spawnCalls, 1);
  assert.equal(existsSync(join(dir, "sessions")), false);
  const fenceFile = readdirSync(join(dir, "operations"))[0]!;
  const fence = JSON.parse(readFileSync(join(dir, "operations", fenceFile), "utf8")) as {
    state: string;
    terminalPayload?: { dispatchId?: string; outcome?: string; error?: { code?: string; message?: string } };
  };
  assert.equal(fence.state, "failed");
  assert.deepEqual(fence.terminalPayload, {
    dispatchId: "dispatch-spawn-rejected",
    outcome: "failed",
    error: {
      code: "browser_cli_spawn_rejected",
      message: "BrowserSkill process creation was rejected before execution",
    },
  });
  first.socket.close(1000, "done");
  await first.running;

  const second = await connectOperationHost({ dataDir: dir, sessionRunner });
  second.socket.message(
    JSON.stringify({
      ...invocation,
      payload: { ...invocation.payload, dispatchId: "dispatch-spawn-rejected-replay" },
    }),
  );
  const replayAccepted = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[2], "spawn rejected replay accepted"),
    "1.2",
    "1.0",
  ) as HostAcceptedMessage;
  const replayFailed = decodeDesktopBrowserMessage(
    await waitFor(() => second.socket.sent[3], "spawn rejected replay failed"),
    "1.2",
    "1.0",
  ) as HostResultMessage;
  assert.equal(replayAccepted.payload.dispatchId, "dispatch-spawn-rejected-replay");
  assert.deepEqual(replayFailed.payload, {
    dispatchId: "dispatch-spawn-rejected-replay",
    operationId: authority.operationId,
    outcome: "failed",
    resultHash: replayFailed.payload.resultHash,
    error: {
      code: "browser_cli_spawn_rejected",
      message: "BrowserSkill process creation was rejected before execution",
    },
  });
  assert.equal(spawnCalls, 1);
  second.socket.close(1000, "done");
  await second.running;
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
      browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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

test("installed BrowserSkill executable rejects legacy env, relative paths, PATH lookups, symlinks, and non-executables", () => {
  const installDir = mkdtempSync(join(tmpdir(), "host-broker-bsk-install-"));
  const configPath = join(installDir, "browser-skill-executable.txt");
  const target = writeExecutable(join(installDir, "bsk"));
  const symlinkPath = join(installDir, "bsk-link");
  const nonExecutablePath = join(installDir, "bsk-noexec");
  writeFileSync(nonExecutablePath, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(nonExecutablePath, 0o644);
  symlinkSync(target, symlinkPath);

  assert.throws(
    () =>
      resolveInstalledBrowserSkillExecutable({
        env: { QM_HOST_BROKER_BSK_EXECUTABLE: target },
        installRoot: installDir,
      }),
    /QM_HOST_BROKER_BSK_EXECUTABLE.*unsupported|rejected|removed/i,
  );

  writeFileSync(configPath, "bsk\n", "utf8");
  chmodSync(configPath, 0o600);
  assert.throws(() => resolveInstalledBrowserSkillExecutable({ env: {}, installRoot: installDir }), /absolute/i);

  writeFileSync(configPath, "./bsk\n", "utf8");
  chmodSync(configPath, 0o600);
  assert.throws(() => resolveInstalledBrowserSkillExecutable({ env: {}, installRoot: installDir }), /absolute/i);

  writeFileSync(configPath, `${symlinkPath}\n`, "utf8");
  chmodSync(configPath, 0o600);
  assert.throws(
    () => resolveInstalledBrowserSkillExecutable({ env: {}, installRoot: installDir }),
    /symlink|symbolic link/i,
  );

  writeFileSync(configPath, `${nonExecutablePath}\n`, "utf8");
  chmodSync(configPath, 0o600);
  assert.throws(() => resolveInstalledBrowserSkillExecutable({ env: {}, installRoot: installDir }), /executable/i);
});

test("installed BrowserSkill executable resolves one fixed absolute path and the broker spawns it with shell disabled", async () => {
  const installDir = mkdtempSync(join(tmpdir(), "host-broker-bsk-absolute-"));
  const executable = writeExecutable(join(installDir, "bsk"));
  writeFileSync(join(installDir, "browser-skill-executable.txt"), `${executable}\n`, "utf8");
  chmodSync(join(installDir, "browser-skill-executable.txt"), 0o600);
  assert.equal(resolveInstalledBrowserSkillExecutable({ env: {}, installRoot: installDir }), executable);

  const dir = mkdtempSync(join(tmpdir(), "host-broker-absolute-spawn-"));
  const spawnCalls: Array<{ executable: string; argv: readonly string[]; options: unknown }> = [];
  const { socket, running } = await connectOperationHost({
    dataDir: dir,
    browserSkillExecutable: executable,
    sessionRunner: {
      run(nextExecutable, argv, options) {
        spawnCalls.push({ executable: nextExecutable, argv, options });
        return {
          result: Promise.resolve({
            exitCode: 0,
            stdout: JSON.stringify({
              session_id: "session-absolute",
              browser_instance_id: "browser-primary",
              agent_window_id: 7,
            }),
            stderr: "",
          }),
          async cancel() {},
        };
      },
    },
  });
  const authority = {
    ...sessionStartAuthority("0198f3d2-1950-7000-8000-000000000062"),
    taskId: "task-absolute-1",
    attemptId: "attempt-absolute-1",
  };
  socket.message(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "relay.invoke",
      payload: {
        dispatchId: "dispatch-absolute-1",
        requestHash: computeDesktopBrowserRequestHash(authority, "1.2", "1.0"),
        authority,
      },
    }),
  );
  await waitFor(() => (spawnCalls.length === 1 ? true : undefined), "absolute spawn call");
  assert.deepEqual(spawnCalls, [
    {
      executable,
      argv: ["--json", "session", "start", "--browser", "browser-primary"],
      options: { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    },
  ]);
  socket.close(1000, "done");
  await running;
});

test("direct HostBrokerConnection construction requires an absolute BrowserSkill executable for the default runner", async () => {
  const dir = mkdtempSync(join(tmpdir(), "host-broker-direct-library-reject-"));
  const identity = await loadOrCreateDeviceIdentity(dir);

  assert.throws(
    () =>
      new HostBrokerConnection({
        qmUrl: "https://qm.example.com",
        relayUrl: "wss://relay.example.com/v1/device",
        brokerInstanceId: "broker-local-1",
        brokerVersion: "0.0.0-test",
        supportedProtocolVersions: ["1.0"],
        supportedPolicyGrammarVersions: ["1.0"],
        identity,
        runtime: runtime(),
        transport: new FakeTransport(new FakeSocket(), "wss://relay.example.com/v1/device"),
      }),
    /required/i,
  );

  assert.throws(
    () =>
      new HostBrokerConnection({
        qmUrl: "https://qm.example.com",
        relayUrl: "wss://relay.example.com/v1/device",
        brokerInstanceId: "broker-local-1",
        brokerVersion: "0.0.0-test",
        supportedProtocolVersions: ["1.0"],
        supportedPolicyGrammarVersions: ["1.0"],
        identity,
        runtime: runtime(),
        browserSkillExecutable: "./bsk",
        transport: new FakeTransport(new FakeSocket(), "wss://relay.example.com/v1/device"),
      }),
    /absolute/i,
  );
});

test("runHostBrokerCli connect rejects omitted and relative BrowserSkill executables for the default runner", async () => {
  const makeDeps = (browserSkillExecutable?: string) => ({
    dataDir: mkdtempSync(join(tmpdir(), "host-broker-cli-library-reject-")),
    stdout: { write() {} },
    stderr: { write() {} },
    runtime: runtime(),
    ...(browserSkillExecutable === undefined ? {} : { browserSkillExecutable }),
  });

  await assert.rejects(() => runHostBrokerCli(["connect", "https://qm.example.com"], makeDeps()), /required/i);
  await assert.rejects(() => runHostBrokerCli(["connect", "https://qm.example.com"], makeDeps("./bsk")), /absolute/i);
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    negotiatedProtocolVersion: "1.0",
    negotiatedPolicyGrammarVersion: "1.0",
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
      browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
      browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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
    browserSkillExecutable: TEST_BROWSER_SKILL_EXECUTABLE,
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

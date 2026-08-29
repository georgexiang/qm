import { createHash, randomUUID } from "node:crypto";
import {
  DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  computeDesktopBrowserRequestHash,
  computeDesktopBrowserPublicDeviceFingerprint,
  decodeDesktopBrowserMessage,
  encodeDesktopBrowserMessage,
  projectDesktopBrowserPublicIdentity,
  verifyHostChallengeResponseMessage,
  type DesktopBrowserHostFailure,
  type DesktopBrowserArtifactIntent,
  type DesktopBrowserOperationAuthorityEnvelope,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserRelayRegistryBinding,
  type HostAcceptedMessage,
  type HostResultMessage,
  type HostHelloMessage,
  type RelayInvocationMessage,
  type RelayChallengeMessage,
  type RelayArtifactGrantMessage,
} from "qm-desktop-browser-contracts";
import type { WebSocket, WebSocketServer } from "ws";
import { type DesktopBrowserRelayOperationStore } from "./operation-store.ts";

type RelayConnectionStage = "awaiting_hello" | "awaiting_challenge_response" | "pending" | "registered" | "closing";

type RelayTimerHandle = unknown;

export interface DesktopBrowserRelaySocket {
  addEventListener(type: "message" | "close" | "error" | "pong", listener: (event?: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  ping(data?: Uint8Array<ArrayBuffer>): void;
}

export type DesktopBrowserRelayBinding = DesktopBrowserRelayRegistryBinding;

export type DesktopBrowserRelayProjection = DesktopBrowserRelayConnectionProjection;

export interface DesktopBrowserRelaySnapshot extends DesktopBrowserRelayProjection {
  stage: RelayConnectionStage;
  devicePublicKey: string;
  supportedProtocolVersions: string[];
  supportedPolicyGrammarVersions: string[];
}

export interface DesktopBrowserRelayRegistryAdapter {
  resolveBinding(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
  }): Promise<DesktopBrowserRelayBinding | null>;
  publishConnection(projection: DesktopBrowserRelayProjection): Promise<void>;
  clearConnection(connectionId: string): Promise<void>;
  reconcileDevice?(input: {
    reconciliationId: string;
    devicePublicKey: string;
    browserInstanceId: string;
    confirmedAt: number;
  }): Promise<void>;
}

export interface DesktopBrowserRelayArtifactGrantClient {
  requestGrant(intent: DesktopBrowserArtifactIntent): Promise<RelayArtifactGrantMessage["payload"]>;
}

export interface DesktopBrowserRelayClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): RelayTimerHandle;
  clearTimeout(handle: RelayTimerHandle): void;
  setInterval(callback: () => void, ms: number): RelayTimerHandle;
  clearInterval(handle: RelayTimerHandle): void;
}

export type RelayDispatchResult =
  | {
      kind: "host.result";
      accepted: HostAcceptedMessage;
      result: HostResultMessage;
    }
  | {
      kind: "not_accepted_or_unknown";
      dispatchId: string;
      operationId: string;
      requestHash: string;
      error: DesktopBrowserHostFailure;
    }
  | {
      kind: "accepted_unknown";
      accepted: HostAcceptedMessage;
      result?: HostResultMessage;
      error: DesktopBrowserHostFailure;
    };

export interface DesktopBrowserRelayServiceOptions {
  relayInstanceId: string;
  deploymentCanonicalId: string;
  supportedProtocolVersions: string[];
  supportedPolicyGrammarVersions: string[];
  registry: DesktopBrowserRelayRegistryAdapter;
  clock?: DesktopBrowserRelayClock;
  maxMessageBytes?: number;
  helloTimeoutMs?: number;
  challengeTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  heartbeatGraceMs?: number;
  invocationTimeoutMs?: number;
  maxSettledDispatchHistory?: number;
  settledDispatchHistoryTtlMs?: number;
  createNonce?: () => string;
  createConnectionId?: () => string;
  operationStore?: DesktopBrowserRelayOperationStore;
  artifactGrantClient?: DesktopBrowserRelayArtifactGrantClient;
}

interface RelayConnectionState {
  readonly connectionId: string;
  readonly socket: DesktopBrowserRelaySocket;
  stage: RelayConnectionStage;
  processing: Promise<void>;
  stageTimer: RelayTimerHandle | null;
  heartbeatTimer: RelayTimerHandle | null;
  heartbeatDeadlineTimer: RelayTimerHandle | null;
  hello: HostHelloMessage | null;
  binding: DesktopBrowserRelayBinding | null;
  challenge: RelayChallengeMessage | null;
  negotiatedProtocolVersion: `${number}.${number}` | null;
  negotiatedPolicyGrammarVersion: string | null;
  projectionPublished: boolean;
  currentLease: { taskId: string; attemptId: string; leaseId: string; leaseVersion: number } | null;
  pendingDispatch: {
    dispatchId: string;
    operationId: string;
    requestHash: string;
    authority: DesktopBrowserOperationAuthorityEnvelope;
    timeout: RelayTimerHandle;
    accepted: HostAcceptedMessage | null;
    resolve: (result: RelayDispatchResult) => void;
  } | null;
  lastSeenAt: number;
  closeReason: string | null;
}

interface RelayDispatchHistoryEntry {
  operationId: string;
  requestHash: string;
  state: "in_flight" | "accepted" | "terminal" | "unknown";
  settledAt: number | null;
}

interface RelayDispatchTombstone {
  operationId: string;
  requestHash: string;
  state: "accepted" | "terminal" | "unknown";
  expiresAt: number;
}

interface RelayOperationRequestHashEntry {
  requestHash: string;
  refCount: number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_GRACE_MS = 5_000;
const DEFAULT_INVOCATION_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_SETTLED_DISPATCH_HISTORY = 1_024;
const DEFAULT_SETTLED_DISPATCH_HISTORY_TTL_MS = 300_000;

const systemClock: DesktopBrowserRelayClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  setInterval: (callback, ms) => setInterval(callback, ms),
  clearInterval: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
};

function iso(at: number): string {
  return new Date(at).toISOString();
}

function canonicalVersionParts(version: string): { major: number; minor: number } {
  const match = /^(0|[1-9][0-9]{0,8})\.(0|[1-9][0-9]{0,8})$/.exec(version);
  if (!match) throw new Error(`invalid canonical version ${JSON.stringify(version)}`);
  return { major: Number(match[1]), minor: Number(match[2]) };
}

function compareCanonicalVersions(left: string, right: string): number {
  const leftParts = canonicalVersionParts(left);
  const rightParts = canonicalVersionParts(right);
  if (leftParts.major !== rightParts.major) return leftParts.major - rightParts.major;
  return leftParts.minor - rightParts.minor;
}

function negotiateProtocolVersion(remoteSupported: string[], localSupported: string[]): `${number}.${number}` {
  const remote = new Set(remoteSupported);
  const candidates = [...localSupported].sort((left, right) => compareCanonicalVersions(right, left));
  for (const candidate of candidates) {
    if (remote.has(candidate)) {
      return candidate as `${number}.${number}`;
    }
  }
  throw new Error("no compatible desktop browser protocol version available");
}

function negotiatePolicyGrammarVersion(remoteSupported: string[], localSupported: string[]): string {
  const remote = new Set(remoteSupported);
  const candidates = [...localSupported].filter((candidate) => remote.has(candidate));
  if (candidates.length === 0) throw new Error("no compatible policy grammar version available");
  return candidates.sort((left, right) => compareCanonicalVersions(right, left))[0]!;
}

function byteLength(raw: string): number {
  return Buffer.byteLength(raw, "utf8");
}

function identityKey(binding: Pick<DesktopBrowserRelayBinding, "devicePublicKey" | "brokerInstanceId">): string {
  return `${binding.devicePublicKey}\u0000${binding.brokerInstanceId}`;
}

function eventData(event?: unknown): string {
  if (typeof event === "string") return event;
  if (event instanceof Uint8Array) return Buffer.from(event).toString("utf8");
  if (event && typeof event === "object" && "data" in event) {
    const data = (event as { data: unknown }).data;
    if (typeof data === "string") return data;
    if (data instanceof Uint8Array) return Buffer.from(data).toString("utf8");
    return String(data ?? "");
  }
  return String(event ?? "");
}

function socketCloseCode(event?: unknown): number | undefined {
  if (!event || typeof event !== "object" || !("code" in event)) return undefined;
  const code = (event as { code?: unknown }).code;
  return typeof code === "number" ? code : undefined;
}

export class DesktopBrowserRelayService {
  private readonly options: Required<
    Pick<
      DesktopBrowserRelayServiceOptions,
      | "relayInstanceId"
      | "deploymentCanonicalId"
      | "supportedProtocolVersions"
      | "supportedPolicyGrammarVersions"
      | "registry"
      | "maxMessageBytes"
      | "helloTimeoutMs"
      | "challengeTimeoutMs"
      | "heartbeatIntervalMs"
      | "heartbeatGraceMs"
      | "invocationTimeoutMs"
      | "maxSettledDispatchHistory"
      | "settledDispatchHistoryTtlMs"
    >
  > & {
    clock: DesktopBrowserRelayClock;
    createNonce: () => string;
    createConnectionId: () => string;
  };
  private readonly connections = new Map<string, RelayConnectionState>();
  private readonly currentByIdentity = new Map<string, string>();
  private readonly operationRequestHashById = new Map<string, RelayOperationRequestHashEntry>();
  private readonly dispatchHistoryById = new Map<string, RelayDispatchHistoryEntry>();
  private readonly settledDispatchOrder: string[] = [];
  private readonly dispatchTombstonesById = new Map<string, RelayDispatchTombstone>();
  private readonly dispatchTombstoneOrder: string[] = [];
  private readonly operationStore: DesktopBrowserRelayOperationStore | null;
  private readonly artifactGrantClient: DesktopBrowserRelayArtifactGrantClient | null;
  private draining = false;

  constructor(options: DesktopBrowserRelayServiceOptions) {
    this.options = {
      relayInstanceId: options.relayInstanceId,
      deploymentCanonicalId: options.deploymentCanonicalId,
      supportedProtocolVersions: options.supportedProtocolVersions,
      supportedPolicyGrammarVersions: options.supportedPolicyGrammarVersions,
      registry: options.registry,
      maxMessageBytes: options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES,
      helloTimeoutMs: options.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS,
      challengeTimeoutMs: options.challengeTimeoutMs ?? DEFAULT_CHALLENGE_TIMEOUT_MS,
      heartbeatIntervalMs: options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
      heartbeatGraceMs: options.heartbeatGraceMs ?? DEFAULT_HEARTBEAT_GRACE_MS,
      invocationTimeoutMs: options.invocationTimeoutMs ?? DEFAULT_INVOCATION_TIMEOUT_MS,
      maxSettledDispatchHistory: options.maxSettledDispatchHistory ?? DEFAULT_MAX_SETTLED_DISPATCH_HISTORY,
      settledDispatchHistoryTtlMs: options.settledDispatchHistoryTtlMs ?? DEFAULT_SETTLED_DISPATCH_HISTORY_TTL_MS,
      clock: options.clock ?? systemClock,
      createNonce: options.createNonce ?? (() => randomUUID()),
      createConnectionId: options.createConnectionId ?? (() => randomUUID()),
    };
    this.operationStore = options.operationStore ?? null;
    this.artifactGrantClient = options.artifactGrantClient ?? null;
    if (this.options.supportedProtocolVersions.length === 0) {
      throw new Error("at least one supported protocol version is required");
    }
    if (this.options.supportedPolicyGrammarVersions.length === 0) {
      throw new Error("at least one supported policy grammar version is required");
    }
    if (!Number.isSafeInteger(this.options.maxSettledDispatchHistory) || this.options.maxSettledDispatchHistory < 1) {
      throw new Error("maxSettledDispatchHistory must be a positive safe integer");
    }
    if (
      !Number.isSafeInteger(this.options.settledDispatchHistoryTtlMs) ||
      this.options.settledDispatchHistoryTtlMs < 1
    ) {
      throw new Error("settledDispatchHistoryTtlMs must be a positive safe integer");
    }
  }

  acceptSocket(socket: DesktopBrowserRelaySocket): string {
    const connectionId = this.options.createConnectionId();
    if (this.draining) {
      socket.close(1012, "service restart");
      return connectionId;
    }
    const connection: RelayConnectionState = {
      connectionId,
      socket,
      stage: "awaiting_hello",
      processing: Promise.resolve(),
      stageTimer: null,
      heartbeatTimer: null,
      heartbeatDeadlineTimer: null,
      hello: null,
      binding: null,
      challenge: null,
      negotiatedProtocolVersion: null,
      negotiatedPolicyGrammarVersion: null,
      projectionPublished: false,
      currentLease: null,
      pendingDispatch: null,
      lastSeenAt: this.options.clock.now(),
      closeReason: null,
    };
    this.connections.set(connectionId, connection);
    connection.stageTimer = this.options.clock.setTimeout(() => {
      void this.failConnection(connection, "host hello timed out before relay challenge started");
    }, this.options.helloTimeoutMs);
    socket.addEventListener("message", (event) => {
      connection.processing = connection.processing
        .then(async () => {
          await this.handleMessage(connection, eventData(event));
        })
        .catch(async (error) => {
          await this.failConnection(connection, error instanceof Error ? error.message : String(error));
        });
    });
    socket.addEventListener("pong", () => {
      void this.recordHeartbeat(connection);
    });
    socket.addEventListener("error", () => {
      void this.failConnection(connection, "desktop browser relay transport failed");
    });
    socket.addEventListener("close", (event) => {
      void this.handleClose(connection, socketCloseCode(event));
    });
    return connectionId;
  }

  snapshots(): DesktopBrowserRelaySnapshot[] {
    return [...this.connections.values()]
      .filter(
        (connection) =>
          connection.binding &&
          connection.hello &&
          connection.negotiatedProtocolVersion &&
          connection.negotiatedPolicyGrammarVersion,
      )
      .map((connection) => this.snapshot(connection));
  }

  async refreshBinding(input: { devicePublicKey: string; brokerInstanceId: string }): Promise<void> {
    const candidates = [...this.connections.values()].filter((connection) => {
      if (!connection.binding) return false;
      return (
        connection.binding.devicePublicKey === input.devicePublicKey &&
        connection.binding.brokerInstanceId === input.brokerInstanceId &&
        (connection.stage === "pending" || connection.stage === "registered")
      );
    });
    for (const connection of candidates) {
      const latest = await this.options.registry.resolveBinding({
        devicePublicKey: input.devicePublicKey,
        brokerInstanceId: input.brokerInstanceId,
      });
      if (!latest) continue;
      if (!connection.binding) continue;
      const sameBinding =
        latest.browserInstanceId === connection.binding.browserInstanceId &&
        latest.connectionEpoch === connection.binding.connectionEpoch;
      if (sameBinding && latest.registrationState !== connection.binding.registrationState) {
        connection.binding = latest;
        connection.stage = latest.registrationState;
        await this.publishProjection(connection);
        continue;
      }
      if (!sameBinding) {
        await this.failConnection(connection, "connection epoch has been replaced by a newer registration");
      }
    }
  }

  async dispatchInvocation(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    invocation: RelayInvocationMessage;
  }): Promise<RelayDispatchResult> {
    const connection = await this.resolveCurrentRegisteredConnection(input);
    const binding = connection.binding;
    if (!binding) throw new Error("desktop browser host is not connected");
    if (!connection.negotiatedProtocolVersion) {
      throw new Error("desktop browser host protocol version is unavailable");
    }
    if (
      compareCanonicalVersions(connection.negotiatedProtocolVersion, DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION) < 0
    ) {
      throw new Error(
        `desktop browser invocation requires protocol version ${DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION} or newer`,
      );
    }

    if (input.invocation.protocolVersion !== connection.negotiatedProtocolVersion) {
      throw new Error(
        `desktop browser invocation requires negotiated protocol version ${input.invocation.protocolVersion}`,
      );
    }
    if (!connection.hello || !connection.negotiatedPolicyGrammarVersion) {
      throw new Error("desktop browser host capability identity is unavailable");
    }
    const decoded = decodeDesktopBrowserMessage(
      encodeDesktopBrowserMessage(input.invocation),
      connection.negotiatedProtocolVersion,
      connection.negotiatedPolicyGrammarVersion,
    );
    if (decoded.kind !== "relay.invoke") {
      throw new Error("desktop browser relay dispatch requires a relay.invoke message");
    }
    const canonicalRequestHash = computeDesktopBrowserRequestHash(
      decoded.payload.authority,
      connection.negotiatedProtocolVersion,
      connection.negotiatedPolicyGrammarVersion,
    );
    if (decoded.payload.requestHash !== canonicalRequestHash) {
      throw new Error(
        `relay.invoke requestHash ${JSON.stringify(decoded.payload.requestHash)} does not match canonical request hash ${JSON.stringify(canonicalRequestHash)}`,
      );
    }
    const authority = decoded.payload.authority;
    if (Date.parse(authority.leaseExpiresAt) <= this.options.clock.now()) {
      throw new Error("desktop browser invocation Lease expired before Relay delivery");
    }
    if (authority.deploymentCanonicalId !== this.options.deploymentCanonicalId) {
      throw new Error("desktop browser invocation deployment does not match this relay");
    }
    if (authority.deviceId.length === 0) {
      throw new Error("desktop browser invocation device identity is unavailable");
    }
    if (authority.browserInstanceId !== input.browserInstanceId) {
      throw new Error("desktop browser invocation browser does not match the requested host");
    }
    if (authority.browserInstanceId !== binding.browserInstanceId) {
      throw new Error("desktop browser invocation browser does not match the registered host");
    }
    if (binding.devicePublicKey !== input.devicePublicKey) {
      throw new Error("desktop browser invocation device key does not match the registered host");
    }
    if (binding.brokerInstanceId !== input.brokerInstanceId) {
      throw new Error("desktop browser invocation broker does not match the registered host");
    }
    const advertised = connection.hello.payload;
    const capability = authority.capabilitySet;
    if (
      capability.protocolVersion !== connection.negotiatedProtocolVersion ||
      capability.policyGrammarVersion !== connection.negotiatedPolicyGrammarVersion ||
      capability.bskVersion !== advertised.bskVersion ||
      capability.extensionVersion !== advertised.extensionVersion ||
      capability.cliShapeHash !== advertised.cliShapeHash
    ) {
      throw new Error("desktop browser invocation capability set does not match the registered host");
    }
    if (connection.pendingDispatch) {
      throw new Error("desktop browser host already has an in-flight invocation");
    }
    if (this.operationStore) {
      const prepared = await this.operationStore.prepare(decoded);
      if (prepared.status === "existing" && prepared.checkpoint.deliveryState === "started") {
        return {
          kind: "not_accepted_or_unknown",
          dispatchId: decoded.payload.dispatchId,
          operationId: authority.operationId,
          requestHash: canonicalRequestHash,
          error: this.relayDeliveryUnknown(
            prepared.checkpoint.state === "accepted"
              ? "Host acceptance is durable but the terminal result is unavailable"
              : "Prior wire delivery may have reached the Host and cannot be repeated",
          ),
        };
      }
    }
    connection.currentLease = {
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      leaseId: authority.leaseId,
      leaseVersion: authority.leaseVersion,
    };
    this.pruneDispatchTracking(this.options.clock.now());
    this.assertOperationRequestHash(authority.operationId, canonicalRequestHash);
    this.assertDispatchIdAvailable(decoded.payload.dispatchId);
    return new Promise<RelayDispatchResult>((resolve, reject) => {
      this.startDispatchTracking(decoded.payload.dispatchId, authority.operationId, canonicalRequestHash);
      const timeout = this.options.clock.setTimeout(() => {
        if (connection.pendingDispatch?.dispatchId !== decoded.payload.dispatchId) return;
        void this.closeConnection(
          connection,
          1008,
          connection.pendingDispatch.accepted
            ? "desktop browser invocation timed out waiting for host.result after host.accepted"
            : "desktop browser invocation timed out waiting for host.accepted",
        );
      }, this.options.invocationTimeoutMs);
      connection.pendingDispatch = {
        dispatchId: decoded.payload.dispatchId,
        operationId: authority.operationId,
        requestHash: canonicalRequestHash,
        authority,
        timeout,
        accepted: null,
        resolve,
      };
      try {
        if (!this.operationStore) {
          connection.socket.send(encodeDesktopBrowserMessage(decoded));
          return;
        }
        void this.operationStore
          .markDeliveryStarted(authority.attemptId, decoded.payload.dispatchId)
          .then(
            async () => {
              if (
                !this.connections.has(connection.connectionId) ||
                connection.stage === "closing" ||
                connection.pendingDispatch?.dispatchId !== decoded.payload.dispatchId
              ) {
                await this.operationStore!.markDeliveryNotStarted(authority.attemptId, decoded.payload.dispatchId);
                return;
              }
              try {
                connection.socket.send(encodeDesktopBrowserMessage(decoded));
              } catch (error) {
                await this.operationStore!.markDeliveryNotStarted(authority.attemptId, decoded.payload.dispatchId);
                this.options.clock.clearTimeout(timeout);
                connection.pendingDispatch = null;
                this.dropDispatchTracking(decoded.payload.dispatchId);
                reject(error instanceof Error ? error : new Error(String(error)));
              }
            },
            (error) => {
              this.options.clock.clearTimeout(timeout);
              connection.pendingDispatch = null;
              this.dropDispatchTracking(decoded.payload.dispatchId);
              reject(error instanceof Error ? error : new Error(String(error)));
            },
          )
          .catch((error) => {
            if (connection.pendingDispatch?.dispatchId === decoded.payload.dispatchId) {
              this.options.clock.clearTimeout(timeout);
              connection.pendingDispatch = null;
              this.dropDispatchTracking(decoded.payload.dispatchId);
              reject(error instanceof Error ? error : new Error(String(error)));
            }
          });
      } catch (error) {
        this.options.clock.clearTimeout(timeout);
        connection.pendingDispatch = null;
        this.dropDispatchTracking(decoded.payload.dispatchId);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  async dispatchProjectedInvocation(input: {
    publicDeviceFingerprint: string;
    browserInstanceId: string;
    invocation: RelayInvocationMessage;
  }): Promise<RelayDispatchResult> {
    const candidates = [...this.connections.values()].filter((connection) => {
      if (connection.stage !== "registered" || !connection.binding || !connection.hello) return false;
      const snapshot = this.snapshot(connection);
      return (
        snapshot.publicDeviceFingerprint === input.publicDeviceFingerprint &&
        snapshot.browserInstanceId === input.browserInstanceId
      );
    });
    if (candidates.length !== 1) throw new Error("desktop browser host is not uniquely connected");
    const binding = candidates[0]!.binding!;
    return this.dispatchInvocation({
      devicePublicKey: binding.devicePublicKey,
      brokerInstanceId: binding.brokerInstanceId,
      browserInstanceId: input.browserInstanceId,
      invocation: input.invocation,
    });
  }

  async revokeProjectedLease(input: {
    publicDeviceFingerprint: string;
    browserInstanceId: string;
    taskId: string;
    attemptId: string;
    leaseId: string;
    leaseVersion: number;
  }): Promise<void> {
    if (!this.operationStore) throw new Error("desktop browser durable revocation storage is unavailable");
    await this.operationStore.recordLeaseRevocation(input);
    const candidates = [...this.connections.values()].filter((connection) => {
      if (connection.stage !== "registered" || !connection.binding || !connection.hello) return false;
      const snapshot = this.snapshot(connection);
      return (
        snapshot.publicDeviceFingerprint === input.publicDeviceFingerprint &&
        snapshot.browserInstanceId === input.browserInstanceId
      );
    });
    if (candidates.length !== 1) throw new Error("desktop browser host is not uniquely connected");
    const currentLease = candidates[0]!.currentLease;
    if (
      currentLease &&
      (currentLease.taskId !== input.taskId ||
        currentLease.attemptId !== input.attemptId ||
        currentLease.leaseId !== input.leaseId ||
        currentLease.leaseVersion + 1 !== input.leaseVersion)
    ) {
      throw new Error("desktop browser Relay revocation does not match the current Host Lease");
    }
    const taskHash = createHash("sha256").update(input.taskId).digest("hex");
    await this.closeConnection(candidates[0]!, 1008, `desktop browser Task Lease revoked:${taskHash}`);
  }

  async consumeCoreNonce(nonce: string, expiresAt: number, now: number): Promise<boolean> {
    if (!this.operationStore) throw new Error("desktop browser durable nonce storage is unavailable");
    return this.operationStore.consumeCoreNonce(nonce, expiresAt, now);
  }

  async projectedAttemptStatus(attemptId: string) {
    if (!this.operationStore) throw new Error("desktop browser durable operation storage is unavailable");
    return this.operationStore.attemptStatus(attemptId);
  }

  async drain(): Promise<void> {
    this.draining = true;
    await Promise.all(
      [...this.connections.values()].map(async (connection) =>
        this.closeConnection(connection, 1012, "service restart"),
      ),
    );
  }

  private snapshot(connection: RelayConnectionState): DesktopBrowserRelaySnapshot {
    const binding = connection.binding!;
    const hello = connection.hello!;
    return {
      connectionId: connection.connectionId,
      publicDeviceFingerprint: computeDesktopBrowserPublicDeviceFingerprint(
        projectDesktopBrowserPublicIdentity({
          registrationProtocolVersion: connection.negotiatedProtocolVersion!,
          deploymentCanonicalId: this.options.deploymentCanonicalId,
          registrationId: connection.connectionId,
          actorId: "projection",
          originatingProjectId: "projection",
          membershipEpoch: 0,
          devicePublicKey: binding.devicePublicKey,
          brokerInstanceId: binding.brokerInstanceId,
          browserInstanceId: binding.browserInstanceId,
          connectionEpoch: binding.connectionEpoch,
          expiresAt: iso(connection.lastSeenAt),
        }),
      ),
      brokerInstanceId: binding.brokerInstanceId,
      browserInstanceId: binding.browserInstanceId,
      connectionEpoch: binding.connectionEpoch,
      registrationState: binding.registrationState,
      protocolVersion: connection.negotiatedProtocolVersion!,
      policyGrammarVersion: connection.negotiatedPolicyGrammarVersion!,
      brokerVersion: hello.payload.brokerVersion,
      bskVersion: hello.payload.bskVersion,
      extensionVersion: hello.payload.extensionVersion,
      cliShapeHash: hello.payload.cliShapeHash,
      lastSeenAt: iso(connection.lastSeenAt),
      stage: connection.stage,
      devicePublicKey: binding.devicePublicKey,
      supportedProtocolVersions: [...hello.payload.supportedProtocolVersions],
      supportedPolicyGrammarVersions: [...hello.payload.supportedPolicyGrammarVersions],
    };
  }

  private async resolveCurrentRegisteredConnection(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
  }): Promise<RelayConnectionState> {
    const key = identityKey(input);
    const current = this.currentByIdentity.get(key);
    if (!current) throw new Error("desktop browser host is not connected");
    const connection = this.connections.get(current);
    if (!connection || !connection.binding) throw new Error("desktop browser host is not connected");
    if (connection.binding.browserInstanceId !== input.browserInstanceId) {
      throw new Error("desktop browser host is not connected");
    }
    if (connection.stage === "pending") {
      throw new Error("desktop browser host is pending registration and cannot receive task invocations");
    }
    if (connection.stage !== "registered") {
      throw new Error("desktop browser host is not connected");
    }
    const latest = await this.options.registry.resolveBinding({
      devicePublicKey: input.devicePublicKey,
      brokerInstanceId: input.brokerInstanceId,
    });
    if (!latest) {
      await this.closeConnection(connection, 1008, "desktop browser binding expired before relay delivery");
      throw new Error("desktop browser host is not connected");
    }
    if (latest.registrationState !== "registered") {
      connection.binding = latest;
      connection.stage = latest.registrationState;
      await this.publishProjection(connection);
      throw new Error("desktop browser host is pending registration and cannot receive task invocations");
    }
    const bindingChanged =
      latest.devicePublicKey !== connection.binding.devicePublicKey ||
      latest.brokerInstanceId !== connection.binding.brokerInstanceId ||
      latest.browserInstanceId !== connection.binding.browserInstanceId ||
      latest.connectionEpoch !== connection.binding.connectionEpoch;
    if (bindingChanged) {
      await this.closeConnection(connection, 1008, "connection replaced by a newer relay registration");
      throw new Error("desktop browser host is not connected");
    }
    connection.binding = latest;
    return connection;
  }

  private relayDeliveryUnknown(detail: string): DesktopBrowserHostFailure {
    return {
      code: "relay_delivery_unknown",
      message: detail,
    };
  }

  private assertOperationRequestHash(operationId: string, requestHash: string): void {
    const existing = this.operationRequestHashById.get(operationId);
    if (!existing) return;
    if (existing.requestHash !== requestHash) {
      throw new Error(
        `operationId ${JSON.stringify(operationId)} already dispatched with different requestHash ${JSON.stringify(requestHash)}`,
      );
    }
  }

  private assertDispatchIdAvailable(dispatchId: string): void {
    const current = this.dispatchHistoryById.get(dispatchId) ?? this.dispatchTombstonesById.get(dispatchId);
    if (!current) return;
    throw new Error(
      `dispatchId ${JSON.stringify(dispatchId)} already used for operationId ${JSON.stringify(current.operationId)}`,
    );
  }

  private startDispatchTracking(dispatchId: string, operationId: string, requestHash: string): void {
    const existing = this.operationRequestHashById.get(operationId);
    if (existing) {
      existing.refCount += 1;
    } else {
      this.operationRequestHashById.set(operationId, { requestHash, refCount: 1 });
    }
    this.dispatchHistoryById.set(dispatchId, {
      operationId,
      requestHash,
      state: "in_flight",
      settledAt: null,
    });
  }

  private settleDispatch(dispatchId: string, state: "accepted" | "terminal" | "unknown"): void {
    const history = this.dispatchHistoryById.get(dispatchId);
    if (!history) return;
    history.state = state;
    if (history.settledAt !== null) return;
    history.settledAt = this.options.clock.now();
    this.settledDispatchOrder.push(dispatchId);
    this.pruneDispatchTracking(history.settledAt);
  }

  private dropDispatchTracking(dispatchId: string): void {
    const history = this.dispatchHistoryById.get(dispatchId);
    if (!history) return;
    this.dispatchHistoryById.delete(dispatchId);
    this.releaseOperationRequestHash(history.operationId);
  }

  private releaseOperationRequestHash(operationId: string): void {
    const existing = this.operationRequestHashById.get(operationId);
    if (!existing) return;
    if (existing.refCount <= 1) {
      this.operationRequestHashById.delete(operationId);
      return;
    }
    existing.refCount -= 1;
  }

  private settledDispatch(dispatchId: string): RelayDispatchHistoryEntry | RelayDispatchTombstone | null {
    const history = this.dispatchHistoryById.get(dispatchId);
    if (history && history.settledAt !== null) return history;
    return this.dispatchTombstonesById.get(dispatchId) ?? null;
  }

  private pruneDispatchTracking(now: number): void {
    this.pruneSettledDispatchHistory(now);
    this.pruneDispatchTombstones(now);
  }

  private pruneSettledDispatchHistory(now: number): void {
    while (this.settledDispatchOrder.length > 0) {
      const dispatchId = this.settledDispatchOrder[0]!;
      const history = this.dispatchHistoryById.get(dispatchId);
      if (!history || history.settledAt === null) {
        this.settledDispatchOrder.shift();
        continue;
      }
      const expired = history.settledAt + this.options.settledDispatchHistoryTtlMs <= now;
      const overLimit = this.settledDispatchOrder.length > this.options.maxSettledDispatchHistory;
      if (!expired && !overLimit) return;
      this.settledDispatchOrder.shift();
      this.dispatchHistoryById.delete(dispatchId);
      this.dispatchTombstonesById.set(dispatchId, {
        operationId: history.operationId,
        requestHash: history.requestHash,
        state: history.state === "terminal" || history.state === "accepted" ? history.state : "unknown",
        expiresAt: now + this.options.settledDispatchHistoryTtlMs,
      });
      this.dispatchTombstoneOrder.push(dispatchId);
    }
  }

  private pruneDispatchTombstones(now: number): void {
    while (this.dispatchTombstoneOrder.length > 0) {
      const dispatchId = this.dispatchTombstoneOrder[0]!;
      const tombstone = this.dispatchTombstonesById.get(dispatchId);
      if (!tombstone) {
        this.dispatchTombstoneOrder.shift();
        continue;
      }
      const expired = tombstone.expiresAt <= now;
      const overLimit = this.dispatchTombstonesById.size > this.options.maxSettledDispatchHistory;
      if (!expired && !overLimit) return;
      this.dispatchTombstoneOrder.shift();
      this.dispatchTombstonesById.delete(dispatchId);
      this.releaseOperationRequestHash(tombstone.operationId);
    }
  }

  private isKnownStaleSequentialResult(
    pending: NonNullable<RelayConnectionState["pendingDispatch"]>,
    message: HostResultMessage,
  ): boolean {
    const history = this.settledDispatch(message.payload.dispatchId);
    if (!history) return false;
    if (history.state !== "accepted" && history.state !== "terminal") return false;
    return (
      history.operationId === message.payload.operationId &&
      history.operationId === pending.operationId &&
      history.requestHash === pending.requestHash
    );
  }

  private async handleMessage(connection: RelayConnectionState, raw: string): Promise<void> {
    if (!this.connections.has(connection.connectionId) || connection.stage === "closing") return;
    if (byteLength(raw) > this.options.maxMessageBytes) {
      throw new Error("desktop browser relay message exceeded the maximum allowed size");
    }
    connection.lastSeenAt = this.options.clock.now();
    this.pruneDispatchTracking(connection.lastSeenAt);
    if (connection.stage === "awaiting_hello") {
      const message = decodeDesktopBrowserMessage(raw, this.options.supportedProtocolVersions[0]);
      if (message.kind !== "host.hello")
        throw new Error(`unexpected desktop browser message kind ${JSON.stringify(message.kind)}`);
      await this.handleHello(connection, message);
      return;
    }
    if (connection.stage === "awaiting_challenge_response") {
      const message = decodeDesktopBrowserMessage(
        raw,
        connection.negotiatedProtocolVersion ?? this.options.supportedProtocolVersions[0],
      );
      if (message.kind !== "host.challenge-response") {
        if (message.kind === "relay.invoke") {
          throw new Error("unexpected relay.invoke frame from host");
        }
        throw new Error(`unexpected desktop browser message kind ${JSON.stringify(message.kind)}`);
      }
      await this.handleChallengeResponse(connection, message);
      return;
    }
    const message = decodeDesktopBrowserMessage(
      raw,
      connection.negotiatedProtocolVersion ?? this.options.supportedProtocolVersions[0],
    );
    if (message.kind === "relay.invoke") throw new Error("unexpected relay.invoke frame from host");
    if (message.kind === "relay.local-stop-ack") {
      throw new Error("unexpected relay.local-stop-ack frame from host");
    }
    if (message.kind === "relay.device-reconcile-ack") {
      throw new Error("unexpected relay.device-reconcile-ack frame from host");
    }
    if (message.kind === "relay.artifact-grant") {
      throw new Error("unexpected relay.artifact-grant frame from host");
    }
    if (message.kind === "relay.artifact-grant-failed") {
      throw new Error("unexpected relay.artifact-grant-failed frame from host");
    }
    if (message.kind === "host.device-reconciled") {
      if (!this.options.registry.reconcileDevice) {
        throw new Error("desktop browser Device reconciliation is unavailable");
      }
      await this.options.registry.reconcileDevice({
        reconciliationId: message.payload.reconciliationId,
        devicePublicKey: connection.binding!.devicePublicKey,
        browserInstanceId: connection.binding!.browserInstanceId,
        confirmedAt: message.payload.confirmedAt,
      });
      connection.socket.send(
        encodeDesktopBrowserMessage({
          protocolVersion: message.protocolVersion,
          kind: "relay.device-reconcile-ack",
          payload: { reconciliationId: message.payload.reconciliationId },
        }),
      );
      return;
    }
    if (message.kind === "host.local-stop-receipt") {
      if (!this.operationStore) throw new Error("desktop browser durable Local Stop storage is unavailable");
      const projection = this.snapshot(connection);
      await this.operationStore.recordLocalStopReceipt(message, {
        publicDeviceFingerprint: projection.publicDeviceFingerprint,
        browserInstanceId: projection.browserInstanceId,
      });
      connection.socket.send(
        encodeDesktopBrowserMessage({
          protocolVersion: message.protocolVersion,
          kind: "relay.local-stop-ack",
          payload: { receiptId: message.payload.receiptId },
        }),
      );
      return;
    }
    if (message.kind === "host.artifact-intent") {
      if (!this.artifactGrantClient) throw new Error("desktop browser artifact grants are unavailable");
      const pending = connection.pendingDispatch;
      if (!pending?.accepted) throw new Error("artifact intent requires an accepted in-flight invocation");
      const authority = pending.authority;
      const intent = message.payload;
      if (
        intent.taskId !== authority.taskId ||
        intent.attemptId !== authority.attemptId ||
        intent.operationId !== authority.operationId ||
        intent.requestHash !== pending.requestHash ||
        intent.deviceId !== authority.deviceId ||
        intent.actorId !== authority.actorId ||
        intent.projectId !== authority.projectId ||
        intent.leaseId !== authority.leaseId ||
        intent.leaseVersion !== authority.leaseVersion ||
        intent.leaseExpiresAt !== authority.leaseExpiresAt
      ) {
        throw new Error("artifact intent does not match the accepted invocation authority");
      }
      const connectionEpoch = connection.binding!.connectionEpoch;
      let grant: RelayArtifactGrantMessage["payload"];
      try {
        grant = await this.artifactGrantClient.requestGrant(intent);
      } catch {
        if (
          this.connections.get(connection.connectionId) === connection &&
          connection.stage === "registered" &&
          connection.binding?.connectionEpoch === connectionEpoch &&
          connection.pendingDispatch === pending
        ) {
          connection.socket.send(
            encodeDesktopBrowserMessage({
              protocolVersion: message.protocolVersion,
              kind: "relay.artifact-grant-failed",
              payload: {
                artifactIntentId: intent.artifactIntentId,
                operationId: intent.operationId,
                error: { code: "grant_refused", message: "Artifact grant unavailable" },
              },
            }),
          );
        }
        return;
      }
      if (
        this.connections.get(connection.connectionId) !== connection ||
        connection.stage !== "registered" ||
        connection.binding?.connectionEpoch !== connectionEpoch ||
        connection.pendingDispatch !== pending
      ) {
        return;
      }
      if (grant.artifactIntentId !== intent.artifactIntentId || grant.operationId !== intent.operationId) {
        throw new Error("Core artifact grant does not match the Host intent");
      }
      connection.socket.send(
        encodeDesktopBrowserMessage({
          protocolVersion: message.protocolVersion,
          kind: "relay.artifact-grant",
          payload: grant,
        }),
      );
      return;
    }
    if (message.kind === "host.accepted") {
      const pending = connection.pendingDispatch;
      if (!pending) throw new Error("unexpected host.accepted without an in-flight invocation");
      if (pending.accepted) throw new Error("duplicate host.accepted for the in-flight invocation");
      if (message.payload.dispatchId !== pending.dispatchId) {
        throw new Error("host.accepted dispatch does not match the in-flight invocation");
      }
      if (message.payload.operationId !== pending.operationId) {
        throw new Error("host.accepted operation does not match the in-flight invocation");
      }
      if (message.payload.requestHash !== pending.requestHash) {
        throw new Error("host.accepted requestHash does not match the in-flight invocation");
      }
      const history = this.dispatchHistoryById.get(pending.dispatchId);
      if (history) history.state = "accepted";
      if (this.operationStore) await this.operationStore.recordAccepted(message);
      pending.accepted = message;
      return;
    }
    if (message.kind === "host.result") {
      const pending = connection.pendingDispatch;
      if (!pending) throw new Error("unexpected host.result without an in-flight invocation");
      if (message.payload.dispatchId !== pending.dispatchId) {
        if (this.operationStore) {
          try {
            await this.operationStore.recordTerminal(message);
            return;
          } catch {
            throw new Error("host.result dispatch does not match a durable Relay operation");
          }
        }
        if (this.isKnownStaleSequentialResult(pending, message)) {
          return;
        }
        if (!pending.accepted) {
          throw new Error("host.result arrived before host.accepted");
        }
        throw new Error("host.result dispatch does not match the accepted invocation");
      }
      if (!pending.accepted) {
        if (!this.operationStore) {
          throw new Error("host.result arrived before host.accepted");
        }
        if (message.payload.operationId !== pending.operationId) {
          throw new Error("host.result operation does not match the in-flight invocation");
        }
        pending.accepted = {
          protocolVersion: message.protocolVersion,
          kind: "host.accepted",
          payload: {
            dispatchId: pending.dispatchId,
            operationId: pending.operationId,
            requestHash: pending.requestHash,
          },
        };
        await this.operationStore.recordAccepted(pending.accepted);
        const history = this.dispatchHistoryById.get(pending.dispatchId);
        if (history) history.state = "accepted";
      }
      if (message.payload.operationId !== pending.accepted.payload.operationId) {
        throw new Error("host.result operation does not match the accepted invocation");
      }
      if (this.operationStore) await this.operationStore.recordTerminal(message);
      connection.pendingDispatch = null;
      this.options.clock.clearTimeout(pending.timeout);
      this.settleDispatch(pending.dispatchId, "terminal");
      pending.resolve({
        kind: "host.result",
        accepted: pending.accepted,
        result: message,
      });
      return;
    }
    throw new Error(
      `desktop browser relay operations are not implemented in Ticket04: ${JSON.stringify(message.kind)}`,
    );
  }

  private async handleHello(connection: RelayConnectionState, message: HostHelloMessage): Promise<void> {
    const binding = await this.options.registry.resolveBinding({
      devicePublicKey: message.payload.devicePublicKey,
      brokerInstanceId: message.payload.brokerInstanceId,
    });
    if (!binding) {
      throw new Error("no pending or registered desktop browser binding exists for this host hello");
    }
    if (binding.devicePublicKey !== message.payload.devicePublicKey) {
      throw new Error("resolved desktop browser binding does not match the presented device key");
    }
    if (binding.brokerInstanceId !== message.payload.brokerInstanceId) {
      throw new Error("resolved desktop browser binding does not match the presented broker instance");
    }
    connection.hello = message;
    connection.binding = binding;
    connection.negotiatedProtocolVersion = negotiateProtocolVersion(
      message.payload.supportedProtocolVersions,
      this.options.supportedProtocolVersions,
    );
    connection.negotiatedPolicyGrammarVersion = negotiatePolicyGrammarVersion(
      message.payload.supportedPolicyGrammarVersions,
      this.options.supportedPolicyGrammarVersions,
    );
    const challenge: RelayChallengeMessage = {
      protocolVersion: connection.negotiatedProtocolVersion,
      kind: "relay.challenge",
      payload: {
        relayInstanceId: this.options.relayInstanceId,
        challengeNonce: this.options.createNonce(),
        deploymentCanonicalId: this.options.deploymentCanonicalId,
        brokerInstanceId: binding.brokerInstanceId,
        browserInstanceId: binding.browserInstanceId,
        connectionEpoch: binding.connectionEpoch,
      },
    };
    connection.challenge = challenge;
    connection.stage = "awaiting_challenge_response";
    this.clearStageTimer(connection);
    connection.stageTimer = this.options.clock.setTimeout(() => {
      void this.failConnection(connection, "relay challenge response timed out");
    }, this.options.challengeTimeoutMs);
    connection.socket.send(encodeDesktopBrowserMessage(challenge));
  }

  private async handleChallengeResponse(
    connection: RelayConnectionState,
    message: Extract<ReturnType<typeof decodeDesktopBrowserMessage>, { kind: "host.challenge-response" }>,
  ): Promise<void> {
    if (!connection.hello || !connection.binding || !connection.challenge || !connection.negotiatedProtocolVersion) {
      throw new Error("desktop browser relay challenge state is incomplete");
    }
    if (connection.stageTimer === null) {
      throw new Error("relay challenge nonce is no longer current");
    }
    if (message.protocolVersion !== connection.negotiatedProtocolVersion) {
      throw new Error("host challenge-response protocol version does not match the negotiated version");
    }
    if (!verifyHostChallengeResponseMessage(message)) {
      throw new Error("host challenge-response signature verification failed");
    }
    const expected = connection.challenge.payload;
    const payload = message.payload;
    if (payload.relayInstanceId !== expected.relayInstanceId) {
      throw new Error("host challenge-response relay instance does not match the issued challenge");
    }
    if (payload.deploymentCanonicalId !== expected.deploymentCanonicalId) {
      throw new Error("host challenge-response deployment does not match the issued challenge");
    }
    if (payload.devicePublicKey !== connection.binding.devicePublicKey) {
      throw new Error("host challenge-response device key does not match the issued binding");
    }
    if (payload.brokerInstanceId !== expected.brokerInstanceId) {
      throw new Error("host challenge-response broker does not match the issued challenge");
    }
    if (payload.browserInstanceId !== expected.browserInstanceId) {
      throw new Error("host challenge-response browser does not match the issued challenge");
    }
    if (payload.connectionEpoch !== expected.connectionEpoch) {
      throw new Error("host challenge-response connection epoch does not match the issued challenge");
    }
    if (payload.challengeNonce !== expected.challengeNonce) {
      throw new Error("host challenge-response nonce is stale or does not match the issued challenge");
    }
    const latest = await this.options.registry.resolveBinding({
      devicePublicKey: connection.binding.devicePublicKey,
      brokerInstanceId: connection.binding.brokerInstanceId,
    });
    if (!latest) {
      throw new Error("desktop browser binding expired before the host answered the challenge");
    }
    if (
      latest.browserInstanceId !== connection.binding.browserInstanceId ||
      latest.connectionEpoch !== connection.binding.connectionEpoch
    ) {
      if (latest.connectionEpoch > connection.binding.connectionEpoch) {
        throw new Error("host challenge-response arrived for a stale connection epoch");
      }
      throw new Error("desktop browser binding changed before the host answered the challenge");
    }
    const key = identityKey(connection.binding);
    const current = this.currentByIdentity.get(key);
    if (current) {
      const existing = this.connections.get(current);
      if (existing && existing !== connection && existing.binding) {
        if (existing.binding.connectionEpoch > connection.binding.connectionEpoch) {
          throw new Error("host challenge-response arrived for a stale connection epoch");
        }
        await this.closeConnection(existing, 1008, "connection replaced by a newer relay registration");
      }
    }
    connection.binding = latest;
    connection.stage = latest.registrationState;
    this.currentByIdentity.set(key, connection.connectionId);
    this.clearStageTimer(connection);
    this.startHeartbeat(connection);
    await this.publishProjection(connection);
  }

  private startHeartbeat(connection: RelayConnectionState): void {
    this.clearHeartbeat(connection);
    connection.heartbeatTimer = this.options.clock.setInterval(() => {
      connection.socket.ping();
      this.clearHeartbeatDeadline(connection);
      connection.heartbeatDeadlineTimer = this.options.clock.setTimeout(() => {
        void this.failConnection(connection, "desktop browser relay heartbeat timed out");
      }, this.options.heartbeatGraceMs);
    }, this.options.heartbeatIntervalMs);
  }

  private async recordHeartbeat(connection: RelayConnectionState): Promise<void> {
    if (connection.stage !== "pending" && connection.stage !== "registered") return;
    connection.lastSeenAt = this.options.clock.now();
    this.clearHeartbeatDeadline(connection);
    await this.publishProjection(connection);
  }

  private async publishProjection(connection: RelayConnectionState): Promise<void> {
    if (
      !connection.binding ||
      !connection.hello ||
      !connection.negotiatedProtocolVersion ||
      !connection.negotiatedPolicyGrammarVersion
    ) {
      return;
    }
    const projection = this.snapshot(connection);
    await this.options.registry.publishConnection({
      connectionId: projection.connectionId,
      publicDeviceFingerprint: projection.publicDeviceFingerprint,
      brokerInstanceId: projection.brokerInstanceId,
      browserInstanceId: projection.browserInstanceId,
      connectionEpoch: projection.connectionEpoch,
      registrationState: projection.registrationState,
      protocolVersion: projection.protocolVersion,
      policyGrammarVersion: projection.policyGrammarVersion,
      brokerVersion: projection.brokerVersion,
      bskVersion: projection.bskVersion,
      extensionVersion: projection.extensionVersion,
      cliShapeHash: projection.cliShapeHash,
      lastSeenAt: projection.lastSeenAt,
    });
    connection.projectionPublished = true;
  }

  private async failConnection(connection: RelayConnectionState, reason: string): Promise<void> {
    if (connection.stage === "closing") return;
    await this.closeConnection(connection, 1008, reason);
  }

  private async closeConnection(connection: RelayConnectionState, code: number, reason: string): Promise<void> {
    if (connection.stage === "closing") return;
    connection.stage = "closing";
    connection.closeReason = reason;
    connection.socket.close(code, reason);
    await this.handleClose(connection, code);
  }

  private async handleClose(connection: RelayConnectionState, _code?: number): Promise<void> {
    if (!this.connections.has(connection.connectionId)) return;
    this.connections.delete(connection.connectionId);
    this.clearStageTimer(connection);
    this.clearHeartbeat(connection);
    if (connection.pendingDispatch) {
      const pending = connection.pendingDispatch;
      connection.pendingDispatch = null;
      this.options.clock.clearTimeout(pending.timeout);
      this.settleDispatch(pending.dispatchId, pending.accepted ? "accepted" : "unknown");
      const error = this.relayDeliveryUnknown(
        connection.closeReason ??
          (pending.accepted
            ? "desktop browser host connection closed after host.accepted before host.result"
            : "desktop browser host connection closed before host.accepted"),
      );
      let acceptedUnknownResult: HostResultMessage | undefined;
      if (pending.accepted && this.operationStore) {
        try {
          acceptedUnknownResult = await this.operationStore.recordAcceptedUnknown(pending.accepted);
        } catch {
          console.error(`[qm-broker-relay] failed to persist accepted-unknown operationId=${pending.operationId}`);
        }
      }
      pending.resolve(
        pending.accepted
          ? {
              kind: "accepted_unknown",
              accepted: pending.accepted,
              ...(acceptedUnknownResult ? { result: acceptedUnknownResult } : {}),
              error,
            }
          : {
              kind: "not_accepted_or_unknown",
              dispatchId: pending.dispatchId,
              operationId: pending.operationId,
              requestHash: pending.requestHash,
              error,
            },
      );
    }
    if (connection.binding) {
      const key = identityKey(connection.binding);
      if (this.currentByIdentity.get(key) === connection.connectionId) {
        this.currentByIdentity.delete(key);
      }
    }
    if (connection.projectionPublished) {
      await this.options.registry.clearConnection(connection.connectionId);
      connection.projectionPublished = false;
    }
  }

  private clearStageTimer(connection: RelayConnectionState): void {
    if (connection.stageTimer !== null) {
      this.options.clock.clearTimeout(connection.stageTimer);
      connection.stageTimer = null;
    }
  }

  private clearHeartbeat(connection: RelayConnectionState): void {
    if (connection.heartbeatTimer !== null) {
      this.options.clock.clearInterval(connection.heartbeatTimer);
      connection.heartbeatTimer = null;
    }
    this.clearHeartbeatDeadline(connection);
  }

  private clearHeartbeatDeadline(connection: RelayConnectionState): void {
    if (connection.heartbeatDeadlineTimer !== null) {
      this.options.clock.clearTimeout(connection.heartbeatDeadlineTimer);
      connection.heartbeatDeadlineTimer = null;
    }
  }
}

function adaptWsSocket(socket: WebSocket): DesktopBrowserRelaySocket {
  return {
    addEventListener(type, listener) {
      if (type === "message") {
        socket.on("message", (data) => listener({ data: typeof data === "string" ? data : data.toString("utf8") }));
        return;
      }
      if (type === "close") {
        socket.on("close", (code, reason) => listener({ code, reason: reason.toString("utf8") }));
        return;
      }
      if (type === "error") {
        socket.on("error", (error) => listener(error));
        return;
      }
      socket.on("pong", (data) => listener({ data }));
    },
    send(data) {
      socket.send(data);
    },
    close(code, reason) {
      socket.close(code, reason);
    },
    ping(data) {
      socket.ping(data ? Buffer.from(data) : undefined);
    },
  };
}

export function attachDesktopBrowserRelayWebSocketServer(
  server: WebSocketServer,
  service: DesktopBrowserRelayService,
): () => void {
  const listener = (socket: WebSocket) => {
    service.acceptSocket(adaptWsSocket(socket));
  };
  server.on("connection", listener);
  return () => {
    server.off("connection", listener);
  };
}

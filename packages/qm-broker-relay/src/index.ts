import { randomUUID } from "node:crypto";
import {
  computeDesktopBrowserPublicDeviceFingerprint,
  decodeDesktopBrowserMessage,
  encodeDesktopBrowserMessage,
  projectDesktopBrowserPublicIdentity,
  verifyHostChallengeResponseMessage,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserRelayRegistryBinding,
  type HostHelloMessage,
  type RelayChallengeMessage,
} from "qm-desktop-browser-contracts";
import type { WebSocket, WebSocketServer } from "ws";

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
}

export interface DesktopBrowserRelayClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): RelayTimerHandle;
  clearTimeout(handle: RelayTimerHandle): void;
  setInterval(callback: () => void, ms: number): RelayTimerHandle;
  clearInterval(handle: RelayTimerHandle): void;
}

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
  createNonce?: () => string;
  createConnectionId?: () => string;
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
  lastSeenAt: number;
  closeReason: string | null;
}

const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;
const DEFAULT_HELLO_TIMEOUT_MS = 5_000;
const DEFAULT_CHALLENGE_TIMEOUT_MS = 5_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_HEARTBEAT_GRACE_MS = 5_000;

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

function identityKey(
  binding: Pick<DesktopBrowserRelayBinding, "devicePublicKey" | "brokerInstanceId" | "browserInstanceId">,
): string {
  return `${binding.devicePublicKey}\u0000${binding.brokerInstanceId}\u0000${binding.browserInstanceId}`;
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
    >
  > & {
    clock: DesktopBrowserRelayClock;
    createNonce: () => string;
    createConnectionId: () => string;
  };
  private readonly connections = new Map<string, RelayConnectionState>();
  private readonly currentByIdentity = new Map<string, string>();
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
      clock: options.clock ?? systemClock,
      createNonce: options.createNonce ?? (() => randomUUID()),
      createConnectionId: options.createConnectionId ?? (() => randomUUID()),
    };
    if (this.options.supportedProtocolVersions.length === 0) {
      throw new Error("at least one supported protocol version is required");
    }
    if (this.options.supportedPolicyGrammarVersions.length === 0) {
      throw new Error("at least one supported policy grammar version is required");
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
      if (
        latest.browserInstanceId === connection.binding.browserInstanceId &&
        latest.connectionEpoch === connection.binding.connectionEpoch &&
        latest.registrationState !== connection.binding.registrationState
      ) {
        connection.binding = latest;
        connection.stage = latest.registrationState;
        await this.publishProjection(connection);
        continue;
      }
      if (
        latest.browserInstanceId === connection.binding.browserInstanceId &&
        latest.connectionEpoch > connection.binding.connectionEpoch
      ) {
        await this.failConnection(connection, "connection epoch has been replaced by a newer registration");
      }
    }
  }

  async dispatchInvocation(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
  }): Promise<never> {
    const key = identityKey(input);
    const current = this.currentByIdentity.get(key);
    if (!current) throw new Error("desktop browser host is not connected");
    const connection = this.connections.get(current);
    if (!connection || !connection.binding) throw new Error("desktop browser host is not connected");
    if (connection.stage === "pending") {
      throw new Error("desktop browser host is pending registration and cannot receive task invocations");
    }
    throw new Error("relay invocation delivery is not implemented in Ticket04");
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

  private async handleMessage(connection: RelayConnectionState, raw: string): Promise<void> {
    if (byteLength(raw) > this.options.maxMessageBytes) {
      throw new Error("desktop browser relay message exceeded the maximum allowed size");
    }
    connection.lastSeenAt = this.options.clock.now();
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

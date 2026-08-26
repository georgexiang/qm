import {
  chmodSync,
  closeSync,
  constants as fsConstants,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { dirname, join } from "node:path";
import {
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  decodeDesktopBrowserMessage,
  encodeDesktopBrowserMessage,
  encodeHostChallengeResponseSigningBytes,
  encodeDesktopBrowserRegistrationConfirmationSigningBytes,
  encodeDesktopBrowserRegistrationConfirmationVerificationBytes,
  parseDesktopBrowserRegistrationConfirmationEnvelope,
  parseDesktopBrowserRegistrationReservationTuple,
  projectDesktopBrowserPublicIdentity,
  type DesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRegistrationReservationTuple,
  type HostChallengeResponseMessage,
  type RelayChallengeMessage,
} from "../../desktop-browser-contracts/src/index.ts";

const MAX_RELAY_MESSAGE_BYTES = 64 * 1024;
const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
const SAFE_DIR_MODE = 0o700;
const SAFE_FILE_MODE = 0o600;

export const HOST_BROKER_CONTROL_NOTICE =
  "QM controls the browser on this device. The browser profile is shared across this deployment.";

export interface DeviceIdentity {
  devicePublicKey: string;
  sign(bytes: Uint8Array<ArrayBuffer>): string;
  verify(bytes: Uint8Array<ArrayBuffer>, signature: string): boolean;
}

export interface BrowserRuntimeMetadata {
  browserInstanceId: string;
  browserSkillStatus: "ready" | "offline";
  bskVersion: string;
  extensionVersion: string;
  cliShapeHash: string;
}

export interface HostBrokerStateSnapshot {
  qmUrl: string | null;
  relayUrl: string | null;
  deploymentCanonicalId: string | null;
  brokerStatus: "ready" | "paused" | "disconnected";
  browserSkillStatus: "ready" | "offline";
  currentTaskPresent: boolean;
  brokerInstanceId: string;
  browserInstanceId: string | null;
  connectionEpoch: number | null;
  devicePublicKey: string;
  publicDeviceFingerprint: string | null;
  confirmationFingerprint: string | null;
  notice: string;
}

export interface RegistrationConfirmationPreview {
  confirmationFingerprint: string;
  publicDeviceFingerprint: string;
  publicIdentity: {
    publicIdentityVersion: `${number}.${number}`;
    deploymentCanonicalId: string;
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
  };
}

export interface HostBrokerSocket {
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event?: unknown) => void): void;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export interface HostBrokerTransport {
  connect(url: string): HostBrokerSocket;
}

export interface HostBrokerConnectionOptions {
  qmUrl: string;
  relayUrl: string;
  deploymentCanonicalId?: string | null;
  brokerInstanceId: string;
  brokerVersion: string;
  supportedProtocolVersions: string[];
  supportedPolicyGrammarVersions: string[];
  identity: DeviceIdentity;
  runtime: BrowserRuntimeMetadata;
  connectionEpoch?: number | null;
  publicDeviceFingerprint?: string | null;
  confirmationFingerprint?: string | null;
  transport: HostBrokerTransport;
  maxMessageBytes?: number;
  handshakeTimeoutMs?: number;
  onStateChange?: (state: HostBrokerStateSnapshot) => void;
}

export interface HostBrokerCliDeps {
  dataDir: string;
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
  transport?: HostBrokerTransport;
  brokerInstanceId?: string;
  brokerVersion?: string;
  resolveRelayUrl?: (qmUrl: string) => string;
  runtime?: BrowserRuntimeMetadata;
}

interface DeviceIdentityFile {
  privateKeyPem: string;
  devicePublicKey: string;
}

type BrokerStateFile = HostBrokerStateSnapshot;

interface RegistrationTupleBinding {
  deploymentCanonicalId?: string | null;
  brokerInstanceId?: string | null;
  browserInstanceId?: string | null;
  connectionEpoch?: number | null;
  now?: number;
}

const DEVICE_KEY_FILE = "device-key.json";
const STATE_FILE = "state.json";
const DEFAULT_RUNTIME: BrowserRuntimeMetadata = {
  browserInstanceId: "unbound",
  browserSkillStatus: "offline",
  bskVersion: "unavailable",
  extensionVersion: "unavailable",
  cliShapeHash: "unavailable",
};

function encodeDevicePublicKey(publicKey: ReturnType<typeof createPublicKey>): string {
  return `ed25519:${publicKey.export({ format: "der", type: "spki" }).toString("base64url")}`;
}

function decodeDevicePublicKey(devicePublicKey: string) {
  const [algorithm, encoded] = devicePublicKey.split(":", 2);
  if (algorithm !== "ed25519" || !encoded) throw new Error("device public key must use ed25519:<base64url-spki> form");
  return createPublicKey({ key: Buffer.from(encoded, "base64url"), format: "der", type: "spki" });
}

function assertSafeDirectory(path: string): void {
  if (!existsSync(path)) {
    mkdirSync(path, { recursive: true, mode: SAFE_DIR_MODE });
  }
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`refusing symbolic link path ${JSON.stringify(path)}`);
  if (!stats.isDirectory()) throw new Error(`expected directory at ${JSON.stringify(path)}`);
  if ((stats.mode & 0o777) !== SAFE_DIR_MODE) {
    throw new Error(`directory ${JSON.stringify(path)} must use mode 0700`);
  }
}

function assertSafeFile(path: string, mode: number): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`refusing symbolic link path ${JSON.stringify(path)}`);
  if (!stats.isFile()) throw new Error(`expected regular file at ${JSON.stringify(path)}`);
  if ((stats.mode & 0o777) !== mode) {
    throw new Error(`file ${JSON.stringify(path)} must use mode ${mode.toString(8).padStart(4, "0")}`);
  }
}

function atomicWriteText(filePath: string, text: string, mode: number): void {
  assertSafeDirectory(dirname(filePath));
  if (existsSync(filePath)) assertSafeFile(filePath, mode);
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  const fd = openSync(
    tempPath,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    mode,
  );
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    chmodSync(tempPath, mode);
  } finally {
    closeSync(fd);
  }
  try {
    renameSync(tempPath, filePath);
    assertSafeFile(filePath, mode);
    const dirFd = openSync(dirname(filePath), "r");
    try {
      fsyncSync(dirFd);
    } finally {
      closeSync(dirFd);
    }
  } catch (error) {
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
}

function readJsonFile<T>(filePath: string): T | null {
  if (!existsSync(filePath)) return null;
  assertSafeFile(filePath, SAFE_FILE_MODE);
  const fd = openSync(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    return JSON.parse(readFileSync(fd, "utf8")) as T;
  } finally {
    closeSync(fd);
  }
}

function keyFilePath(dataDir: string): string {
  return join(dataDir, DEVICE_KEY_FILE);
}

function stateFilePath(dataDir: string): string {
  return join(dataDir, STATE_FILE);
}

function identityFromPrivateKeyPem(privateKeyPem: string): DeviceIdentity {
  const privateKey = createPrivateKey(privateKeyPem);
  const publicKey = createPublicKey(privateKey);
  return {
    devicePublicKey: encodeDevicePublicKey(publicKey),
    sign(bytes) {
      return sign(null, Buffer.from(bytes), privateKey).toString("base64url");
    },
    verify(bytes, signature) {
      return verify(null, Buffer.from(bytes), publicKey, Buffer.from(signature, "base64url"));
    },
  };
}

function loadState(dataDir: string): BrokerStateFile | null {
  return readJsonFile<BrokerStateFile>(stateFilePath(dataDir));
}

function saveState(dataDir: string, state: BrokerStateFile): void {
  atomicWriteText(stateFilePath(dataDir), `${JSON.stringify(state)}\n`, 0o600);
}

function withLatestConfirmationPreview(dataDir: string, state: HostBrokerStateSnapshot): HostBrokerStateSnapshot {
  const stored = loadState(dataDir);
  return {
    ...state,
    publicDeviceFingerprint: stored?.publicDeviceFingerprint ?? state.publicDeviceFingerprint,
    confirmationFingerprint: stored?.confirmationFingerprint ?? state.confirmationFingerprint,
  };
}

function createInitialState(input: {
  qmUrl: string | null;
  relayUrl: string | null;
  deploymentCanonicalId: string | null;
  brokerInstanceId: string;
  browserInstanceId: string | null;
  browserSkillStatus: "ready" | "offline";
  devicePublicKey: string;
  publicDeviceFingerprint: string | null;
  confirmationFingerprint: string | null;
  connectionEpoch: number | null;
}): BrokerStateFile {
  return {
    qmUrl: input.qmUrl,
    relayUrl: input.relayUrl,
    deploymentCanonicalId: input.deploymentCanonicalId,
    brokerStatus: "disconnected",
    browserSkillStatus: input.browserSkillStatus,
    currentTaskPresent: false,
    brokerInstanceId: input.brokerInstanceId,
    browserInstanceId: input.browserInstanceId,
    connectionEpoch: input.connectionEpoch,
    devicePublicKey: input.devicePublicKey,
    publicDeviceFingerprint: input.publicDeviceFingerprint,
    confirmationFingerprint: input.confirmationFingerprint,
    notice: HOST_BROKER_CONTROL_NOTICE,
  };
}

function createHostChallengeResponse(
  identity: DeviceIdentity,
  challenge: RelayChallengeMessage["payload"],
): HostChallengeResponseMessage {
  const signingPayload = {
    relayInstanceId: challenge.relayInstanceId,
    deploymentCanonicalId: challenge.deploymentCanonicalId,
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: challenge.brokerInstanceId,
    browserInstanceId: challenge.browserInstanceId,
    connectionEpoch: challenge.connectionEpoch,
    challengeNonce: challenge.challengeNonce,
  };
  const unsignedMessage = {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    payload: signingPayload,
  };
  return {
    protocolVersion: unsignedMessage.protocolVersion,
    kind: "host.challenge-response",
    payload: {
      ...signingPayload,
      signatureAlgorithm: "ed25519",
      signature: identity.sign(encodeHostChallengeResponseSigningBytes(unsignedMessage)),
    },
  };
}

function assertTrustedRelayChallenge(
  payload: RelayChallengeMessage["payload"],
  trusted: Pick<
    HostBrokerStateSnapshot,
    "deploymentCanonicalId" | "brokerInstanceId" | "browserInstanceId" | "connectionEpoch"
  >,
): void {
  if (payload.brokerInstanceId !== trusted.brokerInstanceId) {
    throw new Error("relay challenge broker does not match the local broker binding");
  }
  if (trusted.browserInstanceId && payload.browserInstanceId !== trusted.browserInstanceId) {
    throw new Error("relay challenge browser does not match the local browser binding");
  }
  if (trusted.deploymentCanonicalId && payload.deploymentCanonicalId !== trusted.deploymentCanonicalId) {
    throw new Error("relay challenge deployment does not match the locally bound deployment");
  }
  if (trusted.connectionEpoch && payload.connectionEpoch < trusted.connectionEpoch) {
    throw new Error("relay challenge connection epoch is older than the trusted local binding");
  }
}

function renderHumanState(state: HostBrokerStateSnapshot): string {
  return [
    `QM URL: ${state.qmUrl ?? "unconfigured"}`,
    `Relay URL: ${state.relayUrl ?? "unconfigured"}`,
    `Deployment: ${state.deploymentCanonicalId ?? "unbound"}`,
    `Broker status: ${state.brokerStatus}`,
    `BrowserSkill status: ${state.browserSkillStatus}`,
    `Broker instance: ${state.brokerInstanceId}`,
    `Browser instance: ${state.browserInstanceId ?? "unbound"}`,
    `Connection epoch: ${state.connectionEpoch ?? "unregistered"}`,
    `Confirmation fingerprint: ${state.confirmationFingerprint ?? "pending local confirmation"}`,
    `Public device fingerprint: ${state.publicDeviceFingerprint ?? "pending local confirmation"}`,
    state.notice,
  ].join("\n");
}

function writeOutput(
  stdout: { write(chunk: string): void },
  json: boolean,
  payload: HostBrokerStateSnapshot | Record<string, unknown>,
): void {
  stdout.write(`${json ? JSON.stringify(payload) : renderHumanState(payload as HostBrokerStateSnapshot)}\n`);
}

function resolveRelayUrlDefault(qmUrl: string): string {
  const target = new URL("/v1/device", qmUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

function assertConnectableRuntime(runtime: BrowserRuntimeMetadata): void {
  if (runtime.browserSkillStatus !== "ready") throw new Error("browser runtime must report ready before connecting");
  if (!runtime.browserInstanceId || runtime.browserInstanceId === "unbound") {
    throw new Error("browser runtime must provide a bound browserInstanceId before connecting");
  }
  if (!runtime.bskVersion || runtime.bskVersion === "unavailable") {
    throw new Error("browser runtime must provide a concrete browser skill version before connecting");
  }
  if (!runtime.extensionVersion || runtime.extensionVersion === "unavailable") {
    throw new Error("browser runtime must provide a concrete extension version before connecting");
  }
  if (!runtime.cliShapeHash || runtime.cliShapeHash === "unavailable") {
    throw new Error("browser runtime must provide a concrete cli shape hash before connecting");
  }
}

function assertSecureRelayUrl(relayUrl: string): void {
  const url = new URL(relayUrl);
  if (url.protocol === "wss:") return;
  if (
    url.protocol === "ws:" &&
    process.env.NODE_ENV === "test" &&
    ["127.0.0.1", "localhost", "::1"].includes(url.hostname)
  ) {
    return;
  }
  throw new Error("relay URL must use wss outside explicit test loopback transport");
}

function assertTupleBinding(
  tuple: DesktopBrowserRegistrationReservationTuple,
  binding: RegistrationTupleBinding | undefined,
): void {
  const now = binding?.now ?? Date.now();
  if (Date.parse(tuple.expiresAt) <= now) {
    throw new Error("registration reservation tuple has expired");
  }
  if (binding?.deploymentCanonicalId && tuple.deploymentCanonicalId !== binding.deploymentCanonicalId) {
    throw new Error("registration reservation tuple deployment does not match the locally bound deployment");
  }
  if (binding?.brokerInstanceId && tuple.brokerInstanceId !== binding.brokerInstanceId) {
    throw new Error("registration reservation tuple broker does not match the local broker binding");
  }
  if (binding?.browserInstanceId && tuple.browserInstanceId !== binding.browserInstanceId) {
    throw new Error("registration reservation tuple browser does not match the local browser binding");
  }
  if (binding?.connectionEpoch && tuple.connectionEpoch !== binding.connectionEpoch) {
    throw new Error("registration reservation tuple connection epoch does not match the local binding");
  }
}

function applyAuthoritativeChallengeBinding(
  state: HostBrokerStateSnapshot,
  payload: RelayChallengeMessage["payload"],
): void {
  if (payload.deploymentCanonicalId) state.deploymentCanonicalId = payload.deploymentCanonicalId;
  if (payload.brokerInstanceId) state.brokerInstanceId = payload.brokerInstanceId;
  if (payload.browserInstanceId) state.browserInstanceId = payload.browserInstanceId;
  if (payload.connectionEpoch) state.connectionEpoch = payload.connectionEpoch;
}

function defaultTransport(): HostBrokerTransport {
  return {
    connect(url: string) {
      return new WebSocket(url) as unknown as HostBrokerSocket;
    },
  };
}

function nextBrokerInstanceId(existing: string | null): string {
  return existing ?? `broker-${process.pid}-${Date.now().toString(36)}`;
}

function takeOption(args: string[], name: string): string | null {
  const index = args.indexOf(name);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  args.splice(index, 2);
  return value;
}

function takeFlag(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index < 0) return false;
  args.splice(index, 1);
  return true;
}

function ensureNoExtraArgs(args: string[]): void {
  if (args.length > 0) throw new Error(`unexpected arguments: ${args.join(" ")}`);
}

export async function loadOrCreateDeviceIdentity(dataDir: string): Promise<DeviceIdentity> {
  assertSafeDirectory(dataDir);
  const path = keyFilePath(dataDir);
  const stored = readJsonFile<DeviceIdentityFile>(path);
  if (stored) {
    const identity = identityFromPrivateKeyPem(stored.privateKeyPem);
    if (identity.devicePublicKey !== stored.devicePublicKey)
      throw new Error("stored device identity does not match its public key");
    return identity;
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
  const identity = identityFromPrivateKeyPem(privateKeyPem);
  atomicWriteText(
    path,
    `${JSON.stringify({ privateKeyPem, devicePublicKey: identity.devicePublicKey })}\n`,
    SAFE_FILE_MODE,
  );
  return identity;
}

export function createRegistrationConfirmationPreview(
  identity: DeviceIdentity,
  tuple: DesktopBrowserRegistrationReservationTuple,
  binding?: RegistrationTupleBinding,
): RegistrationConfirmationPreview {
  const parsedTuple = parseDesktopBrowserRegistrationReservationTuple(tuple);
  assertTupleBinding(parsedTuple, binding);
  const publicIdentity = projectDesktopBrowserPublicIdentity(parsedTuple);
  if (publicIdentity.devicePublicKey !== identity.devicePublicKey) {
    throw new Error("registration tuple device public key does not match the local device identity");
  }
  return {
    confirmationFingerprint: computeDesktopBrowserRegistrationConfirmationFingerprint(parsedTuple),
    publicDeviceFingerprint: computeDesktopBrowserPublicDeviceFingerprint(publicIdentity),
    publicIdentity,
  };
}

export function confirmRegistration(
  identity: DeviceIdentity,
  tuple: DesktopBrowserRegistrationReservationTuple,
  expectedFingerprint: string,
  binding?: RegistrationTupleBinding,
): DesktopBrowserRegistrationConfirmationEnvelope {
  const parsedTuple = parseDesktopBrowserRegistrationReservationTuple(tuple);
  const preview = createRegistrationConfirmationPreview(identity, parsedTuple, binding);
  if (expectedFingerprint !== preview.confirmationFingerprint) throw new Error("confirmation fingerprint mismatch");
  return {
    registrationTuple: parsedTuple,
    publicIdentity: preview.publicIdentity,
    confirmationFingerprint: preview.confirmationFingerprint,
    signatureAlgorithm: "ed25519",
    signature: identity.sign(encodeDesktopBrowserRegistrationConfirmationSigningBytes(parsedTuple)),
  };
}

export function verifyRegistrationConfirmationEnvelopeSignature(
  envelope: DesktopBrowserRegistrationConfirmationEnvelope,
): boolean {
  try {
    const parsed = parseDesktopBrowserRegistrationConfirmationEnvelope(envelope);
    return verify(
      null,
      Buffer.from(encodeDesktopBrowserRegistrationConfirmationVerificationBytes(parsed.registrationTuple)),
      decodeDevicePublicKey(parsed.publicIdentity.devicePublicKey),
      Buffer.from(parsed.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export function verifyHostChallengeResponseMessage(message: HostChallengeResponseMessage): boolean {
  try {
    return verify(
      null,
      Buffer.from(
        encodeHostChallengeResponseSigningBytes({
          protocolVersion: message.protocolVersion,
          payload: message.payload,
        }),
      ),
      decodeDevicePublicKey(message.payload.devicePublicKey),
      Buffer.from(message.payload.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

export class HostBrokerConnection {
  private readonly options: HostBrokerConnectionOptions;
  private readonly snapshotState: HostBrokerStateSnapshot;

  constructor(options: HostBrokerConnectionOptions) {
    this.options = options;
    this.snapshotState = createInitialState({
      qmUrl: options.qmUrl,
      relayUrl: options.relayUrl,
      deploymentCanonicalId: options.deploymentCanonicalId ?? null,
      brokerInstanceId: options.brokerInstanceId,
      browserInstanceId: options.runtime.browserInstanceId,
      browserSkillStatus: options.runtime.browserSkillStatus,
      devicePublicKey: options.identity.devicePublicKey,
      publicDeviceFingerprint: options.publicDeviceFingerprint ?? null,
      confirmationFingerprint: options.confirmationFingerprint ?? null,
      connectionEpoch: options.connectionEpoch ?? null,
    });
  }

  snapshot(): HostBrokerStateSnapshot {
    return { ...this.snapshotState };
  }

  private emitState(): void {
    this.options.onStateChange?.(this.snapshot());
  }

  start(): Promise<void> {
    assertSecureRelayUrl(this.options.relayUrl);
    assertConnectableRuntime(this.options.runtime);
    const socket = this.options.transport.connect(this.options.relayUrl);
    return new Promise<void>((resolve, reject) => {
      let settled = false;
      let challenged = false;
      let handshakeComplete = false;
      const handshakeTimeout = setTimeout(() => {
        finish(new Error("relay challenge timed out before host registration completed"));
      }, this.options.handshakeTimeoutMs ?? RELAY_HANDSHAKE_TIMEOUT_MS);
      const clearHandshakeTimeout = (): void => {
        if (handshakeComplete) return;
        handshakeComplete = true;
        clearTimeout(handshakeTimeout);
      };
      const finish = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearHandshakeTimeout();
        this.snapshotState.brokerStatus = "disconnected";
        this.emitState();
        if (error) reject(error);
        else resolve();
      };
      socket.addEventListener("open", () => {
        socket.send(
          encodeDesktopBrowserMessage({
            protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
            kind: "host.hello",
            payload: {
              devicePublicKey: this.options.identity.devicePublicKey,
              brokerInstanceId: this.options.brokerInstanceId,
              brokerVersion: this.options.brokerVersion,
              supportedProtocolVersions: this.options.supportedProtocolVersions,
              supportedPolicyGrammarVersions: this.options.supportedPolicyGrammarVersions,
              bskVersion: this.options.runtime.bskVersion,
              extensionVersion: this.options.runtime.extensionVersion,
              cliShapeHash: this.options.runtime.cliShapeHash,
            },
          }),
        );
      });
      socket.addEventListener("message", (event) => {
        try {
          const raw =
            event && typeof event === "object" && "data" in event ? String((event as { data: unknown }).data) : "";
          if (Buffer.byteLength(raw, "utf8") > (this.options.maxMessageBytes ?? MAX_RELAY_MESSAGE_BYTES)) {
            throw new Error("relay message exceeded the maximum allowed size");
          }
          const message = decodeDesktopBrowserMessage(raw);
          if (message.kind === "relay.challenge") {
            if (challenged) throw new Error("relay sent multiple challenge messages for one host registration");
            assertTrustedRelayChallenge(message.payload, this.snapshotState);
            const response = createHostChallengeResponse(this.options.identity, message.payload);
            if (!verifyHostChallengeResponseMessage(response)) {
              throw new Error("host challenge response failed local signature verification");
            }
            applyAuthoritativeChallengeBinding(this.snapshotState, message.payload);
            socket.send(encodeDesktopBrowserMessage(response));
            challenged = true;
            clearHandshakeTimeout();
            this.snapshotState.brokerStatus = "ready";
            this.emitState();
            return;
          }
          if (message.kind === "relay.invoke") {
            if (!challenged) throw new Error("relay invoke arrived before the host challenge completed");
            throw new Error("host broker operation handling is not implemented");
          }
          throw new Error(`unsupported relay message kind ${JSON.stringify(message.kind)}`);
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      });
      socket.addEventListener("close", () => finish());
      socket.addEventListener("error", () => finish(new Error("host broker transport failed")));
    });
  }
}

export async function runHostBrokerCli(argv: string[], deps: HostBrokerCliDeps): Promise<number> {
  const [command, ...rest] = argv;
  if (!command) throw new Error("expected a qm-host-broker command");
  const json = takeFlag(rest, "--json");
  const identity = await loadOrCreateDeviceIdentity(deps.dataDir);
  const stored = loadState(deps.dataDir);
  const brokerInstanceId = nextBrokerInstanceId(deps.brokerInstanceId ?? stored?.brokerInstanceId ?? null);
  const runtime = deps.runtime ?? DEFAULT_RUNTIME;

  if (command === "status") {
    ensureNoExtraArgs(rest);
    const state =
      stored ??
      createInitialState({
        qmUrl: null,
        relayUrl: null,
        deploymentCanonicalId: null,
        brokerInstanceId,
        browserInstanceId: runtime.browserInstanceId,
        browserSkillStatus: runtime.browserSkillStatus,
        devicePublicKey: identity.devicePublicKey,
        publicDeviceFingerprint: null,
        confirmationFingerprint: null,
        connectionEpoch: null,
      });
    writeOutput(deps.stdout, json, state);
    return 0;
  }

  if (command === "confirmation") {
    const tupleJson = takeOption(rest, "--tuple-json");
    const expectedFingerprint = takeOption(rest, "--confirm");
    ensureNoExtraArgs(rest);
    if (!tupleJson) throw new Error("confirmation requires --tuple-json");
    const tuple = parseDesktopBrowserRegistrationReservationTuple(JSON.parse(tupleJson));
    const binding: RegistrationTupleBinding = {
      deploymentCanonicalId: stored?.deploymentCanonicalId ?? null,
      brokerInstanceId: stored?.brokerInstanceId ?? brokerInstanceId,
      browserInstanceId:
        stored?.browserInstanceId ?? (runtime.browserInstanceId !== "unbound" ? runtime.browserInstanceId : null),
      connectionEpoch: stored?.connectionEpoch ?? null,
    };
    const preview = createRegistrationConfirmationPreview(identity, tuple, binding);
    if (
      expectedFingerprint &&
      stored?.confirmationFingerprint &&
      stored.confirmationFingerprint !== preview.confirmationFingerprint
    ) {
      throw new Error("registration confirmation request does not match the locally previewed tuple binding");
    }
    const envelope = expectedFingerprint ? confirmRegistration(identity, tuple, expectedFingerprint, binding) : null;
    const baseState =
      stored ??
      createInitialState({
        qmUrl: null,
        relayUrl: null,
        deploymentCanonicalId: null,
        brokerInstanceId: brokerInstanceId,
        browserInstanceId: runtime.browserInstanceId !== "unbound" ? runtime.browserInstanceId : null,
        browserSkillStatus: runtime.browserSkillStatus,
        devicePublicKey: identity.devicePublicKey,
        publicDeviceFingerprint: preview.publicDeviceFingerprint,
        confirmationFingerprint: preview.confirmationFingerprint,
        connectionEpoch: null,
      });
    const nextState: HostBrokerStateSnapshot = {
      ...baseState,
      devicePublicKey: identity.devicePublicKey,
      publicDeviceFingerprint: preview.publicDeviceFingerprint,
      confirmationFingerprint: preview.confirmationFingerprint,
      notice: HOST_BROKER_CONTROL_NOTICE,
    };
    saveState(deps.dataDir, nextState);
    if (json) {
      deps.stdout.write(
        `${JSON.stringify({
          notice: HOST_BROKER_CONTROL_NOTICE,
          confirmationFingerprint: preview.confirmationFingerprint,
          publicDeviceFingerprint: preview.publicDeviceFingerprint,
          confirmed: envelope !== null,
          envelope,
        })}\n`,
      );
    } else {
      deps.stdout.write(
        [
          `Confirmation fingerprint: ${preview.confirmationFingerprint}`,
          `Public device fingerprint: ${preview.publicDeviceFingerprint}`,
          HOST_BROKER_CONTROL_NOTICE,
          envelope === null
            ? `Run qm-host-broker confirmation --tuple-json '<tuple-json>' --confirm ${preview.confirmationFingerprint} to sign this reservation.`
            : "Registration confirmation signed.",
        ].join("\n") + "\n",
      );
    }
    return 0;
  }

  if (command === "connect") {
    const qmUrl = rest.shift();
    if (!qmUrl) throw new Error("connect requires the QM public URL");
    ensureNoExtraArgs(rest);
    const relayUrl = deps.resolveRelayUrl ? deps.resolveRelayUrl(qmUrl) : resolveRelayUrlDefault(qmUrl);
    const initialState = createInitialState({
      qmUrl,
      relayUrl,
      deploymentCanonicalId: stored?.deploymentCanonicalId ?? null,
      brokerInstanceId,
      browserInstanceId: runtime.browserInstanceId,
      browserSkillStatus: runtime.browserSkillStatus,
      devicePublicKey: identity.devicePublicKey,
      publicDeviceFingerprint: stored?.publicDeviceFingerprint ?? null,
      confirmationFingerprint: stored?.confirmationFingerprint ?? null,
      connectionEpoch: stored?.connectionEpoch ?? null,
    });
    saveState(deps.dataDir, initialState);
    if (!json) deps.stdout.write(`${renderHumanState(initialState)}\n`);
    const connection = new HostBrokerConnection({
      qmUrl,
      relayUrl,
      deploymentCanonicalId: stored?.deploymentCanonicalId ?? null,
      brokerInstanceId,
      brokerVersion: deps.brokerVersion ?? "0.0.0",
      supportedProtocolVersions: [DESKTOP_BROWSER_PROTOCOL_VERSION],
      supportedPolicyGrammarVersions: ["1.0"],
      identity,
      runtime,
      connectionEpoch: stored?.connectionEpoch ?? null,
      publicDeviceFingerprint: stored?.publicDeviceFingerprint ?? null,
      confirmationFingerprint: stored?.confirmationFingerprint ?? null,
      transport: deps.transport ?? defaultTransport(),
      onStateChange(state) {
        saveState(deps.dataDir, withLatestConfirmationPreview(deps.dataDir, { ...initialState, ...state }));
      },
    });
    try {
      await connection.start();
      const finalState = withLatestConfirmationPreview(deps.dataDir, { ...initialState, ...connection.snapshot() });
      saveState(deps.dataDir, finalState);
      if (json) writeOutput(deps.stdout, true, finalState);
      return 0;
    } catch (error) {
      const failedState = withLatestConfirmationPreview(deps.dataDir, {
        ...initialState,
        ...connection.snapshot(),
        brokerStatus: "disconnected" as const,
      });
      saveState(deps.dataDir, failedState);
      deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  throw new Error(`unsupported qm-host-broker command ${JSON.stringify(command)}`);
}

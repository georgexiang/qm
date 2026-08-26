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
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
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
const RECONNECT_BACKOFF_BASE_MS = 250;
const RECONNECT_BACKOFF_MAX_MS = 5_000;
const SAFE_DIR_MODE = 0o700;
const SAFE_FILE_MODE = 0o600;
const HOST_BROKER_RELAY_URL_ENV = "QM_HOST_BROKER_RELAY_URL";
const HOST_BROKER_RELAY_WSS_PATH_ENV = "QM_HOST_BROKER_RELAY_WSS_PATH";

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
  processEpoch: number | null;
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
  removeEventListener?(type: "open" | "message" | "close" | "error", listener: (event?: unknown) => void): void;
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
  signal?: AbortSignal;
  scheduler?: HostBrokerScheduler;
  processEpoch?: number | null;
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
  signal?: AbortSignal;
  scheduler?: HostBrokerScheduler;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

export interface HostBrokerScheduler {
  now(): number;
  random(): number;
  setTimeout(callback: () => void, ms: number): HostBrokerTimer;
  clearTimeout(timer: HostBrokerTimer): void;
}

type HostBrokerTimer = ReturnType<typeof setTimeout>;

interface HostBrokerConnectionRunResult {
  reason: "retryable-close" | "settled" | "stopped";
  ready: boolean;
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

const DEFAULT_SCHEDULER: HostBrokerScheduler = {
  now: () => Date.now(),
  random: () => Math.random(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (timer) => clearTimeout(timer),
};

class RetryableHostBrokerError extends Error {
  readonly ready: boolean;

  constructor(message: string, ready: boolean) {
    super(message);
    this.name = "RetryableHostBrokerError";
    this.ready = ready;
  }
}

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
  const keepPreview =
    stored !== null &&
    stored.deploymentCanonicalId === state.deploymentCanonicalId &&
    stored.brokerInstanceId === state.brokerInstanceId &&
    stored.browserInstanceId === state.browserInstanceId &&
    stored.connectionEpoch === state.connectionEpoch;
  return {
    ...state,
    publicDeviceFingerprint: keepPreview ? stored.publicDeviceFingerprint : null,
    confirmationFingerprint: keepPreview ? stored.confirmationFingerprint : null,
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
  processEpoch: number | null;
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
    processEpoch: input.processEpoch,
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
    `Process epoch: ${state.processEpoch ?? "idle"}`,
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

function assertRelayWssPath(path: string): void {
  if (!path.startsWith("/") || path.length === 1) {
    throw new Error(`${HOST_BROKER_RELAY_WSS_PATH_ENV} must start with / and must not be /`);
  }
}

function isLoopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (normalizedHostname === "localhost" || normalizedHostname === "::1" || normalizedHostname === "0:0:0:0:0:0:0:1") {
    return true;
  }
  return isIP(normalizedHostname) === 4 && normalizedHostname.startsWith("127.");
}

function assertRelayUrlOverride(relayUrl: string): void {
  const target = new URL(relayUrl);
  if (target.protocol !== "wss:" && target.protocol !== "ws:") {
    throw new Error(`${HOST_BROKER_RELAY_URL_ENV} must use ws:// or wss://`);
  }
  if (target.protocol === "ws:" && !isLoopbackHostname(target.hostname)) {
    throw new Error(`${HOST_BROKER_RELAY_URL_ENV} may use ws:// only for loopback hosts`);
  }
  if (target.username || target.password) {
    throw new Error(`${HOST_BROKER_RELAY_URL_ENV} must not include credentials`);
  }
  if (target.search || target.hash) {
    throw new Error(`${HOST_BROKER_RELAY_URL_ENV} must not include query or fragment components`);
  }
  if (!target.pathname.startsWith("/")) {
    throw new Error(`${HOST_BROKER_RELAY_URL_ENV} must include an absolute websocket path`);
  }
}

function resolveRelayUrlDefault(qmUrl: string, relayWssPath: string = DESKTOP_BROWSER_RELAY_WSS_PATH): string {
  const target = new URL(relayWssPath, qmUrl);
  target.protocol = target.protocol === "https:" ? "wss:" : "ws:";
  return target.toString();
}

export function resolveRelayUrlFromEnv(qmUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const relayUrlOverride = env[HOST_BROKER_RELAY_URL_ENV]?.trim();
  if (relayUrlOverride) {
    assertRelayUrlOverride(relayUrlOverride);
    return new URL(relayUrlOverride).toString();
  }
  const relayWssPathOverride = env[HOST_BROKER_RELAY_WSS_PATH_ENV]?.trim();
  if (relayWssPathOverride) {
    assertRelayWssPath(relayWssPathOverride);
    return resolveRelayUrlDefault(qmUrl, relayWssPathOverride);
  }
  return resolveRelayUrlDefault(qmUrl);
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

function isRetryableHostBrokerError(error: unknown): error is RetryableHostBrokerError {
  return error instanceof RetryableHostBrokerError;
}

function nextProcessEpoch(existing: number | null | undefined, scheduler: HostBrokerScheduler): number {
  return Math.max((existing ?? 0) + 1, scheduler.now());
}

function computeReconnectDelayMs(
  consecutiveTransientFailures: number,
  baseMs: number,
  maxMs: number,
  scheduler: HostBrokerScheduler,
): number {
  const exponent = Math.max(0, consecutiveTransientFailures);
  const cappedBase = Math.min(maxMs, baseMs * 2 ** exponent);
  return Math.max(1, Math.floor(cappedBase * (0.5 + scheduler.random() * 0.5)));
}

function waitForDelay(ms: number, signal: AbortSignal | undefined, scheduler: HostBrokerScheduler): Promise<boolean> {
  if (signal?.aborted) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    let timer: HostBrokerTimer | null = null;
    const finish = (value: boolean): void => {
      if (timer !== null) scheduler.clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    };
    const onAbort = (): void => finish(false);
    signal?.addEventListener("abort", onAbort, { once: true });
    timer = scheduler.setTimeout(() => finish(true), ms);
  });
}

function closeDescription(code: number | null, reason: string | null): string {
  const parts = [] as string[];
  if (code !== null) parts.push(`code ${code}`);
  if (reason) parts.push(`reason ${JSON.stringify(reason)}`);
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function closeEventDetails(event?: unknown): { code: number | null; reason: string | null } {
  if (!event || typeof event !== "object") return { code: null, reason: null };
  const code =
    "code" in event && typeof (event as { code?: unknown }).code === "number" ? (event as { code: number }).code : null;
  const reason =
    "reason" in event && typeof (event as { reason?: unknown }).reason === "string"
      ? (event as { reason: string }).reason
      : null;
  return { code, reason };
}

function classifySocketClose(
  event: unknown,
  ready: boolean,
  locallyRequestedStop: boolean,
): { result?: HostBrokerConnectionRunResult; error?: Error } {
  const { code, reason } = closeEventDetails(event);
  if (locallyRequestedStop) return { result: { reason: "stopped", ready } };
  if (code === 1012) return { result: { reason: "retryable-close", ready } };
  if (code === 1000) return { result: { reason: "settled", ready } };
  return {
    error: new Error(`host broker relay closed with a nonretryable code${closeDescription(code, reason)}`),
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
      processEpoch: options.processEpoch ?? null,
      connectionEpoch: options.connectionEpoch ?? null,
    });
  }

  snapshot(): HostBrokerStateSnapshot {
    return { ...this.snapshotState };
  }

  private emitState(): void {
    this.options.onStateChange?.(this.snapshot());
  }

  start(): Promise<HostBrokerConnectionRunResult> {
    assertSecureRelayUrl(this.options.relayUrl);
    assertConnectableRuntime(this.options.runtime);
    const scheduler = this.options.scheduler ?? DEFAULT_SCHEDULER;
    if (this.options.signal?.aborted) {
      this.snapshotState.brokerStatus = "disconnected";
      this.emitState();
      return Promise.resolve({ reason: "stopped", ready: false });
    }
    let socket: HostBrokerSocket;
    try {
      socket = this.options.transport.connect(this.options.relayUrl);
    } catch (error) {
      throw new RetryableHostBrokerError(error instanceof Error ? error.message : String(error), false);
    }
    return new Promise<HostBrokerConnectionRunResult>((resolve, reject) => {
      let settled = false;
      let challenged = false;
      let handshakeComplete = false;
      let active = true;
      let locallyRequestedStop = false;
      const handshakeTimeout = scheduler.setTimeout(() => {
        finish(
          undefined,
          new RetryableHostBrokerError("relay challenge timed out before host registration completed", challenged),
        );
      }, this.options.handshakeTimeoutMs ?? RELAY_HANDSHAKE_TIMEOUT_MS);
      const openListener = () => {
        if (!active) return;
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
      };
      const messageListener = (event?: unknown) => {
        if (!active) return;
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
          finish(undefined, error instanceof Error ? error : new Error(String(error)));
        }
      };
      const closeListener = (event?: unknown) => {
        if (!active) return;
        const classified = classifySocketClose(
          event,
          challenged,
          locallyRequestedStop || this.options.signal?.aborted === true,
        );
        finish(classified.result, classified.error);
      };
      const errorListener = () => {
        if (!active) return;
        finish(undefined, new RetryableHostBrokerError("host broker transport failed", challenged));
      };
      const detachListeners = (): void => {
        active = false;
        socket.removeEventListener?.("open", openListener);
        socket.removeEventListener?.("message", messageListener);
        socket.removeEventListener?.("close", closeListener);
        socket.removeEventListener?.("error", errorListener);
      };
      const closeSocket = (code: number, reason: string): void => {
        locallyRequestedStop = true;
        try {
          socket.close(code, reason);
        } catch {
          return;
        }
      };
      const onAbort = (): void => {
        try {
          closeSocket(1000, "local stop");
        } finally {
          finish({ reason: "stopped", ready: challenged });
        }
      };
      const clearHandshakeTimeout = (): void => {
        if (handshakeComplete) return;
        handshakeComplete = true;
        scheduler.clearTimeout(handshakeTimeout);
      };
      const finish = (result?: HostBrokerConnectionRunResult, error?: Error): void => {
        if (settled) return;
        settled = true;
        detachListeners();
        clearHandshakeTimeout();
        this.options.signal?.removeEventListener("abort", onAbort);
        if (!locallyRequestedStop) closeSocket(1000, error ? "local cleanup" : "settled");
        this.snapshotState.brokerStatus = "disconnected";
        this.emitState();
        if (error) reject(error);
        else resolve(result ?? { reason: "settled", ready: challenged });
      };
      this.options.signal?.addEventListener("abort", onAbort, { once: true });
      socket.addEventListener("open", openListener);
      socket.addEventListener("message", messageListener);
      socket.addEventListener("close", closeListener);
      socket.addEventListener("error", errorListener);
    });
  }
}

async function runHostBrokerConnectionSupervisor(options: {
  initialState: HostBrokerStateSnapshot;
  dataDir: string;
  signal: AbortSignal;
  scheduler: HostBrokerScheduler;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  createConnection: (state: HostBrokerStateSnapshot) => HostBrokerConnection;
}): Promise<HostBrokerStateSnapshot> {
  let state = options.initialState;
  let consecutiveTransientFailures = 0;
  while (true) {
    if (options.signal.aborted) return state;
    const connection = options.createConnection(state);
    try {
      const result = await connection.start();
      state = withLatestConfirmationPreview(options.dataDir, { ...state, ...connection.snapshot() });
      saveState(options.dataDir, state);
      if (result.reason !== "retryable-close") return state;
      consecutiveTransientFailures = result.ready ? 0 : consecutiveTransientFailures + 1;
    } catch (error) {
      state = withLatestConfirmationPreview(options.dataDir, {
        ...state,
        ...connection.snapshot(),
        brokerStatus: "disconnected",
      });
      saveState(options.dataDir, state);
      if (!isRetryableHostBrokerError(error) || options.signal.aborted) {
        throw error;
      }
      consecutiveTransientFailures = error.ready ? 0 : consecutiveTransientFailures + 1;
    }
    const delayMs = computeReconnectDelayMs(
      consecutiveTransientFailures,
      options.reconnectBaseMs,
      options.reconnectMaxMs,
      options.scheduler,
    );
    const shouldContinue = await waitForDelay(delayMs, options.signal, options.scheduler);
    if (!shouldContinue) return state;
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
  const scheduler = deps.scheduler ?? DEFAULT_SCHEDULER;
  const storedProcessEpoch = stored?.processEpoch ?? null;

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
        processEpoch: storedProcessEpoch,
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
        processEpoch: storedProcessEpoch,
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
    const processEpoch = nextProcessEpoch(stored?.processEpoch ?? null, scheduler);
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
      processEpoch,
      connectionEpoch: stored?.connectionEpoch ?? null,
    });
    saveState(deps.dataDir, initialState);
    if (!json) deps.stdout.write(`${renderHumanState(initialState)}\n`);
    const createConnection = (state: HostBrokerStateSnapshot): HostBrokerConnection =>
      new HostBrokerConnection({
        qmUrl,
        relayUrl,
        deploymentCanonicalId: state.deploymentCanonicalId,
        brokerInstanceId: state.brokerInstanceId,
        brokerVersion: deps.brokerVersion ?? "0.0.0",
        supportedProtocolVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS],
        supportedPolicyGrammarVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS],
        identity,
        runtime,
        connectionEpoch: state.connectionEpoch,
        publicDeviceFingerprint: state.publicDeviceFingerprint,
        confirmationFingerprint: state.confirmationFingerprint,
        processEpoch: state.processEpoch,
        transport: deps.transport ?? defaultTransport(),
        signal: deps.signal,
        scheduler,
        onStateChange(nextState) {
          saveState(deps.dataDir, withLatestConfirmationPreview(deps.dataDir, { ...state, ...nextState }));
        },
      });
    try {
      const finalState = deps.signal
        ? await runHostBrokerConnectionSupervisor({
            initialState,
            dataDir: deps.dataDir,
            signal: deps.signal,
            scheduler,
            reconnectBaseMs: deps.reconnectBaseMs ?? RECONNECT_BACKOFF_BASE_MS,
            reconnectMaxMs: deps.reconnectMaxMs ?? RECONNECT_BACKOFF_MAX_MS,
            createConnection,
          })
        : await (() => {
            const connection = createConnection(initialState);
            return connection.start().then(() => {
              const oneShotState = withLatestConfirmationPreview(deps.dataDir, {
                ...initialState,
                ...connection.snapshot(),
              });
              saveState(deps.dataDir, oneShotState);
              return oneShotState;
            });
          })();
      if (json) writeOutput(deps.stdout, true, finalState);
      return 0;
    } catch (error) {
      const failedState = withLatestConfirmationPreview(deps.dataDir, {
        ...(loadState(deps.dataDir) ?? initialState),
        brokerStatus: "disconnected" as const,
      });
      saveState(deps.dataDir, failedState);
      deps.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      return 1;
    }
  }

  throw new Error(`unsupported qm-host-broker command ${JSON.stringify(command)}`);
}

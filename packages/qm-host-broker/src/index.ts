import {
  accessSync,
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
import { spawn } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { isIP } from "node:net";
import { dirname, isAbsolute, join } from "node:path";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRequestHash,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  decodeDesktopBrowserMessage,
  encodeDesktopBrowserMessage,
  encodeHostChallengeResponseSigningBytes,
  encodeDesktopBrowserRegistrationConfirmationSigningBytes,
  encodeDesktopBrowserRegistrationConfirmationVerificationBytes,
  parseDesktopBrowserRegistrationConfirmationEnvelope,
  parseDesktopBrowserRegistrationReservationTuple,
  projectDesktopBrowserPublicIdentity,
  type DesktopBrowserHostFailure,
  type DesktopBrowserSessionStartAuthorityEnvelope,
  type DesktopBrowserSessionStartResult,
  type DesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRegistrationReservationTuple,
  type HostAcceptedMessage,
  type HostResultMessage,
  type HostChallengeResponseMessage,
  type RelayChallengeMessage,
} from "qm-desktop-browser-contracts";

const MAX_RELAY_MESSAGE_BYTES = 64 * 1024;
const MAX_BROWSER_SKILL_OUTPUT_BYTES = 64 * 1024;
const MAX_BROWSER_SKILL_RUN_MS = 15_000;
const RELAY_HANDSHAKE_TIMEOUT_MS = 10_000;
const RECONNECT_BACKOFF_BASE_MS = 250;
const RECONNECT_BACKOFF_MAX_MS = 5_000;
const SAFE_DIR_MODE = 0o700;
const SAFE_FILE_MODE = 0o600;
const SAFE_INSTALL_FILE_MAX_MODE = 0o755;
const DEFAULT_CHILD_KILL_GRACE_MS = 250;
const HOST_BROKER_RELAY_URL_ENV = "QM_HOST_BROKER_RELAY_URL";
const HOST_BROKER_RELAY_WSS_PATH_ENV = "QM_HOST_BROKER_RELAY_WSS_PATH";
const HOST_BROKER_BSK_EXECUTABLE_ENV = "QM_HOST_BROKER_BSK_EXECUTABLE";
const HOST_BROKER_BSK_EXECUTABLE_CONFIG_FILE = "browser-skill-executable.txt";

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
  negotiatedProtocolVersion: string | null;
  negotiatedPolicyGrammarVersion: string | null;
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
  dataDir?: string;
  deviceId?: string;
  browserSkillExecutable?: string;
  sessionRunner?: HostBrokerSessionRunner;
  maxBrowserSkillOutputBytes?: number;
  browserSkillTimeoutMs?: number;
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
  writeObserver?: HostBrokerWriteObserver;
}

export interface HostBrokerWriteObserver {
  onFenceCreated?(fence: HostOperationFence): void;
  onFenceSaved?(fence: HostOperationFence): void;
  onSessionOwnershipSaved(record: {
    taskId: string;
    attemptId: string;
    operationId: string;
    requestHash: string;
    sessionId: string;
    browserInstanceId: string;
    agentWindowId: number;
  }): void;
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
  deviceId?: string;
  browserSkillExecutable?: string;
  sessionRunner?: HostBrokerSessionRunner;
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

export interface HostBrokerSessionRunOptions {
  shell: false;
  stdio: ["ignore", "pipe", "pipe"];
}

export interface HostBrokerSessionRunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface HostBrokerSessionRunControl {
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface HostBrokerSessionRunHandle {
  result: Promise<HostBrokerSessionRunResult>;
  cancel(reason?: Error): Promise<void>;
}

export interface HostBrokerSessionRunner {
  run(
    executable: string,
    argv: readonly string[],
    options: HostBrokerSessionRunOptions,
    control?: HostBrokerSessionRunControl,
  ): Promise<HostBrokerSessionRunResult> | HostBrokerSessionRunHandle;
}

export interface ResolveInstalledBrowserSkillExecutableOptions {
  env?: NodeJS.ProcessEnv;
  installRoot: string;
}

export interface CreateDefaultHostBrokerSessionRunnerOptions {
  spawn?: typeof spawn;
  defaultTimeoutMs?: number;
  maxOutputBytes?: number;
  killGraceMs?: number;
  closeGraceMs?: number;
  setTimeout?: typeof setTimeout;
  clearTimeout?: typeof clearTimeout;
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

type PersistedHostTerminalPayload =
  | {
      dispatchId?: string;
      operationId?: string;
      outcome: "completed";
      resultHash?: string;
      result: DesktopBrowserSessionStartResult;
    }
  | {
      dispatchId?: string;
      operationId?: string;
      outcome: "failed" | "unknown";
      resultHash?: string;
      error?: DesktopBrowserHostFailure;
    };

interface HostOperationFence {
  operationId: string;
  requestHash: string;
  taskId: string;
  attemptId: string;
  state: "accepted" | "completed" | "failed" | "unknown";
  terminalPayload?: PersistedHostTerminalPayload;
}

const DEVICE_KEY_FILE = "device-key.json";
const STATE_FILE = "state.json";
const OPERATIONS_DIR = "operations";
const SESSIONS_DIR = "sessions";
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

export class HostBrokerSpawnRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HostBrokerSpawnRejectedError";
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

function localRecordPath(dataDir: string, directory: string, identity: string): string {
  const digest = createHash("sha256").update(identity).digest("hex");
  return join(dataDir, directory, `${digest}.json`);
}

function operationFencePath(dataDir: string, operationId: string): string {
  return localRecordPath(dataDir, OPERATIONS_DIR, operationId);
}

function sessionOwnershipPath(dataDir: string, taskId: string): string {
  return localRecordPath(dataDir, SESSIONS_DIR, taskId);
}

function loadOperationFence(dataDir: string, operationId: string): HostOperationFence | null {
  return readJsonFile<HostOperationFence>(operationFencePath(dataDir, operationId));
}

function saveOperationFence(dataDir: string, fence: HostOperationFence): void {
  atomicWriteText(operationFencePath(dataDir, fence.operationId), `${JSON.stringify(fence)}\n`, SAFE_FILE_MODE);
}

function createOperationFence(dataDir: string, fence: HostOperationFence): boolean {
  const filePath = operationFencePath(dataDir, fence.operationId);
  assertSafeDirectory(dirname(filePath));
  let fd: number;
  try {
    fd = openSync(
      filePath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      SAFE_FILE_MODE,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw error;
  }
  try {
    writeFileSync(fd, `${JSON.stringify(fence)}\n`, "utf8");
    fsyncSync(fd);
    chmodSync(filePath, SAFE_FILE_MODE);
  } finally {
    closeSync(fd);
  }
  const dirFd = openSync(dirname(filePath), "r");
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
  assertSafeFile(filePath, SAFE_FILE_MODE);
  return true;
}

function assertSafeInstallOwnedFile(path: string): void {
  const stats = lstatSync(path);
  if (stats.isSymbolicLink()) throw new Error(`refusing symbolic link path ${JSON.stringify(path)}`);
  if (!stats.isFile()) throw new Error(`expected regular file at ${JSON.stringify(path)}`);
  if ((stats.mode & 0o022) !== 0) {
    throw new Error(`file ${JSON.stringify(path)} must not be writable by group or others`);
  }
  if ((stats.mode & 0o777) > SAFE_INSTALL_FILE_MAX_MODE) {
    throw new Error(`file ${JSON.stringify(path)} uses an unsafe mode`);
  }
  const currentUid = process.getuid?.();
  if (currentUid !== undefined && stats.uid !== currentUid && stats.uid !== 0) {
    throw new Error(`file ${JSON.stringify(path)} must be owned by the current user or root`);
  }
}

function assertSafeExecutableFile(path: string): void {
  if (!isAbsolute(path)) throw new Error("BrowserSkill executable path must be absolute");
  assertSafeInstallOwnedFile(path);
  try {
    accessSync(path, fsConstants.X_OK);
  } catch {
    throw new Error(`BrowserSkill executable is not executable at ${path}`);
  }
}

function normalizeInstalledExecutablePath(text: string): string {
  const executable = text.trim();
  if (!executable) throw new Error("BrowserSkill executable config is empty");
  if (!isAbsolute(executable)) throw new Error("BrowserSkill executable path must be absolute");
  return executable;
}

function normalizeBrowserSkillExecutable(
  executable: string | undefined,
  sessionRunner: HostBrokerSessionRunner | undefined,
): string {
  if (executable === undefined) {
    if (!sessionRunner) {
      throw new Error("BrowserSkill executable is required when using the default host broker session runner");
    }
    return "";
  }
  assertSafeExecutableFile(executable);
  return executable;
}

export function resolveInstalledBrowserSkillExecutable(options: ResolveInstalledBrowserSkillExecutableOptions): string {
  const env = options.env ?? process.env;
  if (env[HOST_BROKER_BSK_EXECUTABLE_ENV]?.trim()) {
    throw new Error(
      `${HOST_BROKER_BSK_EXECUTABLE_ENV} is removed; configure ${HOST_BROKER_BSK_EXECUTABLE_CONFIG_FILE}`,
    );
  }
  const configPath = join(options.installRoot, HOST_BROKER_BSK_EXECUTABLE_CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(`BrowserSkill executable config is missing at ${JSON.stringify(configPath)}`);
  }
  assertSafeInstallOwnedFile(configPath);
  const executable = normalizeInstalledExecutablePath(readFileSync(configPath, "utf8"));
  assertSafeExecutableFile(executable);
  return executable;
}

function isSessionRunHandle(
  value: Promise<HostBrokerSessionRunResult> | HostBrokerSessionRunHandle,
): value is HostBrokerSessionRunHandle {
  return typeof value === "object" && value !== null && "result" in value && "cancel" in value;
}

function normalizeSessionRunHandle(
  value: Promise<HostBrokerSessionRunResult> | HostBrokerSessionRunHandle,
): HostBrokerSessionRunHandle {
  if (isSessionRunHandle(value)) return value;
  return {
    result: value,
    async cancel() {},
  };
}

function stableJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("host result contains a non-JSON value");
}

function computeHostResultHash(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function parseBrowserSkillSessionStartResult(stdout: string, maxBytes: number): DesktopBrowserSessionStartResult {
  if (Buffer.byteLength(stdout, "utf8") > maxBytes) throw new Error("BrowserSkill output exceeded the maximum size");
  const raw: unknown = JSON.parse(stdout);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("BrowserSkill session start output must be an object");
  }
  const record = raw as Record<string, unknown>;
  if (typeof record.session_id !== "string" || record.session_id.length === 0 || /\s/.test(record.session_id)) {
    throw new Error("BrowserSkill session start output has an invalid session_id");
  }
  if (
    typeof record.browser_instance_id !== "string" ||
    record.browser_instance_id.length === 0 ||
    /\s/.test(record.browser_instance_id)
  ) {
    throw new Error("BrowserSkill session start output has an invalid browser_instance_id");
  }
  if (!Number.isSafeInteger(record.agent_window_id) || (record.agent_window_id as number) < 0) {
    throw new Error("BrowserSkill session start output has an invalid agent_window_id");
  }
  return Object.freeze({
    session_id: record.session_id,
    browser_instance_id: record.browser_instance_id,
    agent_window_id: record.agent_window_id as number,
  });
}

function classifyAcceptedFailure(error: unknown): {
  state: "failed" | "unknown";
  terminalPayload: PersistedHostTerminalPayload;
} {
  if (error instanceof HostBrokerSpawnRejectedError) {
    return {
      state: "failed",
      terminalPayload: {
        outcome: "failed",
        error: {
          code: "browser_cli_spawn_rejected",
          message: error.message,
        },
      },
    };
  }
  const unknownError = error instanceof Error ? error : new Error(String(error));
  return {
    state: "unknown",
    terminalPayload: {
      outcome: "unknown",
      error: {
        code: "host_operation_unknown",
        message: unknownError.message,
      },
    },
  };
}

export function createDefaultHostBrokerSessionRunner(
  options: CreateDefaultHostBrokerSessionRunnerOptions = {},
): HostBrokerSessionRunner {
  const spawnProcess = options.spawn ?? spawn;
  const setTimer = options.setTimeout ?? setTimeout;
  const clearTimer = options.clearTimeout ?? clearTimeout;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? MAX_BROWSER_SKILL_RUN_MS;
  const maxOutputBytes = options.maxOutputBytes ?? MAX_BROWSER_SKILL_OUTPUT_BYTES;
  const killGraceMs = options.killGraceMs ?? DEFAULT_CHILD_KILL_GRACE_MS;
  const closeGraceMs = options.closeGraceMs ?? killGraceMs;
  return {
    run(executable, argv, runOptions, control) {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawnProcess(executable, [...argv], runOptions);
      } catch (error) {
        return {
          result: Promise.reject(
            new HostBrokerSpawnRejectedError(error instanceof Error ? error.message : String(error)),
          ),
          async cancel() {},
        };
      }
      if (!child.stdout || !child.stderr) {
        return {
          result: Promise.reject(new HostBrokerSpawnRejectedError("BrowserSkill pipes were not available")),
          async cancel() {},
        };
      }
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let finish: (() => void) | null = null;
      let rejectResult: ((error: Error) => void) | null = null;
      let terminationReason: Error | null = null;
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
      let killTimer: ReturnType<typeof setTimeout> | null = null;
      let closeTimer: ReturnType<typeof setTimeout> | null = null;
      const clearTerminationTimers = (): void => {
        if (timeoutTimer !== null) {
          clearTimer(timeoutTimer);
          timeoutTimer = null;
        }
        if (killTimer !== null) {
          clearTimer(killTimer);
          killTimer = null;
        }
        if (closeTimer !== null) {
          clearTimer(closeTimer);
          closeTimer = null;
        }
      };
      const cleanupAbortListener = (): void => {
        control?.signal?.removeEventListener("abort", onAbort);
      };
      const settleRejection = (error: Error): void => {
        if (settled) return;
        settled = true;
        clearTerminationTimers();
        cleanupAbortListener();
        rejectResult?.(error);
        finish?.();
      };
      const settleResolution = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTerminationTimers();
        cleanupAbortListener();
        if (terminationReason) {
          rejectResult?.(terminationReason);
        } else {
          finish?.();
        }
        if (!terminationReason && exitCode !== null) {
          resolveResult({
            exitCode,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          });
        } else if (!terminationReason && exitCode === null) {
          rejectResult?.(new Error("BrowserSkill session start terminated"));
        }
      };
      let resolveResult!: (value: HostBrokerSessionRunResult) => void;
      const result = new Promise<HostBrokerSessionRunResult>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = (error) => reject(error);
        finish = () => {};
      });
      const terminate = (reason: Error): Promise<void> => {
        if (!terminationReason) {
          terminationReason = reason;
          if (!settled) {
            void child.kill("SIGTERM");
            killTimer = setTimer(() => {
              void child.kill("SIGKILL");
              closeTimer = setTimer(() => {
                settleRejection(new Error("BrowserSkill session start failed to terminate after SIGKILL"));
              }, closeGraceMs);
            }, killGraceMs);
          }
        }
        return result.then(
          () => undefined,
          (error) => {
            if (error === terminationReason) return;
            throw error;
          },
        );
      };
      const collect = (chunks: Buffer[], chunk: Buffer): void => {
        outputBytes += chunk.length;
        if (outputBytes > maxOutputBytes) {
          void terminate(new Error("BrowserSkill output exceeded the maximum size"));
          return;
        }
        chunks.push(chunk);
      };
      const onAbort = (): void => {
        void terminate(new Error("BrowserSkill session start cancelled"));
      };
      child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
      child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
      child.once("error", (error) => {
        settleRejection(new HostBrokerSpawnRejectedError(error instanceof Error ? error.message : String(error)));
      });
      child.once("close", (exitCode) => {
        settleResolution(exitCode);
      });
      control?.signal?.addEventListener("abort", onAbort, { once: true });
      timeoutTimer = setTimer(() => {
        void terminate(new Error("BrowserSkill session start timed out"));
      }, control?.timeoutMs ?? defaultTimeoutMs);
      return {
        result,
        cancel(reason) {
          return terminate(reason ?? new Error("BrowserSkill session start cancelled"));
        },
      };
    },
  };
}

const DEFAULT_SESSION_RUNNER = createDefaultHostBrokerSessionRunner();

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
  negotiatedProtocolVersion?: string | null;
  negotiatedPolicyGrammarVersion?: string | null;
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
    negotiatedProtocolVersion: input.negotiatedProtocolVersion ?? null,
    negotiatedPolicyGrammarVersion: input.negotiatedPolicyGrammarVersion ?? null,
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
  challenge: RelayChallengeMessage,
): HostChallengeResponseMessage {
  const signingPayload = {
    relayInstanceId: challenge.payload.relayInstanceId,
    deploymentCanonicalId: challenge.payload.deploymentCanonicalId,
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: challenge.payload.brokerInstanceId,
    browserInstanceId: challenge.payload.browserInstanceId,
    connectionEpoch: challenge.payload.connectionEpoch,
    challengeNonce: challenge.payload.challengeNonce,
  };
  const unsignedMessage = {
    protocolVersion: challenge.protocolVersion,
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
    `Negotiated protocol: ${state.negotiatedProtocolVersion ?? "pending handshake"}`,
    `Negotiated policy grammar: ${state.negotiatedPolicyGrammarVersion ?? "pending handshake"}`,
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

function currentCapabilitySet(
  runtime: BrowserRuntimeMetadata,
  negotiatedProtocolVersion: string,
  negotiatedPolicyGrammarVersion: string,
) {
  return {
    protocolVersion: negotiatedProtocolVersion,
    policyGrammarVersion: negotiatedPolicyGrammarVersion,
    bskVersion: runtime.bskVersion,
    extensionVersion: runtime.extensionVersion,
    cliShapeHash: runtime.cliShapeHash,
  };
}

function assertSessionStartAuthorityBindings(
  authority: DesktopBrowserSessionStartAuthorityEnvelope,
  deviceId: string | null,
  runtime: BrowserRuntimeMetadata,
  state: HostBrokerStateSnapshot,
  negotiatedProtocolVersion: string,
  negotiatedPolicyGrammarVersion: string,
  now: number,
): void {
  if (authority.audience !== DESKTOP_BROWSER_RELAY_AUDIENCE) throw new Error("authority audience is not the relay");
  if (!state.deploymentCanonicalId || authority.deploymentCanonicalId !== state.deploymentCanonicalId) {
    throw new Error("authority deployment does not match the authoritative relay binding");
  }
  if (!deviceId || authority.deviceId !== deviceId) {
    throw new Error("authority device does not match the local host binding");
  }
  if (
    authority.browserInstanceId !== runtime.browserInstanceId ||
    authority.browserInstanceId !== state.browserInstanceId
  ) {
    throw new Error("authority browser does not match the live host runtime");
  }
  const expectedCapabilitySet = currentCapabilitySet(
    runtime,
    negotiatedProtocolVersion,
    negotiatedPolicyGrammarVersion,
  );
  if (stableJson(authority.capabilitySet) !== stableJson(expectedCapabilitySet)) {
    throw new Error("authority capability set does not exactly match the live host runtime");
  }
  if (Date.parse(authority.issuedAt) > now) throw new Error("authority lease is not valid yet");
  if (Date.parse(authority.leaseExpiresAt) <= now) throw new Error("authority lease expired before acceptance");
}

function assertSessionStartRequestHash(
  authority: DesktopBrowserSessionStartAuthorityEnvelope,
  requestHash: string,
  negotiatedProtocolVersion: string,
  negotiatedPolicyGrammarVersion: string,
): void {
  const canonicalRequestHash = computeDesktopBrowserRequestHash(
    authority,
    negotiatedProtocolVersion,
    negotiatedPolicyGrammarVersion,
  );
  if (canonicalRequestHash !== requestHash) {
    throw new Error("relay.invoke request hash does not match the locally recomputed authority hash");
  }
}

function accepted(
  protocolVersion: `${number}.${number}`,
  dispatchId: string,
  operationId: string,
  requestHash: string,
): HostAcceptedMessage {
  return {
    protocolVersion,
    kind: "host.accepted",
    payload: {
      dispatchId,
      operationId,
      requestHash,
    },
  };
}

function materializeHostResultPayload(
  dispatchId: string,
  operationId: string,
  terminalPayload: PersistedHostTerminalPayload,
): HostResultMessage["payload"] {
  if (terminalPayload.outcome === "completed") {
    return {
      dispatchId,
      operationId,
      outcome: "completed",
      resultHash: computeHostResultHash({
        dispatchId,
        operationId,
        outcome: "completed",
        result: terminalPayload.result,
      }),
      result: terminalPayload.result,
    };
  }
  return {
    dispatchId,
    operationId,
    outcome: terminalPayload.outcome,
    resultHash: computeHostResultHash({
      dispatchId,
      operationId,
      outcome: terminalPayload.outcome,
      ...(terminalPayload.error === undefined ? {} : { error: terminalPayload.error }),
    }),
    ...(terminalPayload.error === undefined ? {} : { error: terminalPayload.error }),
  };
}

function terminalResult(
  protocolVersion: `${number}.${number}`,
  dispatchId: string,
  operationId: string,
  terminalPayload: PersistedHostTerminalPayload,
): HostResultMessage {
  return {
    protocolVersion,
    kind: "host.result",
    payload: materializeHostResultPayload(dispatchId, operationId, terminalPayload),
  };
}

function unknownResult(
  protocolVersion: `${number}.${number}`,
  dispatchId: string,
  operationId: string,
  error?: Error,
): HostResultMessage {
  const errorPayload = error ? { code: "host_operation_unknown", message: error.message } : undefined;
  return terminalResult(protocolVersion, dispatchId, operationId, {
    dispatchId,
    outcome: "unknown",
    ...(errorPayload ? { error: errorPayload } : {}),
  });
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
  private readonly dataDir: string | null;
  private readonly deviceId: string | null;
  private readonly browserSkillExecutable: string;
  private readonly sessionRunner: HostBrokerSessionRunner;
  private readonly maxBrowserSkillOutputBytes: number;
  private readonly browserSkillTimeoutMs: number;
  private readonly writeObserver: HostBrokerWriteObserver | null;
  private readonly activeSessionRuns = new Set<HostBrokerSessionRunHandle>();

  constructor(options: HostBrokerConnectionOptions) {
    this.options = options;
    this.dataDir = options.dataDir ?? null;
    this.deviceId = options.deviceId ?? null;
    this.browserSkillExecutable = normalizeBrowserSkillExecutable(
      options.browserSkillExecutable,
      options.sessionRunner,
    );
    this.sessionRunner = options.sessionRunner ?? DEFAULT_SESSION_RUNNER;
    this.maxBrowserSkillOutputBytes = options.maxBrowserSkillOutputBytes ?? MAX_BROWSER_SKILL_OUTPUT_BYTES;
    this.browserSkillTimeoutMs = options.browserSkillTimeoutMs ?? MAX_BROWSER_SKILL_RUN_MS;
    this.writeObserver = options.writeObserver ?? null;
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

  private async handleRelayInvocation(input: {
    raw: string;
    socket: HostBrokerSocket;
    protocolVersion: `${number}.${number}`;
    policyGrammarVersion: string;
    now: () => number;
    isActive: () => boolean;
    signal: AbortSignal;
  }): Promise<void> {
    const decoded = decodeDesktopBrowserMessage(input.raw, input.protocolVersion, input.policyGrammarVersion);
    if (decoded.kind !== "relay.invoke") throw new Error("expected relay.invoke message");
    if (!this.dataDir) throw new Error("host operation state directory is not configured");
    assertSessionStartAuthorityBindings(
      decoded.payload.authority,
      this.deviceId,
      this.options.runtime,
      this.snapshotState,
      input.protocolVersion,
      input.policyGrammarVersion,
      input.now(),
    );
    assertSessionStartRequestHash(
      decoded.payload.authority,
      decoded.payload.requestHash,
      input.protocolVersion,
      input.policyGrammarVersion,
    );
    const message = decoded;

    const dataDir = this.dataDir!;
    const authority = message.payload.authority;
    const acceptedMessage = accepted(
      input.protocolVersion,
      message.payload.dispatchId,
      authority.operationId,
      message.payload.requestHash,
    );
    let existingFence = loadOperationFence(dataDir, authority.operationId);
    if (existingFence) {
      if (existingFence.requestHash === message.payload.requestHash && existingFence.terminalPayload) {
        input.socket.send(encodeDesktopBrowserMessage(acceptedMessage));
        input.socket.send(
          encodeDesktopBrowserMessage(
            terminalResult(
              input.protocolVersion,
              message.payload.dispatchId,
              authority.operationId,
              existingFence.terminalPayload,
            ),
          ),
        );
        return;
      }
      if (existingFence.requestHash !== message.payload.requestHash) {
        throw new Error("operationId is already bound to a different request hash");
      }
      input.socket.send(encodeDesktopBrowserMessage(acceptedMessage));
      const unknown = unknownResult(input.protocolVersion, message.payload.dispatchId, authority.operationId);
      input.socket.send(encodeDesktopBrowserMessage(unknown));
      return;
    }

    const fence: HostOperationFence = {
      operationId: authority.operationId,
      requestHash: message.payload.requestHash,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      state: "accepted",
    };
    if (!createOperationFence(dataDir, fence)) {
      existingFence = loadOperationFence(dataDir, authority.operationId);
      if (existingFence?.requestHash === message.payload.requestHash && existingFence.terminalPayload) {
        input.socket.send(encodeDesktopBrowserMessage(acceptedMessage));
        input.socket.send(
          encodeDesktopBrowserMessage(
            terminalResult(
              input.protocolVersion,
              message.payload.dispatchId,
              authority.operationId,
              existingFence.terminalPayload,
            ),
          ),
        );
        return;
      }
      if (existingFence && existingFence.requestHash !== message.payload.requestHash) {
        throw new Error("operationId is already bound to a different request hash");
      }
      input.socket.send(encodeDesktopBrowserMessage(acceptedMessage));
      input.socket.send(
        encodeDesktopBrowserMessage(
          unknownResult(
            input.protocolVersion,
            message.payload.dispatchId,
            authority.operationId,
            new Error("operation was fenced concurrently and cannot be spawned again"),
          ),
        ),
      );
      return;
    }
    this.writeObserver?.onFenceCreated?.(fence);
    this.snapshotState.currentTaskPresent = true;
    this.emitState();
    input.socket.send(encodeDesktopBrowserMessage(acceptedMessage));
    let completedPersisted = false;
    const runHandle = normalizeSessionRunHandle(
      this.sessionRunner.run(
        this.browserSkillExecutable,
        authority.argv,
        {
          shell: false,
          stdio: ["ignore", "pipe", "pipe"],
        },
        {
          signal: input.signal,
          timeoutMs: this.browserSkillTimeoutMs,
        },
      ),
    );
    this.activeSessionRuns.add(runHandle);
    try {
      const runResult = await runHandle.result;
      if (runResult.exitCode !== 0) throw new Error("BrowserSkill session start did not exit successfully");
      const result = parseBrowserSkillSessionStartResult(runResult.stdout, this.maxBrowserSkillOutputBytes);
      if (result.browser_instance_id !== authority.browserInstanceId) {
        throw new Error("BrowserSkill returned a browser outside the authority binding");
      }
      const completedTerminalPayload: PersistedHostTerminalPayload = {
        dispatchId: message.payload.dispatchId,
        outcome: "completed",
        result,
      };
      const completed = terminalResult(
        input.protocolVersion,
        message.payload.dispatchId,
        authority.operationId,
        completedTerminalPayload,
      );
      const sessionOwnership = {
        taskId: authority.taskId,
        attemptId: authority.attemptId,
        operationId: authority.operationId,
        requestHash: message.payload.requestHash,
        sessionId: result.session_id,
        browserInstanceId: result.browser_instance_id,
        agentWindowId: result.agent_window_id,
      };
      atomicWriteText(
        sessionOwnershipPath(dataDir, authority.taskId),
        `${JSON.stringify(sessionOwnership)}\n`,
        SAFE_FILE_MODE,
      );
      this.writeObserver?.onSessionOwnershipSaved(sessionOwnership);
      const completedFence = {
        ...fence,
        state: "completed" as const,
        terminalPayload: completedTerminalPayload,
      };
      saveOperationFence(dataDir, completedFence);
      completedPersisted = true;
      this.writeObserver?.onFenceSaved?.(completedFence);
      if (!input.isActive()) return;
      input.socket.send(encodeDesktopBrowserMessage(completed));
      return;
    } catch (error) {
      if (completedPersisted) throw error;
      const failure = classifyAcceptedFailure(error);
      const terminal = terminalResult(
        input.protocolVersion,
        message.payload.dispatchId,
        authority.operationId,
        failure.terminalPayload,
      );
      const failedFence = {
        ...fence,
        state: failure.state,
        terminalPayload: {
          dispatchId: message.payload.dispatchId,
          ...failure.terminalPayload,
        },
      };
      saveOperationFence(dataDir, failedFence);
      this.writeObserver?.onFenceSaved?.(failedFence);
      if (input.isActive()) input.socket.send(encodeDesktopBrowserMessage(terminal));
      return;
    } finally {
      this.activeSessionRuns.delete(runHandle);
      this.snapshotState.currentTaskPresent = false;
      this.emitState();
    }
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
      let negotiatedProtocolVersion: `${number}.${number}` | null = null;
      let negotiatedPolicyGrammarVersion: string | null = null;
      let handshakeComplete = false;
      let active = true;
      let locallyRequestedStop = false;
      const invocationAbortController = new AbortController();
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
          const rawEnvelope = JSON.parse(raw) as {
            kind?: unknown;
            payload?: { policyGrammarVersion?: unknown };
          };
          if (challenged) {
            if (rawEnvelope.kind === "relay.invoke") {
              if (!negotiatedProtocolVersion) {
                throw new Error("relay invoke arrived without an exact negotiated protocol version");
              }
              if (!negotiatedPolicyGrammarVersion) {
                throw new Error("relay connection does not identify one exact negotiated policy grammar");
              }
              void this.handleRelayInvocation({
                raw,
                socket,
                protocolVersion: negotiatedProtocolVersion,
                policyGrammarVersion: negotiatedPolicyGrammarVersion,
                now: () => scheduler.now(),
                isActive: () => active,
                signal: invocationAbortController.signal,
              }).catch((error: unknown) => {
                finish(undefined, error instanceof Error ? error : new Error(String(error)));
              });
              return;
            }
          }
          const message = decodeDesktopBrowserMessage(
            raw,
            negotiatedProtocolVersion ?? this.options.supportedProtocolVersions[0],
          );
          if (message.kind === "relay.challenge") {
            if (challenged) throw new Error("relay sent multiple challenge messages for one host registration");
            if (!this.options.supportedProtocolVersions.includes(message.protocolVersion)) {
              throw new Error("relay challenge protocol version was not advertised by this host");
            }
            assertTrustedRelayChallenge(message.payload, this.snapshotState);
            const response = createHostChallengeResponse(this.options.identity, message);
            if (!verifyHostChallengeResponseMessage(response)) {
              throw new Error("host challenge response failed local signature verification");
            }
            applyAuthoritativeChallengeBinding(this.snapshotState, message.payload);
            negotiatedProtocolVersion = message.protocolVersion;
            this.snapshotState.negotiatedProtocolVersion = message.protocolVersion;
            const authoritativePolicyGrammarVersion = rawEnvelope.payload?.policyGrammarVersion;
            if (authoritativePolicyGrammarVersion !== undefined) {
              if (
                typeof authoritativePolicyGrammarVersion !== "string" ||
                !this.options.supportedPolicyGrammarVersions.includes(authoritativePolicyGrammarVersion)
              ) {
                throw new Error("relay challenge policy grammar version was not advertised by this host");
              }
              negotiatedPolicyGrammarVersion = authoritativePolicyGrammarVersion;
            } else {
              negotiatedPolicyGrammarVersion =
                this.options.supportedPolicyGrammarVersions.length === 1
                  ? this.options.supportedPolicyGrammarVersions[0]!
                  : null;
            }
            this.snapshotState.negotiatedPolicyGrammarVersion = negotiatedPolicyGrammarVersion;
            socket.send(encodeDesktopBrowserMessage(response));
            challenged = true;
            clearHandshakeTimeout();
            this.snapshotState.brokerStatus = "ready";
            this.emitState();
            return;
          }
          if (message.kind === "relay.invoke")
            throw new Error("relay invoke arrived before the host challenge completed");
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
        invocationAbortController.abort();
        if (!locallyRequestedStop) closeSocket(1000, error ? "local cleanup" : "settled");
        this.snapshotState.brokerStatus = "disconnected";
        this.emitState();
        const cancelReason = error
          ? new Error(`BrowserSkill session start interrupted: ${error.message}`)
          : new Error(
              result?.reason === "stopped"
                ? "BrowserSkill session start stopped"
                : "BrowserSkill session start cancelled",
            );
        const inFlightCancels = [...this.activeSessionRuns].map((handle) => handle.cancel(cancelReason));
        void Promise.allSettled(inFlightCancels).then((cancelResults) => {
          const cleanupFailure = cancelResults.find((entry) => entry.status === "rejected");
          if (cleanupFailure) {
            const reason = cleanupFailure.reason;
            reject(
              new Error(
                `Host broker terminal cleanup failed: ${reason instanceof Error ? reason.message : String(reason)}`,
              ),
            );
            return;
          }
          if (error) reject(error);
          else resolve(result ?? { reason: "settled", ready: challenged });
        });
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
    normalizeBrowserSkillExecutable(deps.browserSkillExecutable, deps.sessionRunner);
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
        dataDir: deps.dataDir,
        deviceId: deps.deviceId,
        browserSkillExecutable: deps.browserSkillExecutable,
        sessionRunner: deps.sessionRunner,
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

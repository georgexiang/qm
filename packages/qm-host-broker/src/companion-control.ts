import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";

export const HOST_BROKER_COMPANION_HOST = "127.0.0.1";
export const HOST_BROKER_COMPANION_PORT = 32145;
export const HOST_BROKER_COMPANION_EXTENSION_ID = "nciggffamocnffbemkbjefanopmelkgm";
export const HOST_BROKER_COMPANION_ORIGIN = `chrome-extension://${HOST_BROKER_COMPANION_EXTENSION_ID}`;

export type HostBrokerOperationCategory = "session_start" | "browser_effect" | "observation" | "session_cleanup";

interface ActiveLocalOperation {
  taskId: string;
  attemptId: string;
  operationId: string;
  category: HostBrokerOperationCategory;
  startedAt: number;
  cancel?(reason?: Error): Promise<void>;
  stopping?: boolean;
}

export interface HostBrokerLocalStatus {
  brokerStatus: "ready" | "paused" | "disconnected";
  browserSkillStatus: "ready" | "offline";
  currentTaskPresent: boolean;
  deviceStatus?: "ready" | "needs_local_reconciliation";
  operationCategory?: HostBrokerOperationCategory;
  elapsedMs?: number;
  stopNonce?: string;
  stopNonceExpiresAt?: number;
}

export interface HostBrokerLocalStopReceipt {
  receiptVersion: "1.0";
  receiptId: string;
  processEpoch: number;
  taskId: string;
  attemptId: string;
  operationId: string;
  operationCategory: HostBrokerOperationCategory;
  requestedAt: number;
  status: "requested" | "canceled";
  origin: string;
}

export interface HostBrokerLocalControl {
  setBrokerState(state: {
    brokerStatus: HostBrokerLocalStatus["brokerStatus"];
    browserSkillStatus: HostBrokerLocalStatus["browserSkillStatus"];
  }): void;
  setDeviceStatus(status: "ready" | "needs_local_reconciliation"): void;
  beginOperation(operation: ActiveLocalOperation): void;
  endOperation(operationId: string): void;
  status(origin: string): HostBrokerLocalStatus;
  stop(origin: string, nonce: string): Promise<"stopped" | "task_changed">;
}

const LOCAL_STOP_RECEIPTS_DIR = "local-stop-receipts";

function receiptPath(dataDir: string, receiptId: string): string {
  return join(dataDir, LOCAL_STOP_RECEIPTS_DIR, `${createHash("sha256").update(receiptId).digest("hex")}.json`);
}

function persistReceipt(dataDir: string, receipt: HostBrokerLocalStopReceipt): void {
  const directory = join(dataDir, LOCAL_STOP_RECEIPTS_DIR);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("local Stop receipt directory is unsafe");
  }
  const path = receiptPath(dataDir, receipt.receiptId);
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let fd: number | null = null;
  try {
    fd = openSync(
      tempPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(fd, `${JSON.stringify(receipt)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    if (existsSync(path)) {
      const existingFd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const existingStat = fstatSync(existingFd);
        if (!existingStat.isFile() || (existingStat.mode & 0o177) !== 0 || existingStat.size > 4_096) {
          throw new Error("local Stop receipt file is unsafe");
        }
      } finally {
        closeSync(existingFd);
      }
    }
    renameSync(tempPath, path);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (existsSync(tempPath)) unlinkSync(tempPath);
    throw error;
  }
  const directoryFd = openSync(directory, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function listHostBrokerLocalStopReceipts(dataDir: string): HostBrokerLocalStopReceipt[] {
  const directory = join(dataDir, LOCAL_STOP_RECEIPTS_DIR);
  if (!existsSync(directory)) return [];
  const directoryStat = lstatSync(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || (directoryStat.mode & 0o077) !== 0) {
    throw new Error("local Stop receipt directory is unsafe");
  }
  return readdirSync(directory)
    .filter((name) => /^[a-f0-9]{64}\.json$/.test(name))
    .sort()
    .map((name) => {
      const path = join(directory, name);
      const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      try {
        const fileStat = fstatSync(fd);
        if (!fileStat.isFile() || (fileStat.mode & 0o177) !== 0 || fileStat.size > 4_096) {
          throw new Error("local Stop receipt file is unsafe");
        }
        const receipt = JSON.parse(readFileSync(fd, "utf8")) as HostBrokerLocalStopReceipt;
        if (
          receipt.receiptVersion !== "1.0" ||
          typeof receipt.receiptId !== "string" ||
          !Number.isSafeInteger(receipt.processEpoch) ||
          typeof receipt.taskId !== "string" ||
          typeof receipt.attemptId !== "string" ||
          typeof receipt.operationId !== "string" ||
          !["session_start", "browser_effect", "observation", "session_cleanup"].includes(
            receipt.operationCategory,
          ) ||
          !Number.isSafeInteger(receipt.requestedAt) ||
          (receipt.status !== "requested" && receipt.status !== "canceled") ||
          receipt.origin !== HOST_BROKER_COMPANION_ORIGIN
        ) {
          throw new Error("local Stop receipt is invalid");
        }
        return receipt;
      } finally {
        closeSync(fd);
      }
    });
}

export function deleteHostBrokerLocalStopReceipt(dataDir: string, receiptId: string): void {
  const path = receiptPath(dataDir, receiptId);
  if (!existsSync(path)) return;
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const fileStat = fstatSync(fd);
    if (!fileStat.isFile() || (fileStat.mode & 0o177) !== 0) throw new Error("local Stop receipt file is unsafe");
  } finally {
    closeSync(fd);
  }
  unlinkSync(path);
  const directoryFd = openSync(join(dataDir, LOCAL_STOP_RECEIPTS_DIR), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}

export function createHostBrokerLocalControl(options: {
  dataDir: string;
  processEpoch: number;
  now?: () => number;
  createNonce?: () => string;
}): HostBrokerLocalControl {
  const now = options.now ?? Date.now;
  const createNonce = options.createNonce ?? randomUUID;
  let brokerStatus: HostBrokerLocalStatus["brokerStatus"] = "disconnected";
  let browserSkillStatus: HostBrokerLocalStatus["browserSkillStatus"] = "offline";
  let deviceStatus: NonNullable<HostBrokerLocalStatus["deviceStatus"]> = "ready";
  const active = new Map<string, ActiveLocalOperation>();
  const stopNonces = new Map<
    string,
    {
      processEpoch: number;
      taskId: string;
      attemptId: string;
      operationId: string;
      origin: string;
      expiresAt: number;
    }
  >();
  return {
    setBrokerState(state) {
      brokerStatus = state.brokerStatus;
      browserSkillStatus = state.browserSkillStatus;
    },
    setDeviceStatus(status) {
      deviceStatus = status;
    },
    beginOperation(operation) {
      active.set(operation.operationId, operation);
    },
    endOperation(operationId) {
      active.delete(operationId);
    },
    status(origin) {
      if (active.size === 0) return { brokerStatus, browserSkillStatus, deviceStatus, currentTaskPresent: false };
      const operation = active.size === 1 ? active.values().next().value! : null;
      const at = now();
      for (const [nonce, binding] of stopNonces) {
        if (binding.expiresAt <= at) stopNonces.delete(nonce);
      }
      if (stopNonces.size >= 10_000) throw new Error("local Stop nonce capacity exceeded");
      if (!operation) return { brokerStatus, browserSkillStatus, deviceStatus, currentTaskPresent: true };
      if (!operation.cancel || operation.stopping) {
        return {
          brokerStatus,
          browserSkillStatus,
          deviceStatus,
          currentTaskPresent: true,
          operationCategory: operation.category,
          elapsedMs: Math.max(0, at - operation.startedAt),
        };
      }
      const stopNonce = createNonce();
      stopNonces.set(stopNonce, {
        processEpoch: options.processEpoch,
        taskId: operation.taskId,
        attemptId: operation.attemptId,
        operationId: operation.operationId,
        origin,
        expiresAt: at + 30_000,
      });
      return {
        brokerStatus,
        browserSkillStatus,
        deviceStatus,
        currentTaskPresent: true,
        operationCategory: operation.category,
        elapsedMs: Math.max(0, at - operation.startedAt),
        stopNonce,
        stopNonceExpiresAt: at + 30_000,
      };
    },
    async stop(origin, nonce) {
      const binding = stopNonces.get(nonce);
      stopNonces.delete(nonce);
      const operation = binding ? active.get(binding.operationId) ?? null : null;
      const at = now();
      if (
        !binding ||
        !operation?.cancel ||
        binding.processEpoch !== options.processEpoch ||
        binding.taskId !== operation.taskId ||
        binding.attemptId !== operation.attemptId ||
        binding.operationId !== operation.operationId ||
        binding.origin !== origin ||
        binding.expiresAt <= at
      ) {
        return "task_changed";
      }
      if (operation.stopping) return "task_changed";
      operation.stopping = true;
      persistReceipt(options.dataDir, {
        receiptVersion: "1.0",
        receiptId: `local-stop-${options.processEpoch}-${operation.operationId}-${at}`,
        processEpoch: options.processEpoch,
        taskId: operation.taskId,
        attemptId: operation.attemptId,
        operationId: operation.operationId,
        operationCategory: operation.category,
        requestedAt: at,
        status: "requested",
        origin,
      });
      try {
        await operation.cancel(new Error("BrowserSkill operation stopped by local Companion"));
      } catch (error) {
        operation.stopping = false;
        throw error;
      }
      persistReceipt(options.dataDir, {
        receiptVersion: "1.0",
        receiptId: `local-stop-${options.processEpoch}-${operation.operationId}-${at}`,
        processEpoch: options.processEpoch,
        taskId: operation.taskId,
        attemptId: operation.attemptId,
        operationId: operation.operationId,
        operationCategory: operation.category,
        requestedAt: at,
        status: "canceled",
        origin,
      });
      active.delete(operation.operationId);
      return "stopped";
    },
  };
}

export interface HostBrokerCompanionServerRuntime {
  server: Server;
  listen(): Promise<void>;
  close(): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown, origin?: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader("x-content-type-options", "nosniff");
  if (origin) res.setHeader("access-control-allow-origin", origin);
  res.end(JSON.stringify(body));
}

function sendPreflight(res: ServerResponse): void {
  res.statusCode = 204;
  res.setHeader("cache-control", "no-store");
  res.setHeader("access-control-allow-origin", HOST_BROKER_COMPANION_ORIGIN);
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-qm-readiness-nonce, x-qm-request-id");
  res.setHeader("access-control-max-age", "0");
  res.end();
}

function validToken(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createHostBrokerCompanionServer(options: {
  control: HostBrokerLocalControl;
  host?: string;
  port?: number;
}): HostBrokerCompanionServerRuntime {
  const host = options.host ?? HOST_BROKER_COMPANION_HOST;
  const port = options.port ?? HOST_BROKER_COMPANION_PORT;
  if (host !== HOST_BROKER_COMPANION_HOST) throw new Error("Companion control must bind to IPv4 loopback");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("Companion control port is invalid");
  const readinessNonces = new Map<string, number>();
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
    const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
    const address = server.address();
    const expectedHost = address && typeof address === "object" ? `${HOST_BROKER_COMPANION_HOST}:${address.port}` : "";
    if (
      origin !== HOST_BROKER_COMPANION_ORIGIN ||
      req.headers.host !== expectedHost ||
      req.headers.authorization !== undefined ||
      req.headers.cookie !== undefined
    ) {
      sendJson(res, 403, { error: "forbidden" });
      return;
    }
    if (req.method === "OPTIONS") {
      const requestedMethod = req.headers["access-control-request-method"];
      const requestedHeaders = String(req.headers["access-control-request-headers"] ?? "")
        .toLowerCase()
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean);
      const allowedHeaders = new Set(["content-type", "x-qm-readiness-nonce", "x-qm-request-id"]);
      if (
        (requestedMethod !== "GET" && requestedMethod !== "POST") ||
        requestedHeaders.some((value) => !allowedHeaders.has(value))
      ) {
        sendJson(res, 403, { error: "forbidden" }, origin);
        return;
      }
      sendPreflight(res);
      return;
    }
    const requestId = typeof req.headers["x-qm-request-id"] === "string" ? req.headers["x-qm-request-id"] : undefined;
    if (!validToken(requestId)) {
      sendJson(res, 400, { error: "bad_request" }, origin);
      return;
    }
    if (req.method === "GET" && req.url === "/v1/status") {
      const readinessNonce =
        typeof req.headers["x-qm-readiness-nonce"] === "string" ? req.headers["x-qm-readiness-nonce"] : undefined;
      if (!validToken(readinessNonce)) {
        sendJson(res, 400, { error: "bad_request", requestId }, origin);
        return;
      }
      const at = Date.now();
      for (const [nonce, expiresAt] of readinessNonces) {
        if (expiresAt <= at) readinessNonces.delete(nonce);
      }
      if (readinessNonces.has(readinessNonce)) {
        sendJson(res, 409, { error: "replayed_nonce", requestId }, origin);
        return;
      }
      if (readinessNonces.size >= 10_000) {
        sendJson(res, 503, { error: "nonce_capacity", requestId }, origin);
        return;
      }
      readinessNonces.set(readinessNonce, at + 30_000);
      sendJson(res, 200, { requestId, ...options.control.status(origin) }, origin);
      return;
    }
    if (req.method === "POST" && req.url === "/v1/stop") {
      if (req.headers["content-type"] !== "application/json") {
        sendJson(res, 415, { error: "json_required", requestId }, origin);
        return;
      }
      try {
        const body = await readJsonBody(req, 4_096);
        const stopNonce =
          body && typeof body === "object" && !Array.isArray(body) && typeof (body as { stopNonce?: unknown }).stopNonce === "string"
            ? (body as { stopNonce: string }).stopNonce
            : undefined;
        if (!validToken(stopNonce)) {
          sendJson(res, 400, { error: "bad_request", requestId }, origin);
          return;
        }
        const result = await options.control.stop(origin, stopNonce);
        if (result === "task_changed") {
          sendJson(res, 409, { error: "task_changed", requestId }, origin);
          return;
        }
        sendJson(res, 202, { status: "stopped", requestId }, origin);
      } catch (error) {
        sendJson(res, error instanceof Error && error.message === "body_too_large" ? 413 : 400, { error: "bad_request", requestId }, origin);
      }
      return;
    }
    sendJson(res, 404, { error: "not_found", requestId }, origin);
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: "internal_error" });
      else res.destroy();
    });
  });
  server.headersTimeout = 5_000;
  server.requestTimeout = 5_000;
  server.keepAliveTimeout = 1_000;
  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

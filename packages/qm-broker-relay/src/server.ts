import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { attachDesktopBrowserRelayWebSocketServer, type DesktopBrowserRelayService } from "./index.ts";
import type { RelayInvocationMessage } from "qm-desktop-browser-contracts";

export interface DesktopBrowserRelayReadinessProbe {
  check(): Promise<void>;
}

export interface DesktopBrowserRelayServerOptions {
  host: string;
  port: number;
  path: string;
  service: DesktopBrowserRelayService;
  adapterReadiness: DesktopBrowserRelayReadinessProbe;
  storageReadiness?: DesktopBrowserRelayReadinessProbe;
  coreAuthSecret?: string;
  shutdownDrainMs: number;
}

export interface DesktopBrowserRelayReadyState {
  ok: boolean;
  config: { ok: boolean; message?: string };
  adapter: { ok: boolean; message?: string };
  storage: { ok: boolean; message?: string };
}

export interface DesktopBrowserRelayServerRuntime {
  readonly server: HttpServer;
  readonly wsServer: WebSocketServer;
  readonly options: DesktopBrowserRelayServerOptions;
  health(): { ok: true };
  ready(): Promise<DesktopBrowserRelayReadyState>;
  listen(): Promise<void>;
  shutdown(signal?: string): Promise<void>;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(body));
}

function validPath(path: string): boolean {
  return path.startsWith("/") && path.length > 1;
}

async function probe(readiness?: DesktopBrowserRelayReadinessProbe): Promise<{ ok: boolean; message?: string }> {
  if (!readiness) return { ok: true };
  try {
    await readiness.check();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

function rejectUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
  socket.destroy();
}

async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > maxBytes) throw new Error("request body exceeds limit");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function validCoreSignature(req: IncomingMessage, pathWithQuery: string, body: string, secret: string): boolean {
  const timestamp = String(req.headers["x-timestamp"] ?? "");
  const signature = String(req.headers["x-signature"] ?? "");
  if (!/^\d+$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(Date.now() - Number(timestamp) * 1000) > 5 * 60_000) return false;
  const canonical = `POST\n${pathWithQuery}\n${body}`;
  const expected = `v0=${createHmac("sha256", secret).update(`v0:${timestamp}:${canonical}`).digest("hex")}`;
  return timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

export function createDesktopBrowserRelayServer(
  options: DesktopBrowserRelayServerOptions,
): DesktopBrowserRelayServerRuntime {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw new Error("QM_RELAY_PORT must be an integer between 0 and 65535");
  }
  if (!validPath(options.path)) throw new Error("QM_RELAY_WSS_PATH must start with / and must not be /");
  if (!Number.isInteger(options.shutdownDrainMs) || options.shutdownDrainMs < 0) {
    throw new Error("QM_RELAY_SHUTDOWN_DRAIN_MS must be a non-negative integer");
  }

  const wsServer = new WebSocketServer({ noServer: true });
  const detach = attachDesktopBrowserRelayWebSocketServer(wsServer, options.service);
  let shuttingDown = false;
  let shutdownPromise: Promise<void> | null = null;
  let healthChecks = 0;
  let readinessChecks = 0;

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", "http://relay.local");
    const pathname = url.pathname;
    if (req.method === "GET" && pathname === "/healthz") {
      healthChecks += 1;
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && pathname === "/readyz") {
      readinessChecks += 1;
      const state = await runtime.ready();
      sendJson(res, state.ok ? 200 : 503, state);
      return;
    }
    if (req.method === "GET" && pathname === "/metrics") {
      sendJson(res, 200, { ...options.service.metrics(), healthChecks, readinessChecks });
      return;
    }
    if (req.method === "POST" && pathname === "/v1/invocations" && options.coreAuthSecret) {
      try {
        const body = await readBody(req, 128 * 1024);
        const nonce = url.searchParams.get("_sourceAuthNonce");
        if (!nonce || !validCoreSignature(req, pathname + url.search, body, options.coreAuthSecret)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const now = Date.now();
        if (!(await options.service.consumeCoreNonce(nonce, now + 5 * 60_000, now))) {
          sendJson(res, 409, { error: "replayed_request" });
          return;
        }
        const parsed: unknown = JSON.parse(body);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("invalid invocation request");
        const input = parsed as Record<string, unknown>;
        if (
          typeof input.publicDeviceFingerprint !== "string" ||
          typeof input.browserInstanceId !== "string" ||
          !input.invocation ||
          typeof input.invocation !== "object" ||
          Array.isArray(input.invocation)
        ) {
          throw new Error("invalid invocation request");
        }
        const result = await options.service.dispatchProjectedInvocation({
          publicDeviceFingerprint: input.publicDeviceFingerprint,
          browserInstanceId: input.browserInstanceId,
          invocation: input.invocation as RelayInvocationMessage,
        });
        sendJson(res, 200, result);
      } catch {
        sendJson(res, 409, { error: "dispatch_failed" });
      }
      return;
    }
    if (req.method === "POST" && pathname === "/v1/revocations" && options.coreAuthSecret) {
      try {
        const body = await readBody(req, 16 * 1024);
        const nonce = url.searchParams.get("_sourceAuthNonce");
        if (!nonce || !validCoreSignature(req, pathname + url.search, body, options.coreAuthSecret)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const now = Date.now();
        if (!(await options.service.consumeCoreNonce(nonce, now + 5 * 60_000, now))) {
          sendJson(res, 409, { error: "replayed_request" });
          return;
        }
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (
          typeof parsed.publicDeviceFingerprint !== "string" ||
          typeof parsed.browserInstanceId !== "string" ||
          typeof parsed.taskId !== "string" ||
          typeof parsed.attemptId !== "string" ||
          typeof parsed.leaseId !== "string" ||
          !Number.isSafeInteger(parsed.leaseVersion)
        ) {
          throw new Error("invalid revocation request");
        }
        await options.service.revokeProjectedLease({
          publicDeviceFingerprint: parsed.publicDeviceFingerprint,
          browserInstanceId: parsed.browserInstanceId,
          taskId: parsed.taskId,
          attemptId: parsed.attemptId,
          leaseId: parsed.leaseId,
          leaseVersion: parsed.leaseVersion as number,
        });
        res.statusCode = 204;
        res.end();
      } catch {
        sendJson(res, 409, { error: "revocation_failed" });
      }
      return;
    }
    if (req.method === "POST" && pathname === "/v1/attempt-status" && options.coreAuthSecret) {
      try {
        const body = await readBody(req, 4 * 1024);
        const nonce = url.searchParams.get("_sourceAuthNonce");
        if (!nonce || !validCoreSignature(req, pathname + url.search, body, options.coreAuthSecret)) {
          sendJson(res, 401, { error: "unauthorized" });
          return;
        }
        const now = Date.now();
        if (!(await options.service.consumeCoreNonce(nonce, now + 5 * 60_000, now))) {
          sendJson(res, 409, { error: "replayed_request" });
          return;
        }
        const parsed = JSON.parse(body) as { attemptId?: unknown };
        if (typeof parsed.attemptId !== "string" || !parsed.attemptId) throw new Error("invalid Attempt status request");
        const status = await options.service.projectedAttemptStatus(parsed.attemptId);
        sendJson(res, status ? 200 : 404, status ?? { error: "not_found" });
      } catch {
        sendJson(res, 409, { error: "status_failed" });
      }
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.on("upgrade", (req, socket, head) => {
    if (shuttingDown || options.service.isDraining()) {
      rejectUpgrade(socket);
      return;
    }
    const pathname = new URL(req.url ?? "/", "http://relay.local").pathname;
    if (pathname !== options.path) {
      rejectUpgrade(socket);
      return;
    }
    wsServer.handleUpgrade(req, socket, head, (webSocket) => {
      wsServer.emit("connection", webSocket, req);
    });
  });

  const runtime: DesktopBrowserRelayServerRuntime = {
    server,
    wsServer,
    options,

    health() {
      return { ok: true };
    },

    async ready() {
      const config = options.service.isDraining()
        ? { ok: false, message: "Relay is draining" }
        : { ok: true };
      const adapter = await probe(options.adapterReadiness);
      const storage = await probe(options.storageReadiness);
      return { ok: config.ok && adapter.ok && storage.ok, config, adapter, storage };
    },

    async listen() {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => {
          server.off("listening", onListening);
          reject(error);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(options.port, options.host);
      });
    },

    async shutdown() {
      if (shutdownPromise) return shutdownPromise;
      shuttingDown = true;
      options.service.beginDrain();
      shutdownPromise = (async () => {
        detach();
        server.closeIdleConnections();
        const forceTimer = setTimeout(() => {
          server.closeAllConnections();
        }, options.shutdownDrainMs);
        try {
          await options.service.drain(options.shutdownDrainMs);
          await new Promise<void>((resolve) => wsServer.close(() => resolve()));
          await new Promise<void>((resolve) => server.close(() => resolve()));
        } finally {
          clearTimeout(forceTimer);
        }
      })();
      return shutdownPromise;
    },
  };

  return runtime;
}

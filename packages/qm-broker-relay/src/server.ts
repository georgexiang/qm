import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { attachDesktopBrowserRelayWebSocketServer, type DesktopBrowserRelayService } from "./index.ts";

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
  shutdownDrainMs: number;
}

export interface DesktopBrowserRelayReadyState {
  ok: boolean;
  config: { ok: boolean };
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

  const server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const pathname = new URL(req.url ?? "/", "http://relay.local").pathname;
    if (req.method === "GET" && pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === "GET" && pathname === "/readyz") {
      const state = await runtime.ready();
      sendJson(res, state.ok ? 200 : 503, state);
      return;
    }
    res.statusCode = 404;
    res.end();
  });

  server.on("upgrade", (req, socket, head) => {
    if (shuttingDown) {
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
      const config = { ok: true };
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
      shutdownPromise = (async () => {
        detach();
        server.closeIdleConnections();
        const forceTimer = setTimeout(() => {
          server.closeAllConnections();
        }, options.shutdownDrainMs);
        try {
          await options.service.drain();
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

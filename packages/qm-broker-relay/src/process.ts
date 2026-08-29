import type {
  DesktopBrowserRelayBindingResolveRequest,
  DesktopBrowserRelayBindingResolveResponse,
  DesktopBrowserRelayConnectionPublishRequest,
  DesktopBrowserRelayRegistryBinding,
} from "qm-desktop-browser-contracts";
import { randomUUID } from "node:crypto";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
  DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  decodeDesktopBrowserMessage,
} from "qm-desktop-browser-contracts";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
} from "./index.ts";
import { createDesktopBrowserRelayServer, type DesktopBrowserRelayReadinessProbe } from "./server.ts";
import { signedRequestHeaders, withSourceAuthNonce } from "../../../plugins/chassis/src/core-client.ts";
import type { DesktopBrowserRelayOperationStore } from "./operation-store.ts";
import { createPostgresDesktopBrowserRelayOperationStore } from "./operation-postgres.ts";

const MIN_SOURCE_AUTH_SECRET_LENGTH = 32;

export interface DesktopBrowserRelayRuntimeConfig {
  host: string;
  port: number;
  wssPath: string;
  relayInstanceId: string;
  deploymentCanonicalId: string;
  coreApiUrl: string;
  sourceAuthSecret: string;
  coreAuthSecret: string;
  databaseUrl: string;
  databaseSchema: string;
  supportedProtocolVersions: string[];
  supportedPolicyGrammarVersions: string[];
  maxSettledDispatchHistory: number;
  settledDispatchHistoryTtlMs: number;
  callbackDeadLetterMs: number;
  shutdownDrainMs: number;
}

export interface DesktopBrowserRelayRuntime {
  readonly config: DesktopBrowserRelayRuntimeConfig;
  readonly service: DesktopBrowserRelayService;
  readonly registry: CoreHttpDesktopBrowserRelayRegistryAdapter;
  readonly server: ReturnType<typeof createDesktopBrowserRelayServer>;
  start(): Promise<void>;
  shutdown(signal?: string): Promise<void>;
}

function parseList(input: string | undefined, fallback: string[]): string[] {
  const values = (input ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  return values.length === 0 ? fallback : values;
}

function requireEnv(name: string, value: string | undefined): string {
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function parseInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function parsePositiveSafeInteger(name: string, value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

export function loadDesktopBrowserRelayConfig(env: NodeJS.ProcessEnv = process.env): DesktopBrowserRelayRuntimeConfig {
  const sourceAuthSecret = requireEnv("QM_RELAY_SOURCE_AUTH_SECRET", env.QM_RELAY_SOURCE_AUTH_SECRET);
  if (sourceAuthSecret.trim().length < MIN_SOURCE_AUTH_SECRET_LENGTH) {
    throw new Error(`QM_RELAY_SOURCE_AUTH_SECRET must be at least ${MIN_SOURCE_AUTH_SECRET_LENGTH} characters`);
  }
  const coreAuthSecret = requireEnv("QM_RELAY_CORE_AUTH_SECRET", env.QM_RELAY_CORE_AUTH_SECRET);
  if (coreAuthSecret.trim().length < MIN_SOURCE_AUTH_SECRET_LENGTH) {
    throw new Error(`QM_RELAY_CORE_AUTH_SECRET must be at least ${MIN_SOURCE_AUTH_SECRET_LENGTH} characters`);
  }
  const databaseUrl = requireEnv("QM_RELAY_DATABASE_URL", env.QM_RELAY_DATABASE_URL);
  const databaseSchema = env.QM_RELAY_DATABASE_SCHEMA ?? "qm_broker_relay";
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(databaseSchema)) {
    throw new Error("QM_RELAY_DATABASE_SCHEMA must be a lowercase PostgreSQL identifier");
  }
  return {
    host: env.QM_RELAY_HOST ?? "127.0.0.1",
    port: parseInteger("QM_RELAY_PORT", env.QM_RELAY_PORT, 8091),
    wssPath: env.QM_RELAY_WSS_PATH ?? DESKTOP_BROWSER_RELAY_WSS_PATH,
    relayInstanceId: requireEnv("QM_RELAY_INSTANCE_ID", env.QM_RELAY_INSTANCE_ID),
    deploymentCanonicalId: requireEnv("QM_RELAY_DEPLOYMENT_CANONICAL_ID", env.QM_RELAY_DEPLOYMENT_CANONICAL_ID),
    coreApiUrl: requireEnv("QM_RELAY_CORE_API_URL", env.QM_RELAY_CORE_API_URL).replace(/\/$/, ""),
    sourceAuthSecret,
    coreAuthSecret,
    databaseUrl,
    databaseSchema,
    supportedProtocolVersions: parseList(env.QM_RELAY_SUPPORTED_PROTOCOL_VERSIONS, [
      ...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
    ]),
    supportedPolicyGrammarVersions: parseList(env.QM_RELAY_SUPPORTED_POLICY_GRAMMAR_VERSIONS, [
      ...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
    ]),
    maxSettledDispatchHistory: parsePositiveSafeInteger(
      "QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY",
      env.QM_RELAY_MAX_SETTLED_DISPATCH_HISTORY,
      1_024,
    ),
    settledDispatchHistoryTtlMs: parsePositiveSafeInteger(
      "QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS",
      env.QM_RELAY_SETTLED_DISPATCH_HISTORY_TTL_MS,
      300_000,
    ),
    callbackDeadLetterMs: parsePositiveSafeInteger(
      "QM_RELAY_CALLBACK_DEAD_LETTER_MS",
      env.QM_RELAY_CALLBACK_DEAD_LETTER_MS,
      24 * 60 * 60_000,
    ),
    shutdownDrainMs: parseInteger("QM_RELAY_SHUTDOWN_DRAIN_MS", env.QM_RELAY_SHUTDOWN_DRAIN_MS, 10_000),
  };
}

function signedPath(pathWithQuery: string, secret: string): string {
  return withSourceAuthNonce(pathWithQuery, secret);
}

async function requireOk(response: Response): Promise<void> {
  if (response.ok) return;
  const body = await response.text();
  throw new Error(`core request failed with ${response.status}: ${body || response.statusText}`);
}

export async function deliverDesktopBrowserRelayCallbacks(
  store: DesktopBrowserRelayOperationStore,
  config: Pick<DesktopBrowserRelayRuntimeConfig, "coreApiUrl" | "sourceAuthSecret"> &
    Partial<Pick<DesktopBrowserRelayRuntimeConfig, "callbackDeadLetterMs">>,
  fetchImpl: typeof fetch = fetch,
  options: { now?: () => number; owner?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const owner = options.owner ?? randomUUID();
  const now = options.now ?? Date.now;
  for (const entry of await store.claimCallbacks(owner, 25, 30_000)) {
    try {
      const path = signedPath("/v1/desktop-browser/relay/callbacks/terminal", config.sourceAuthSecret);
      const body = JSON.stringify({ taskId: entry.taskId, accepted: entry.accepted, result: entry.result });
      const response = await fetchImpl(`${config.coreApiUrl}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(config.sourceAuthSecret, "POST", path, body, {
          "content-type": "application/json",
        }),
        body,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      });
      await requireOk(response);
      await store.markCallbackDelivered(entry.operationId, entry.callbackType, owner);
    } catch {
      const at = now();
      const deadLetter = at >= entry.createdAt + (config.callbackDeadLetterMs ?? 24 * 60 * 60_000);
      const retryDelay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(entry.attempts - 1, 8));
      await store.releaseCallback(entry.operationId, entry.callbackType, owner, at + retryDelay, deadLetter);
      if (deadLetter) {
        console.error(
          `[qm-broker-relay] terminal callback dead-lettered operationId=${entry.operationId} attempts=${entry.attempts}`,
        );
      }
    }
  }
}

export async function deliverDesktopBrowserLocalStopCallbacks(
  store: DesktopBrowserRelayOperationStore,
  config: Pick<DesktopBrowserRelayRuntimeConfig, "coreApiUrl" | "sourceAuthSecret">,
  fetchImpl: typeof fetch = fetch,
  options: { now?: () => number; owner?: string; signal?: AbortSignal } = {},
): Promise<void> {
  const owner = options.owner ?? randomUUID();
  const now = options.now ?? Date.now;
  for (const entry of await store.claimLocalStopCallbacks(owner, 25, 30_000)) {
    try {
      const path = signedPath("/v1/desktop-browser/relay/callbacks/local-stop", config.sourceAuthSecret);
      const body = JSON.stringify({ receipt: entry.message });
      const response = await fetchImpl(`${config.coreApiUrl}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(config.sourceAuthSecret, "POST", path, body, {
          "content-type": "application/json",
        }),
        body,
        signal: options.signal
          ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)])
          : AbortSignal.timeout(20_000),
      });
      await requireOk(response);
      await store.markLocalStopCallbackDelivered(entry.receiptId, owner, entry.message.payload.status);
    } catch {
      const at = now();
      const retryDelay = Math.min(5 * 60_000, 1_000 * 2 ** Math.min(entry.attempts - 1, 8));
      await store.releaseLocalStopCallback(entry.receiptId, owner, entry.message.payload.status, at + retryDelay, false);
    }
  }
}

export async function waitForDesktopBrowserRelayShutdown(work: Promise<unknown>, deadlineMs: number): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    work,
    new Promise<void>((resolve) => {
      deadline = setTimeout(resolve, deadlineMs);
      deadline.unref?.();
    }),
  ]);
  if (deadline) clearTimeout(deadline);
}

export class CoreHttpDesktopBrowserRelayRegistryAdapter
  implements DesktopBrowserRelayRegistryAdapter, DesktopBrowserRelayReadinessProbe
{
  private readonly config: {
    baseUrl: string;
    sourceAuthSecret: string;
  };

  constructor(config: { baseUrl: string; sourceAuthSecret: string }) {
    this.config = config;
  }

  async check(): Promise<void> {
    const path = signedPath("/v1/desktop-browser/relay/ready", this.config.sourceAuthSecret);
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "GET",
      headers: signedRequestHeaders(this.config.sourceAuthSecret, "GET", path),
    });
    await requireOk(response);
  }

  async resolveBinding(
    input: DesktopBrowserRelayBindingResolveRequest,
  ): Promise<DesktopBrowserRelayRegistryBinding | null> {
    const path = signedPath("/v1/desktop-browser/relay/bindings/resolve", this.config.sourceAuthSecret);
    const body = JSON.stringify(input);
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(this.config.sourceAuthSecret, "POST", path, body, {
        "content-type": "application/json",
      }),
      body,
    });
    if (response.status === 404) return null;
    await requireOk(response);
    const payload = (await response.json()) as DesktopBrowserRelayBindingResolveResponse;
    return payload.binding;
  }

  async publishConnection(projection: DesktopBrowserRelayProjection): Promise<void> {
    const path = signedPath(
      `/v1/desktop-browser/relay/connections/${encodeURIComponent(projection.connectionId)}`,
      this.config.sourceAuthSecret,
    );
    const body = JSON.stringify({ projection } satisfies DesktopBrowserRelayConnectionPublishRequest);
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "PUT",
      headers: signedRequestHeaders(this.config.sourceAuthSecret, "PUT", path, body, {
        "content-type": "application/json",
      }),
      body,
    });
    await requireOk(response);
  }

  async clearConnection(connectionId: string): Promise<void> {
    const path = signedPath(
      `/v1/desktop-browser/relay/connections/${encodeURIComponent(connectionId)}`,
      this.config.sourceAuthSecret,
    );
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "DELETE",
      headers: signedRequestHeaders(this.config.sourceAuthSecret, "DELETE", path),
    });
    await requireOk(response);
  }

  async reconcileDevice(input: {
    reconciliationId: string;
    devicePublicKey: string;
    browserInstanceId: string;
    confirmedAt: number;
  }): Promise<void> {
    const path = signedPath("/v1/desktop-browser/relay/device-reconciliations", this.config.sourceAuthSecret);
    const body = JSON.stringify(input);
    const response = await fetch(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(this.config.sourceAuthSecret, "POST", path, body, {
        "content-type": "application/json",
      }),
      body,
    });
    await requireOk(response);
  }
}

export class CoreHttpDesktopBrowserRelayArtifactGrantClient {
  private readonly config: { baseUrl: string; sourceAuthSecret: string };
  private readonly fetchImpl: typeof fetch;

  constructor(
    config: { baseUrl: string; sourceAuthSecret: string },
    fetchImpl: typeof fetch = fetch,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  async requestGrant(
    intent: import("qm-desktop-browser-contracts").DesktopBrowserArtifactIntent,
  ): Promise<import("qm-desktop-browser-contracts").RelayArtifactGrantMessage["payload"]> {
    const path = signedPath("/v1/desktop-browser/relay/artifact-grants", this.config.sourceAuthSecret);
    const body = JSON.stringify({ intent });
    const response = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: signedRequestHeaders(this.config.sourceAuthSecret, "POST", path, body, {
        "content-type": "application/json",
      }),
      body,
      signal: AbortSignal.timeout(20_000),
    });
    await requireOk(response);
    const payload = (await response.json()) as {
      grant?: unknown;
    };
    const decoded = decodeDesktopBrowserMessage(
      JSON.stringify({
        protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
        kind: "relay.artifact-grant",
        payload: payload.grant,
      }),
      DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      "1.0",
    );
    if (decoded.kind !== "relay.artifact-grant") throw new Error("Core artifact grant response is invalid");
    return decoded.payload;
  }
}

export function createDesktopBrowserRelayRuntime(
  config: DesktopBrowserRelayRuntimeConfig,
  deps: { operationStore?: DesktopBrowserRelayOperationStore } = {},
): DesktopBrowserRelayRuntime {
  const registry = new CoreHttpDesktopBrowserRelayRegistryAdapter({
    baseUrl: config.coreApiUrl,
    sourceAuthSecret: config.sourceAuthSecret,
  });
  const artifactGrantClient = new CoreHttpDesktopBrowserRelayArtifactGrantClient({
    baseUrl: config.coreApiUrl,
    sourceAuthSecret: config.sourceAuthSecret,
  });
  const operationStore =
    deps.operationStore ??
    createPostgresDesktopBrowserRelayOperationStore({
      connectionString: config.databaseUrl,
      schema: config.databaseSchema,
    });
  const operationCheck =
    typeof (operationStore as { check?: unknown }).check === "function"
      ? () => (operationStore as unknown as { check(): Promise<void> }).check()
      : async () => undefined;
  const operationClose =
    typeof (operationStore as { close?: unknown }).close === "function"
      ? () => (operationStore as unknown as { close(): Promise<void> }).close()
      : async () => undefined;
  const service = new DesktopBrowserRelayService({
    relayInstanceId: config.relayInstanceId,
    deploymentCanonicalId: config.deploymentCanonicalId,
    supportedProtocolVersions: config.supportedProtocolVersions,
    supportedPolicyGrammarVersions: config.supportedPolicyGrammarVersions,
    maxSettledDispatchHistory: config.maxSettledDispatchHistory,
    settledDispatchHistoryTtlMs: config.settledDispatchHistoryTtlMs,
    registry,
    operationStore,
    artifactGrantClient,
  });
  const server = createDesktopBrowserRelayServer({
    host: config.host,
    port: config.port,
    path: config.wssPath,
    service,
    adapterReadiness: registry,
    storageReadiness: { check: operationCheck },
    coreAuthSecret: config.coreAuthSecret,
    shutdownDrainMs: config.shutdownDrainMs,
  });
  let callbackTimer: ReturnType<typeof setInterval> | null = null;
  let callbackDelivery = Promise.resolve();
  const callbackAbort = new AbortController();
  const deliverCallbacks = () => {
    callbackDelivery = callbackDelivery
      .then(async () => {
        await deliverDesktopBrowserRelayCallbacks(operationStore, config, fetch, { signal: callbackAbort.signal });
        await deliverDesktopBrowserLocalStopCallbacks(operationStore, config, fetch, { signal: callbackAbort.signal });
      })
      .catch(() => undefined);
  };

  return {
    config,
    service,
    registry,
    server,

    async start() {
      await server.listen();
      deliverCallbacks();
      callbackTimer = setInterval(deliverCallbacks, 1_000);
    },

    async shutdown() {
      if (callbackTimer) clearInterval(callbackTimer);
      callbackTimer = null;
      callbackAbort.abort();
      const work = Promise.allSettled([server.shutdown(), callbackDelivery, operationClose()]);
      await waitForDesktopBrowserRelayShutdown(work, config.shutdownDrainMs);
    },
  };
}

export async function runDesktopBrowserRelayProcess(
  env: NodeJS.ProcessEnv = process.env,
): Promise<DesktopBrowserRelayRuntime> {
  const config = loadDesktopBrowserRelayConfig(env);
  const runtime = createDesktopBrowserRelayRuntime(config);
  await runtime.start();

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    await runtime.shutdown(signal);
  };
  const onSigint = () => void shutdown("SIGINT");
  const onSigterm = () => void shutdown("SIGTERM");
  process.once("SIGINT", onSigint);
  process.once("SIGTERM", onSigterm);

  return runtime;
}

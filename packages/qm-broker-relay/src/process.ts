import type {
  DesktopBrowserRelayBindingResolveRequest,
  DesktopBrowserRelayBindingResolveResponse,
  DesktopBrowserRelayConnectionPublishRequest,
  DesktopBrowserRelayRegistryBinding,
} from "qm-desktop-browser-contracts";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_RELAY_WSS_PATH,
} from "qm-desktop-browser-contracts";
import {
  DesktopBrowserRelayService,
  type DesktopBrowserRelayProjection,
  type DesktopBrowserRelayRegistryAdapter,
} from "./index.ts";
import { createDesktopBrowserRelayServer, type DesktopBrowserRelayReadinessProbe } from "./server.ts";
import { signedRequestHeaders, withSourceAuthNonce } from "../../../plugins/chassis/src/core-client.ts";

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
  supportedProtocolVersions: string[];
  supportedPolicyGrammarVersions: string[];
  maxSettledDispatchHistory: number;
  settledDispatchHistoryTtlMs: number;
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
  return {
    host: env.QM_RELAY_HOST ?? "127.0.0.1",
    port: parseInteger("QM_RELAY_PORT", env.QM_RELAY_PORT, 8091),
    wssPath: env.QM_RELAY_WSS_PATH ?? DESKTOP_BROWSER_RELAY_WSS_PATH,
    relayInstanceId: requireEnv("QM_RELAY_INSTANCE_ID", env.QM_RELAY_INSTANCE_ID),
    deploymentCanonicalId: requireEnv("QM_RELAY_DEPLOYMENT_CANONICAL_ID", env.QM_RELAY_DEPLOYMENT_CANONICAL_ID),
    coreApiUrl: requireEnv("QM_RELAY_CORE_API_URL", env.QM_RELAY_CORE_API_URL).replace(/\/$/, ""),
    sourceAuthSecret,
    coreAuthSecret,
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
}

class NoopReadinessProbe implements DesktopBrowserRelayReadinessProbe {
  async check(): Promise<void> {}
}

export function createDesktopBrowserRelayRuntime(config: DesktopBrowserRelayRuntimeConfig): DesktopBrowserRelayRuntime {
  const registry = new CoreHttpDesktopBrowserRelayRegistryAdapter({
    baseUrl: config.coreApiUrl,
    sourceAuthSecret: config.sourceAuthSecret,
  });
  const service = new DesktopBrowserRelayService({
    relayInstanceId: config.relayInstanceId,
    deploymentCanonicalId: config.deploymentCanonicalId,
    supportedProtocolVersions: config.supportedProtocolVersions,
    supportedPolicyGrammarVersions: config.supportedPolicyGrammarVersions,
    maxSettledDispatchHistory: config.maxSettledDispatchHistory,
    settledDispatchHistoryTtlMs: config.settledDispatchHistoryTtlMs,
    registry,
  });
  const server = createDesktopBrowserRelayServer({
    host: config.host,
    port: config.port,
    path: config.wssPath,
    service,
    adapterReadiness: registry,
    storageReadiness: new NoopReadinessProbe(),
    coreAuthSecret: config.coreAuthSecret,
    shutdownDrainMs: config.shutdownDrainMs,
  });

  return {
    config,
    service,
    registry,
    server,

    async start() {
      await server.listen();
    },

    async shutdown() {
      await server.shutdown();
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

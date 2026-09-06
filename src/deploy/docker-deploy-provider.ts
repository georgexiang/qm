import type { Deployment, DeploymentVersion } from "./deploy-store.ts";
import type { DeployEndpoint, DeployProvider } from "./deploy-provider.ts";
import { spawnDockerExec, type DockerExec } from "../sandbox/docker-exec.ts";
import { errMessage } from "../util/errors.ts";
import { cp, lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { sleep } from "../util/async.ts";

const APP_PORT = 8080;
const LEGACY_NETWORK = "agent-deploynet";
const DAEMON_PROBE_TIMEOUT_MS = 10_000;

export interface DockerDeployProviderOptions {
  image?: string;
  docker?: string;
  dockerExec?: DockerExec;
  coreContainer?: string;
  snapshotRoot?: string;
  fetch?: typeof fetch;
  readinessTimeoutMs?: number;
}

export class DockerDeploymentUnavailable extends Error {}
export class DockerDeploymentInvalidSnapshot extends Error {}

interface ContainerState {
  State: { Running: boolean; ExitCode: number; Status: string };
  NetworkSettings: {
    Networks: Record<string, unknown>;
    Ports: Record<string, Array<{ HostIp: string; HostPort: string }> | null>;
  };
}

async function stageSnapshot(source: string, root?: string): Promise<string> {
  const staging = await mkdtemp(join(tmpdir(), "qm-deploy-artifact-"));
  try {
    if (!isAbsolute(source) || !(await lstat(source)).isDirectory()) throw new Error();
    if (root) {
      const path = relative(await realpath(root), await realpath(source));
      if (!path || path === ".." || path.startsWith("../") || isAbsolute(path)) throw new Error();
    }
    const validEntry = async (path: string): Promise<boolean> => {
      const stat = await lstat(path);
      if (!stat.isDirectory() && !(stat.isFile() && stat.nlink === 1)) throw new Error();
      return true;
    };
    await cp(source, join(staging, "app"), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      filter: validEntry,
    });
    let files = 0;
    const validate = async (path: string): Promise<void> => {
      await validEntry(path);
      if ((await lstat(path)).isDirectory()) {
        for (const entry of await readdir(path)) await validate(join(path, entry));
      } else files++;
    };
    await validate(join(staging, "app"));
    if (!files) throw new Error();
    return staging;
  } catch {
    await rm(staging, { recursive: true, force: true });
    throw new DockerDeploymentInvalidSnapshot("invalid deployment snapshot: expected regular files without links");
  }
}

export interface DockerDaemonProbeOptions {
  docker?: string;
  dockerExec?: DockerExec;
}

export async function dockerDaemonFailure(opts: DockerDaemonProbeOptions = {}): Promise<string | null> {
  const dexec = opts.dockerExec ?? spawnDockerExec(opts.docker ?? "docker");
  try {
    const r = await dexec(["version", "-f", "{{.Server.Version}}"], DAEMON_PROBE_TIMEOUT_MS);
    if (r.code === 0) return null;
    const stderr = r.stderr.trim();
    if (stderr) return stderr;
    return r.code < 0 ? `no response within ${DAEMON_PROBE_TIMEOUT_MS / 1000}s` : `exit ${r.code}`;
  } catch (e) {
    return errMessage(e);
  }
}

export function createDockerDeployProvider(opts: DockerDeployProviderOptions = {}): DeployProvider {
  const docker = opts.docker ?? "docker";
  const image = opts.image ?? "node:24-alpine";
  const dexec = opts.dockerExec ?? spawnDockerExec(docker);
  const fetchApp = opts.fetch ?? fetch;
  const readinessTimeoutMs = opts.readinessTimeoutMs ?? 30_000;
  if (!Number.isFinite(readinessTimeoutMs) || readinessTimeoutMs <= 0) throw new Error("invalid readiness timeout");
  if (opts.coreContainer !== undefined && !opts.coreContainer.trim()) throw new Error("invalid Core container");

  const name = (d: Deployment) => `agent-deploy-${d.id.slice(0, 12)}`;
  const network = (d: Deployment) => `${name(d)}-net`;
  const artifact = (d: Deployment) => `${name(d)}-artifact`;
  const helper = (d: Deployment) => `${name(d)}-copy`;
  const missing = (message: string) =>
    /no such (?:object|container|network|volume)|network \S+ not found/i.test(message);
  const command = async (args: string[], accepted?: RegExp): Promise<void> => {
    const result = await dexec(args);
    if (result.code !== 0 && !accepted?.test(result.stderr)) {
      throw new Error(`docker ${args[0]} ${args[1]} failed`);
    }
  };
  const ensureNetwork = async (net: string): Promise<boolean> => {
    const inspected = await dexec(["network", "inspect", net]);
    if (inspected.code !== 0) {
      if (!missing(inspected.stderr)) throw new Error("docker network inspect failed");
      await command(["network", "create", net], /already exists/i);
      return true;
    }
    return false;
  };
  const inspect = async (container: string, timeoutMs?: number): Promise<ContainerState | null> => {
    const inspected = await dexec(
      ["inspect", "--format", '{"State":{{json .State}},"NetworkSettings":{{json .NetworkSettings}}}', container],
      timeoutMs,
    );
    if (inspected.code !== 0) {
      if (missing(inspected.stderr)) return null;
      throw new Error("docker inspect failed: daemon unavailable or access denied");
    }
    try {
      const state = JSON.parse(inspected.stdout) as ContainerState;
      if (typeof state.State.Running !== "boolean" || !state.NetworkSettings.Networks) throw new Error();
      return state;
    } catch {
      throw new Error("docker inspect returned invalid container state");
    }
  };
  const requireRunning = (state: ContainerState | null): ContainerState => {
    if (!state) throw new Error("deployment container disappeared");
    if (state.State.Status === "exited" || state.State.Status === "dead") {
      throw new DockerDeploymentUnavailable(
        `deployment not running (exit ${state.State.ExitCode}); republish required`,
      );
    }
    if (!state.State.Running || state.State.Status === "paused") throw new Error("deployment temporarily not running");
    return state;
  };
  const connectCore = async (net: string): Promise<void> => {
    if (opts.coreContainer) await command(["network", "connect", net, opts.coreContainer], /already exists/i);
  };
  const migrateContainer = async (container: string, state: ContainerState): Promise<void> => {
    const attached = state.NetworkSettings.Networks;
    const target = `${container}-net`;
    if (Object.keys(attached).some((net) => net !== target && net !== LEGACY_NETWORK)) {
      throw new Error("deployment has unexpected networks; republish required");
    }
    await ensureNetwork(target);
    if (!(target in attached)) {
      await command(["network", "connect", target, container], /already exists/i);
    }
    if (LEGACY_NETWORK in attached) {
      await command(["network", "disconnect", LEGACY_NETWORK, container]);
    }
    await connectCore(target);
  };
  const endpointOf = (container: string, state: ContainerState): DeployEndpoint => {
    if (opts.coreContainer) return { host: container, port: APP_PORT };
    const binding = state.NetworkSettings.Ports[`${APP_PORT}/tcp`]?.find((port) => port.HostIp === "127.0.0.1");
    const port = Number(binding?.HostPort);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error("deployment has no loopback port; republish required");
    }
    return { host: "127.0.0.1", port };
  };
  const waitReady = async (container: string, endpoint: DeployEndpoint): Promise<void> => {
    const deadline = Date.now() + readinessTimeoutMs;
    while (Date.now() < deadline) {
      requireRunning(await inspect(container, Math.max(1, deadline - Date.now())));
      if (Date.now() >= deadline) break;
      let ready: boolean;
      try {
        const response = await fetchApp(`http://${endpoint.host}:${endpoint.port}/`, {
          redirect: "manual",
          signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))),
        });
        ready = true;
        await response.body?.cancel();
      } catch {
        ready = false;
      }
      if (ready && Date.now() < deadline) {
        requireRunning(await inspect(container, Math.max(1, deadline - Date.now())));
        if (Date.now() < deadline) return;
      }
      await sleep(Math.max(0, Math.min(200, deadline - Date.now())));
    }
    throw new DockerDeploymentUnavailable("deployment HTTP readiness timed out; republish required");
  };
  const removeApp = async (d: Deployment): Promise<void> => {
    await command(["rm", "-f", name(d)], /no such (?:object|container)/i);
    await command(["rm", "-f", helper(d)], /no such (?:object|container)/i);
    await command(["volume", "rm", artifact(d)], /no such volume/i);
  };
  const destroy = async (d: Deployment): Promise<void> => {
    await removeApp(d);
    if (opts.coreContainer) {
      await command(
        ["network", "disconnect", network(d), opts.coreContainer],
        /no such (?:network|container)|not connected|not found/i,
      );
    }
    await command(["network", "rm", network(d)], /no such network|network \S+ not found|has active endpoints/i);
  };

  return {
    profile: { managedScaleToZero: false },
    serializeEndpointResolution: true,

    async apply(d: Deployment, version: DeploymentVersion): Promise<DeployEndpoint> {
      const staging = await stageSnapshot(version.snapshotDir, opts.snapshotRoot);
      const net = network(d);
      let createdNetwork = false;
      let createdVolume = false;
      let createdHelper = false;
      let createdApp = false;
      let connectedCore = false;
      let stage = "previous runtime cleanup";
      try {
        await removeApp(d);
        stage = "network setup";
        createdNetwork = await ensureNetwork(net);
        stage = "artifact volume creation";
        await command(["volume", "create", artifact(d)]);
        createdVolume = true;
        const mount = `type=volume,source=${artifact(d)},target=/app,volume-nocopy`;
        stage = "artifact helper creation";
        await command(["create", "--name", helper(d), "--network", "none", "--mount", mount, image, "true"]);
        createdHelper = true;
        stage = "artifact copy";
        await command(["cp", `${join(staging, "app")}/.`, `${helper(d)}:/app`]);
        await command(["rm", "-f", helper(d)]);
        createdHelper = false;
        const envArgs = Object.entries(version.env ?? {}).flatMap(([key, value]) => ["-e", `${key}=${value}`]);
        stage = "app container creation";
        await command([
          "create",
          "--name",
          name(d),
          "--network",
          net,
          "--memory",
          "512m",
          "--cpus",
          "1",
          "--pids-limit",
          "256",
          "--cap-drop",
          "ALL",
          "--security-opt",
          "no-new-privileges",
          "--mount",
          `${mount},readonly`,
          ...(opts.coreContainer ? [] : ["-p", `127.0.0.1:0:${APP_PORT}`]),
          "-w",
          "/app",
          ...envArgs,
          "-e",
          `PORT=${APP_PORT}`,
          image,
          "sh",
          "-c",
          version.entrypoint,
        ]);
        createdApp = true;
        stage = "Core network connection";
        await connectCore(net);
        connectedCore = !!opts.coreContainer;
        stage = "app startup";
        await command(["start", name(d)]);
        const state = requireRunning(await inspect(name(d)));
        const endpoint = endpointOf(name(d), state);
        await waitReady(name(d), endpoint);
        return endpoint;
      } catch (error) {
        const failedState = createdApp ? await inspect(name(d)).catch(() => null) : null;
        const retainApp = failedState?.State.Status === "exited" || failedState?.State.Status === "dead";
        if (createdHelper) await command(["rm", "-f", helper(d)]).catch(() => undefined);
        if (!retainApp) {
          if (createdApp) await command(["rm", "-f", name(d)]).catch(() => undefined);
          if (createdVolume) await command(["volume", "rm", artifact(d)]).catch(() => undefined);
          if (createdNetwork) {
            if (connectedCore)
              await command(["network", "disconnect", net, opts.coreContainer!]).catch(() => undefined);
            await command(["network", "rm", net]).catch(() => undefined);
          }
        }
        if (!(error instanceof DockerDeploymentUnavailable)) {
          throw new DockerDeploymentUnavailable(`deployment creation failed during ${stage}; republish required`);
        }
        throw error;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    },

    async logs(d: Deployment, opts: { tailLines: number }): Promise<string | null> {
      const lines = Math.max(1, Math.min(2000, Math.floor(opts.tailLines)));
      const r = await dexec(["logs", "--tail", String(lines), name(d)]);
      if (r.code !== 0) return null;
      return `${r.stdout}${r.stderr}`;
    },

    destroy,

    async resolveEndpoint(d): Promise<DeployEndpoint | null> {
      const state = await inspect(name(d));
      if (!state) return null;
      requireRunning(state);
      await migrateContainer(name(d), state);
      const endpoint = endpointOf(name(d), state);
      return endpoint;
    },
  };
}

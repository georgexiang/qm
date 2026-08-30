import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { join } from "node:path";
import type { BrowserRuntimeMetadata } from "./index.ts";

interface RuntimeProbeOptions {
  installRoot: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}

async function daemonResult(socketPath: string, method: string, timeoutMs: number): Promise<unknown> {
  return await new Promise((resolve, reject) => {
    const id = `qm-runtime-${randomUUID()}`;
    const socket = createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (error: Error | null, value?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.end();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      socket.destroy();
      finish(new Error(`BrowserSkill daemon ${method} timed out`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify({ id, method, params: {} })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      try {
        const frame = JSON.parse(buffer.slice(0, newline)) as { id?: unknown; result?: unknown; error?: { message?: unknown } };
        if (frame.id !== id) return finish(new Error("BrowserSkill daemon returned a mismatched response"));
        if (frame.error) return finish(new Error(String(frame.error.message ?? "BrowserSkill daemon request failed")));
        finish(null, frame.result);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.once("error", (error) => finish(error));
  });
}

async function socketPath(home: string): Promise<string | null> {
  try {
    const info = JSON.parse(await readFile(join(home, "daemon.json"), "utf8")) as { sock_path?: unknown };
    return typeof info.sock_path === "string" && info.sock_path ? info.sock_path : null;
  } catch {
    return null;
  }
}

export async function probeInstalledBrowserRuntime(options: RuntimeProbeOptions): Promise<BrowserRuntimeMetadata> {
  const env = options.env ?? process.env;
  const bundle = JSON.parse(await readFile(join(options.installRoot, "phase-f-manifest.json"), "utf8")) as {
    browserSkill?: { sourceCommit?: unknown; cliSha256?: unknown };
  };
  const extension = JSON.parse(
    await readFile(join(options.installRoot, "browser-skill-extension", "manifest.json"), "utf8"),
  ) as { version?: unknown };
  const bskVersion = bundle.browserSkill?.sourceCommit;
  const cliSha256 = bundle.browserSkill?.cliSha256;
  if (typeof bskVersion !== "string" || typeof cliSha256 !== "string" || typeof extension.version !== "string") {
    throw new Error("installed BrowserSkill provenance is incomplete");
  }
  const homes = [...new Set([env.BSK_HOME, env.HOME ? join(env.HOME, ".bsk") : undefined].filter(Boolean) as string[])];
  for (const home of homes) {
    const daemonSocket = await socketPath(home);
    if (!daemonSocket) continue;
    const raw = await daemonResult(daemonSocket, "browser.list", options.timeoutMs ?? 5_000);
    const record = raw && typeof raw === "object" && !Array.isArray(raw) ? (raw as { browsers?: unknown }) : null;
    let browsers: unknown[] = [];
    if (Array.isArray(record?.browsers)) browsers = record.browsers;
    else if (Array.isArray(raw)) browsers = raw;
    const instanceIds = browsers
      .map((browser) => (browser && typeof browser === "object" ? (browser as { instance_id?: unknown }).instance_id : null))
      .filter((value): value is string => typeof value === "string" && value.length > 0);
    if (instanceIds.length > 1) {
      throw new Error("multiple BrowserSkill browser instances are connected; keep exactly one test browser open");
    }
    if (instanceIds.length === 1) {
      return {
        browserInstanceId: instanceIds[0]!,
        browserSkillStatus: "ready",
        bskVersion,
        extensionVersion: extension.version,
        cliShapeHash: `sha256:${cliSha256}`,
      };
    }
  }
  return {
    browserInstanceId: "unbound",
    browserSkillStatus: "offline",
    bskVersion,
    extensionVersion: extension.version,
    cliShapeHash: `sha256:${cliSha256}`,
  };
}
import { createBackgroundBroker } from "../connectors/background-exec-broker.ts";
import { captureDeviceFlowLogins, DEVICE_FLOW_ORIGIN } from "../credentials/device-flow-persist.ts";
import type { Keychain } from "../credentials/keychain.ts";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { ProcessRegistry } from "../processes/process-registry.ts";
import { supportsProcessSessions, type Sandbox } from "../sandbox/sandbox.ts";
import type { ScopeId } from "../types.ts";
import { shq } from "../util/shell.ts";

export type AzureDeviceCodeFlowStatus = "starting" | "pending" | "ready" | "completed" | "failed" | "expired";

export interface AzureDeviceCodeFlow {
  flowId: string;
  principalId: string;
  intendedScopeId: ScopeId;
  status: AzureDeviceCodeFlowStatus;
  processRef?: string;
  sessionRef?: string;
  createdAt: number;
  expiresAt: number;
  connectionId?: string;
  capturedCredentialId?: string;
}

export interface AzureDeviceCodeStartResult {
  processRef: string;
  sessionRef: string;
  verificationUri: string;
  userCode: string;
}

export interface AzureDeviceCodeDriver {
  start(input: {
    flowId: string;
    principalId: string;
    scopeId: ScopeId;
    expiresAt: number;
  }): Promise<AzureDeviceCodeStartResult>;
  poll(flow: AzureDeviceCodeFlow): Promise<"pending" | "ready" | "failed">;
  capture(flow: AzureDeviceCodeFlow): Promise<string>;
}

export interface AzureDeviceCodeFlowDeps {
  backing: DurableMap<AzureDeviceCodeFlow>;
  driver?: AzureDeviceCodeDriver;
  ttlMs?: number;
  now?: () => number;
}

const DEVICE_CODE_URI = "https://microsoft.com/devicelogin";

function driverScript(displayPath: string): string {
  const script = [
    'const { spawn } = require("node:child_process")',
    'const { writeFileSync } = require("node:fs")',
    'const child = spawn("az", ["login", "--use-device-code", "--output", "none"], { stdio: ["ignore", "pipe", "pipe"] })',
    'let text = ""',
    "let written = false",
    "const consume = chunk => {",
    "  if (written) return",
    '  text = (text + chunk.toString("utf8")).slice(-16384)',
    "  const uri = text.match(/https:\\/\\/[^\\s]+devicelogin/i)?.[0]",
    "  const code = text.match(/(?:code|enter)\\s+([A-Z0-9-]{6,})/i)?.[1]",
    '  if (code) { writeFileSync(process.argv[1], JSON.stringify({ verificationUri: uri || "https://microsoft.com/devicelogin", userCode: code }), { mode: 0o600 }); written = true }',
    "}",
    'child.stdout.on("data", consume)',
    'child.stderr.on("data", consume)',
    'child.on("error", () => process.exit(127))',
    'child.on("exit", code => process.exit(code ?? 1))',
  ].join("; ");
  return `node -e ${shq(script)} ${shq(displayPath)}`;
}

export function createSandboxAzureDeviceCodeDriver(deps: {
  sandbox: Sandbox;
  processes: ProcessRegistry;
  keychain: Keychain;
}): AzureDeviceCodeDriver | undefined {
  if (!supportsProcessSessions(deps.sandbox)) return undefined;
  const sandbox = deps.sandbox;
  return {
    async start(input) {
      const handle = await sandbox.provision([{ scopeId: input.scopeId, mode: "rw", mountPath: "" }]);
      const displayPath = `/tmp/qm-azure-device-code-${input.flowId}.json`;
      await sandbox.run(handle, `rm -f ${shq(displayPath)}`, { timeoutMs: 30_000 });
      const broker = createBackgroundBroker({
        sandbox,
        registry: deps.processes,
        scopeId: input.scopeId,
        ttlMs: Math.max(1, input.expiresAt - Date.now()),
        pollMs: 100,
      });
      const started = await broker.start(handle, driverScript(displayPath), Math.max(1, input.expiresAt - Date.now()));
      const display = await sandbox.run(
        handle,
        `i=0; while [ "$i" -lt 75 ]; do if [ -s ${shq(displayPath)} ]; then cat ${shq(displayPath)}; exit; fi; i=$((i + 1)); sleep 0.2; done; exit 1`,
        { timeoutMs: 30_000 },
      );
      await sandbox.run(handle, `rm -f ${shq(displayPath)}`, { timeoutMs: 30_000 }).catch(() => undefined);
      if (display.code !== 0) {
        await broker.stop(handle, started.processId).catch(() => undefined);
        throw new Error("Azure Device Code was not produced");
      }
      const parsed = JSON.parse(display.stdout) as { verificationUri?: unknown; userCode?: unknown };
      if (typeof parsed.userCode !== "string" || !parsed.userCode) {
        await broker.stop(handle, started.processId).catch(() => undefined);
        throw new Error("Azure Device Code was invalid");
      }
      return {
        processRef: started.processId,
        sessionRef: handle.id,
        verificationUri: typeof parsed.verificationUri === "string" ? parsed.verificationUri : DEVICE_CODE_URI,
        userCode: parsed.userCode,
      };
    },
    async poll(flow) {
      if (!flow.processRef) return "failed";
      const handle = await sandbox.provision([{ scopeId: flow.intendedScopeId, mode: "rw", mountPath: "" }]);
      const broker = createBackgroundBroker({
        sandbox,
        registry: deps.processes,
        scopeId: flow.intendedScopeId,
      });
      const result = await broker.poll(handle, flow.processRef, { maxBytes: 1, waitMs: 0 });
      if (result.status.state === "running") return "pending";
      return result.status.code === 0 ? "ready" : "failed";
    },
    async capture(flow) {
      const handle = await sandbox.provision([{ scopeId: flow.intendedScopeId, mode: "rw", mountPath: "" }]);
      const existingIds = new Set(
        (await deps.keychain.listByOwner(flow.principalId))
          .filter((candidate) => candidate.service === "azure")
          .map((candidate) => candidate.id),
      );
      const captured = await captureDeviceFlowLogins({
        sandbox,
        handle,
        keychain: deps.keychain,
        ownerId: flow.principalId,
        services: ["azure"],
        credentialSlotByService: { azure: `device-code:${flow.flowId}` },
      });
      if (!captured.includes("azure")) throw new Error("Azure credentials were not captured");
      const credential = (await deps.keychain.listByOwner(flow.principalId)).find(
        (candidate) =>
          candidate.service === "azure" && candidate.origin === DEVICE_FLOW_ORIGIN && !existingIds.has(candidate.id),
      );
      if (!credential) throw new Error("Azure credentials were not captured");
      return credential.id;
    },
  };
}

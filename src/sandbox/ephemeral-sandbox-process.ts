import { fromJSONSchema } from "zod";
import {
  CapabilityUnsupportedError,
  type ReadProcessOptions,
  type ReadProcessResult,
  type Sandbox,
  type SandboxHandle,
} from "./sandbox.ts";

export interface EphemeralSandboxProcessRegistration {
  executableId: string;
  protocolMajor: number;
  launchSchema: Record<string, unknown>;
}

export interface EphemeralSandboxProcessRequest {
  handle: SandboxHandle;
  executableId: string;
  protocolMajor: number;
  launch: Record<string, unknown>;
}

export interface EphemeralSandboxProcess {
  processId: string;
}

export interface EphemeralSandboxProcessProvider {
  start(request: EphemeralSandboxProcessRequest): Promise<EphemeralSandboxProcess>;
  observe(process: EphemeralSandboxProcess, options?: ReadProcessOptions): Promise<ReadProcessResult>;
  stop(process: EphemeralSandboxProcess): Promise<void>;
}

interface SandboxProcessState {
  handle: SandboxHandle;
  processId: string;
  stopped: boolean;
}

const hasProcessSessionMethods = (
  sandbox: Sandbox,
): sandbox is Sandbox & Required<Pick<Sandbox, "startProcess" | "readProcess" | "writeStdin" | "signalProcess">> =>
  typeof sandbox.startProcess === "function" &&
  typeof sandbox.readProcess === "function" &&
  typeof sandbox.writeStdin === "function" &&
  typeof sandbox.signalProcess === "function";

export function createSandboxEphemeralProcessProvider(
  sandbox: Sandbox,
  registrations: readonly EphemeralSandboxProcessRegistration[],
): EphemeralSandboxProcessProvider {
  const states = new WeakMap<EphemeralSandboxProcess, SandboxProcessState>();
  const stateOf = (process: EphemeralSandboxProcess): SandboxProcessState => {
    const state = states.get(process);
    if (!state) throw new Error("ephemeral process does not belong to this provider");
    return state;
  };
  const exited = async (state: SandboxProcessState, waitMs: number): Promise<boolean> =>
    (
      await sandbox.readProcess!(state.handle, state.processId, {
        sinceCursor: Number.MAX_SAFE_INTEGER,
        maxBytes: 1,
        waitMs,
      })
    ).status.state === "exited";
  const stopState = async (state: SandboxProcessState): Promise<void> => {
    if (state.stopped) return;
    const errors: unknown[] = [];
    await sandbox.signalProcess!(state.handle, state.processId, "TERM").catch((error) => errors.push(error));
    let didExit = await exited(state, 5_000).catch((error) => {
      errors.push(error);
      return false;
    });
    if (!didExit) {
      await sandbox.signalProcess!(state.handle, state.processId, "KILL").catch((error) => errors.push(error));
      didExit = await exited(state, 1_000).catch((error) => {
        errors.push(error);
        return false;
      });
    }
    if (didExit) {
      state.stopped = true;
      return;
    }
    if (errors.length === 0) throw new Error(`ephemeral process ${state.processId} remained running after KILL`);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, `failed to stop ephemeral process ${state.processId}`);
  };
  return {
    async start(request) {
      if (!request.handle.scopeId) throw new Error("ephemeral processes require a scoped Sandbox handle");
      if (!hasProcessSessionMethods(sandbox)) {
        throw new CapabilityUnsupportedError(sandbox.profile.backend, "ephemeral processes");
      }
      const matches = registrations.filter((entry) => entry.executableId === request.executableId);
      if (matches.length !== 1) {
        throw new Error(
          matches.length === 0
            ? `ephemeral executable ${JSON.stringify(request.executableId)} is not registered`
            : `ephemeral executable ${JSON.stringify(request.executableId)} is registered more than once`,
        );
      }
      const registration = matches[0]!;
      if (registration.protocolMajor !== request.protocolMajor) {
        throw new Error(
          `ephemeral executable ${JSON.stringify(request.executableId)} uses protocol major ${registration.protocolMajor}, not ${request.protocolMajor}`,
        );
      }
      const launchSchema = fromJSONSchema(registration.launchSchema as Parameters<typeof fromJSONSchema>[0]);
      const parsedLaunch = launchSchema.safeParse(request.launch);
      if (!parsedLaunch.success) {
        throw new Error(
          `ephemeral executable ${JSON.stringify(request.executableId)} launch does not match its launch schema: ${parsedLaunch.error.issues.map((issue) => issue.message).join("; ")}`,
        );
      }
      const { processId } = await sandbox.startProcess(request.handle, registration.executableId);
      const process = { processId };
      states.set(process, { handle: request.handle, processId, stopped: false });
      try {
        await sandbox.writeStdin(request.handle, processId, `${JSON.stringify(parsedLaunch.data)}\n`);
      } catch (error) {
        let cleanupError: unknown;
        try {
          await stopState(states.get(process)!);
        } catch (caughtCleanupError) {
          cleanupError = caughtCleanupError;
        }
        if (cleanupError !== undefined) {
          throw new AggregateError([error, cleanupError], `failed to launch ephemeral process ${processId}`, {
            cause: error,
          });
        }
        throw error;
      }
      return process;
    },
    observe(process, options) {
      const state = stateOf(process);
      return sandbox.readProcess!(state.handle, state.processId, options);
    },
    async stop(process) {
      await stopState(stateOf(process));
    },
  };
}

export async function withEphemeralSandboxProcess<T>(
  provider: EphemeralSandboxProcessProvider,
  request: EphemeralSandboxProcessRequest,
  operation: (process: EphemeralSandboxProcess) => Promise<T>,
): Promise<T> {
  const process = await provider.start(request);
  let outcome: { ok: true; value: T } | { ok: false; error: unknown };
  try {
    outcome = { ok: true, value: await operation(process) };
  } catch (error) {
    outcome = { ok: false, error };
  }
  let cleanupError: unknown;
  try {
    await provider.stop(process);
  } catch (error) {
    cleanupError = error;
  }
  if (!outcome.ok) {
    if (cleanupError !== undefined) {
      throw new AggregateError([outcome.error, cleanupError], "ephemeral process operation and cleanup failed", {
        cause: outcome.error,
      });
    }
    throw outcome.error;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return outcome.value;
}

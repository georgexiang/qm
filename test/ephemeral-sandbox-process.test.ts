import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSandboxEphemeralProcessProvider,
  withEphemeralSandboxProcess,
  type EphemeralSandboxProcess,
  type EphemeralSandboxProcessProvider,
} from "../src/sandbox/ephemeral-sandbox-process.ts";
import type { Sandbox } from "../src/sandbox/sandbox.ts";

function fakeProvider() {
  const calls: string[] = [];
  const process: EphemeralSandboxProcess = { processId: "process-1" };
  const provider: EphemeralSandboxProcessProvider = {
    async start(request) {
      calls.push(`start:${request.executableId}:${request.handle.scopeId}`);
      return process;
    },
    async observe(current) {
      calls.push(`observe:${current.processId}`);
      return { chunks: "ready", cursor: 5, status: { state: "running" } };
    },
    async stop(current) {
      calls.push(`stop:${current.processId}`);
    },
  };
  return { calls, provider };
}

const request = {
  handle: { id: "sandbox-1", rootDir: "/workspace", scopeId: "personal:U1" },
  executableId: "local-browser-adapter",
  protocolMajor: 2,
  launch: { taskId: "task-1" },
};

test("an ephemeral process starts and stops exactly once around its owning operation", async () => {
  const { calls, provider } = fakeProvider();

  const result = await withEphemeralSandboxProcess(provider, request, async (process) => {
    const observed = await provider.observe(process);
    return observed.chunks;
  });

  assert.equal(result, "ready");
  assert.deepEqual(calls, ["start:local-browser-adapter:personal:U1", "observe:process-1", "stop:process-1"]);
});

test("an ephemeral process still stops exactly once when its owning operation fails", async () => {
  const { calls, provider } = fakeProvider();

  await assert.rejects(
    withEphemeralSandboxProcess(provider, request, async () => {
      throw new Error("operation failed");
    }),
    /operation failed/,
  );

  assert.deepEqual(calls, ["start:local-browser-adapter:personal:U1", "stop:process-1"]);
});

test("operation and cleanup failures are both preserved", async () => {
  const { provider } = fakeProvider();
  provider.stop = async () => {
    throw new Error("cleanup failed");
  };

  await assert.rejects(
    withEphemeralSandboxProcess(provider, request, async () => {
      throw new Error("operation failed");
    }),
    (error) => {
      assert.ok(error instanceof AggregateError);
      assert.deepEqual(
        error.errors.map((entry) => (entry as Error).message),
        ["operation failed", "cleanup failed"],
      );
      return true;
    },
  );
});

test("the Sandbox provider starts, observes, and stops a registered executable", async () => {
  const calls: string[] = [];
  let running = true;
  const sandbox = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    async startProcess(_handle, command) {
      calls.push(`start:${command}`);
      return { processId: "sandbox-process-1" };
    },
    async writeStdin(_handle, processId, data) {
      calls.push(`stdin:${processId}:${data}`);
    },
    async readProcess(_handle, processId) {
      calls.push(`observe:${processId}`);
      return {
        chunks: "listening",
        cursor: 9,
        status: running ? ({ state: "running" } as const) : ({ state: "exited", code: 0 } as const),
      };
    },
    async signalProcess(_handle, processId, signal) {
      calls.push(`stop:${processId}:${signal}`);
      running = false;
    },
    async listProcesses() {
      return [];
    },
  } as Partial<Sandbox> as Sandbox;
  const provider = createSandboxEphemeralProcessProvider(sandbox, [
    {
      executableId: "local-browser-adapter",
      protocolMajor: 2,
      launchSchema: { type: "object" },
    },
  ]);

  const result = await withEphemeralSandboxProcess(provider, request, (process) => provider.observe(process));

  assert.equal(result.chunks, "listening");
  assert.deepEqual(calls, [
    "start:local-browser-adapter",
    'stdin:sandbox-process-1:{"taskId":"task-1"}\n',
    "observe:sandbox-process-1",
    "stop:sandbox-process-1:TERM",
    "observe:sandbox-process-1",
  ]);
});

test("the Sandbox provider escalates to KILL and leaves stop retryable until exit is confirmed", async () => {
  const signals: string[] = [];
  let running = true;
  let killFailures = 1;
  const sandbox = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: false },
    async startProcess() {
      return { processId: "stubborn-process" };
    },
    async writeStdin() {},
    async readProcess() {
      return {
        chunks: "",
        cursor: 0,
        status: running ? ({ state: "running" } as const) : ({ state: "exited", code: 137 } as const),
      };
    },
    async signalProcess(_handle, _processId, signal) {
      signals.push(signal);
      if (signal === "KILL" && killFailures-- > 0) throw new Error("transient signal failure");
      if (signal === "KILL") running = false;
    },
    async listProcesses() {
      return [];
    },
  } as Partial<Sandbox> as Sandbox;
  const provider = createSandboxEphemeralProcessProvider(sandbox, [
    { executableId: "local-browser-adapter", protocolMajor: 2, launchSchema: { type: "object" } },
  ]);
  const process = await provider.start(request);

  await assert.rejects(provider.stop(process), /transient signal failure/);
  await provider.stop(process);

  assert.deepEqual(signals, ["TERM", "KILL", "TERM", "KILL"]);
});

test("the Sandbox provider rejects a launch that does not match the registered schema", async () => {
  let starts = 0;
  const sandbox = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    async startProcess() {
      starts++;
      return { processId: "must-not-start" };
    },
    async writeStdin() {},
    async readProcess() {
      return { chunks: "", cursor: 0, status: { state: "running" as const } };
    },
    async signalProcess() {},
    async listProcesses() {
      return [];
    },
  } as Partial<Sandbox> as Sandbox;
  const provider = createSandboxEphemeralProcessProvider(sandbox, [
    {
      executableId: "local-browser-adapter",
      protocolMajor: 2,
      launchSchema: {
        type: "object",
        properties: { taskId: { type: "string" } },
        required: ["taskId"],
        additionalProperties: false,
      },
    },
  ]);

  await assert.rejects(provider.start({ ...request, launch: { taskId: 42 } }), /launch schema/);
  await assert.rejects(
    provider.start({ ...request, handle: { id: "unscoped", rootDir: "/workspace" } }),
    /scoped Sandbox handle/,
  );
  assert.equal(starts, 0);
});

test("startup preserves stdin failure as the cause when process cleanup also fails", async () => {
  const sandbox = {
    profile: { backend: "fake", writablePersistence: "resident_disk", processSessions: true },
    async startProcess() {
      return { processId: "failed-process" };
    },
    async writeStdin() {
      throw new Error("stdin failed");
    },
    async readProcess() {
      return { chunks: "", cursor: 0, status: { state: "running" as const } };
    },
    async signalProcess() {
      throw new Error("signal failed");
    },
    async listProcesses() {
      return [];
    },
  } as Partial<Sandbox> as Sandbox;
  const provider = createSandboxEphemeralProcessProvider(sandbox, [
    { executableId: "local-browser-adapter", protocolMajor: 2, launchSchema: { type: "object" } },
  ]);

  await assert.rejects(provider.start(request), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal((error.cause as Error).message, "stdin failed");
    assert.equal((error.errors[0] as Error).message, "stdin failed");
    const cleanupError = error.errors[1];
    assert.ok(cleanupError instanceof AggregateError);
    assert.deepEqual(
      cleanupError.errors.map((entry) => (entry as Error).message),
      ["signal failed", "signal failed"],
    );
    return true;
  });
});

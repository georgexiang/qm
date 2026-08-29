import type {
  HostAcceptedMessage,
  HostLocalStopReceiptMessage,
  HostResultMessage,
  RelayInvocationMessage,
} from "qm-desktop-browser-contracts";
import { createHash } from "node:crypto";

export interface DesktopBrowserRelayOperationCheckpoint {
  attemptId: string;
  operationId: string;
  requestHash: string;
  state: "prepared" | "accepted" | "terminal" | "accepted_unknown";
  deliveryState: "not_started" | "started";
  invocation?: RelayInvocationMessage;
  dispatchId?: string;
  terminalOutcome?: "completed" | "failed" | "unknown";
  resultHash?: string;
  updatedAt: number;
}

export interface DesktopBrowserRelayAcceptedEvidence {
  protocolVersion: `${number}.${number}`;
  operationId: string;
  dispatchId: string;
  requestHash: string;
  acceptedAt: number;
}

export interface DesktopBrowserRelayTerminalEvidence {
  operationId: string;
  dispatchId: string;
  resultHash: string;
  outcome: "completed" | "failed" | "unknown";
  terminalAt: number;
}

export interface DesktopBrowserRelayCallbackOutboxEntry {
  taskId: string;
  operationId: string;
  callbackType: "terminal";
  accepted: HostAcceptedMessage;
  result?: HostResultMessage;
  createdAt: number;
  deliveredAt: number | null;
  attempts: number;
  nextAttemptAt: number;
  claimOwner: string | null;
  claimExpiresAt: number | null;
  deadLetteredAt: number | null;
}

export interface DesktopBrowserRelayLocalStopEvidence {
  message: HostLocalStopReceiptMessage;
  receivedAt: number;
}

export interface DesktopBrowserRelayLocalStopCallbackEntry {
  receiptId: string;
  message: HostLocalStopReceiptMessage;
  createdAt: number;
  deliveredAt: number | null;
  attempts: number;
  nextAttemptAt: number;
  claimOwner: string | null;
  claimExpiresAt: number | null;
  deadLetteredAt: number | null;
}

interface DesktopBrowserRelayOperationRecord {
  attemptId: string;
  taskId: string;
  protocolVersion: `${number}.${number}`;
  operationId: string;
  operationSequence: number;
  leaseVersion: number;
  leaseId: string;
  deviceId: string;
  browserInstanceId: string;
  effectClass: string;
  requestHash: string;
  dispatchId?: string;
  state: "prepared" | "accepted" | "terminal";
  resultHash?: string;
  terminalResult?: HostResultMessage;
  revokedAt?: number;
}

export interface DesktopBrowserRelayOperationState {
  checkpoints: Record<string, DesktopBrowserRelayOperationCheckpoint>;
  operations: Record<string, DesktopBrowserRelayOperationRecord>;
  acceptedEvidence: DesktopBrowserRelayAcceptedEvidence[];
  terminalEvidence: DesktopBrowserRelayTerminalEvidence[];
  callbackOutbox: DesktopBrowserRelayCallbackOutboxEntry[];
  localStopEvidence?: DesktopBrowserRelayLocalStopEvidence[];
  localStopCallbackOutbox?: DesktopBrowserRelayLocalStopCallbackEntry[];
  coreNonceExpirations?: Record<string, number>;
  connectionOwners?: Record<string, DesktopBrowserRelayConnectionOwner>;
}

export interface DesktopBrowserRelayConnectionOwner {
  connectionId: string;
  connectionEpoch: number;
}

export interface DesktopBrowserRelayConnectionOwnerStore {
  connectionOwner(input: { devicePublicKey: string; brokerInstanceId: string }): Promise<DesktopBrowserRelayConnectionOwner | null>;
  claimConnectionOwner(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
    connectionId: string;
    connectionEpoch: number;
    initialEpoch: number;
  }): Promise<boolean>;
  isConnectionOwner(input: {
    devicePublicKey: string;
    brokerInstanceId: string;
    connectionId: string;
    connectionEpoch: number;
  }): Promise<boolean>;
  withConnectionOwner<T>(
    input: {
      devicePublicKey: string;
      brokerInstanceId: string;
      connectionId: string;
      connectionEpoch: number;
    },
    run: () => Promise<T>,
  ): Promise<{ status: "ok"; result: T } | { status: "superseded" }>;
}

export interface DesktopBrowserRelayOperationBacking {
  transaction<T>(update: (state: DesktopBrowserRelayOperationState) => T): Promise<T>;
  snapshot(): Promise<DesktopBrowserRelayOperationState>;
}

export interface DesktopBrowserRelayOperationStore extends DesktopBrowserRelayConnectionOwnerStore {
  consumeCoreNonce(nonce: string, expiresAt: number, now: number): Promise<boolean>;
  prepare(invocation: RelayInvocationMessage): Promise<{
    status: "prepared" | "existing";
    checkpoint: DesktopBrowserRelayOperationCheckpoint;
  }>;
  markDeliveryStarted(attemptId: string, dispatchId: string): Promise<DesktopBrowserRelayOperationCheckpoint>;
  markDeliveryStartedIfOwner(
    owner: {
      devicePublicKey: string;
      brokerInstanceId: string;
      connectionId: string;
      connectionEpoch: number;
    },
    attemptId: string,
    dispatchId: string,
  ): Promise<DesktopBrowserRelayOperationCheckpoint | null>;
  markDeliveryNotStarted(attemptId: string, dispatchId: string): Promise<DesktopBrowserRelayOperationCheckpoint>;
  recordAccepted(message: HostAcceptedMessage): Promise<DesktopBrowserRelayOperationCheckpoint>;
  recordAcceptedUnknown(message: HostAcceptedMessage): Promise<HostResultMessage>;
  recordLeaseRevocation(input: {
    taskId: string;
    attemptId: string;
    leaseId: string;
    leaseVersion: number;
  }): Promise<"revoked" | "already_revoked">;
  recordTerminal(message: HostResultMessage): Promise<DesktopBrowserRelayOperationCheckpoint>;
  recordLocalStopReceipt(
    message: HostLocalStopReceiptMessage,
    host: { publicDeviceFingerprint: string; browserInstanceId: string },
  ): Promise<"recorded" | "existing">;
  localStopReceipts(): Promise<DesktopBrowserRelayLocalStopEvidence[]>;
  pendingLocalStopCallbacks(): Promise<DesktopBrowserRelayLocalStopCallbackEntry[]>;
  claimLocalStopCallbacks(owner: string, limit: number, leaseMs: number): Promise<DesktopBrowserRelayLocalStopCallbackEntry[]>;
  releaseLocalStopCallback(
    receiptId: string,
    owner: string,
    status: HostLocalStopReceiptMessage["payload"]["status"],
    retryAt: number,
    deadLetter: boolean,
  ): Promise<boolean>;
  markLocalStopCallbackDelivered(
    receiptId: string,
    owner: string,
    status: HostLocalStopReceiptMessage["payload"]["status"],
  ): Promise<boolean>;
  checkpoint(attemptId: string): Promise<DesktopBrowserRelayOperationCheckpoint | null>;
  attemptStatus(attemptId: string): Promise<{
    checkpoint: DesktopBrowserRelayOperationCheckpoint;
    accepted?: HostAcceptedMessage;
    result?: HostResultMessage;
  } | null>;
  acceptedEvidence(): Promise<DesktopBrowserRelayAcceptedEvidence[]>;
  terminalEvidence(): Promise<DesktopBrowserRelayTerminalEvidence[]>;
  pendingCallbacks(): Promise<DesktopBrowserRelayCallbackOutboxEntry[]>;
  deadLetters(): Promise<DesktopBrowserRelayCallbackOutboxEntry[]>;
  claimCallbacks(owner: string, limit: number, leaseMs: number): Promise<DesktopBrowserRelayCallbackOutboxEntry[]>;
  releaseCallback(
    operationId: string,
    callbackType: "terminal",
    owner: string,
    retryAt: number,
    deadLetter: boolean,
  ): Promise<void>;
  markCallbackDelivered(operationId: string, callbackType: "terminal", owner?: string): Promise<void>;
}

function emptyState(): DesktopBrowserRelayOperationState {
  return { checkpoints: {}, operations: {}, acceptedEvidence: [], terminalEvidence: [], callbackOutbox: [] };
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

export function canonicalRelayJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalRelayJson).join(",")}]`;
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalRelayJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("desktop browser Relay canonical JSON contains a non-JSON value");
}

export function createMemoryDesktopBrowserRelayOperationBacking(): DesktopBrowserRelayOperationBacking {
  let state = emptyState();
  let pending = Promise.resolve();
  return {
    async transaction(update) {
      let result!: ReturnType<typeof update>;
      const run = pending.then(() => {
        const next = copy(state);
        result = update(next);
        state = next;
      });
      pending = run.then(
        () => undefined,
        () => undefined,
      );
      await run;
      return copy(result);
    },
    async snapshot() {
      await pending;
      return copy(state);
    },
  };
}

function operationRecord(
  state: DesktopBrowserRelayOperationState,
  operationId: string,
): DesktopBrowserRelayOperationRecord {
  const operation = state.operations[operationId];
  if (!operation) throw new Error("desktop browser Relay operation not found");
  return operation;
}

function localStopCategory(effectClass: string): HostLocalStopReceiptMessage["payload"]["operationCategory"] {
  if (effectClass === "observation") return "observation";
  if (effectClass === "cleanup") return "session_cleanup";
  if (effectClass === "local_effect") return "session_start";
  return "browser_effect";
}

export function createDesktopBrowserRelayOperationStore(
  backing: DesktopBrowserRelayOperationBacking,
  options: { now?: () => number } = {},
): DesktopBrowserRelayOperationStore {
  const now = options.now ?? Date.now;
  const connectionKey = (input: { devicePublicKey: string; brokerInstanceId: string }) =>
    createHash("sha256").update(`${input.devicePublicKey}\0${input.brokerInstanceId}`).digest("hex");
  const ownerQueues = new Map<string, Promise<void>>();
  return {
    async connectionOwner(input) {
      const state = await backing.snapshot();
      return state.connectionOwners?.[connectionKey(input)] ?? null;
    },
    async claimConnectionOwner(input) {
      return backing.transaction((state) => {
        state.connectionOwners ??= {};
        const key = connectionKey(input);
        const current = state.connectionOwners[key];
        let expected = input.initialEpoch;
        if (current?.connectionId === input.connectionId) expected = current.connectionEpoch;
        else if (current) expected = current.connectionEpoch + 1;
        if (input.connectionEpoch !== expected) return false;
        state.connectionOwners[key] = {
          connectionId: input.connectionId,
          connectionEpoch: input.connectionEpoch,
        };
        return true;
      });
    },
    async isConnectionOwner(input) {
      const owner = await this.connectionOwner(input);
      return owner?.connectionId === input.connectionId && owner.connectionEpoch === input.connectionEpoch;
    },
    async withConnectionOwner(input, run) {
      const key = connectionKey(input);
      const previous = ownerQueues.get(key) ?? Promise.resolve();
      let release!: () => void;
      const current = new Promise<void>((resolve) => {
        release = resolve;
      });
      const queued = previous.then(() => current);
      ownerQueues.set(key, queued);
      await previous;
      try {
        if (!(await this.isConnectionOwner(input))) return { status: "superseded" };
        return { status: "ok", result: await run() };
      } finally {
        release();
        if (ownerQueues.get(key) === queued) ownerQueues.delete(key);
      }
    },
    async consumeCoreNonce(nonce, expiresAt, now) {
      return backing.transaction((state) => {
        state.coreNonceExpirations ??= {};
        for (const [key, expiration] of Object.entries(state.coreNonceExpirations)) {
          if (expiration <= now) delete state.coreNonceExpirations[key];
        }
        if (state.coreNonceExpirations[nonce] !== undefined) return false;
        state.coreNonceExpirations[nonce] = expiresAt;
        return true;
      });
    },
    async prepare(invocation) {
      return backing.transaction((state) => {
        const authority = invocation.payload.authority;
        const current = state.checkpoints[authority.attemptId];
        if (current) {
          if (current.operationId === authority.operationId && current.requestHash === invocation.payload.requestHash) {
            return { status: "existing" as const, checkpoint: current };
          }
          const previous = operationRecord(state, current.operationId);
          if (
            current.state !== "terminal" ||
            authority.operationSequence <= previous.operationSequence ||
            authority.leaseVersion <= previous.leaseVersion
          ) {
            throw new Error("desktop browser Relay Attempt already has a different current operation");
          }
        }
        const checkpoint: DesktopBrowserRelayOperationCheckpoint = {
          attemptId: authority.attemptId,
          operationId: authority.operationId,
          requestHash: invocation.payload.requestHash,
          state: "prepared",
          deliveryState: "not_started",
          invocation: copy(invocation),
          updatedAt: now(),
        };
        state.checkpoints[authority.attemptId] = checkpoint;
        state.operations[authority.operationId] = {
          attemptId: authority.attemptId,
          taskId: authority.taskId,
          protocolVersion: invocation.protocolVersion,
          operationId: authority.operationId,
          operationSequence: authority.operationSequence,
          leaseVersion: authority.leaseVersion,
          leaseId: authority.leaseId,
          deviceId: authority.deviceId,
          browserInstanceId: authority.browserInstanceId,
          effectClass: authority.effectClass,
          requestHash: invocation.payload.requestHash,
          state: "prepared",
        };
        return { status: "prepared" as const, checkpoint };
      });
    },
    async markDeliveryStartedIfOwner(owner, attemptId, dispatchId) {
      const result = await this.withConnectionOwner(owner, () => this.markDeliveryStarted(attemptId, dispatchId));
      return result.status === "ok" ? result.result : null;
    },
    async markDeliveryStarted(attemptId, dispatchId) {
      return backing.transaction((state) => {
        const checkpoint = state.checkpoints[attemptId];
        if (!checkpoint) throw new Error("desktop browser Relay operation checkpoint not found");
        if (checkpoint.dispatchId && checkpoint.dispatchId !== dispatchId) {
          throw new Error("desktop browser Relay operation delivery already started under another dispatch");
        }
        checkpoint.deliveryState = "started";
        checkpoint.dispatchId = dispatchId;
        checkpoint.updatedAt = now();
        const operation = operationRecord(state, checkpoint.operationId);
        operation.dispatchId = dispatchId;
        return checkpoint;
      });
    },
    async markDeliveryNotStarted(attemptId, dispatchId) {
      return backing.transaction((state) => {
        const checkpoint = state.checkpoints[attemptId];
        if (!checkpoint) throw new Error("desktop browser Relay operation checkpoint not found");
        if (checkpoint.state !== "prepared" || checkpoint.dispatchId !== dispatchId) {
          throw new Error("desktop browser Relay delivery can no longer return to not_started");
        }
        checkpoint.deliveryState = "not_started";
        delete checkpoint.dispatchId;
        checkpoint.updatedAt = now();
        const operation = operationRecord(state, checkpoint.operationId);
        delete operation.dispatchId;
        return checkpoint;
      });
    },
    async recordAccepted(message) {
      return backing.transaction((state) => {
        const operation = operationRecord(state, message.payload.operationId);
        if (operation.requestHash !== message.payload.requestHash) {
          throw new Error("desktop browser Relay acceptance request hash does not match checkpoint");
        }
        if (operation.dispatchId !== message.payload.dispatchId) {
          throw new Error("desktop browser Relay acceptance dispatch does not match checkpoint");
        }
        const existingEvidence = state.acceptedEvidence.find(
          (entry) =>
            entry.operationId === message.payload.operationId && entry.dispatchId === message.payload.dispatchId,
        );
        if (
          existingEvidence &&
          (existingEvidence.protocolVersion !== message.protocolVersion ||
            existingEvidence.requestHash !== message.payload.requestHash)
        ) {
          throw new Error("desktop browser Relay acceptance conflicts with persisted evidence");
        }
        if (!existingEvidence) {
          state.acceptedEvidence.push({
            protocolVersion: message.protocolVersion,
            operationId: message.payload.operationId,
            dispatchId: message.payload.dispatchId,
            requestHash: message.payload.requestHash,
            acceptedAt: now(),
          });
        }
        if (operation.state === "prepared") operation.state = "accepted";
        const checkpoint = state.checkpoints[operation.attemptId]!;
        if (checkpoint.operationId === operation.operationId) {
          if (checkpoint.state === "prepared") checkpoint.state = "accepted";
          checkpoint.updatedAt = now();
        }
        return checkpoint;
      });
    },
    async recordAcceptedUnknown(message) {
      return backing.transaction((state) => {
        const operation = operationRecord(state, message.payload.operationId);
        if (
          operation.requestHash !== message.payload.requestHash ||
          operation.dispatchId !== message.payload.dispatchId
        ) {
          throw new Error("desktop browser Relay accepted-unknown does not match checkpoint");
        }
        if (operation.terminalResult) return operation.terminalResult;
        const resultHash = `sha256:${createHash("sha256")
          .update(`accepted_unknown:${operation.operationId}:${operation.requestHash}`)
          .digest("hex")}`;
        const result: HostResultMessage = {
          protocolVersion: message.protocolVersion,
          kind: "host.result",
          payload: {
            dispatchId: message.payload.dispatchId,
            operationId: message.payload.operationId,
            outcome: "unknown",
            resultHash,
            error: {
              code: "relay_accepted_unknown",
              message: "Host accepted the operation but Relay did not receive a terminal result",
            },
          },
        };
        if (!state.terminalEvidence.some((entry) => entry.operationId === operation.operationId)) {
          state.terminalEvidence.push({
            operationId: operation.operationId,
            dispatchId: message.payload.dispatchId,
            resultHash,
            outcome: "unknown",
            terminalAt: now(),
          });
        }
        if (!state.callbackOutbox.some((entry) => entry.operationId === operation.operationId)) {
          state.callbackOutbox.push({
            taskId: operation.taskId,
            operationId: operation.operationId,
            callbackType: "terminal",
            accepted: message,
            result,
            createdAt: now(),
            deliveredAt: null,
            attempts: 0,
            nextAttemptAt: now(),
            claimOwner: null,
            claimExpiresAt: null,
            deadLetteredAt: null,
          });
        }
        operation.state = "terminal";
        operation.resultHash = resultHash;
        operation.terminalResult = result;
        const checkpoint = state.checkpoints[operation.attemptId]!;
        if (checkpoint.operationId === operation.operationId) {
          checkpoint.state = "accepted_unknown";
          checkpoint.terminalOutcome = "unknown";
          checkpoint.resultHash = resultHash;
          checkpoint.updatedAt = now();
          delete checkpoint.invocation;
        }
        return result;
      });
    },
    async recordLeaseRevocation(input) {
      return backing.transaction((state) => {
        const checkpoint = state.checkpoints[input.attemptId];
        if (!checkpoint) throw new Error("desktop browser Relay revocation Attempt not found");
        const operation = operationRecord(state, checkpoint.operationId);
        if (
          operation.taskId !== input.taskId ||
          operation.leaseId !== input.leaseId ||
          input.leaseVersion !== operation.leaseVersion + 1
        ) {
          throw new Error("desktop browser Relay revocation Lease is stale");
        }
        if (operation.revokedAt !== undefined) return "already_revoked";
        operation.revokedAt = now();
        return "revoked";
      });
    },
    async recordLocalStopReceipt(message, host) {
      return backing.transaction((state) => {
        const operation = operationRecord(state, message.payload.operationId);
        const expectedCategory = localStopCategory(operation.effectClass);
        if (
          operation.taskId !== message.payload.taskId ||
          operation.attemptId !== message.payload.attemptId ||
          operation.deviceId !== host.publicDeviceFingerprint ||
          operation.browserInstanceId !== host.browserInstanceId ||
          message.payload.operationCategory !== expectedCategory
        ) {
          throw new Error("desktop browser Local Stop Receipt does not match Relay operation authority");
        }
        state.localStopEvidence ??= [];
        state.localStopCallbackOutbox ??= [];
        const existing = state.localStopEvidence.find(
          (entry) => entry.message.payload.receiptId === message.payload.receiptId,
        );
        if (existing) {
          if (
            existing.message.payload.status === "requested" &&
            message.payload.status === "canceled" &&
            canonicalRelayJson({ ...existing.message, payload: { ...existing.message.payload, status: "canceled" } }) ===
              canonicalRelayJson(message)
          ) {
            existing.message = copy(message);
            const callback = state.localStopCallbackOutbox.find(
              (entry) => entry.receiptId === message.payload.receiptId,
            );
            if (callback) callback.message = copy(message);
            if (callback) {
              callback.deliveredAt = null;
              callback.claimOwner = null;
              callback.claimExpiresAt = null;
              callback.nextAttemptAt = now();
              callback.deadLetteredAt = null;
            }
            return "recorded";
          }
          if (canonicalRelayJson(existing.message) !== canonicalRelayJson(message)) {
            throw new Error("desktop browser Local Stop Receipt identity already has different evidence");
          }
          return "existing";
        }
        const at = now();
        state.localStopEvidence.push({ message: copy(message), receivedAt: at });
        state.localStopCallbackOutbox.push({
          receiptId: message.payload.receiptId,
          message: copy(message),
          createdAt: at,
          deliveredAt: null,
          attempts: 0,
          nextAttemptAt: at,
          claimOwner: null,
          claimExpiresAt: null,
          deadLetteredAt: null,
        });
        return "recorded";
      });
    },
    async localStopReceipts() {
      return copy((await backing.snapshot()).localStopEvidence ?? []);
    },
    async pendingLocalStopCallbacks() {
      return copy(
        ((await backing.snapshot()).localStopCallbackOutbox ?? []).filter(
          (entry) => entry.deliveredAt === null && entry.deadLetteredAt === null,
        ),
      );
    },
    async claimLocalStopCallbacks(owner, limit, leaseMs) {
      if (!owner || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new Error("desktop browser Local Stop callback claim bounds are invalid");
      }
      return backing.transaction((state) => {
        const at = now();
        return (state.localStopCallbackOutbox ?? [])
          .filter(
            (entry) =>
              entry.deliveredAt === null &&
              entry.deadLetteredAt === null &&
              entry.nextAttemptAt <= at &&
              (entry.claimExpiresAt === null || entry.claimExpiresAt <= at),
          )
          .sort((left, right) => left.createdAt - right.createdAt || left.receiptId.localeCompare(right.receiptId))
          .slice(0, limit)
          .map((entry) => {
            entry.claimOwner = owner;
            entry.claimExpiresAt = at + leaseMs;
            entry.attempts += 1;
            return entry;
          });
      });
    },
    async releaseLocalStopCallback(receiptId, owner, status, retryAt, deadLetter) {
      return backing.transaction((state) => {
        const entry = (state.localStopCallbackOutbox ?? []).find((candidate) => candidate.receiptId === receiptId);
        if (!entry || entry.claimOwner !== owner || entry.message.payload.status !== status) return false;
        entry.claimOwner = null;
        entry.claimExpiresAt = null;
        entry.nextAttemptAt = retryAt;
        if (deadLetter) entry.deadLetteredAt = now();
        return true;
      });
    },
    async markLocalStopCallbackDelivered(receiptId, owner, status) {
      return backing.transaction((state) => {
        const entry = (state.localStopCallbackOutbox ?? []).find((candidate) => candidate.receiptId === receiptId);
        if (!entry || entry.claimOwner !== owner || entry.message.payload.status !== status) return false;
        entry.deliveredAt = now();
        entry.claimOwner = null;
        entry.claimExpiresAt = null;
        return true;
      });
    },
    async recordTerminal(message) {
      return backing.transaction((state) => {
        const operation = operationRecord(state, message.payload.operationId);
        if (operation.dispatchId !== message.payload.dispatchId) {
          throw new Error("desktop browser Relay terminal dispatch does not match checkpoint");
        }
        const existingEvidence = state.terminalEvidence.find(
          (entry) =>
            entry.operationId === message.payload.operationId && entry.dispatchId === message.payload.dispatchId,
        );
        if (
          existingEvidence &&
          (existingEvidence.resultHash !== message.payload.resultHash || existingEvidence.outcome !== message.payload.outcome)
        ) {
          throw new Error("desktop browser Relay terminal result conflicts with persisted evidence");
        }
        if (!existingEvidence) {
          state.terminalEvidence.push({
            operationId: message.payload.operationId,
            dispatchId: message.payload.dispatchId,
            resultHash: message.payload.resultHash,
            outcome: message.payload.outcome,
            terminalAt: now(),
          });
        }
        if (!state.callbackOutbox.some((entry) => entry.operationId === message.payload.operationId)) {
          const acceptance = state.acceptedEvidence.find(
            (entry) =>
              entry.operationId === message.payload.operationId && entry.dispatchId === message.payload.dispatchId,
          );
          if (!acceptance) throw new Error("desktop browser Relay terminal requires Accepted Evidence");
          state.callbackOutbox.push({
            taskId: operation.taskId,
            operationId: message.payload.operationId,
            callbackType: "terminal",
            accepted: {
              protocolVersion: acceptance.protocolVersion,
              kind: "host.accepted",
              payload: {
                dispatchId: acceptance.dispatchId,
                operationId: acceptance.operationId,
                requestHash: acceptance.requestHash,
              },
            },
            result: copy(message),
            createdAt: now(),
            deliveredAt: null,
            attempts: 0,
            nextAttemptAt: now(),
            claimOwner: null,
            claimExpiresAt: null,
            deadLetteredAt: null,
          });
        }
        operation.state = "terminal";
        operation.resultHash = message.payload.resultHash;
        operation.terminalResult = copy(message);
        const checkpoint = state.checkpoints[operation.attemptId]!;
        if (checkpoint.operationId === operation.operationId) {
          checkpoint.state = "terminal";
          checkpoint.terminalOutcome = message.payload.outcome;
          checkpoint.resultHash = message.payload.resultHash;
          checkpoint.updatedAt = now();
          delete checkpoint.invocation;
        }
        return checkpoint;
      });
    },
    async checkpoint(attemptId) {
      return copy((await backing.snapshot()).checkpoints[attemptId] ?? null);
    },
    async attemptStatus(attemptId) {
      const state = await backing.snapshot();
      const checkpoint = state.checkpoints[attemptId];
      if (!checkpoint) return null;
      const operation = state.operations[checkpoint.operationId];
      const accepted = state.acceptedEvidence.find((entry) => entry.operationId === checkpoint.operationId);
      return {
        checkpoint: copy(checkpoint),
        ...(accepted
          ? {
              accepted: {
                protocolVersion: accepted.protocolVersion,
                kind: "host.accepted" as const,
                payload: {
                  operationId: accepted.operationId,
                  dispatchId: accepted.dispatchId,
                  requestHash: accepted.requestHash,
                },
              },
            }
          : {}),
        ...(operation?.terminalResult ? { result: copy(operation.terminalResult) } : {}),
      };
    },
    async acceptedEvidence() {
      return copy((await backing.snapshot()).acceptedEvidence);
    },
    async terminalEvidence() {
      return copy((await backing.snapshot()).terminalEvidence);
    },
    async pendingCallbacks() {
      return copy(
        (await backing.snapshot()).callbackOutbox.filter(
          (entry) => entry.deliveredAt === null && entry.deadLetteredAt === null,
        ),
      );
    },
    async deadLetters() {
      return copy(
        (await backing.snapshot()).callbackOutbox.filter(
          (entry) => entry.deliveredAt === null && entry.deadLetteredAt !== null,
        ),
      );
    },
    async claimCallbacks(owner, limit, leaseMs) {
      if (!owner || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new Error("desktop browser Relay callback claim bounds are invalid");
      }
      return backing.transaction((state) => {
        const at = now();
        const claimed = state.callbackOutbox
          .filter(
            (entry) =>
              entry.deliveredAt === null &&
              entry.deadLetteredAt === null &&
              entry.nextAttemptAt <= at &&
              (entry.claimExpiresAt === null || entry.claimExpiresAt <= at),
          )
          .sort((left, right) => left.createdAt - right.createdAt || left.operationId.localeCompare(right.operationId))
          .slice(0, limit);
        for (const entry of claimed) {
          entry.claimOwner = owner;
          entry.claimExpiresAt = at + leaseMs;
          entry.attempts += 1;
        }
        return claimed;
      });
    },
    async releaseCallback(operationId, callbackType, owner, retryAt, deadLetter) {
      await backing.transaction((state) => {
        const entry = state.callbackOutbox.find(
          (candidate) => candidate.operationId === operationId && candidate.callbackType === callbackType,
        );
        if (!entry || entry.claimOwner !== owner) {
          throw new Error("desktop browser Relay callback claim does not match");
        }
        entry.claimOwner = null;
        entry.claimExpiresAt = null;
        entry.nextAttemptAt = retryAt;
        if (deadLetter) {
          entry.deadLetteredAt = now();
          const operation = state.operations[operationId];
          if (operation) delete operation.terminalResult;
          delete entry.result;
        }
      });
    },
    async markCallbackDelivered(operationId, callbackType, owner) {
      await backing.transaction((state) => {
        const entry = state.callbackOutbox.find(
          (candidate) => candidate.operationId === operationId && candidate.callbackType === callbackType,
        );
        if (!entry) throw new Error("desktop browser Relay callback outbox entry not found");
        if (owner !== undefined && entry.claimOwner !== owner) {
          throw new Error("desktop browser Relay callback claim does not match");
        }
        if (entry.deliveredAt === null) entry.deliveredAt = now();
        entry.claimOwner = null;
        entry.claimExpiresAt = null;
        const operation = state.operations[operationId];
        if (operation) delete operation.terminalResult;
        delete entry.result;
      });
    },
  };
}

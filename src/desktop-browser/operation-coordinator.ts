import { createHash, randomUUID } from "node:crypto";
import {
  type DesktopBrowserSanitizedObservationResult,
  type HostAcceptedMessage,
  type HostResultMessage,
  type RelayInvocationMessage,
} from "qm-desktop-browser-contracts";
import type { DesktopBrowserTask, DesktopBrowserTaskStore } from "./browser-task-store.ts";
import { projectScopeId } from "../projects/project-store.ts";
import type { AuditLog } from "../audit/audit-log.ts";
import { persistDesktopBrowserFinalizationAudit } from "./finalization-audit.ts";

export type DesktopBrowserRelayDispatchResult =
  | { kind: "host.result"; accepted: HostAcceptedMessage; result: HostResultMessage }
  | {
      kind: "accepted_unknown";
      accepted: HostAcceptedMessage;
      result?: HostResultMessage;
      error: { code: string; message: string };
    }
  | {
      kind: "not_accepted_or_unknown";
      dispatchId: string;
      operationId: string;
      requestHash: string;
      error: { code: string; message: string };
    };

export interface DesktopBrowserRelayDispatcher {
  dispatch(input: {
    publicDeviceFingerprint: string;
    browserInstanceId: string;
    invocation: RelayInvocationMessage;
  }): Promise<DesktopBrowserRelayDispatchResult>;
}

export interface DesktopBrowserOperationCoordinator {
  startForTask(taskId: string): Promise<{ status: "ok" } | { status: "refused"; reason: string }>;
  invokeForSession(input: {
    sessionId: string;
    actorId: string;
    projectScopeLabel: string;
    projectMembershipVersion: string;
    argv: unknown;
  }): Promise<
    | {
        status: "ok";
        taskId: string;
        result: HostResultMessage;
        observation?: DesktopBrowserSanitizedObservationResult;
      }
    | { status: "refused"; reason: string }
  >;
  finalizeForSession(input: {
    sessionId: string;
    actorId: string;
    projectScopeLabel: string;
    projectMembershipVersion: string;
    outcome: "completed" | "failed";
    summary: string;
  }): Promise<{ status: "ok"; taskId: string } | { status: "refused"; reason: string }>;
}

function scopedTask(
  tasks: DesktopBrowserTask[],
  input: {
    actorId: string;
    projectScopeLabel: string;
    projectMembershipVersion: string;
  },
): DesktopBrowserTask | null {
  const matches = tasks.filter(
    (task) =>
      task.actorId === input.actorId &&
      projectScopeId(task.projectId) === input.projectScopeLabel &&
      task.projectMembershipVersion === input.projectMembershipVersion &&
      task.status === "waiting_for_broker" &&
      task.browserSkillSessionId !== undefined,
  );
  return matches.length === 1 ? matches[0]! : null;
}

function activeTask(tasks: DesktopBrowserTask[], input: Parameters<typeof scopedTask>[1]): DesktopBrowserTask | null {
  const task = scopedTask(tasks, input);
  return task?.status === "waiting_for_broker" &&
    task.outcome === undefined &&
    task.browserSkillSessionStoppedAt === undefined
    ? task
    : null;
}

function unknownResult(accepted: HostAcceptedMessage, error: { code: string; message: string }): HostResultMessage {
  const resultHash = `sha256:${createHash("sha256").update(`${error.code}:${error.message}`).digest("hex")}`;
  return {
    protocolVersion: accepted.protocolVersion,
    kind: "host.result",
    payload: {
      dispatchId: accepted.payload.dispatchId,
      operationId: accepted.payload.operationId,
      outcome: "unknown",
      resultHash,
      error: { code: error.code, message: "Relay lost the Host result after acceptance" },
    },
  };
}

export function createDesktopBrowserOperationCoordinator(options: {
  tasks: DesktopBrowserTaskStore;
  dispatcher: DesktopBrowserRelayDispatcher;
  auditLog?: AuditLog;
  claimDevice?: (taskId: string) => Promise<{ status: "ok" } | { status: "refused"; reason: string }>;
  quarantineDevice?: (taskId: string) => Promise<void>;
  releaseDevice?: (taskId: string) => Promise<void>;
  consumeSessionStartResult?: (
    taskId: string,
    result: HostResultMessage,
  ) => ReturnType<DesktopBrowserTaskStore["consumeSessionStartResult"]>;
  createDispatchId?: () => string;
}): DesktopBrowserOperationCoordinator {
  const createDispatchId = options.createDispatchId ?? randomUUID;
  return {
    async startForTask(taskId) {
      const existing = await options.tasks.get(taskId);
      if (!existing || existing.status !== "waiting_for_broker" || existing.stopIntent) {
        return { status: "refused", reason: "Desktop Browser Task is no longer waiting" };
      }
      if (existing?.browserSkillSessionId && existing.browserSkillSessionStoppedAt === undefined) {
        return { status: "ok" };
      }
      const claimed = await options.claimDevice?.(taskId);
      if (claimed?.status === "refused") return claimed;
      let prepared: Awaited<ReturnType<DesktopBrowserTaskStore["prepareSessionStart"]>>;
      try {
        prepared = await options.tasks.prepareSessionStart(taskId);
      } catch (error) {
        await options.quarantineDevice?.(taskId);
        throw error;
      }
      if (prepared.status === "refused") {
        await options.releaseDevice?.(taskId);
        return prepared;
      }
      const invocation: RelayInvocationMessage = {
        protocolVersion: prepared.operation.authority.capabilitySet.protocolVersion,
        kind: "relay.invoke",
        payload: {
          dispatchId: createDispatchId(),
          requestHash: prepared.operation.requestHash,
          authority: prepared.operation.authority,
        },
      };
      let dispatched: DesktopBrowserRelayDispatchResult;
      try {
        dispatched = await options.dispatcher.dispatch({
          publicDeviceFingerprint: prepared.operation.authority.deviceId,
          browserInstanceId: prepared.operation.authority.browserInstanceId,
          invocation,
        });
      } catch (error) {
        await options.quarantineDevice?.(taskId);
        throw error;
      }
      if (dispatched.kind === "not_accepted_or_unknown") {
        await options.quarantineDevice?.(taskId);
        return { status: "refused", reason: "Desktop Browser Relay could not prove Host acceptance" };
      }
      let accepted: Awaited<ReturnType<DesktopBrowserTaskStore["consumeSessionStartAccepted"]>>;
      try {
        accepted = await options.tasks.consumeSessionStartAccepted(taskId, dispatched.accepted);
      } catch (error) {
        await options.quarantineDevice?.(taskId);
        throw error;
      }
      if (accepted.status === "refused") {
        await options.quarantineDevice?.(taskId);
        return accepted;
      }
      const result =
        dispatched.kind === "host.result"
          ? dispatched.result
          : (dispatched.result ?? unknownResult(dispatched.accepted, dispatched.error));
      let consumed: Awaited<ReturnType<DesktopBrowserTaskStore["consumeSessionStartResult"]>>;
      try {
        consumed = options.consumeSessionStartResult
          ? await options.consumeSessionStartResult(taskId, result)
          : await options.tasks.consumeSessionStartResult(taskId, result);
      } catch (error) {
        await options.quarantineDevice?.(taskId);
        throw error;
      }
      if (consumed.status === "refused") {
        await options.quarantineDevice?.(taskId);
        return consumed;
      }
      if (!consumed.task.browserSkillSessionId) {
        if (result.payload.outcome === "failed") await options.releaseDevice?.(taskId);
        else await options.quarantineDevice?.(taskId);
        return { status: "refused", reason: "Desktop Browser Host did not establish a usable session" };
      }
      return { status: "ok" };
    },
    async invokeForSession(input) {
      const task = activeTask(await options.tasks.listForSession(input.sessionId), input);
      if (!task) return { status: "refused", reason: "No active Desktop Browser Task belongs to this Agent session" };
      const prepared = await options.tasks.prepareOperation(task.id, input.argv);
      if (prepared.status === "refused") return prepared;
      const invocation: RelayInvocationMessage = {
        protocolVersion: prepared.operation.authority.capabilitySet.protocolVersion,
        kind: "relay.invoke",
        payload: {
          dispatchId: createDispatchId(),
          requestHash: prepared.operation.requestHash,
          authority: prepared.operation.authority,
        },
      };
      const dispatched = await options.dispatcher.dispatch({
        publicDeviceFingerprint: prepared.operation.authority.deviceId,
        browserInstanceId: prepared.operation.authority.browserInstanceId,
        invocation,
      });
      if (dispatched.kind === "not_accepted_or_unknown") {
        const marked = await options.tasks.markOperationDeliveryUnknown(
          task.id,
          prepared.operation.authority.operationId,
        );
        if (marked.status === "refused") return marked;
        return { status: "refused", reason: "Desktop Browser Relay could not prove Host acceptance" };
      }
      const accepted = await options.tasks.consumeOperationAccepted(task.id, dispatched.accepted);
      if (accepted.status === "refused") return accepted;
      const result =
        dispatched.kind === "host.result"
          ? dispatched.result
          : (dispatched.result ?? unknownResult(dispatched.accepted, dispatched.error));
      const consumed = await options.tasks.consumeOperationResult(task.id, result);
      if (consumed.status === "refused") return consumed;
      if (consumed.task.status === "canceled_with_unknown_effects") {
        return { status: "refused", reason: "Desktop Browser Task was stopped; browser effects may be unknown" };
      }
      return {
        status: "ok",
        taskId: task.id,
        result,
        ...(consumed.observation ? { observation: consumed.observation } : {}),
      };
    },
    async finalizeForSession(input) {
      if (!options.auditLog) return { status: "refused", reason: "Desktop Browser finalization audit is unavailable" };
      const task = scopedTask(await options.tasks.listForSession(input.sessionId), input);
      if (!task) return { status: "refused", reason: "No active Desktop Browser Task belongs to this Agent session" };
      if (task.browserSkillSessionStoppedAt === undefined) {
        return { status: "refused", reason: "Desktop Browser Task session cleanup is required before finalization" };
      }
      const finalized = await options.tasks.finalize(task.id, { outcome: input.outcome, summary: input.summary });
      if (finalized.status === "refused") return finalized;
      await persistDesktopBrowserFinalizationAudit(options.tasks, options.auditLog, finalized.task);
      if (finalized.task.browserSkillSessionStoppedAt !== undefined) {
        await options.releaseDevice?.(finalized.task.id);
      }
      return { status: "ok", taskId: task.id };
    },
  };
}

import { createHash, randomUUID } from "node:crypto";
import {
  buildDesktopBrowserSessionStartArgv,
  DESKTOP_BROWSER_AUTHORITY_VERSION,
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  DESKTOP_BROWSER_TASK_LEASE_DURATION_MS,
  computeDesktopBrowserRequestHash,
  decodeDesktopBrowserMessage,
  parseDesktopBrowserSessionStartAuthorityEnvelope,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserSessionStartAuthorityEnvelope,
  type HostAcceptedMessage,
  type HostResultMessage,
} from "qm-desktop-browser-contracts";
import type { DurableMap } from "../persistence/durable-map.ts";

type DesktopBrowserTaskStatus = "waiting_for_broker" | "canceled";

export interface DesktopBrowserSessionStartRegistrationSnapshot {
  deploymentCanonicalId: string;
  registrationId: string;
  waitingTaskId: string;
  actorId: string;
  projectId: string;
  membershipEpoch: number;
  authorityId: string;
  authorityExpiresAt: number;
  publicDeviceFingerprint: string;
  browserInstanceId: string;
  status: "online" | "offline";
  browserRuntimeStatus: "ready" | "offline";
}

export interface DesktopBrowserSessionStartAuthoritySnapshot {
  registration: DesktopBrowserSessionStartRegistrationSnapshot;
  relayConnection: DesktopBrowserRelayConnectionProjection;
}

export interface DesktopBrowserPreparedSessionStartOperation {
  authority: DesktopBrowserSessionStartAuthorityEnvelope;
  requestHash: string;
}

export interface DesktopBrowserTaskExecution {
  attemptId: string;
  attemptStatus: "prepared" | "pre_fence_failed" | "accepted_failed" | "accepted_unknown" | "completed";
  leaseId: string;
  leaseVersion: number;
  operation: DesktopBrowserPreparedSessionStartOperation;
  createdAt: number;
  hostAccepted?: HostAcceptedMessage;
  resultHash?: string;
  completedAt?: number;
  resultRecordedAt?: number;
  hostResult?: HostResultMessage;
}

type DesktopBrowserCurrentSessionStartAuthority =
  { status: "ok"; authority: DesktopBrowserSessionStartAuthoritySnapshot } | { status: "refused"; reason: string };

export interface DesktopBrowserTask {
  id: string;
  status: DesktopBrowserTaskStatus;
  goal: string;
  actorId: string;
  actorSnapshot: { id: string; displayName?: string };
  projectId: string;
  projectSnapshot: { id: string; name: string };
  projectMembershipVersion: string;
  authorityId: string;
  authorityExpiresAt: number;
  sessionId: string;
  threadRef: string;
  createdAt: number;
  updatedAt: number;
  execution?: DesktopBrowserTaskExecution;
  browserSkillSessionId?: string;
  browserInstanceId?: string;
  agentWindowId?: number;
}

interface CreateDesktopBrowserTaskInput {
  goal: string;
  actorId: string;
  actorDisplayName?: string;
  projectId: string;
  projectName: string;
  projectMembershipVersion: string;
  authorityId: string;
  authorityExpiresAt: number;
  sessionId: string;
  threadRef: string;
}

export interface DesktopBrowserTaskStore {
  createWaiting(input: CreateDesktopBrowserTaskInput): Promise<DesktopBrowserTask>;
  get(id: string): Promise<DesktopBrowserTask | null>;
  list(): Promise<DesktopBrowserTask[]>;
  listForSession(sessionId: string): Promise<DesktopBrowserTask[]>;
  cancelWaiting(id: string): Promise<DesktopBrowserTask | null>;
  prepareSessionStart(
    id: string,
  ): Promise<
    { status: "ok"; operation: DesktopBrowserPreparedSessionStartOperation } | { status: "refused"; reason: string }
  >;
  consumeSessionStartAccepted(
    id: string,
    accepted: HostAcceptedMessage,
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
  consumeSessionStartResult(
    id: string,
    result: HostResultMessage,
    currentAuthority?: DesktopBrowserCurrentSessionStartAuthority,
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
}

function snapshotHash(snapshot: object): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot)).digest("hex")}`;
}

function relayBindingRefusal(): string {
  return "Desktop Browser Relay connection is no longer bound to the registered device";
}

function capabilitySetRefusal(): string {
  return "Desktop Browser Relay connection capability set no longer matches the prepared task";
}

function protocolVersionRefusal(kind: "acceptance" | "result"): string {
  return `Desktop Browser Host ${kind} protocol does not match the prepared task`;
}

function dispatchRefusal(kind: "acceptance" | "result"): string {
  return `Desktop Browser Host ${kind} dispatch does not match the prepared task`;
}

function sameAccepted(left: HostAcceptedMessage, right: HostAcceptedMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameResult(left: HostResultMessage, right: HostResultMessage): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function currentAuthorityRefusal(
  task: DesktopBrowserTask,
  execution: DesktopBrowserTaskExecution,
  currentAuthority: DesktopBrowserCurrentSessionStartAuthority,
): string | null {
  if (currentAuthority.status === "refused") return currentAuthority.reason;
  const { registration, relayConnection } = currentAuthority.authority;
  if (
    registration.waitingTaskId !== task.id ||
    registration.actorId !== task.actorSnapshot.id ||
    registration.projectId !== task.projectSnapshot.id ||
    registration.membershipEpoch !== Number(task.projectMembershipVersion) ||
    registration.authorityId !== task.authorityId ||
    registration.authorityExpiresAt !== task.authorityExpiresAt
  ) {
    return "Desktop Browser Task authorization is no longer current";
  }
  if (registration.status !== "online" || registration.browserRuntimeStatus !== "ready") {
    return "Desktop Browser device is not online";
  }
  if (
    registration.publicDeviceFingerprint !== execution.operation.authority.deviceId ||
    registration.browserInstanceId !== execution.operation.authority.browserInstanceId ||
    relayConnection.registrationState !== "registered" ||
    relayConnection.publicDeviceFingerprint !== registration.publicDeviceFingerprint ||
    relayConnection.browserInstanceId !== registration.browserInstanceId
  ) {
    return relayBindingRefusal();
  }
  if (
    relayConnection.protocolVersion !== execution.operation.authority.capabilitySet.protocolVersion ||
    relayConnection.policyGrammarVersion !== execution.operation.authority.capabilitySet.policyGrammarVersion ||
    relayConnection.bskVersion !== execution.operation.authority.capabilitySet.bskVersion ||
    relayConnection.extensionVersion !== execution.operation.authority.capabilitySet.extensionVersion ||
    relayConnection.cliShapeHash !== execution.operation.authority.capabilitySet.cliShapeHash
  ) {
    return capabilitySetRefusal();
  }
  return null;
}

export function createDesktopBrowserTaskStore(
  backing: DurableMap<DesktopBrowserTask>,
  options: {
    id?: () => string;
    now?: () => number;
    sessionStartAuthority?: (taskId: string) => Promise<DesktopBrowserSessionStartAuthoritySnapshot | null>;
  } = {},
): DesktopBrowserTaskStore {
  const id = options.id ?? randomUUID;
  const now = options.now ?? Date.now;
  const copy = (task: DesktopBrowserTask): DesktopBrowserTask => structuredClone(task);
  return {
    async createWaiting(input) {
      const taskId = id();
      const at = now();
      const task: DesktopBrowserTask = {
        id: taskId,
        status: "waiting_for_broker",
        goal: input.goal,
        actorId: input.actorId,
        actorSnapshot: {
          id: input.actorId,
          ...(input.actorDisplayName ? { displayName: input.actorDisplayName } : {}),
        },
        projectId: input.projectId,
        projectSnapshot: { id: input.projectId, name: input.projectName },
        projectMembershipVersion: input.projectMembershipVersion,
        authorityId: input.authorityId,
        authorityExpiresAt: input.authorityExpiresAt,
        sessionId: input.sessionId,
        threadRef: input.threadRef,
        createdAt: at,
        updatedAt: at,
      };
      if (backing.insertIfAbsent) {
        if (!(await backing.insertIfAbsent(taskId, task)))
          throw new Error(`desktop browser task ${taskId} already exists`);
      } else {
        const stored = await backing.putIfAbsent(taskId, task);
        if (stored.id !== taskId) throw new Error(`desktop browser task ${taskId} already exists`);
      }
      return copy(task);
    },
    async get(id) {
      const task = await backing.get(id);
      return task ? copy(task) : null;
    },
    async list() {
      return (await backing.all())
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(copy);
    },
    async listForSession(sessionId) {
      return (await backing.all())
        .filter((task) => task.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(copy);
    },
    async cancelWaiting(taskId) {
      let canceled = false;
      const task = await backing.update?.(taskId, (current) => {
        if (current.status !== "waiting_for_broker") return current;
        canceled = true;
        return { ...current, status: "canceled", updatedAt: now() };
      });
      return canceled && task ? copy(task) : null;
    },
    async prepareSessionStart(taskId) {
      const current = await backing.get(taskId);
      if (!current) return { status: "refused", reason: "Desktop Browser Task not found" };
      if (current.execution) return { status: "ok", operation: structuredClone(current.execution.operation) };
      if (!options.sessionStartAuthority) {
        return { status: "refused", reason: "Desktop Browser session-start authority is unavailable" };
      }
      const source = await options.sessionStartAuthority(taskId);
      if (!source) return { status: "refused", reason: "Desktop Browser device is not online" };
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let prepared: DesktopBrowserPreparedSessionStartOperation | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        if (task.execution) {
          prepared = task.execution.operation;
          return task;
        }
        const at = now();
        const registration = source.registration;
        const relayConnection = source.relayConnection;
        if (task.status !== "waiting_for_broker") {
          refusal = "Desktop Browser Task is no longer waiting";
          return task;
        }
        if (task.authorityExpiresAt <= at || registration.authorityExpiresAt <= at) {
          refusal = "Desktop Browser Turn authority expired; start a new Turn";
          return task;
        }
        if (
          registration.waitingTaskId !== task.id ||
          registration.actorId !== task.actorSnapshot.id ||
          registration.projectId !== task.projectSnapshot.id ||
          registration.membershipEpoch !== Number(task.projectMembershipVersion) ||
          registration.authorityId !== task.authorityId ||
          registration.authorityExpiresAt !== task.authorityExpiresAt
        ) {
          refusal = "Desktop Browser Task authorization is no longer current";
          return task;
        }
        if (registration.status !== "online" || registration.browserRuntimeStatus !== "ready") {
          refusal = "Desktop Browser device is not online";
          return task;
        }
        if (
          relayConnection.registrationState !== "registered" ||
          relayConnection.publicDeviceFingerprint !== registration.publicDeviceFingerprint ||
          relayConnection.browserInstanceId !== registration.browserInstanceId
        ) {
          refusal = "Desktop Browser Relay connection is no longer bound to the registered device";
          return task;
        }
        const attemptId = id();
        const leaseId = id();
        const operationId = id();
        const issuedAt = new Date(at).toISOString();
        const authority = parseDesktopBrowserSessionStartAuthorityEnvelope({
          authorityVersion: DESKTOP_BROWSER_AUTHORITY_VERSION,
          audience: DESKTOP_BROWSER_RELAY_AUDIENCE,
          deploymentCanonicalId: registration.deploymentCanonicalId,
          actorId: task.actorSnapshot.id,
          actorSnapshotHash: snapshotHash(task.actorSnapshot),
          projectId: task.projectSnapshot.id,
          projectSnapshotHash: snapshotHash(task.projectSnapshot),
          membershipEpoch: registration.membershipEpoch,
          taskId: task.id,
          attemptId,
          deviceId: registration.publicDeviceFingerprint,
          browserInstanceId: registration.browserInstanceId,
          leaseId,
          leaseVersion: 1,
          leaseExpiresAt: new Date(at + DESKTOP_BROWSER_TASK_LEASE_DURATION_MS).toISOString(),
          operationId,
          operationSequence: 1,
          capabilitySet: {
            protocolVersion: relayConnection.protocolVersion,
            policyGrammarVersion: relayConnection.policyGrammarVersion,
            bskVersion: relayConnection.bskVersion,
            extensionVersion: relayConnection.extensionVersion,
            cliShapeHash: relayConnection.cliShapeHash,
          },
          argv: buildDesktopBrowserSessionStartArgv(registration.browserInstanceId),
          brokerOptions: { forceSharedRuntime: false },
          effectClass: "local_effect",
          nonce: id(),
          issuedAt,
        });
        prepared = {
          authority,
          requestHash: computeDesktopBrowserRequestHash(
            authority,
            relayConnection.protocolVersion,
            relayConnection.policyGrammarVersion,
          ),
        };
        return {
          ...task,
          execution: {
            attemptId,
            attemptStatus: "prepared",
            leaseId,
            leaseVersion: 1,
            operation: prepared,
            createdAt: at,
          },
          updatedAt: at,
        };
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!prepared) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", operation: structuredClone(prepared) };
    },
    async consumeSessionStartAccepted(taskId, input) {
      let accepted: HostAcceptedMessage;
      try {
        const decoded = decodeDesktopBrowserMessage(JSON.stringify(input), input.protocolVersion);
        if (decoded.kind !== "host.accepted") {
          return { status: "refused", reason: "Desktop Browser Host acceptance is invalid" };
        }
        accepted = decoded;
      } catch {
        return { status: "refused", reason: "Desktop Browser Host acceptance is invalid" };
      }
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let recorded: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        const execution = task.execution;
        if (!execution) {
          refusal = "Desktop Browser Task has no prepared session start";
          return task;
        }
        if (accepted.protocolVersion !== execution.operation.authority.capabilitySet.protocolVersion) {
          refusal = protocolVersionRefusal("acceptance");
          return task;
        }
        if (accepted.payload.operationId !== execution.operation.authority.operationId) {
          refusal = "Desktop Browser Host acceptance operation does not match the prepared task";
          return task;
        }
        if (accepted.payload.requestHash !== execution.operation.requestHash) {
          refusal = capabilitySetRefusal();
          return task;
        }
        if (execution.hostResult) {
          refusal = "Desktop Browser Task already recorded a Host result";
          return task;
        }
        if (execution.hostAccepted) {
          if (sameAccepted(execution.hostAccepted, accepted)) {
            recorded = task;
            return task;
          }
          refusal = "Desktop Browser Task already recorded Host acceptance";
          return task;
        }
        const at = now();
        recorded = {
          ...task,
          execution: {
            ...execution,
            hostAccepted: structuredClone(accepted),
          },
          updatedAt: at,
        };
        return recorded;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!recorded) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(recorded) };
    },
    async consumeSessionStartResult(taskId, input, currentAuthority) {
      let result: HostResultMessage;
      try {
        const decoded = decodeDesktopBrowserMessage(JSON.stringify(input), input.protocolVersion);
        if (decoded.kind !== "host.result") {
          return { status: "refused", reason: "Desktop Browser Host result is invalid" };
        }
        result = decoded;
      } catch {
        return { status: "refused", reason: "Desktop Browser Host result is invalid" };
      }
      const current = await backing.get(taskId);
      if (!current) return { status: "refused", reason: "Desktop Browser Task not found" };
      const needsCurrentAuthority =
        !!current.execution?.hostAccepted &&
        !current.execution?.hostResult &&
        (result.payload.outcome === "completed" || result.payload.outcome === "unknown");
      let authorityState = currentAuthority;
      if (needsCurrentAuthority && !authorityState) {
        if (!options.sessionStartAuthority) {
          authorityState = { status: "refused", reason: "Desktop Browser session-start authority is unavailable" };
        } else {
          const latestAuthority = await options.sessionStartAuthority(taskId);
          authorityState = latestAuthority
            ? { status: "ok", authority: latestAuthority }
            : { status: "refused", reason: "Desktop Browser device is not online" };
        }
      }
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let bound: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        const execution = task.execution;
        if (!execution) {
          refusal = "Desktop Browser Task has no prepared session start";
          return task;
        }
        if (!execution.hostResult) {
          if (task.status !== "waiting_for_broker") {
            refusal = "Desktop Browser Task is no longer waiting";
            return task;
          }
          if (task.authorityExpiresAt <= now()) {
            refusal = "Desktop Browser Turn authority expired; start a new Turn";
            return task;
          }
        }
        if (result.payload.operationId !== execution.operation.authority.operationId) {
          refusal = "Desktop Browser Host result operation does not match the prepared task";
          return task;
        }
        if (result.protocolVersion !== execution.operation.authority.capabilitySet.protocolVersion) {
          refusal = protocolVersionRefusal("result");
          return task;
        }
        if (execution.hostResult) {
          if (sameResult(execution.hostResult, result)) {
            bound = task;
            return task;
          }
          refusal = "Desktop Browser Task already recorded a Host result";
          return task;
        }
        if (!execution.hostAccepted) {
          refusal = "Desktop Browser Host result requires prior Host acceptance";
          return task;
        }
        if (execution.hostAccepted.payload.operationId !== result.payload.operationId) {
          refusal = "Desktop Browser Host result operation does not match the prepared task";
          return task;
        }
        if (execution.hostAccepted.payload.dispatchId !== result.payload.dispatchId) {
          refusal = dispatchRefusal("result");
          return task;
        }
        if (execution.hostAccepted.payload.requestHash !== execution.operation.requestHash) {
          refusal = capabilitySetRefusal();
          return task;
        }
        if (result.payload.outcome !== "completed") {
          const at = now();
          let attemptStatus: DesktopBrowserTaskExecution["attemptStatus"];
          if (result.payload.outcome === "failed") {
            attemptStatus = "accepted_failed";
          } else {
            attemptStatus = "accepted_unknown";
          }
          bound = {
            ...task,
            execution: {
              ...execution,
              attemptStatus,
              resultHash: result.payload.resultHash,
              resultRecordedAt: at,
              hostResult: structuredClone(result),
            },
            updatedAt: at,
          };
          return bound;
        }
        if (authorityState) {
          const currentRefusal = currentAuthorityRefusal(task, execution, authorityState);
          if (currentRefusal) {
            refusal = currentRefusal;
            return task;
          }
        }
        if (result.payload.result.browser_instance_id !== execution.operation.authority.browserInstanceId) {
          refusal = "Desktop Browser Host result browser does not match the prepared task";
          return task;
        }
        if (
          task.browserSkillSessionId !== undefined ||
          task.browserInstanceId !== undefined ||
          task.agentWindowId !== undefined
        ) {
          if (
            task.browserSkillSessionId === result.payload.result.session_id &&
            task.browserInstanceId === result.payload.result.browser_instance_id &&
            task.agentWindowId === result.payload.result.agent_window_id &&
            execution.attemptStatus === "completed" &&
            execution.resultHash === result.payload.resultHash
          ) {
            bound = task;
            return task;
          }
          refusal = "Desktop Browser Task browser ownership is already bound";
          return task;
        }
        const at = now();
        bound = {
          ...task,
          browserSkillSessionId: result.payload.result.session_id,
          browserInstanceId: result.payload.result.browser_instance_id,
          agentWindowId: result.payload.result.agent_window_id,
          execution: {
            ...execution,
            attemptStatus: "completed",
            resultHash: result.payload.resultHash,
            completedAt: at,
            resultRecordedAt: at,
            hostResult: structuredClone(result),
          },
          updatedAt: at,
        };
        return bound;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!bound) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(bound) };
    },
  };
}

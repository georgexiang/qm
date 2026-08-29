import { createHash, randomUUID } from "node:crypto";
import {
  buildDesktopBrowserSessionStartArgv,
  DESKTOP_BROWSER_AUTHORITY_VERSION,
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  DESKTOP_BROWSER_TASK_LEASE_DURATION_MS,
  DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  computeDesktopBrowserRequestHash,
  decodeDesktopBrowserMessage,
  parseDesktopBrowserOperationAuthorityEnvelope,
  parseDesktopBrowserSessionStartAuthorityEnvelope,
  validateDesktopBrowserPhaseFArgv,
  type DesktopBrowserEffectClass,
  type DesktopBrowserArtifactIntent,
  type DesktopBrowserOperationAuthorityEnvelope,
  type DesktopBrowserPhaseFArgv,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserSanitizedObservationResult,
  type DesktopBrowserSessionStartAuthorityEnvelope,
  type HostAcceptedMessage,
  type HostLocalStopReceiptMessage,
  type HostResultMessage,
} from "qm-desktop-browser-contracts";
import type { DurableMap } from "../persistence/durable-map.ts";

type DesktopBrowserTaskStatus =
  "waiting_for_broker" | "completed" | "failed" | "canceled" | "canceled_with_unknown_effects";

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

export interface DesktopBrowserPreparedOperation {
  authority: DesktopBrowserOperationAuthorityEnvelope;
  requestHash: string;
}

export interface DesktopBrowserTaskOperation {
  operation: DesktopBrowserPreparedOperation;
  status: "prepared" | "accepted" | "completed" | "failed" | "unknown" | "result_lost_retryable";
  createdAt: number;
  retryOfOperationId?: string;
  hostAccepted?: HostAcceptedMessage;
  hostResult?: HostResultMessage;
  resultRecordedAt?: number;
}

export interface DesktopBrowserTaskOutcome {
  outcome: "completed" | "failed";
  summary: string;
  finalizedAt: number;
}

export interface DesktopBrowserFinalizationAudit {
  idempotencyKey: string;
  status: "pending" | "recorded";
}

export interface DesktopBrowserStopIntent {
  requestedBy: string;
  reason: "webui" | "admin";
  requestedAt: number;
  auditStatus?: "pending" | "recorded";
  revocationStatus?: "pending" | "delivered";
}

export interface DesktopBrowserLeaseRevocation {
  leaseId: string;
  leaseVersion: number;
  revokedAt: number;
}

export interface DesktopBrowserTaskExecution {
  attemptId: string;
  attemptStatus:
    | "prepared"
    | "pre_fence_failed"
    | "accepted_failed"
    | "accepted_unknown"
    | "accepted_completed_unbound"
    | "completed";
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
  operations?: DesktopBrowserTaskOperation[];
  latestObservation?: DesktopBrowserSanitizedObservationResult;
  outcome?: DesktopBrowserTaskOutcome;
  finalizationAudit?: DesktopBrowserFinalizationAudit;
  stopIntent?: DesktopBrowserStopIntent;
  leaseRevocation?: DesktopBrowserLeaseRevocation;
  auditWarnings?: string[];
  localStopReceipts?: HostLocalStopReceiptMessage[];
  browserSkillSessionId?: string;
  browserSkillSessionStoppedAt?: number;
  browserInstanceId?: string;
  agentWindowId?: number;
  continuationRunId?: string;
  recoveryExpiresAt?: number;
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
  validateArtifactIntent(
    intent: DesktopBrowserArtifactIntent,
  ): Promise<{ status: "ok" } | { status: "refused"; reason: string }>;
  cancelWaiting(id: string): Promise<DesktopBrowserTask | null>;
  requestStop(
    id: string,
    input: { requestedBy: string; reason: "webui" | "admin" },
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
  listPendingStops(): Promise<DesktopBrowserTask[]>;
  markStopAudited(id: string): Promise<DesktopBrowserTask>;
  markStopRevocationDelivered(id: string): Promise<DesktopBrowserTask>;
  markContinuationRun(id: string, runId: string): Promise<DesktopBrowserTask>;
  consumeLocalStopReceipt(
    message: HostLocalStopReceiptMessage,
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
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
  prepareOperation(
    id: string,
    argv: unknown,
    options?: { recoveryMode?: "observe" | "cleanup" },
  ): Promise<{ status: "ok"; operation: DesktopBrowserPreparedOperation } | { status: "refused"; reason: string }>;
  consumeOperationAccepted(
    id: string,
    accepted: HostAcceptedMessage,
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
  consumeOperationResult(
    id: string,
    result: HostResultMessage,
  ): Promise<
    | { status: "ok"; task: DesktopBrowserTask; observation?: DesktopBrowserSanitizedObservationResult }
    | { status: "refused"; reason: string }
  >;
  markOperationDeliveryUnknown(
    id: string,
    operationId: string,
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
  finalize(
    id: string,
    input: { outcome: "completed" | "failed"; summary: string },
  ): Promise<{ status: "ok"; task: DesktopBrowserTask } | { status: "refused"; reason: string }>;
  listPendingFinalizationAudits(): Promise<DesktopBrowserTask[]>;
  markFinalizationAudited(
    id: string,
    idempotencyKey: string,
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

function lateResultWarnings(task: DesktopBrowserTask, operationId: string): string[] | undefined {
  if (task.status === "waiting_for_broker" && task.outcome === undefined) return task.auditWarnings;
  const warning = `Late Host result recorded after terminal Task outcome for operation ${operationId}`;
  return task.auditWarnings?.includes(warning) ? task.auditWarnings : [...(task.auditWarnings ?? []), warning];
}

function operationEffectClass(argv: DesktopBrowserPhaseFArgv): DesktopBrowserEffectClass {
  if (argv[1] === "navigate") return "browser_effect";
  if (argv[1] === "observe") return "observation";
  if (argv[1] === "session" && argv[2] === "stop") return "cleanup";
  return "local_effect";
}

function operationResultCommand(argv: DesktopBrowserPhaseFArgv): "navigate" | "observe" | "session.stop" | null {
  if (argv[1] === "navigate") return "navigate";
  if (argv[1] === "observe") return "observe";
  if (argv[1] === "session" && argv[2] === "stop") return "session.stop";
  return null;
}

function supportsTicket06(protocolVersion: string): boolean {
  const [major, minor] = protocolVersion.split(".").map(Number);
  const [requiredMajor, requiredMinor] = DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION.split(".").map(Number);
  return major === requiredMajor && minor! >= requiredMinor!;
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
    async validateArtifactIntent(intent) {
      const task = await backing.get(intent.taskId);
      if (
        !task ||
        task.status !== "waiting_for_broker" ||
        task.outcome ||
        task.stopIntent ||
        task.authorityExpiresAt <= Date.now()
      ) {
        return { status: "refused", reason: "Desktop Browser artifact Task is not active" };
      }
      const sessionStart = task.execution;
      const later = task.operations?.find(
        (entry) => entry.operation.authority.operationId === intent.operationId,
      );
      const operation =
        sessionStart?.operation.authority.operationId === intent.operationId ? sessionStart.operation : later?.operation;
      const accepted =
        sessionStart?.operation.authority.operationId === intent.operationId
          ? sessionStart.hostAccepted
          : later?.hostAccepted;
      if (!operation || !accepted) {
        return { status: "refused", reason: "Desktop Browser artifact operation was not accepted" };
      }
      const authority = operation.authority;
      if (
        intent.attemptId !== authority.attemptId ||
        intent.deviceId !== authority.deviceId ||
        intent.actorId !== authority.actorId ||
        intent.projectId !== authority.projectId ||
        intent.taskId !== authority.taskId ||
        intent.operationId !== authority.operationId ||
        intent.requestHash !== operation.requestHash ||
        intent.leaseId !== authority.leaseId ||
        intent.leaseVersion !== authority.leaseVersion ||
        intent.leaseExpiresAt !== authority.leaseExpiresAt ||
        Date.parse(authority.leaseExpiresAt) <= Date.now() ||
        task.actorSnapshot.id !== authority.actorId ||
        task.projectSnapshot.id !== authority.projectId
      ) {
        return { status: "refused", reason: "Desktop Browser artifact intent does not match Task authority" };
      }
      return { status: "ok" };
    },
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
    async requestStop(taskId, input) {
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let stopped: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        if (task.stopIntent && task.leaseRevocation) {
          stopped = task;
          return task;
        }
        if (task.status !== "waiting_for_broker" || task.outcome) {
          refusal = "Desktop Browser Task already has a terminal outcome";
          return task;
        }
        const at = now();
        const latestOperation = task.operations?.at(-1);
        const latestAuthority = latestOperation?.operation.authority ?? task.execution?.operation.authority;
        if (!latestAuthority || !task.execution) {
          refusal = "Desktop Browser Task has no active Lease";
          return task;
        }
        const unknownEffects =
          latestOperation !== undefined
            ? latestOperation.status === "prepared" ||
              latestOperation.status === "accepted" ||
              latestOperation.status === "unknown" ||
              latestOperation.status === "result_lost_retryable"
            : task.execution.attemptStatus === "prepared" ||
              task.execution.attemptStatus === "accepted_unknown" ||
              task.execution.attemptStatus === "accepted_completed_unbound" ||
              (!!task.execution.hostAccepted && !task.execution.hostResult);
        stopped = {
          ...task,
          status: unknownEffects ? "canceled_with_unknown_effects" : "canceled",
          stopIntent: {
            requestedBy: input.requestedBy,
            reason: input.reason,
            requestedAt: at,
            auditStatus: "pending",
            revocationStatus: "pending",
          },
          leaseRevocation: {
            leaseId: latestAuthority.leaseId,
            leaseVersion: latestAuthority.leaseVersion + 1,
            revokedAt: at,
          },
          updatedAt: at,
        };
        return stopped;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!stopped) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(stopped) };
    },
    async listPendingStops() {
      return (await backing.all())
        .filter(
          (task) =>
            task.stopIntent &&
            (task.stopIntent.auditStatus !== "recorded" || task.stopIntent.revocationStatus !== "delivered"),
        )
        .sort((left, right) => left.stopIntent!.requestedAt - right.stopIntent!.requestedAt)
        .map(copy);
    },
    async markStopAudited(taskId) {
      const task = await backing.update?.(taskId, (current) => {
        if (!current.stopIntent) return current;
        return { ...current, stopIntent: { ...current.stopIntent, auditStatus: "recorded" }, updatedAt: now() };
      });
      if (!task?.stopIntent) throw new Error("Desktop Browser Task Stop intent not found");
      return copy(task);
    },
    async markStopRevocationDelivered(taskId) {
      const task = await backing.update?.(taskId, (current) => {
        if (!current.stopIntent) return current;
        return { ...current, stopIntent: { ...current.stopIntent, revocationStatus: "delivered" }, updatedAt: now() };
      });
      if (!task?.stopIntent) throw new Error("Desktop Browser Task Stop intent not found");
      return copy(task);
    },
    async markContinuationRun(taskId, runId) {
      const task = await backing.update?.(taskId, (current) => {
        if (current.continuationRunId && current.continuationRunId !== runId) return current;
        return { ...current, continuationRunId: runId, updatedAt: now() };
      });
      if (!task || task.continuationRunId !== runId) {
        throw new Error("Desktop Browser Task Continue Run could not be recorded");
      }
      return copy(task);
    },
    async consumeLocalStopReceipt(message) {
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let recorded: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(message.payload.taskId, (task) => {
        const operation =
          task.execution?.operation.authority.operationId === message.payload.operationId
            ? task.execution.operation.authority
            : task.operations?.find(
                (entry) => entry.operation.authority.operationId === message.payload.operationId,
              )?.operation.authority;
        if (
          !operation ||
          operation.attemptId !== message.payload.attemptId ||
          operation.taskId !== message.payload.taskId
        ) {
          refusal = "Desktop Browser Local Stop Receipt does not match Task authority";
          return task;
        }
        const existing = task.localStopReceipts?.find(
          (entry) => entry.payload.receiptId === message.payload.receiptId,
        );
        if (existing) {
          if (
            existing.payload.status === "requested" &&
            message.payload.status === "canceled" &&
            JSON.stringify({ ...existing, payload: { ...existing.payload, status: "canceled" } }) ===
              JSON.stringify(message)
          ) {
            const localStopReceipts = [...task.localStopReceipts!];
            localStopReceipts[localStopReceipts.indexOf(existing)] = structuredClone(message);
            recorded = { ...task, localStopReceipts, updatedAt: now() };
            return recorded;
          }
          if (JSON.stringify(existing) !== JSON.stringify(message)) {
            refusal = "Desktop Browser Local Stop Receipt identity already has different evidence";
            return task;
          }
          recorded = task;
          return task;
        }
        const terminal = task.status !== "waiting_for_broker" || task.outcome !== undefined;
        const next: DesktopBrowserTask = {
          ...task,
          ...(!terminal
            ? { status: "canceled_with_unknown_effects" as const, recoveryExpiresAt: now() + 15 * 60_000 }
            : {}),
          localStopReceipts: [...(task.localStopReceipts ?? []), structuredClone(message)],
          ...(terminal
            ? { auditWarnings: [...(task.auditWarnings ?? []), "Local Stop arrived after terminal Task outcome"] }
            : {}),
          updatedAt: now(),
        };
        recorded = next;
        return next;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!recorded) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(recorded) };
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
        const authority = parseDesktopBrowserSessionStartAuthorityEnvelope(
          {
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
          },
          relayConnection.protocolVersion,
          relayConnection.policyGrammarVersion,
        );
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
        if (execution.hostAccepted) {
          if (sameAccepted(execution.hostAccepted, accepted)) {
            recorded = task;
            return task;
          }
          refusal = "Desktop Browser Task already recorded Host acceptance";
          return task;
        }
        if (execution.hostResult) {
          refusal = "Desktop Browser Task already recorded a Host result";
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
        !!current.execution?.hostAccepted && !current.execution?.hostResult && result.payload.outcome === "completed";
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
        const at = now();
        if (result.payload.outcome !== "completed") {
          let attemptStatus: DesktopBrowserTaskExecution["attemptStatus"];
          if (result.payload.outcome === "failed") {
            attemptStatus = "accepted_failed";
          } else {
            attemptStatus = "accepted_unknown";
          }
          bound = {
            ...task,
            ...(result.payload.outcome === "unknown" && task.status === "waiting_for_broker" && !task.outcome
              ? { status: "canceled_with_unknown_effects" as const, recoveryExpiresAt: at + 15 * 60_000 }
              : {}),
            execution: {
              ...execution,
              attemptStatus,
              resultHash: result.payload.resultHash,
              resultRecordedAt: at,
              hostResult: structuredClone(result),
            },
            auditWarnings: lateResultWarnings(task, result.payload.operationId),
            updatedAt: at,
          };
          return bound;
        }
        if ("schemaVersion" in result.payload.result) {
          refusal = "Desktop Browser Host result is not a session-start result";
          return task;
        }
        const sessionStartResult = result.payload.result;
        if (sessionStartResult.browser_instance_id !== execution.operation.authority.browserInstanceId) {
          refusal = "Desktop Browser Host result browser does not match the prepared task";
          return task;
        }
        let currentRefusal: string | null = null;
        if (task.status !== "waiting_for_broker") {
          currentRefusal = "Desktop Browser Task is no longer waiting";
        } else if (task.authorityExpiresAt <= at) {
          currentRefusal = "Desktop Browser Turn authority expired; start a new Turn";
        } else if (authorityState) {
          currentRefusal = currentAuthorityRefusal(task, execution, authorityState);
        }
        if (currentRefusal) {
          bound = {
            ...task,
            execution: {
              ...execution,
              attemptStatus: "accepted_completed_unbound",
              resultHash: result.payload.resultHash,
              resultRecordedAt: at,
              hostResult: structuredClone(result),
            },
            auditWarnings: lateResultWarnings(task, result.payload.operationId),
            updatedAt: at,
          };
          return bound;
        }
        if (
          task.browserSkillSessionId !== undefined ||
          task.browserInstanceId !== undefined ||
          task.agentWindowId !== undefined
        ) {
          if (
            task.browserSkillSessionId === sessionStartResult.session_id &&
            task.browserInstanceId === sessionStartResult.browser_instance_id &&
            task.agentWindowId === sessionStartResult.agent_window_id &&
            execution.attemptStatus === "completed" &&
            execution.resultHash === result.payload.resultHash
          ) {
            bound = task;
            return task;
          }
          refusal = "Desktop Browser Task browser ownership is already bound";
          return task;
        }
        bound = {
          ...task,
          browserSkillSessionId: sessionStartResult.session_id,
          browserInstanceId: sessionStartResult.browser_instance_id,
          agentWindowId: sessionStartResult.agent_window_id,
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
    async prepareOperation(taskId, rawArgv, prepareOptions = {}) {
      const current = await backing.get(taskId);
      if (!current) return { status: "refused", reason: "Desktop Browser Task not found" };
      const recoveryMode = prepareOptions.recoveryMode;
      const terminalRecovery = recoveryMode !== undefined;
      if (
        recoveryMode === "observe" &&
        (current.status !== "canceled_with_unknown_effects" ||
          current.recoveryExpiresAt === undefined ||
          current.recoveryExpiresAt <= now())
      ) {
        return { status: "refused", reason: "browser_state_lost" };
      }
      if (recoveryMode === "cleanup" && current.status !== "canceled_with_unknown_effects") {
        return { status: "refused", reason: "browser_state_lost" };
      }
      if (!terminalRecovery && (current.status !== "waiting_for_broker" || current.outcome)) {
        return { status: "refused", reason: "Desktop Browser Task already has a terminal outcome" };
      }
      if (current.browserSkillSessionStoppedAt !== undefined) {
        return { status: "refused", reason: "Desktop Browser Task-owned session is stopped" };
      }
      if (
        !current.browserSkillSessionId ||
        !current.browserInstanceId ||
        current.execution?.attemptStatus !== "completed"
      ) {
        return { status: "refused", reason: "Desktop Browser Task has no Task-owned session" };
      }
      let argv: DesktopBrowserPhaseFArgv;
      try {
        argv = validateDesktopBrowserPhaseFArgv(rawArgv, {
          browserInstanceId: current.browserInstanceId,
          sessionId: current.browserSkillSessionId,
        });
      } catch {
        return { status: "refused", reason: "Desktop Browser argv does not use the Task-owned session" };
      }
      if (argv[1] === "session" && argv[2] === "start") {
        return { status: "refused", reason: "Desktop Browser Task already has a Task-owned session" };
      }
      if (recoveryMode === "observe" && argv[1] !== "observe") {
        return { status: "refused", reason: "Desktop Browser recovery must observe the Task-owned session first" };
      }
      if (recoveryMode === "cleanup" && !(argv[1] === "session" && argv[2] === "stop")) {
        return { status: "refused", reason: "Desktop Browser recovery must observe or clean up the Task-owned session" };
      }
      if (!supportsTicket06(current.execution.operation.authority.capabilitySet.protocolVersion)) {
        return { status: "refused", reason: "Desktop Browser connection does not support Ticket 06 operations" };
      }
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let prepared: DesktopBrowserPreparedOperation | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        if (
          recoveryMode === "observe" &&
          (task.status !== "canceled_with_unknown_effects" ||
            task.recoveryExpiresAt === undefined ||
            task.recoveryExpiresAt <= now())
        ) {
          refusal = "browser_state_lost";
          return task;
        }
        if (recoveryMode === "cleanup" && task.status !== "canceled_with_unknown_effects") {
          refusal = "browser_state_lost";
          return task;
        }
        if (!terminalRecovery && (task.outcome || task.status !== "waiting_for_broker")) {
          refusal = "Desktop Browser Task already has a terminal outcome";
          return task;
        }
        if (task.browserSkillSessionStoppedAt !== undefined) {
          refusal = "Desktop Browser Task-owned session is stopped";
          return task;
        }
        if (!task.browserSkillSessionId || !task.browserInstanceId || task.execution?.attemptStatus !== "completed") {
          refusal = "Desktop Browser Task has no Task-owned session";
          return task;
        }
        const operations = task.operations ?? [];
        const last = operations.at(-1);
        if (last && (last.status === "prepared" || last.status === "accepted")) {
          if (JSON.stringify(last.operation.authority.argv) === JSON.stringify(argv)) {
            prepared = last.operation;
            return task;
          }
          refusal = "Desktop Browser Task already has an operation in progress";
          return task;
        }
        if (!terminalRecovery && last?.status === "unknown") {
          refusal = "Desktop Browser Task has an unknown browser effect";
          return task;
        }
        let retryOfOperationId: string | undefined;
        if (last?.status === "result_lost_retryable") {
          if (
            last.retryOfOperationId !== undefined ||
            last.operation.authority.effectClass !== "observation" ||
            JSON.stringify(last.operation.authority.argv) !== JSON.stringify(argv)
          ) {
            refusal = "Desktop Browser observation result retry is unavailable";
            return task;
          }
          retryOfOperationId = last.operation.authority.operationId;
        }
        const at = now();
        if (!terminalRecovery && task.authorityExpiresAt <= at) {
          refusal = "Desktop Browser Turn authority expired; start a new Turn";
          return task;
        }
        const previousAuthority = last?.operation.authority ?? task.execution.operation.authority;
        const issuedAt = new Date(at).toISOString();
        const authority = parseDesktopBrowserOperationAuthorityEnvelope(
          {
            ...previousAuthority,
            leaseVersion: previousAuthority.leaseVersion + 1,
            leaseExpiresAt: new Date(at + DESKTOP_BROWSER_TASK_LEASE_DURATION_MS).toISOString(),
            operationId: id(),
            operationSequence: previousAuthority.operationSequence + 1,
            argv,
            effectClass: operationEffectClass(argv),
            nonce: id(),
            issuedAt,
          },
          previousAuthority.capabilitySet.protocolVersion,
          previousAuthority.capabilitySet.policyGrammarVersion,
        );
        prepared = {
          authority,
          requestHash: computeDesktopBrowserRequestHash(
            authority,
            authority.capabilitySet.protocolVersion,
            authority.capabilitySet.policyGrammarVersion,
          ),
        };
        return {
          ...task,
          operations: [
            ...operations,
            {
              operation: prepared,
              status: "prepared",
              createdAt: at,
              ...(retryOfOperationId ? { retryOfOperationId } : {}),
            },
          ],
          updatedAt: at,
        };
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!prepared) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", operation: structuredClone(prepared) };
    },
    async consumeOperationAccepted(taskId, input) {
      let accepted: HostAcceptedMessage;
      try {
        const decoded = decodeDesktopBrowserMessage(JSON.stringify(input), input.protocolVersion);
        if (decoded.kind !== "host.accepted") throw new Error("invalid kind");
        accepted = decoded;
      } catch {
        return { status: "refused", reason: "Desktop Browser Host acceptance is invalid" };
      }
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let recorded: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        const index = task.operations?.findIndex(
          (operation) => operation.operation.authority.operationId === accepted.payload.operationId,
        );
        if (index === undefined || index < 0 || !task.operations) {
          refusal = "Desktop Browser Task operation not found";
          return task;
        }
        const operation = task.operations[index]!;
        if (
          accepted.protocolVersion !== operation.operation.authority.capabilitySet.protocolVersion ||
          accepted.payload.requestHash !== operation.operation.requestHash
        ) {
          refusal = "Desktop Browser Host acceptance does not match the prepared operation";
          return task;
        }
        if (operation.hostAccepted) {
          if (sameAccepted(operation.hostAccepted, accepted)) {
            recorded = task;
            return task;
          }
          refusal = "Desktop Browser Task operation already recorded Host acceptance";
          return task;
        }
        if (operation.hostResult) {
          refusal = "Desktop Browser Task operation already recorded a Host result";
          return task;
        }
        const operations = [...task.operations];
        operations[index] = { ...operation, status: "accepted", hostAccepted: structuredClone(accepted) };
        recorded = { ...task, operations, updatedAt: now() };
        return recorded;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!recorded) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(recorded) };
    },
    async consumeOperationResult(taskId, input) {
      let result: HostResultMessage;
      try {
        const decoded = decodeDesktopBrowserMessage(JSON.stringify(input), input.protocolVersion);
        if (decoded.kind !== "host.result") throw new Error("invalid kind");
        result = decoded;
      } catch {
        return { status: "refused", reason: "Desktop Browser Host result is invalid" };
      }
      const resultPayload = result.payload;
      const completedResult = resultPayload.outcome === "completed" ? resultPayload.result : null;
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let recorded: DesktopBrowserTask | null = null;
      let observation: DesktopBrowserSanitizedObservationResult | undefined;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        const index = task.operations?.findIndex(
          (operation) => operation.operation.authority.operationId === resultPayload.operationId,
        );
        if (index === undefined || index < 0 || !task.operations) {
          refusal = "Desktop Browser Task operation not found";
          return task;
        }
        const operation = task.operations[index]!;
        if (result.protocolVersion !== operation.operation.authority.capabilitySet.protocolVersion) {
          refusal = "Desktop Browser Host result protocol does not match the prepared operation";
          return task;
        }
        if (!operation.hostAccepted || operation.hostAccepted.payload.dispatchId !== resultPayload.dispatchId) {
          refusal = "Desktop Browser Host result requires its matching acceptance";
          return task;
        }
        if (operation.hostResult) {
          if (sameResult(operation.hostResult, result)) {
            recorded = task;
            if (
              resultPayload.outcome === "completed" &&
              "schemaVersion" in resultPayload.result &&
              resultPayload.result.command === "observe"
            ) {
              observation = resultPayload.result;
            }
            return task;
          }
          refusal = "Desktop Browser Task operation already recorded a Host result";
          return task;
        }
        let status: DesktopBrowserTaskOperation["status"];
        if (resultPayload.outcome === "failed") status = "failed";
        else if (resultPayload.outcome === "unknown") {
          status = operation.operation.authority.effectClass === "observation" ? "result_lost_retryable" : "unknown";
        } else {
          if (!completedResult || !("schemaVersion" in completedResult)) {
            refusal = "Desktop Browser Host result is not a Task operation result";
            return task;
          }
          const expectedCommand = operationResultCommand(operation.operation.authority.argv);
          if (completedResult.command !== expectedCommand) {
            refusal = "Desktop Browser Host result command does not match the prepared operation";
            return task;
          }
          status = "completed";
          if (completedResult.command === "observe") observation = completedResult;
        }
        const at = now();
        const operations = [...task.operations];
        operations[index] = {
          ...operation,
          status,
          hostResult: structuredClone(result),
          resultRecordedAt: at,
        };
        const stopped =
          completedResult && "schemaVersion" in completedResult && completedResult.command === "session.stop";
        recorded = {
          ...task,
          ...(status === "unknown" && task.status === "waiting_for_broker" && !task.outcome
            ? { status: "canceled_with_unknown_effects" as const, recoveryExpiresAt: at + 15 * 60_000 }
            : {}),
          operations,
          ...(observation ? { latestObservation: structuredClone(observation) } : {}),
          ...(stopped ? { browserSkillSessionStoppedAt: at } : {}),
          auditWarnings: lateResultWarnings(task, resultPayload.operationId),
          updatedAt: at,
        };
        return recorded;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!recorded) return { status: "refused", reason: "Desktop Browser Task not found" };
      return {
        status: "ok",
        task: copy(recorded),
        ...(observation ? { observation: structuredClone(observation) } : {}),
      };
    },
    async markOperationDeliveryUnknown(taskId, operationId) {
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let recorded: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        const index = task.operations?.findIndex(
          (operation) => operation.operation.authority.operationId === operationId,
        );
        if (index === undefined || index < 0 || !task.operations) {
          refusal = "Desktop Browser Task operation not found";
          return task;
        }
        const operation = task.operations[index]!;
        if (operation.status !== "prepared") {
          if (operation.status === "unknown") {
            recorded = task;
            return task;
          }
          refusal = "Desktop Browser Task operation delivery is already settled";
          return task;
        }
        const operations = [...task.operations];
        const at = now();
        operations[index] = { ...operation, status: "unknown", resultRecordedAt: at };
        recorded = {
          ...task,
          ...(operation.operation.authority.effectClass === "observation" ||
          task.status !== "waiting_for_broker" ||
          task.outcome
            ? {}
            : { status: "canceled_with_unknown_effects" as const, recoveryExpiresAt: at + 15 * 60_000 }),
          operations,
          updatedAt: at,
        };
        return recorded;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!recorded) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(recorded) };
    },
    async finalize(taskId, input) {
      if (!input.summary.trim()) return { status: "refused", reason: "Desktop Browser Task summary is required" };
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let finalized: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        const summary = input.summary.trim();
        if (
          task.outcome?.outcome === input.outcome &&
          task.outcome.summary === summary &&
          task.finalizationAudit !== undefined
        ) {
          finalized = task;
          return task;
        }
        if (task.outcome || task.status !== "waiting_for_broker") {
          refusal = "Desktop Browser Task already has a terminal outcome";
          return task;
        }
        if (task.execution?.attemptStatus !== "completed") {
          refusal = "Desktop Browser Task has no completed session start";
          return task;
        }
        const at = now();
        finalized = {
          ...task,
          status: input.outcome,
          outcome: { outcome: input.outcome, summary, finalizedAt: at },
          finalizationAudit: {
            idempotencyKey: `desktop-browser-finalize:${task.id}`,
            status: "pending",
          },
          updatedAt: at,
        };
        return finalized;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!finalized) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(finalized) };
    },
    async listPendingFinalizationAudits() {
      return (await backing.all())
        .filter((task) => task.outcome && task.finalizationAudit?.status === "pending")
        .sort(
          (left, right) => left.outcome!.finalizedAt - right.outcome!.finalizedAt || left.id.localeCompare(right.id),
        )
        .map(copy);
    },
    async markFinalizationAudited(taskId, idempotencyKey) {
      if (!backing.update) throw new Error("desktop browser task storage does not support atomic updates");
      let recorded: DesktopBrowserTask | null = null;
      let refusal: string | null = null;
      await backing.update(taskId, (task) => {
        if (!task.outcome || !task.finalizationAudit) {
          refusal = "Desktop Browser Task has no pending finalization audit";
          return task;
        }
        if (task.finalizationAudit.idempotencyKey !== idempotencyKey) {
          refusal = "Desktop Browser finalization audit identity does not match";
          return task;
        }
        if (task.finalizationAudit.status === "recorded") {
          recorded = task;
          return task;
        }
        recorded = {
          ...task,
          finalizationAudit: { ...task.finalizationAudit, status: "recorded" },
          updatedAt: now(),
        };
        return recorded;
      });
      if (refusal) return { status: "refused", reason: refusal };
      if (!recorded) return { status: "refused", reason: "Desktop Browser Task not found" };
      return { status: "ok", task: copy(recorded) };
    },
  };
}

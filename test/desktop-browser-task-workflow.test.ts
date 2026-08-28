import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  buildDesktopBrowserNavigateArgv,
  buildDesktopBrowserObserveArgv,
  buildDesktopBrowserSessionStartArgv,
  buildDesktopBrowserSessionStopArgv,
  computeDesktopBrowserRequestHash,
  type DesktopBrowserSessionStartAuthorityEnvelope,
  type HostAcceptedMessage,
  type HostResultMessage,
} from "qm-desktop-browser-contracts";
import { createTurnMethods } from "../src/api/app-turn.ts";
import { createDesktopBrowserTaskStore, type DesktopBrowserTask } from "../src/desktop-browser/browser-task-store.ts";
import { createDesktopBrowserOperationCoordinator } from "../src/desktop-browser/operation-coordinator.ts";
import { reconcileDesktopBrowserFinalizationAudits } from "../src/desktop-browser/finalization-audit.ts";
import { projectDesktopBrowserTaskActivity } from "../src/desktop-browser/task-activity.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("Ticket 06 returns sanitized observation and only explicit Core finalize completes the Task", async () => {
  const startedAt = Date.parse("2036-08-27T12:00:00.000Z");
  let currentTime = startedAt;
  const generatedIds = [
    "task-1",
    "attempt-1",
    "lease-1",
    "operation-start",
    "nonce-start",
    "operation-navigate",
    "nonce-navigate",
    "operation-observe",
    "nonce-observe",
    "operation-stop",
    "nonce-stop",
  ];
  const authorityState = {
    registration: {
      deploymentCanonicalId: "qm://deployments/example",
      registrationId: "registration-1",
      waitingTaskId: "task-1",
      actorId: "actor-1",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: startedAt + 120_000,
      publicDeviceFingerprint: "sha256:device-1",
      browserInstanceId: "browser-primary",
      status: "online" as const,
      browserRuntimeStatus: "ready" as const,
    },
    relayConnection: {
      connectionId: "connection-1",
      publicDeviceFingerprint: "sha256:device-1",
      brokerInstanceId: "broker-1",
      browserInstanceId: "browser-primary",
      connectionEpoch: 7,
      registrationState: "registered" as const,
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      policyGrammarVersion: "1.0",
      brokerVersion: "2.0.0",
      bskVersion: "3.0.0",
      extensionVersion: "4.0.0",
      cliShapeHash: "sha256:cli-shape-1",
      lastSeenAt: "2036-08-27T12:00:00.000Z",
    },
  };
  const backing = createMemoryMap<DesktopBrowserTask>();
  const store = createDesktopBrowserTaskStore(backing, {
    id: () => generatedIds.shift()!,
    now: () => currentTime,
    sessionStartAuthority: async () => structuredClone(authorityState),
  });
  const task = await store.createWaiting({
    goal: "Inspect the example page",
    actorId: "actor-1",
    projectId: "project-1",
    projectName: "Apollo",
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: startedAt + 120_000,
    sessionId: "conversation-1",
    threadRef: "thread-1",
  });
  const preparedStart = await store.prepareSessionStart(task.id);
  assert.equal(preparedStart.status, "ok");
  const startAccepted: HostAcceptedMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-start",
      operationId: preparedStart.operation.authority.operationId,
      requestHash: preparedStart.operation.requestHash,
    },
  };
  assert.equal((await store.consumeSessionStartAccepted(task.id, startAccepted)).status, "ok");
  const startResult: HostResultMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-start",
      operationId: preparedStart.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:start",
      result: { session_id: "browser-session-1", browser_instance_id: "browser-primary", agent_window_id: 42 },
    },
  };
  assert.equal(
    (await store.consumeSessionStartResult(task.id, startResult, { status: "ok", authority: authorityState })).status,
    "ok",
  );
  const auditEntries: Array<Record<string, unknown>> = [];
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (principalId: string) => ({ id: principalId, type: "internal" }),
        isInternal: () => true,
      },
      projects: {
        withRosterLock: async (_projectId: string, fn: (project: unknown) => Promise<unknown>) =>
          fn({
            id: "project-1",
            orgId: "default-org",
            ownerId: "actor-1",
            memberIds: [],
            channelMemberIds: [],
            updatedAt: 42,
          }),
      },
      desktopBrowserTasks: store,
      auditLog: {
        record: () => undefined,
        recordOnce: async (_key: string, entry: Record<string, unknown>) => {
          auditEntries.push(entry);
        },
      },
      publicWebUrl: "https://qm.example.com",
    } as any,
    {} as any,
    {} as any,
  );

  currentTime += 1_000;
  const navigate = await app.desktopBrowserPrepareOperation(
    task.id,
    "authority-1",
    buildDesktopBrowserNavigateArgv("https://example.test", "browser-session-1"),
  );
  assert.equal(navigate.status, "ok");
  assert.equal(navigate.operation.authority.operationSequence, 2);
  assert.equal(navigate.operation.authority.effectClass, "browser_effect");
  const navigateAccepted: HostAcceptedMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-navigate",
      operationId: navigate.operation.authority.operationId,
      requestHash: navigate.operation.requestHash,
    },
  };
  assert.equal((await app.desktopBrowserConsumeOperationAccepted(task.id, navigateAccepted)).status, "ok");
  const navigateResult: HostResultMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-navigate",
      operationId: navigate.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:navigate",
      result: {
        schemaVersion: "1.0",
        command: "navigate",
        completedAt: "2036-08-27T12:00:01.000Z",
        data: { tab_id: 7, reached: "load" },
      },
    },
  };
  assert.equal((await app.desktopBrowserConsumeOperationResult(task.id, navigateResult)).status, "ok");

  currentTime += 1_000;
  const observe = await app.desktopBrowserPrepareOperation(
    task.id,
    "authority-1",
    buildDesktopBrowserObserveArgv("browser-session-1"),
  );
  assert.equal(observe.status, "ok");
  assert.equal(observe.operation.authority.operationSequence, 3);
  const observeAccepted: HostAcceptedMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-observe",
      operationId: observe.operation.authority.operationId,
      requestHash: observe.operation.requestHash,
    },
  };
  assert.equal((await app.desktopBrowserConsumeOperationAccepted(task.id, observeAccepted)).status, "ok");
  const observeResult: HostResultMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-observe",
      operationId: observe.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:observe",
      result: {
        schemaVersion: "1.0",
        command: "observe",
        completedAt: "2036-08-27T12:00:02.000Z",
        data: { tab_id: 7, text: "Heading: Example", ref_count: 2, truncated: false },
      },
    },
  };
  const observed = await app.desktopBrowserConsumeOperationResult(task.id, observeResult);
  assert.equal(observed.status, "ok");
  assert.deepEqual(
    observed.observation,
    observeResult.payload.outcome === "completed" ? observeResult.payload.result : null,
  );

  currentTime += 1_000;
  const stop = await app.desktopBrowserPrepareOperation(
    task.id,
    "authority-1",
    buildDesktopBrowserSessionStopArgv("browser-session-1"),
  );
  assert.equal(stop.status, "ok");
  const stopAccepted: HostAcceptedMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-stop",
      operationId: stop.operation.authority.operationId,
      requestHash: stop.operation.requestHash,
    },
  };
  assert.equal((await app.desktopBrowserConsumeOperationAccepted(task.id, stopAccepted)).status, "ok");
  const stopResult: HostResultMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-stop",
      operationId: stop.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:stop",
      result: {
        schemaVersion: "1.0",
        command: "session.stop",
        completedAt: "2036-08-27T12:00:03.000Z",
        data: { returned_tab_ids: [7], return_failures: [] },
      },
    },
  };
  const stopped = await app.desktopBrowserConsumeOperationResult(task.id, stopResult);
  assert.equal(stopped.status, "ok");
  assert.equal(stopped.task.status, "waiting_for_broker");
  assert.equal(stopped.task.browserSkillSessionId, "browser-session-1");
  assert.equal(stopped.task.browserInstanceId, "browser-primary");
  assert.equal(stopped.task.agentWindowId, 42);
  assert.equal(stopped.task.browserSkillSessionStoppedAt, currentTime);
  assert.deepEqual(
    await app.desktopBrowserPrepareOperation(
      task.id,
      "authority-1",
      buildDesktopBrowserObserveArgv("browser-session-1"),
    ),
    { status: "refused", reason: "Desktop Browser Task-owned session is stopped" },
  );

  currentTime += 1_000;
  const finalized = await app.desktopBrowserFinalizeTask(task.id, "actor-1", "authority-1", {
    outcome: "completed",
    summary: "Example page inspected",
  });
  assert.equal(finalized.status, "ok");
  assert.equal(finalized.task.status, "completed");
  assert.equal(finalized.task.outcome?.summary, "Example page inspected");
  assert.deepEqual(projectDesktopBrowserTaskActivity(finalized.task, "https://qm.example.com", null), {
    taskId: "task-1",
    status: "completed",
    actionAuthority: "authority-1",
    actions: [],
    result: {
      outcome: "completed",
      summary: "Example page inspected",
      actorId: "actor-1",
      projectId: "project-1",
      browserSkillSessionId: "browser-session-1",
      browserInstanceId: "browser-primary",
      agentWindowId: 42,
      observation: {
        schemaVersion: "1.0",
        command: "observe",
        completedAt: "2036-08-27T12:00:02.000Z",
        data: { tab_id: 7, text: "Heading: Example", ref_count: 2, truncated: false },
      },
    },
  });
  assert.deepEqual(auditEntries, [
    {
      at: currentTime,
      principalId: "actor-1",
      action: "desktop_browser.task.finalized",
      resource: "task-1",
      scopeLabel: "group:web-project-project-1",
      status: "completed",
    },
  ]);
  const conflicting = await app.desktopBrowserFinalizeTask(task.id, "actor-1", "authority-1", {
    outcome: "failed",
    summary: "late failure",
  });
  assert.deepEqual(conflicting, { status: "refused", reason: "Desktop Browser Task already has a terminal outcome" });
  assert.equal((await store.get(task.id))?.status, "completed");
  assert.equal((await store.get(task.id))?.finalizationAudit?.status, "recorded");
  assert.deepEqual(generatedIds, []);
});

function readyTask(id: string, operationId: string): DesktopBrowserTask {
  const issuedAt = "2036-08-27T12:00:00.000Z";
  const authority: DesktopBrowserSessionStartAuthorityEnvelope = {
    authorityVersion: "1.0",
    audience: "qm-desktop-broker-relay",
    deploymentCanonicalId: "qm://deployments/example",
    actorId: "actor-1",
    actorSnapshotHash: "sha256:actor",
    projectId: "project-1",
    projectSnapshotHash: "sha256:project",
    membershipEpoch: 42,
    taskId: id,
    attemptId: `attempt-${id}`,
    deviceId: "sha256:device-1",
    browserInstanceId: "browser-primary",
    leaseId: `lease-${id}`,
    leaseVersion: 1,
    leaseExpiresAt: "2036-08-27T12:01:00.000Z",
    operationId,
    operationSequence: 1,
    capabilitySet: {
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      policyGrammarVersion: "1.0",
      bskVersion: "3.0.0",
      extensionVersion: "4.0.0",
      cliShapeHash: "sha256:cli-shape-1",
    },
    argv: buildDesktopBrowserSessionStartArgv("browser-primary"),
    brokerOptions: { forceSharedRuntime: false },
    effectClass: "local_effect",
    nonce: `nonce-${id}`,
    issuedAt,
  };
  return {
    id,
    status: "waiting_for_broker",
    goal: "Inspect the page",
    actorId: "actor-1",
    actorSnapshot: { id: "actor-1" },
    projectId: "project-1",
    projectSnapshot: { id: "project-1", name: "Apollo" },
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: Date.parse("2036-08-27T14:00:00.000Z"),
    sessionId: `conversation-${id}`,
    threadRef: `thread-${id}`,
    createdAt: Date.parse(issuedAt),
    updatedAt: Date.parse(issuedAt),
    execution: {
      attemptId: authority.attemptId,
      attemptStatus: "completed",
      leaseId: authority.leaseId,
      leaseVersion: authority.leaseVersion,
      operation: {
        authority,
        requestHash: computeDesktopBrowserRequestHash(authority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
      },
      createdAt: Date.parse(issuedAt),
    },
    browserSkillSessionId: `browser-session-${id}`,
    browserInstanceId: "browser-primary",
    agentWindowId: 42,
  };
}

function acceptedFor(operation: { authority: { operationId: string }; requestHash: string }, dispatchId: string) {
  return {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: { dispatchId, operationId: operation.authority.operationId, requestHash: operation.requestHash },
  } as const satisfies HostAcceptedMessage;
}

function unknownFor(operationId: string, dispatchId: string) {
  return {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: { dispatchId, operationId, outcome: "unknown", resultHash: `sha256:${operationId}` },
  } as const satisfies HostResultMessage;
}

test("Ticket 06 never retries unknown navigate and retries lost observation once with a new identity", async () => {
  const currentTime = Date.parse("2036-08-27T12:00:10.000Z");
  const navigateBacking = createMemoryMap<DesktopBrowserTask>();
  await navigateBacking.put("navigate-task", readyTask("navigate-task", "start-navigate"));
  const navigateIds = ["navigate-operation", "navigate-nonce"];
  const navigateStore = createDesktopBrowserTaskStore(navigateBacking, {
    id: () => navigateIds.shift()!,
    now: () => currentTime,
  });
  const navigate = await navigateStore.prepareOperation(
    "navigate-task",
    buildDesktopBrowserNavigateArgv("https://example.test", "browser-session-navigate-task"),
  );
  assert.equal(navigate.status, "ok");
  await navigateStore.consumeOperationAccepted("navigate-task", acceptedFor(navigate.operation, "dispatch-navigate"));
  await navigateStore.consumeOperationResult(
    "navigate-task",
    unknownFor(navigate.operation.authority.operationId, "dispatch-navigate"),
  );
  assert.deepEqual(
    await navigateStore.prepareOperation(
      "navigate-task",
      buildDesktopBrowserNavigateArgv("https://example.test", "browser-session-navigate-task"),
    ),
    { status: "refused", reason: "Desktop Browser Task has an unknown browser effect" },
  );
  assert.deepEqual(navigateIds, []);

  const observeBacking = createMemoryMap<DesktopBrowserTask>();
  await observeBacking.put("observe-task", readyTask("observe-task", "start-observe"));
  const observeIds = ["observe-operation", "observe-nonce", "observe-retry-operation", "observe-retry-nonce"];
  const observeStore = createDesktopBrowserTaskStore(observeBacking, {
    id: () => observeIds.shift()!,
    now: () => currentTime,
  });
  const argv = buildDesktopBrowserObserveArgv("browser-session-observe-task");
  const observe = await observeStore.prepareOperation("observe-task", argv);
  assert.equal(observe.status, "ok");
  await observeStore.consumeOperationAccepted("observe-task", acceptedFor(observe.operation, "dispatch-observe"));
  await observeStore.consumeOperationResult(
    "observe-task",
    unknownFor(observe.operation.authority.operationId, "dispatch-observe"),
  );
  const retry = await observeStore.prepareOperation("observe-task", argv);
  assert.equal(retry.status, "ok");
  assert.notEqual(retry.operation.authority.operationId, observe.operation.authority.operationId);
  assert.equal(retry.operation.authority.operationSequence, 3);
  await observeStore.consumeOperationAccepted("observe-task", acceptedFor(retry.operation, "dispatch-retry"));
  await observeStore.consumeOperationResult(
    "observe-task",
    unknownFor(retry.operation.authority.operationId, "dispatch-retry"),
  );
  assert.deepEqual(await observeStore.prepareOperation("observe-task", argv), {
    status: "refused",
    reason: "Desktop Browser observation result retry is unavailable",
  });
  assert.deepEqual(observeIds, []);
});

test("Ticket 06 coordinator returns observation to the current Task-scoped Agent session", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-coordinator", readyTask("task-coordinator", "start-coordinator"));
  const ids = ["observe-coordinator", "nonce-coordinator"];
  const store = createDesktopBrowserTaskStore(backing, {
    id: () => ids.shift()!,
    now: () => Date.parse("2036-08-27T12:00:10.000Z"),
  });
  const dispatches: unknown[] = [];
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    createDispatchId: () => "dispatch-coordinator",
    dispatcher: {
      async dispatch(input) {
        dispatches.push(input);
        const operation = input.invocation.payload;
        const accepted: HostAcceptedMessage = {
          protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
          kind: "host.accepted",
          payload: {
            dispatchId: operation.dispatchId,
            operationId: operation.authority.operationId,
            requestHash: operation.requestHash,
          },
        };
        const result: HostResultMessage = {
          protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
          kind: "host.result",
          payload: {
            dispatchId: operation.dispatchId,
            operationId: operation.authority.operationId,
            outcome: "completed",
            resultHash: "sha256:coordinator-observe",
            result: {
              schemaVersion: "1.0",
              command: "observe",
              completedAt: "2036-08-27T12:00:10.000Z",
              data: { tab_id: 7, text: "Heading: Example", ref_count: 2, truncated: false },
            },
          },
        };
        return { kind: "host.result" as const, accepted, result };
      },
    },
  });

  const invoked = await coordinator.invokeForSession({
    sessionId: "conversation-task-coordinator",
    actorId: "actor-1",
    projectScopeLabel: "group:web-project-project-1",
    projectMembershipVersion: "42",
    argv: buildDesktopBrowserObserveArgv("browser-session-task-coordinator"),
  });

  assert.equal(invoked.status, "ok");
  assert.equal(invoked.taskId, "task-coordinator");
  assert.equal(invoked.observation?.data.text, "Heading: Example");
  assert.equal(dispatches.length, 1);
  assert.equal((await store.get("task-coordinator"))?.operations?.at(-1)?.status, "completed");
  assert.deepEqual(ids, []);
});

test("Ticket 06 coordinator never redispatches navigate after ambiguous Relay delivery", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-ambiguous", readyTask("task-ambiguous", "start-ambiguous"));
  const ids = ["navigate-ambiguous", "nonce-ambiguous"];
  const store = createDesktopBrowserTaskStore(backing, {
    id: () => ids.shift()!,
    now: () => Date.parse("2036-08-27T12:00:10.000Z"),
  });
  let dispatches = 0;
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    createDispatchId: () => "dispatch-ambiguous",
    dispatcher: {
      async dispatch(input) {
        dispatches += 1;
        return {
          kind: "not_accepted_or_unknown",
          dispatchId: input.invocation.payload.dispatchId,
          operationId: input.invocation.payload.authority.operationId,
          requestHash: input.invocation.payload.requestHash,
          error: { code: "relay_delivery_unknown", message: "delivery unknown" },
        };
      },
    },
  });
  const input = {
    sessionId: "conversation-task-ambiguous",
    actorId: "actor-1",
    projectScopeLabel: "group:web-project-project-1",
    projectMembershipVersion: "42",
    argv: buildDesktopBrowserNavigateArgv("https://example.test", "browser-session-task-ambiguous"),
  };

  assert.deepEqual(await coordinator.invokeForSession(input), {
    status: "refused",
    reason: "Desktop Browser Relay could not prove Host acceptance",
  });
  assert.deepEqual(await coordinator.invokeForSession(input), {
    status: "refused",
    reason: "Desktop Browser Task has an unknown browser effect",
  });
  assert.equal(dispatches, 1);
});

test("Ticket 06 reconciles a finalization audit after a crash-window write failure", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-audit", readyTask("task-audit", "start-audit"));
  const store = createDesktopBrowserTaskStore(backing, {
    now: () => Date.parse("2036-08-27T12:00:10.000Z"),
  });
  const finalized = await store.finalize("task-audit", { outcome: "completed", summary: "Inspected" });
  assert.equal(finalized.status, "ok");
  let attempts = 0;
  const events: unknown[] = [];
  const auditLog = {
    record: () => undefined,
    async recordOnce(_key: string, event: unknown) {
      attempts += 1;
      if (attempts === 1) throw new Error("audit unavailable");
      events.push(event);
    },
    async events() {
      return [];
    },
    async tail() {
      return [];
    },
  };

  await assert.rejects(reconcileDesktopBrowserFinalizationAudits(store, auditLog), /audit unavailable/);
  assert.equal((await store.get("task-audit"))?.finalizationAudit?.status, "pending");
  await reconcileDesktopBrowserFinalizationAudits(store, auditLog);
  assert.equal((await store.get("task-audit"))?.finalizationAudit?.status, "recorded");
  assert.equal(events.length, 1);
});

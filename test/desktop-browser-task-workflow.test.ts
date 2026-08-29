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
  type HostLocalStopReceiptMessage,
  type HostResultMessage,
} from "qm-desktop-browser-contracts";
import { createTurnMethods } from "../src/api/app-turn.ts";
import { createDesktopBrowserTaskStore, type DesktopBrowserTask } from "../src/desktop-browser/browser-task-store.ts";
import { createDesktopBrowserOperationCoordinator } from "../src/desktop-browser/operation-coordinator.ts";
import { reconcileDesktopBrowserFinalizationAudits } from "../src/desktop-browser/finalization-audit.ts";
import { reconcileDesktopBrowserStops } from "../src/desktop-browser/stop-delivery.ts";
import { reconcileDesktopBrowserAttempts } from "../src/desktop-browser/attempt-reconciliation.ts";
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
  assert.deepEqual(await app.desktopBrowserConsumeRelayTerminalCallback(task.id, observeAccepted, observeResult), {
    status: "ok",
  });

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
    { status: "refused", reason: "Desktop Browser Task already has a terminal outcome" },
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

test("Ticket 09 coordinator starts and binds the Task-owned BrowserSkill session", async () => {
  const task = readyTask("task-continue-start", "old-start");
  const previousAuthority = task.execution!.operation.authority;
  task.execution = undefined;
  task.browserSkillSessionId = undefined;
  task.browserInstanceId = undefined;
  task.agentWindowId = undefined;
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put(task.id, task);
  const ids = ["attempt-continue", "lease-continue", "operation-continue", "nonce-continue"];
  const store = createDesktopBrowserTaskStore(backing, {
    id: () => ids.shift()!,
    now: () => Date.parse("2036-08-27T12:00:10.000Z"),
    sessionStartAuthority: async () => ({
      registration: {
        deploymentCanonicalId: previousAuthority.deploymentCanonicalId,
        registrationId: "registration-continue",
        waitingTaskId: task.id,
        actorId: task.actorId,
        projectId: task.projectId,
        membershipEpoch: 42,
        authorityId: task.authorityId,
        authorityExpiresAt: task.authorityExpiresAt,
        publicDeviceFingerprint: previousAuthority.deviceId,
        browserInstanceId: previousAuthority.browserInstanceId,
        status: "online",
        browserRuntimeStatus: "ready",
      },
      relayConnection: {
        connectionId: "connection-continue",
        publicDeviceFingerprint: previousAuthority.deviceId,
        brokerInstanceId: "broker-continue",
        browserInstanceId: previousAuthority.browserInstanceId,
        connectionEpoch: 8,
        registrationState: "registered",
        protocolVersion: previousAuthority.capabilitySet.protocolVersion,
        policyGrammarVersion: previousAuthority.capabilitySet.policyGrammarVersion,
        brokerVersion: "2.0.0",
        bskVersion: previousAuthority.capabilitySet.bskVersion,
        extensionVersion: previousAuthority.capabilitySet.extensionVersion,
        cliShapeHash: previousAuthority.capabilitySet.cliShapeHash,
        lastSeenAt: "2036-08-27T12:00:09.000Z",
      },
    }),
  });
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    createDispatchId: () => "dispatch-continue-start",
    dispatcher: {
      async dispatch(input) {
        const operation = input.invocation.payload;
        return {
          kind: "host.result" as const,
          accepted: acceptedFor(operation, operation.dispatchId),
          result: {
            protocolVersion: operation.authority.capabilitySet.protocolVersion,
            kind: "host.result" as const,
            payload: {
              dispatchId: operation.dispatchId,
              operationId: operation.authority.operationId,
              outcome: "completed" as const,
              resultHash: "sha256:continue-start",
              result: {
                session_id: "browser-session-continue",
                browser_instance_id: "browser-primary",
                agent_window_id: 77,
              },
            },
          },
        };
      },
    },
  });

  assert.deepEqual(await coordinator.startForTask(task.id), { status: "ok" });
  const started = await store.get(task.id);
  assert.equal(started?.execution?.attemptId, "attempt-continue");
  assert.equal(started?.browserSkillSessionId, "browser-session-continue");
  assert.equal(started?.agentWindowId, 77);
});

test("Ticket 09 coordinator refuses device_busy before creating an Attempt", async () => {
  const task = readyTask("task-device-busy", "old-device-busy");
  task.execution = undefined;
  task.browserSkillSessionId = undefined;
  task.browserInstanceId = undefined;
  task.agentWindowId = undefined;
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put(task.id, task);
  const store = createDesktopBrowserTaskStore(backing);
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    claimDevice: async () => ({ status: "refused", reason: "device_busy" }),
    dispatcher: { dispatch: async () => assert.fail("busy Device must not dispatch") },
  });

  assert.deepEqual(await coordinator.startForTask(task.id), { status: "refused", reason: "device_busy" });
  assert.equal((await store.get(task.id))?.execution, undefined);
});

test("Ticket 09 an enqueued Continue cannot start after Stop wins", async () => {
  const task = readyTask("task-stopped-before-continue", "old-stopped-before-continue");
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put(task.id, task);
  const store = createDesktopBrowserTaskStore(backing, { now: () => 15_000 });
  await store.requestStop(task.id, { requestedBy: task.actorId, reason: "webui" });
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    claimDevice: async () => assert.fail("stopped Task must not claim a Device"),
    dispatcher: { dispatch: async () => assert.fail("stopped Task must not dispatch") },
  });

  assert.deepEqual(await coordinator.startForTask(task.id), {
    status: "refused",
    reason: "Desktop Browser Task is no longer waiting",
  });
});

test("Ticket 09 finalization releases the Device only after session cleanup", async () => {
  const task = readyTask("task-release-device", "start-release-device");
  task.browserSkillSessionStoppedAt = 12_000;
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put(task.id, task);
  const store = createDesktopBrowserTaskStore(backing, { now: () => 13_000 });
  const released: string[] = [];
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    dispatcher: { dispatch: async () => assert.fail("finalize must not dispatch") },
    auditLog: { recordOnce: async () => undefined } as any,
    releaseDevice: async (taskId) => {
      released.push(taskId);
    },
  });

  assert.deepEqual(
    await coordinator.finalizeForSession({
      sessionId: task.sessionId,
      actorId: task.actorId,
      projectScopeLabel: "group:web-project-project-1",
      projectMembershipVersion: task.projectMembershipVersion,
      outcome: "completed",
      summary: "Original goal completed",
    }),
    { status: "ok", taskId: task.id },
  );
  assert.deepEqual(released, [task.id]);
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
    reason: "No active Desktop Browser Task belongs to this Agent session",
  });
  assert.equal(dispatches, 1);
  assert.equal((await store.get("task-ambiguous"))?.status, "canceled_with_unknown_effects");
});

test("Ticket 08 coordinator does not return a late Host completion after Stop wins", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-late-stop", readyTask("task-late-stop", "start-late-stop"));
  const ids = ["observe-late-stop", "nonce-late-stop"];
  const store = createDesktopBrowserTaskStore(backing, { id: () => ids.shift()!, now: () => 11_000 });
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    createDispatchId: () => "dispatch-late-stop",
    dispatcher: {
      async dispatch(input) {
        const operation = input.invocation.payload;
        await store.requestStop("task-late-stop", { requestedBy: "actor-1", reason: "webui" });
        return {
          kind: "host.result" as const,
          accepted: acceptedFor(operation, operation.dispatchId),
          result: {
            protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
            kind: "host.result" as const,
            payload: {
              dispatchId: operation.dispatchId,
              operationId: operation.authority.operationId,
              outcome: "completed" as const,
              resultHash: "sha256:late-completion",
              result: {
                schemaVersion: "1.0" as const,
                command: "observe" as const,
                completedAt: "2036-08-27T12:00:11.000Z",
                data: { tab_id: 7, text: "Late", ref_count: 0, truncated: false },
              },
            },
          },
        };
      },
    },
  });

  assert.deepEqual(
    await coordinator.invokeForSession({
      sessionId: "conversation-task-late-stop",
      actorId: "actor-1",
      projectScopeLabel: "group:web-project-project-1",
      projectMembershipVersion: "42",
      argv: buildDesktopBrowserObserveArgv("browser-session-task-late-stop"),
    }),
    { status: "refused", reason: "Desktop Browser Task was stopped; browser effects may be unknown" },
  );
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

test("Ticket 08 persists Stop and Lease revoke before late result evidence without rewriting outcome", async () => {
  const now = Date.parse("2036-08-27T12:00:10.000Z");
  const backing = createMemoryMap<DesktopBrowserTask>();
  const task = readyTask("task-stop", "start-stop");
  await backing.put(task.id, task);
  const ids = ["navigate-stop", "nonce-stop"];
  const store = createDesktopBrowserTaskStore(backing, { id: () => ids.shift()!, now: () => now });
  const prepared = await store.prepareOperation(
    task.id,
    buildDesktopBrowserNavigateArgv("https://example.test", "browser-session-task-stop"),
  );
  assert.equal(prepared.status, "ok");
  const accepted = acceptedFor(prepared.operation, "dispatch-stop");
  assert.equal((await store.consumeOperationAccepted(task.id, accepted)).status, "ok");

  const stopped = await store.requestStop(task.id, { requestedBy: "actor-1", reason: "webui" });
  assert.equal(stopped.status, "ok");
  assert.equal(stopped.task.status, "canceled_with_unknown_effects");
  assert.deepEqual(stopped.task.stopIntent, {
    requestedBy: "actor-1",
    reason: "webui",
    requestedAt: now,
    auditStatus: "pending",
    revocationStatus: "pending",
  });
  assert.deepEqual(stopped.task.leaseRevocation, {
    leaseId: task.execution!.leaseId,
    leaseVersion: 3,
    revokedAt: now,
  });
  assert.deepEqual(await store.requestStop(task.id, { requestedBy: "actor-1", reason: "webui" }), stopped);
  const restarted = createDesktopBrowserTaskStore(backing, { now: () => now + 1 });
  assert.deepEqual(await restarted.listPendingStops(), [stopped.task]);
  const retried = await restarted.requestStop(task.id, { requestedBy: "administrator-2", reason: "admin" });
  assert.equal(retried.status, "ok");
  assert.equal(retried.task.stopIntent?.requestedBy, "actor-1");
  await restarted.markStopAudited(task.id);
  await restarted.markStopRevocationDelivered(task.id);
  assert.deepEqual(await restarted.listPendingStops(), []);
  assert.deepEqual(await store.prepareOperation(task.id, buildDesktopBrowserObserveArgv("browser-session-task-stop")), {
    status: "refused",
    reason: "Desktop Browser Task already has a terminal outcome",
  });

  const lateResult: HostResultMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: accepted.payload.dispatchId,
      operationId: accepted.payload.operationId,
      outcome: "completed",
      resultHash: "sha256:late-stop-result",
      result: {
        schemaVersion: "1.0",
        command: "navigate",
        completedAt: "2036-08-27T12:00:11.000Z",
        data: { tab_id: 7, reached: "load" },
      },
    },
  };
  const recorded = await store.consumeOperationResult(task.id, lateResult);
  assert.equal(recorded.status, "ok");
  assert.equal(recorded.task.status, "canceled_with_unknown_effects");
  assert.equal(recorded.task.operations?.at(-1)?.hostResult?.payload.resultHash, "sha256:late-stop-result");
});

test("Ticket 11 Local Stop Receipt terminalizes active work once and never rewrites an earlier outcome", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const active = readyTask("task-local-receipt-active", "operation-local-receipt-active");
  active.execution!.hostAccepted = acceptedFor(active.execution!.operation, "dispatch-local-receipt-active");
  const completed = readyTask("task-local-receipt-completed", "operation-local-receipt-completed");
  completed.status = "completed";
  completed.outcome = { outcome: "completed", summary: "Already complete", finalizedAt: 19_000 };
  await backing.put(active.id, active);
  await backing.put(completed.id, completed);
  const store = createDesktopBrowserTaskStore(backing, { now: () => 20_000 });
  const receiptFor = (task: DesktopBrowserTask): HostLocalStopReceiptMessage => ({
    protocolVersion: "1.3",
    kind: "host.local-stop-receipt",
    payload: {
      receiptId: `local-stop-42-${task.id}-20000`,
      processEpoch: 42,
      taskId: task.id,
      attemptId: task.execution!.attemptId,
      operationId: task.execution!.operation.authority.operationId,
      operationCategory: "session_start",
      requestedAt: 20_000,
      status: "canceled",
    },
  });

  const activeReceipt = receiptFor(active);
  activeReceipt.payload.status = "requested";
  assert.equal((await store.consumeLocalStopReceipt(activeReceipt)).status, "ok");
  const canceledReceipt = structuredClone(activeReceipt);
  canceledReceipt.payload.status = "canceled";
  assert.equal((await store.consumeLocalStopReceipt(canceledReceipt)).status, "ok");
  const stopped = await store.get(active.id);
  assert.equal(stopped?.status, "canceled_with_unknown_effects");
  assert.equal(stopped?.localStopReceipts?.length, 1);
  const lateResult: HostResultMessage = {
    protocolVersion: "1.3",
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-local-receipt-active",
      operationId: active.execution!.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:late-local-receipt-result",
      result: {
        session_id: "late-session",
        browser_instance_id: "browser-primary",
        agent_window_id: 99,
      },
    },
  };
  assert.equal((await store.consumeSessionStartResult(active.id, lateResult)).status, "ok");
  const afterLateResult = await store.get(active.id);
  assert.equal(afterLateResult?.status, "canceled_with_unknown_effects");
  assert.match(afterLateResult?.auditWarnings?.at(-1) ?? "", /Late Host result recorded after terminal Task outcome/);

  const completedReceipt = receiptFor(completed);
  assert.equal((await store.consumeLocalStopReceipt(completedReceipt)).status, "ok");
  const unchanged = await store.get(completed.id);
  assert.equal(unchanged?.status, "completed");
  assert.equal(unchanged?.outcome?.summary, "Already complete");
  assert.deepEqual(unchanged?.auditWarnings, ["Local Stop arrived after terminal Task outcome"]);
});

test("Ticket 11 Core restart queries Relay for each nonterminal Attempt without rerunning work", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const first = readyTask("task-recovery-first", "operation-recovery-first");
  const second = readyTask("task-recovery-second", "operation-recovery-second");
  first.execution!.attemptStatus = "prepared";
  first.execution!.hostResult = undefined;
  second.execution!.attemptStatus = "prepared";
  second.execution!.hostResult = undefined;
  await backing.put(first.id, first);
  await backing.put(second.id, second);
  const restarted = createDesktopBrowserTaskStore(backing);
  const queried: string[] = [];
  const consumed: string[] = [];

  await assert.rejects(
    reconcileDesktopBrowserAttempts(
      restarted,
      {
        async attemptStatus(attemptId) {
          queried.push(attemptId);
          if (attemptId === first.execution!.attemptId) throw new Error("Relay temporarily unavailable");
          return {
            checkpoint: { attemptId, operationId: second.execution!.operation.authority.operationId, state: "terminal" },
            accepted: acceptedFor(second.execution!.operation, "dispatch-recovered"),
            result: {
              protocolVersion: "1.3",
              kind: "host.result",
              payload: {
                dispatchId: "dispatch-recovered",
                operationId: second.execution!.operation.authority.operationId,
                outcome: "unknown",
                resultHash: "sha256:recovered-unknown",
              },
            },
          };
        },
      },
      {
        desktopBrowserConsumeSessionStartAccepted: async () => ({ status: "ok", task: second }),
        desktopBrowserConsumeOperationAccepted: async () => ({ status: "ok", task: second }),
        desktopBrowserConsumeRelayTerminalCallback: async (taskId) => {
          consumed.push(taskId);
          return { status: "ok" };
        },
      },
    ),
    /Attempt reconciliation failed/,
  );

  assert.deepEqual(queried.sort(), [first.execution!.attemptId, second.execution!.attemptId].sort());
  assert.deepEqual(consumed, [second.id]);
});

test("Ticket 11 recovery queries a later operation after session start completed", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const task = readyTask("task-recovery-operation", "operation-recovery-session-start");
  const store = createDesktopBrowserTaskStore(backing, {
    id: (() => {
      const ids = ["operation-recovery-navigate", "nonce-recovery-navigate"];
      return () => ids.shift()!;
    })(),
    now: () => 21_000,
  });
  await backing.put(task.id, task);
  const prepared = await store.prepareOperation(
    task.id,
    buildDesktopBrowserNavigateArgv("https://example.test", task.browserSkillSessionId!),
  );
  assert.equal(prepared.status, "ok");
  let operationAcceptances = 0;

  await reconcileDesktopBrowserAttempts(
    store,
    {
      async attemptStatus(attemptId) {
        return {
          checkpoint: { attemptId, operationId: prepared.operation.authority.operationId, state: "accepted" },
          accepted: acceptedFor(prepared.operation, "dispatch-recovered-operation"),
        };
      },
    },
    {
      desktopBrowserConsumeSessionStartAccepted: async () => assert.fail("must not use session-start acceptance"),
      desktopBrowserConsumeOperationAccepted: async () => {
        operationAcceptances += 1;
        return { status: "ok", task };
      },
      desktopBrowserConsumeRelayTerminalCallback: async () => assert.fail("result is not terminal"),
    },
  );

  assert.equal(operationAcceptances, 1);
});

test("Ticket 11 concurrent Local Stop Receipt and Core finalization preserve one terminal outcome", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const task = readyTask("task-local-stop-cas", "operation-local-stop-cas");
  task.browserSkillSessionStoppedAt = 19_000;
  await backing.put(task.id, task);
  const first = createDesktopBrowserTaskStore(backing, { now: () => 20_000 });
  const second = createDesktopBrowserTaskStore(backing, { now: () => 20_001 });
  const receipt: HostLocalStopReceiptMessage = {
    protocolVersion: "1.3",
    kind: "host.local-stop-receipt",
    payload: {
      receiptId: "local-stop-concurrent-cas",
      processEpoch: 42,
      taskId: task.id,
      attemptId: task.execution!.attemptId,
      operationId: task.execution!.operation.authority.operationId,
      operationCategory: "session_start",
      requestedAt: 20_000,
      status: "canceled",
    },
  };

  await Promise.all([
    first.consumeLocalStopReceipt(receipt),
    second.finalize(task.id, { outcome: "completed", summary: "Concurrent completion" }),
  ]);

  const settled = await first.get(task.id);
  assert.ok(settled?.status === "completed" || settled?.status === "canceled_with_unknown_effects");
  assert.equal(settled?.localStopReceipts?.length, 1);
  if (settled?.status === "completed") assert.equal(settled.outcome?.summary, "Concurrent completion");
});

test("Ticket 12 recovery dispatches observation first without reviving the terminal Task", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const task = readyTask("task-observation-recovery", "operation-observation-recovery-start");
  task.status = "canceled_with_unknown_effects";
  task.recoveryExpiresAt = 22_000 + 15 * 60_000;
  await backing.put(task.id, task);
  const ids = ["operation-recovery-observe", "nonce-recovery-observe"];
  const store = createDesktopBrowserTaskStore(backing, { id: () => ids.shift()!, now: () => 22_000 });
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    dispatcher: {
      async dispatch(input) {
        assert.deepEqual(input.invocation.payload.authority.argv, ["--json", "observe", "--session", task.browserSkillSessionId]);
        const operation = input.invocation.payload;
        return {
          kind: "host.result" as const,
          accepted: acceptedFor(operation, operation.dispatchId),
          result: {
            protocolVersion: "1.3",
            kind: "host.result" as const,
            payload: {
              dispatchId: operation.dispatchId,
              operationId: operation.authority.operationId,
              outcome: "completed" as const,
              resultHash: "sha256:recovery-observation",
              result: {
                schemaVersion: "1.0" as const,
                command: "observe" as const,
                completedAt: "2036-08-27T12:00:22.000Z",
                data: { tab_id: 7, text: "Recovered state", ref_count: 1, truncated: false },
              },
            },
          },
        };
      },
    },
  });

  assert.equal((await coordinator.recoverForTask(task.id)).status, "ok");
  const recovered = await store.get(task.id);
  assert.equal(recovered?.status, "canceled_with_unknown_effects");
  assert.equal(recovered?.latestObservation?.data.text, "Recovered state");
});

test("Ticket 12 quarantine timeout cleans only the Task-owned session", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const task = readyTask("task-timeout-cleanup", "operation-timeout-cleanup-start");
  task.status = "canceled_with_unknown_effects";
  task.recoveryExpiresAt = 21_999;
  await backing.put(task.id, task);
  const ids = ["operation-timeout-cleanup", "nonce-timeout-cleanup"];
  const store = createDesktopBrowserTaskStore(backing, { id: () => ids.shift()!, now: () => 22_000 });
  const coordinator = createDesktopBrowserOperationCoordinator({
    tasks: store,
    dispatcher: {
      async dispatch(input) {
        assert.deepEqual(input.invocation.payload.authority.argv, [
          "--json",
          "session",
          "stop",
          task.browserSkillSessionId,
        ]);
        const operation = input.invocation.payload;
        return {
          kind: "host.result" as const,
          accepted: acceptedFor(operation, operation.dispatchId),
          result: {
            protocolVersion: "1.3",
            kind: "host.result" as const,
            payload: {
              dispatchId: operation.dispatchId,
              operationId: operation.authority.operationId,
              outcome: "completed" as const,
              resultHash: "sha256:timeout-cleanup",
              result: {
                schemaVersion: "1.0" as const,
                command: "session.stop" as const,
                completedAt: "2036-08-27T12:00:22.000Z",
                data: { returned_tab_ids: [7], return_failures: [] },
              },
            },
          },
        };
      },
    },
  });

  assert.equal(await coordinator.cleanupQuarantinedTask(task.id), true);
  const cleaned = await store.get(task.id);
  assert.equal(cleaned?.status, "canceled_with_unknown_effects");
  assert.equal(cleaned?.browserSkillSessionStoppedAt, 22_000);
});

test("Ticket 12 authorized recovery creates a Run before observation", async () => {
  const task = readyTask("task-recovery-run", "operation-recovery-run-start");
  task.status = "canceled_with_unknown_effects";
  task.recoveryExpiresAt = Date.now() + 15 * 60_000;
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put(task.id, task);
  const store = createDesktopBrowserTaskStore(backing);
  const enqueued: Array<Record<string, unknown>> = [];
  let recoverCalls = 0;
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (id: string) => ({ id, type: "internal" }),
        isInternal: () => true,
      },
      projects: {
        withRosterLock: async (_id: string, fn: (project: unknown) => Promise<unknown>) =>
          fn({ id: task.projectId, orgId: "default-org", ownerId: task.actorId, memberIds: [], updatedAt: 42 }),
      },
      admin: { canAdminister: async () => false },
      desktopBrowserTasks: store,
      desktopBrowserDeviceRegistry: {
        deviceRecovery: async () => ({ status: "quarantined", expiresAt: task.recoveryExpiresAt! }),
      },
      desktopBrowserRecover: async () => {
        recoverCalls += 1;
        return { status: "ok" };
      },
      sessions: {
        get: async () => ({ id: task.sessionId, type: "group", threadRef: task.threadRef, surface: "web" }),
        participantsOf: async () => [task.actorId],
      },
      runs: {
        enqueue: async (input: Record<string, unknown>) => {
          enqueued.push(input);
          return { run: { id: "run-recovery" }, deduped: false };
        },
      },
      maxAttempts: 3,
    } as any,
    { drive: async (runId: string) => ({ status: "queued", runId }) } as any,
    {} as any,
  );

  assert.deepEqual(await app.desktopBrowserTaskAction(task.id, task.actorId, task.authorityId, "recover"), {
    status: "queued",
    runId: "run-recovery",
  });
  assert.equal(recoverCalls, 0);
  const recoveryRun = enqueued[0]!;
  assert.equal((recoveryRun.request as { desktopBrowserRecoveryTaskId?: string }).desktopBrowserRecoveryTaskId, task.id);
  assert.equal(recoveryRun.dedupKey, `desktop-browser-recovery:${task.id}`);
  assert.deepEqual(await app.desktopBrowserTaskAction(task.id, "outsider", task.authorityId, "recover"), {
    status: "refused",
    reason: "Desktop Browser Task not found",
  });
});

test("Ticket 08 Stop during initial Host acceptance records unknown effects", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  const task = readyTask("task-start-stop", "start-in-flight-stop");
  task.execution!.attemptStatus = "prepared";
  task.execution!.hostAccepted = acceptedFor(task.execution!.operation, "dispatch-start-stop");
  task.browserSkillSessionId = undefined;
  await backing.put(task.id, task);
  const store = createDesktopBrowserTaskStore(backing, { now: () => 13_000 });

  const stopped = await store.requestStop(task.id, { requestedBy: "actor-1", reason: "webui" });

  assert.equal(stopped.status, "ok");
  assert.equal(stopped.task.status, "canceled_with_unknown_effects");
});

test("Ticket 08 Stop reconciliation continues after an earlier revoke failure", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-stop-first", readyTask("task-stop-first", "start-stop-first"));
  await backing.put("task-stop-second", readyTask("task-stop-second", "start-stop-second"));
  const store = createDesktopBrowserTaskStore(backing, { now: () => 14_000 });
  await store.requestStop("task-stop-first", { requestedBy: "actor-1", reason: "webui" });
  await store.requestStop("task-stop-second", { requestedBy: "actor-1", reason: "webui" });

  await assert.rejects(
    reconcileDesktopBrowserStops(
      store,
      { recordOnce: async () => undefined } as any,
      async (input) => {
        if (input.taskId === "task-stop-first") throw new Error("first Host offline");
      },
    ),
    /Stop reconciliation failed/,
  );

  assert.equal((await store.get("task-stop-first"))?.stopIntent?.revocationStatus, "pending");
  assert.equal((await store.get("task-stop-second"))?.stopIntent?.revocationStatus, "delivered");
});

test("Ticket 08 WebUI Stop persists before Relay delivery and never acknowledges failed delivery", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-webui-stop", readyTask("task-webui-stop", "start-webui-stop"));
  const store = createDesktopBrowserTaskStore(backing, { now: () => 12_000 });
  let observedDurableStop = false;
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (id: string) => ({ id, type: "internal" }),
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
      desktopBrowserRevoke: async () => {
        const persisted = await store.get("task-webui-stop");
        observedDurableStop = !!persisted?.stopIntent && !!persisted.leaseRevocation;
        throw new Error("relay unavailable");
      },
      admin: { canAdminister: async () => false },
      auditLog: {
        recordOnce: async () => {
          throw new Error("audit unavailable");
        },
      },
      publicWebUrl: "https://qm.example.test",
    } as any,
    {} as any,
    {} as any,
  );

  const result = await app.desktopBrowserTaskAction("task-webui-stop", "actor-1", "authority-1", "stop");

  assert.deepEqual(result, {
    status: "refused",
    reason: "Desktop Browser Stop recorded; Relay delivery not confirmed",
  });
  assert.equal(observedDurableStop, true);
  assert.equal((await store.get("task-webui-stop"))?.status, "canceled");
});

test("Ticket 08 concurrent Stop and completion use first-persisted-wins CAS", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-cas", readyTask("task-cas", "start-cas"));
  const first = createDesktopBrowserTaskStore(backing, { now: () => 20_000 });
  const second = createDesktopBrowserTaskStore(backing, { now: () => 20_001 });

  const [stop, finalize] = await Promise.all([
    first.requestStop("task-cas", { requestedBy: "actor-1", reason: "webui" }),
    second.finalize("task-cas", { outcome: "completed", summary: "completed concurrently" }),
  ]);

  assert.equal([stop, finalize].filter((result) => result.status === "ok").length, 1);
  assert.equal([stop, finalize].filter((result) => result.status === "refused").length, 1);
  assert.ok(["canceled", "completed"].includes((await first.get("task-cas"))!.status));
});

test("Ticket 08 project administrator Stop is acknowledged only after Relay revoke succeeds", async () => {
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put("task-admin-stop", readyTask("task-admin-stop", "start-admin-stop"));
  const store = createDesktopBrowserTaskStore(backing, { now: () => 30_000 });
  let revoked = false;
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (id: string) => ({ id, type: "internal" }),
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
      desktopBrowserRevoke: async () => {
        revoked = true;
      },
      admin: { canAdminister: async () => true },
      auditLog: {
        recordOnce: async () => {
          throw new Error("audit unavailable");
        },
      },
      publicWebUrl: "https://qm.example.test",
    } as any,
    {} as any,
    {} as any,
  );

  const result = await app.desktopBrowserTaskAction("task-admin-stop", "admin-1", "", "stop");

  assert.equal(result.status, "ok");
  assert.equal(result.reply, "Desktop Browser Stop accepted.");
  assert.equal(revoked, true);
  const stopped = await store.get("task-admin-stop");
  assert.equal(stopped?.stopIntent?.reason, "admin");
  assert.equal(stopped?.stopIntent?.auditStatus, "pending");
  assert.equal(stopped?.stopIntent?.revocationStatus, "delivered");
});

test("Ticket 09 Continue creates one Run from the immutable original goal", async () => {
  const task = readyTask("task-continue", "start-continue");
  task.execution = undefined;
  task.browserSkillSessionId = undefined;
  const backing = createMemoryMap<DesktopBrowserTask>();
  await backing.put(task.id, task);
  const store = createDesktopBrowserTaskStore(backing);
  const enqueued: Array<Record<string, unknown>> = [];
  const started: string[] = [];
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (id: string) => ({ id, type: "internal" }),
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
      desktopBrowserDeviceRegistry: {
        taskRegistration: async () => ({
          registrationId: "registration-continue",
          confirmationFingerprint: "4f8c52de91a3b10c",
          expiresAt: "2036-08-27T13:00:00.000Z",
          status: "confirmed",
        }),
        claimDevice: async () => ({ status: "ok" }),
        releaseDevice: async () => undefined,
      },
      desktopBrowserStart: async (taskId: string) => {
        started.push(taskId);
        return { status: "ok" };
      },
      sessions: {
        get: async () => ({
          id: task.sessionId,
          type: "group",
          scopeId: "group:web-project-project-1",
          threadRef: task.threadRef,
          surface: "web",
          createdAt: 1,
        }),
        participantsOf: async () => ["actor-1"],
      },
      runs: {
        async enqueue(input: Record<string, unknown>) {
          enqueued.push(input);
          return { run: { id: "run-continue" }, deduped: false };
        },
      },
      maxAttempts: 3,
      admin: { canAdminister: async () => false },
    } as any,
    { drive: async (runId: string) => ({ status: "queued", runId }) } as any,
    {} as any,
  );

  const continued = await app.desktopBrowserTaskAction(task.id, "actor-1", task.authorityId, "continue");
  assert.equal(continued.status, "queued");
  assert.equal(continued.runId, "run-continue");
  assert.equal(continued.desktopBrowserActivity?.taskId, task.id);
  assert.equal(enqueued.length, 1);
  assert.deepEqual(started, []);
  const enqueuedRequest = enqueued[0]!;
  assert.equal(enqueuedRequest.dedupKey, `desktop-browser-continue:${task.id}`);
  assert.equal((enqueuedRequest.request as { desktopBrowserTaskId?: string }).desktopBrowserTaskId, task.id);
  assert.equal((enqueuedRequest.request as { text?: string }).text, task.goal);
  assert.equal((enqueuedRequest.request as { displayText?: string }).displayText, task.goal);
  assert.deepEqual((enqueuedRequest.request as { sessionParticipantIds?: string[] }).sessionParticipantIds, ["actor-1"]);
  assert.equal((await store.get(task.id))?.continuationRunId, "run-continue");

  await backing.put(task.id, { ...task, authorityExpiresAt: 1 });
  assert.deepEqual(await app.desktopBrowserTaskAction(task.id, "actor-1", task.authorityId, "continue"), {
    status: "refused",
    reason: `Desktop Browser Turn authority expired; submit a new Turn with: /desktop-browser ${task.goal}`,
    newSubmission: `/desktop-browser ${task.goal}`,
  });
  assert.equal(enqueued.length, 1);
});

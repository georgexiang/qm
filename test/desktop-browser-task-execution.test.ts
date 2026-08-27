import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildDesktopBrowserSessionStartArgv,
  computeDesktopBrowserRequestHash,
  DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  DESKTOP_BROWSER_TASK_LEASE_DURATION_MS,
  parseDesktopBrowserSessionStartAuthorityEnvelope,
  type HostAcceptedMessage,
  type HostResultMessage,
} from "qm-desktop-browser-contracts";
import { createTurnMethods } from "../src/api/app-turn.ts";
import { createDesktopBrowserTaskStore, type DesktopBrowserTask } from "../src/desktop-browser/browser-task-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

async function createPreparedCallbackHarness() {
  const issuedAt = Date.parse("2026-08-27T12:00:00.000Z");
  let currentTime = issuedAt;
  const generatedIds = ["task-1", "attempt-1", "lease-1", "operation-1", "nonce-1"];
  let sessionStartAuthorityStateCalls = 0;
  let validatedAuthorityCalls = 0;
  const authorityState = {
    registration: {
      deploymentCanonicalId: "qm://deployments/example",
      registrationId: "registration-1",
      waitingTaskId: "task-1",
      actorId: "actor-1",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: issuedAt + 120_000,
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
      protocolVersion: "1.2",
      policyGrammarVersion: "1.0",
      brokerVersion: "2.0.0",
      bskVersion: "3.0.0",
      extensionVersion: "4.0.0",
      cliShapeHash: "sha256:cli-shape-1",
      lastSeenAt: "2026-08-27T12:00:00.000Z",
    },
  };
  const backing = createMemoryMap<DesktopBrowserTask>();
  const store = createDesktopBrowserTaskStore(backing, {
    id: () => generatedIds.shift()!,
    now: () => currentTime,
    sessionStartAuthority: async () => structuredClone(authorityState),
  });
  const task = await store.createWaiting({
    goal: "Open the shared browser",
    actorId: "actor-1",
    projectId: "project-1",
    projectName: "Apollo",
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: issuedAt + 120_000,
    sessionId: "session-1",
    threadRef: "thread-1",
  });
  const prepared = await store.prepareSessionStart(task.id);
  assert.equal(prepared.status, "ok");
  if (prepared.status !== "ok") throw new Error("session start was not prepared");
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (principalId: string) => ({ id: principalId, type: "internal" }),
        isInternal: () => true,
      },
      desktopBrowserTasks: store,
      desktopBrowserDeviceRegistry: {
        sessionStartAuthorityState: async () => {
          sessionStartAuthorityStateCalls += 1;
          return { status: "ok" as const, authority: structuredClone(authorityState) };
        },
        withValidatedSessionStartAuthority: async (
          _waitingTaskId: string,
          _operation: unknown,
          fn: (currentAuthority: { status: "ok"; authority: typeof authorityState }) => Promise<unknown>,
        ) => {
          validatedAuthorityCalls += 1;
          return await fn({ status: "ok", authority: structuredClone(authorityState) });
        },
      },
      projects: {
        withRosterLock: async () => {
          throw new Error("roster lock should not be consulted for callback evidence");
        },
      },
      publicWebUrl: "https://qm.example.com",
      auditLog: { record: () => undefined },
    } as any,
    {
      withAdminLink: async (value: any) => value,
      drive: () => ({ status: "failed", reason: "unused" }),
      approvalRecordIsCurrent: async () => false,
      approvalVisibleToViewer: async () => false,
      pendingApprovalForSession: async () => [],
      pendingApprovalResultForThread: async () => null,
      mayUseSharedScope: async () => false,
      viewerMayUseRun: async () => false,
      sessionsForViewer: async () => [],
      replayOrphanedRunSignals: async () => [],
    } as any,
    {
      shouldRouteToSpine: () => false,
      markTriggerHandled: () => undefined,
      addressedWakeText: async () => "",
    } as any,
  );
  return {
    app,
    backing,
    store,
    task,
    prepared: prepared.operation,
    setCurrentTime: (value: number) => {
      currentTime = value;
    },
    counters: {
      sessionStartAuthorityStateCalls: () => sessionStartAuthorityStateCalls,
      validatedAuthorityCalls: () => validatedAuthorityCalls,
    },
  };
}

test("an authorized waiting task prepares one durable session-start operation for its online bound device", async () => {
  const issuedAt = Date.parse("2026-08-27T12:00:00.000Z");
  const generatedIds = ["task-1", "attempt-1", "lease-1", "operation-1", "nonce-1"];
  const backing = createMemoryMap<DesktopBrowserTask>();
  const store = createDesktopBrowserTaskStore(backing, {
    id: () => generatedIds.shift()!,
    now: () => issuedAt,
    sessionStartAuthority: async () => ({
      registration: {
        deploymentCanonicalId: "qm://deployments/example",
        registrationId: "registration-1",
        waitingTaskId: "task-1",
        actorId: "actor-1",
        projectId: "project-1",
        membershipEpoch: 42,
        authorityId: "authority-1",
        authorityExpiresAt: issuedAt + 120_000,
        publicDeviceFingerprint: "sha256:device-1",
        browserInstanceId: "browser-primary",
        status: "online",
        browserRuntimeStatus: "ready",
      },
      relayConnection: {
        connectionId: "connection-1",
        publicDeviceFingerprint: "sha256:device-1",
        brokerInstanceId: "broker-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
        registrationState: "registered",
        protocolVersion: "1.2",
        policyGrammarVersion: "1.0",
        brokerVersion: "2.0.0",
        bskVersion: "3.0.0",
        extensionVersion: "4.0.0",
        cliShapeHash: "sha256:cli-shape-1",
        lastSeenAt: "2026-08-27T12:00:00.000Z",
      },
    }),
  });
  const task = await store.createWaiting({
    goal: "Open the shared browser",
    actorId: "actor-1",
    actorDisplayName: "Ada",
    projectId: "project-1",
    projectName: "Apollo",
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: issuedAt + 120_000,
    sessionId: "session-1",
    threadRef: "thread-1",
  });

  const first = await store.prepareSessionStart(task.id);
  const repeated = await store.prepareSessionStart(task.id);

  assert.equal(first.status, "ok");
  assert.equal(repeated.status, "ok");
  assert.deepEqual(repeated.operation, first.operation);
  assert.equal(first.operation.authority.attemptId, "attempt-1");
  assert.equal(first.operation.authority.leaseId, "lease-1");
  assert.equal(first.operation.authority.operationId, "operation-1");
  assert.equal(first.operation.authority.operationSequence, 1);
  assert.equal(
    first.operation.authority.actorSnapshotHash,
    "sha256:0fd9ab23e3aa19c03718747dc377ca5d913d258ac537b13dbf8ce12eefda9618",
  );
  assert.equal(
    first.operation.authority.projectSnapshotHash,
    "sha256:985e5e07f35ca86e5a8138197b32254df920bb5d987687a864608c664dacf4b0",
  );
  assert.equal(
    Date.parse(first.operation.authority.leaseExpiresAt) - Date.parse(first.operation.authority.issuedAt),
    DESKTOP_BROWSER_TASK_LEASE_DURATION_MS,
  );
  assert.deepEqual(first.operation.authority.argv, buildDesktopBrowserSessionStartArgv("browser-primary"));
  assert.equal(first.operation.requestHash, computeDesktopBrowserRequestHash(first.operation.authority, "1.2", "1.0"));
  assert.deepEqual(first.operation.authority.capabilitySet, {
    protocolVersion: "1.2",
    policyGrammarVersion: "1.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-1",
  });
  assert.deepEqual(
    parseDesktopBrowserSessionStartAuthorityEnvelope(first.operation.authority),
    first.operation.authority,
  );
  assert.deepEqual((await backing.get(task.id))?.execution?.operation, first.operation);
  assert.deepEqual(generatedIds, []);
  const restarted = createDesktopBrowserTaskStore(backing, {
    id: () => {
      throw new Error("persisted preparation allocated another id");
    },
    sessionStartAuthority: async () => {
      throw new Error("persisted preparation consulted current authority state");
    },
  });
  assert.deepEqual(await restarted.prepareSessionStart(task.id), first);
});

test("the application prepares the registered task from the current Relay projection without caller snapshots", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-session-start-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Launch Project");
  assert.ok(project);
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Current Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-session-start",
      audience: [],
    },
    text: "/desktop-browser open the quarterly planning page",
  });
  const taskId = created.desktopBrowserActivity?.taskId;
  const authorityId = created.desktopBrowserActivity?.actionAuthority;
  assert.ok(taskId);
  assert.ok(authorityId);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const reserved = await built.app.desktopBrowserReserveRegistration(taskId, authorityId, {
    devicePublicKey: `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });
  assert.equal(reserved.status, "ok");
  if (reserved.status !== "ok") return;
  const envelope = {
    registrationTuple: reserved.reservation.registrationTuple,
    publicIdentity: reserved.reservation.publicIdentity,
    confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    signatureAlgorithm: "ed25519" as const,
    signature: Buffer.from(
      sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
    ).toString("base64"),
  };
  await built.app.desktopBrowserStageRegistrationConfirmation(reserved.reservation.registrationTuple.registrationId, {
    browserRuntimeStatus: "ready",
    envelope,
  });
  const confirmed = await built.app.desktopBrowserConfirmRegistration(
    reserved.reservation.registrationTuple.registrationId,
    "owner",
    authorityId,
    {
      taskId,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    },
  );
  assert.equal(confirmed.status, "ok");
  await built.app.desktopBrowserPublishRelayConnection({
    connectionId: "connection-1",
    publicDeviceFingerprint: reserved.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    registrationState: "registered",
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-current",
    lastSeenAt: new Date().toISOString(),
  });

  const first = await built.app.desktopBrowserPrepareSessionStart(taskId, authorityId);
  const repeated = await built.app.desktopBrowserPrepareSessionStart(taskId, authorityId);

  assert.equal(first.status, "ok");
  assert.equal(repeated.status, "ok");
  if (first.status !== "ok" || repeated.status !== "ok") return;
  assert.deepEqual(repeated.operation, first.operation);
  assert.equal(first.operation.authority.actorId, "owner");
  assert.equal(first.operation.authority.projectId, project.id);
  assert.equal(first.operation.authority.membershipEpoch, project.updatedAt);
  assert.equal(first.operation.authority.deviceId, reserved.reservation.publicDeviceFingerprint);
  assert.equal(first.operation.authority.capabilitySet.cliShapeHash, "sha256:cli-shape-current");
  const accepted: HostAcceptedMessage = {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-1",
      operationId: first.operation.authority.operationId,
      requestHash: first.operation.requestHash,
    },
  };
  const acceptedResult = await built.app.desktopBrowserConsumeSessionStartAccepted(taskId, accepted);
  assert.equal(acceptedResult.status, "ok");
  const completed = await built.app.desktopBrowserConsumeSessionStartResult(taskId, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-1",
      operationId: first.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-current",
      result: {
        session_id: "browser-skill-session-current",
        browser_instance_id: "browser-primary",
        agent_window_id: 71,
      },
    },
  });
  assert.equal(completed.status, "ok");
  if (completed.status !== "ok") return;
  assert.equal(completed.task.browserSkillSessionId, "browser-skill-session-current");
  assert.equal(completed.task.browserInstanceId, "browser-primary");
  assert.equal(completed.task.agentWindowId, 71);
});

test("a completed Host result atomically binds frozen browser ownership to its prepared task", async () => {
  const issuedAt = Date.parse("2026-08-27T12:00:00.000Z");
  const generatedIds = ["task-1", "attempt-1", "lease-1", "operation-1", "nonce-1"];
  const store = createDesktopBrowserTaskStore(createMemoryMap(), {
    id: () => generatedIds.shift()!,
    now: () => issuedAt,
    sessionStartAuthority: async () => ({
      registration: {
        deploymentCanonicalId: "qm://deployments/example",
        registrationId: "registration-1",
        waitingTaskId: "task-1",
        actorId: "actor-1",
        projectId: "project-1",
        membershipEpoch: 42,
        authorityId: "authority-1",
        authorityExpiresAt: issuedAt + 120_000,
        publicDeviceFingerprint: "sha256:device-1",
        browserInstanceId: "browser-primary",
        status: "online",
        browserRuntimeStatus: "ready",
      },
      relayConnection: {
        connectionId: "connection-1",
        publicDeviceFingerprint: "sha256:device-1",
        brokerInstanceId: "broker-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
        registrationState: "registered",
        protocolVersion: "1.2",
        policyGrammarVersion: "1.0",
        brokerVersion: "2.0.0",
        bskVersion: "3.0.0",
        extensionVersion: "4.0.0",
        cliShapeHash: "sha256:cli-shape-1",
        lastSeenAt: "2026-08-27T12:00:00.000Z",
      },
    }),
  });
  const task = await store.createWaiting({
    goal: "Open the shared browser",
    actorId: "actor-1",
    actorDisplayName: "Ada",
    projectId: "project-1",
    projectName: "Apollo",
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: issuedAt + 120_000,
    sessionId: "session-1",
    threadRef: "thread-1",
  });
  const prepared = await store.prepareSessionStart(task.id);
  assert.equal(prepared.status, "ok");
  if (prepared.status !== "ok") return;
  const accepted: HostAcceptedMessage = {
    protocolVersion: "1.2",
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-1",
      operationId: prepared.operation.authority.operationId,
      requestHash: prepared.operation.requestHash,
    },
  };
  assert.equal((await store.consumeSessionStartAccepted("task-2", accepted)).status, "refused");
  assert.equal(
    (
      await store.consumeSessionStartAccepted(task.id, {
        ...accepted,
        protocolVersion: "1.3",
      })
    ).status,
    "refused",
  );
  assert.equal(
    (
      await store.consumeSessionStartAccepted(task.id, {
        ...accepted,
        payload: { ...accepted.payload, operationId: "operation-2" },
      })
    ).status,
    "refused",
  );
  const acceptedResult = await store.consumeSessionStartAccepted(task.id, accepted);
  assert.equal(acceptedResult.status, "ok");
  const completed = {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: accepted.payload.dispatchId,
      operationId: prepared.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-1",
      result: {
        session_id: "browser-skill-session-1",
        browser_instance_id: "browser-primary",
        agent_window_id: 42,
      },
    },
  } satisfies HostResultMessage;

  assert.equal((await store.consumeSessionStartResult("task-2", completed)).status, "refused");
  assert.equal(
    (
      await store.consumeSessionStartResult(task.id, {
        ...completed,
        protocolVersion: "1.3",
      })
    ).status,
    "refused",
  );
  assert.equal(
    (
      await store.consumeSessionStartResult(task.id, {
        ...completed,
        payload: { ...completed.payload, operationId: "operation-2" },
      })
    ).status,
    "refused",
  );
  assert.equal(
    (
      await store.consumeSessionStartResult(task.id, {
        ...completed,
        payload: { ...completed.payload, dispatchId: "dispatch-2" },
      })
    ).status,
    "refused",
  );
  assert.equal(
    (
      await store.consumeSessionStartResult(task.id, {
        ...completed,
        payload: {
          ...completed.payload,
          result: { ...completed.payload.result, browser_instance_id: "browser-secondary" },
        },
      })
    ).status,
    "refused",
  );

  const bound = await store.consumeSessionStartResult(task.id, completed);
  assert.equal(bound.status, "ok");
  if (bound.status !== "ok") return;
  assert.equal(bound.task.browserSkillSessionId, "browser-skill-session-1");
  assert.equal(bound.task.browserInstanceId, "browser-primary");
  assert.equal(bound.task.agentWindowId, 42);
  assert.equal(bound.task.execution?.attemptStatus, "completed");
  assert.deepEqual(await store.consumeSessionStartResult(task.id, completed), bound);
  assert.equal(
    (
      await store.consumeSessionStartResult(task.id, {
        ...completed,
        payload: {
          ...completed.payload,
          resultHash: "sha256:result-2",
          result: { ...completed.payload.result, session_id: "browser-skill-session-2" },
        },
      })
    ).status,
    "refused",
  );
});

test("Host result requires prior acceptance while accepted unknown remains distinct without creating another operation", async () => {
  async function preparedStore(taskId: string) {
    const issuedAt = Date.parse("2026-08-27T12:00:00.000Z");
    const generatedIds = [taskId, `${taskId}-attempt`, `${taskId}-lease`, `${taskId}-operation`, `${taskId}-nonce`];
    const store = createDesktopBrowserTaskStore(createMemoryMap(), {
      id: () => generatedIds.shift()!,
      now: () => issuedAt,
      sessionStartAuthority: async () => ({
        registration: {
          deploymentCanonicalId: "qm://deployments/example",
          registrationId: `${taskId}-registration`,
          waitingTaskId: taskId,
          actorId: "actor-1",
          projectId: "project-1",
          membershipEpoch: 42,
          authorityId: "authority-1",
          authorityExpiresAt: issuedAt + 120_000,
          publicDeviceFingerprint: "sha256:device-1",
          browserInstanceId: "browser-primary",
          status: "online",
          browserRuntimeStatus: "ready",
        },
        relayConnection: {
          connectionId: `${taskId}-connection`,
          publicDeviceFingerprint: "sha256:device-1",
          brokerInstanceId: "broker-1",
          browserInstanceId: "browser-primary",
          connectionEpoch: 7,
          registrationState: "registered",
          protocolVersion: "1.2",
          policyGrammarVersion: "1.0",
          brokerVersion: "2.0.0",
          bskVersion: "3.0.0",
          extensionVersion: "4.0.0",
          cliShapeHash: "sha256:cli-shape-1",
          lastSeenAt: "2026-08-27T12:00:00.000Z",
        },
      }),
    });
    const task = await store.createWaiting({
      goal: "Open the shared browser",
      actorId: "actor-1",
      projectId: "project-1",
      projectName: "Apollo",
      projectMembershipVersion: "42",
      authorityId: "authority-1",
      authorityExpiresAt: issuedAt + 120_000,
      sessionId: "session-1",
      threadRef: "thread-1",
    });
    const prepared = await store.prepareSessionStart(task.id);
    assert.equal(prepared.status, "ok");
    if (prepared.status !== "ok") throw new Error("session start was not prepared");
    return { store, task, prepared, generatedIds };
  }

  const preFence = await preparedStore("task-pre-fence");
  const preFenceResult = await preFence.store.consumeSessionStartResult(preFence.task.id, {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-pre-fence",
      operationId: preFence.prepared.operation.authority.operationId,
      outcome: "failed",
      error: { code: "browser_cli_shape_changed", message: "CLI shape changed before acceptance" },
      resultHash: "sha256:failed-1",
    },
  });
  assert.deepEqual(preFenceResult, {
    status: "refused",
    reason: "Desktop Browser Host result requires prior Host acceptance",
  });
  assert.equal((await preFence.store.get(preFence.task.id))?.execution?.hostResult, undefined);
  assert.deepEqual(await preFence.store.prepareSessionStart(preFence.task.id), preFence.prepared);
  assert.deepEqual(preFence.generatedIds, []);

  const acceptedUnknown = await preparedStore("task-accepted-unknown");
  const acceptedUnknownAccepted = await acceptedUnknown.store.consumeSessionStartAccepted(acceptedUnknown.task.id, {
    protocolVersion: "1.2",
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-accepted-unknown",
      operationId: acceptedUnknown.prepared.operation.authority.operationId,
      requestHash: acceptedUnknown.prepared.operation.requestHash,
    },
  });
  assert.equal(acceptedUnknownAccepted.status, "ok");
  const unknownResult = await acceptedUnknown.store.consumeSessionStartResult(acceptedUnknown.task.id, {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-accepted-unknown",
      operationId: acceptedUnknown.prepared.operation.authority.operationId,
      outcome: "unknown",
      resultHash: "sha256:unknown-1",
    },
  });
  assert.equal(unknownResult.status, "ok");
  if (unknownResult.status !== "ok") return;
  assert.equal(unknownResult.task.execution?.attemptStatus, "accepted_unknown");
  assert.equal(unknownResult.task.browserSkillSessionId, undefined);
  assert.deepEqual(await acceptedUnknown.store.prepareSessionStart(acceptedUnknown.task.id), acceptedUnknown.prepared);
  assert.deepEqual(acceptedUnknown.generatedIds, []);
});

test("the application records delayed Host acceptance after cancellation or authority expiry", async () => {
  for (const scenario of ["canceled", "expired"] as const) {
    const harness = await createPreparedCallbackHarness();
    const accepted: HostAcceptedMessage = {
      protocolVersion: "1.2",
      kind: "host.accepted",
      payload: {
        dispatchId: `dispatch-${scenario}`,
        operationId: harness.prepared.authority.operationId,
        requestHash: harness.prepared.requestHash,
      },
    };

    if (scenario === "canceled") {
      assert.equal((await harness.store.cancelWaiting(harness.task.id))?.status, "canceled");
    } else {
      await harness.backing.update?.(harness.task.id, (current) => ({
        ...current,
        authorityExpiresAt: 1,
        updatedAt: current.updatedAt + 1,
      }));
    }

    const recorded = await harness.app.desktopBrowserConsumeSessionStartAccepted(harness.task.id, accepted);

    assert.equal(recorded.status, "ok");
    if (recorded.status !== "ok") return;
    assert.deepEqual(recorded.task.execution?.hostAccepted, accepted);
    assert.equal(recorded.task.status, scenario === "canceled" ? "canceled" : "waiting_for_broker");
    assert.equal(harness.counters.sessionStartAuthorityStateCalls(), 0);
    assert.equal(harness.counters.validatedAuthorityCalls(), 0);
  }
});

test("the application records delayed failed and unknown Host results after cancellation without rewriting the first outcome", async () => {
  for (const outcome of ["failed", "unknown"] as const) {
    const harness = await createPreparedCallbackHarness();
    const accepted: HostAcceptedMessage = {
      protocolVersion: "1.2",
      kind: "host.accepted",
      payload: {
        dispatchId: `dispatch-${outcome}`,
        operationId: harness.prepared.authority.operationId,
        requestHash: harness.prepared.requestHash,
      },
    };
    assert.equal((await harness.store.consumeSessionStartAccepted(harness.task.id, accepted)).status, "ok");
    assert.equal((await harness.store.cancelWaiting(harness.task.id))?.status, "canceled");

    const recorded = await harness.app.desktopBrowserConsumeSessionStartResult(harness.task.id, {
      protocolVersion: "1.2",
      kind: "host.result",
      payload:
        outcome === "failed"
          ? {
              dispatchId: accepted.payload.dispatchId,
              operationId: harness.prepared.authority.operationId,
              outcome,
              resultHash: `sha256:${outcome}-1`,
              error: { code: "browser_cli_shape_changed", message: `${outcome} after cancel` },
            }
          : {
              dispatchId: accepted.payload.dispatchId,
              operationId: harness.prepared.authority.operationId,
              outcome,
              resultHash: `sha256:${outcome}-1`,
            },
    });

    assert.equal(recorded.status, "ok");
    if (recorded.status !== "ok") return;
    assert.equal(recorded.task.status, "canceled");
    assert.equal(recorded.task.browserSkillSessionId, undefined);
    assert.equal(recorded.task.execution?.attemptStatus, outcome === "failed" ? "accepted_failed" : "accepted_unknown");
    assert.equal(recorded.task.execution?.hostResult?.payload.outcome, outcome);
    assert.equal(harness.counters.sessionStartAuthorityStateCalls(), 0);
    assert.equal(harness.counters.validatedAuthorityCalls(), 0);

    const refused = await harness.app.desktopBrowserConsumeSessionStartResult(harness.task.id, {
      protocolVersion: "1.2",
      kind: "host.result",
      payload: {
        dispatchId: accepted.payload.dispatchId,
        operationId: harness.prepared.authority.operationId,
        outcome: outcome === "failed" ? "unknown" : "failed",
        resultHash: `sha256:${outcome}-2`,
      },
    });

    assert.deepEqual(refused, {
      status: "refused",
      reason: "Desktop Browser Task already recorded a Host result",
    });
    assert.equal((await harness.store.get(harness.task.id))?.execution?.hostResult?.payload.outcome, outcome);
  }
});

test("an expired prepared task records a completed Host result as evidence without binding browser ownership", async () => {
  const issuedAt = Date.parse("2026-08-27T12:00:00.000Z");
  let currentTime = issuedAt;
  const generatedIds = ["task-1", "attempt-1", "lease-1", "operation-1", "nonce-1"];
  const store = createDesktopBrowserTaskStore(createMemoryMap(), {
    id: () => generatedIds.shift()!,
    now: () => currentTime,
    sessionStartAuthority: async () => ({
      registration: {
        deploymentCanonicalId: "qm://deployments/example",
        registrationId: "registration-1",
        waitingTaskId: "task-1",
        actorId: "actor-1",
        projectId: "project-1",
        membershipEpoch: 42,
        authorityId: "authority-1",
        authorityExpiresAt: issuedAt + 60_000,
        publicDeviceFingerprint: "sha256:device-1",
        browserInstanceId: "browser-primary",
        status: "online",
        browserRuntimeStatus: "ready",
      },
      relayConnection: {
        connectionId: "connection-1",
        publicDeviceFingerprint: "sha256:device-1",
        brokerInstanceId: "broker-1",
        browserInstanceId: "browser-primary",
        connectionEpoch: 7,
        registrationState: "registered",
        protocolVersion: "1.2",
        policyGrammarVersion: "1.0",
        brokerVersion: "2.0.0",
        bskVersion: "3.0.0",
        extensionVersion: "4.0.0",
        cliShapeHash: "sha256:cli-shape-1",
        lastSeenAt: "2026-08-27T12:00:00.000Z",
      },
    }),
  });
  const task = await store.createWaiting({
    goal: "Open the shared browser",
    actorId: "actor-1",
    projectId: "project-1",
    projectName: "Apollo",
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: issuedAt + 60_000,
    sessionId: "session-1",
    threadRef: "thread-1",
  });
  const prepared = await store.prepareSessionStart(task.id);
  assert.equal(prepared.status, "ok");
  if (prepared.status !== "ok") return;
  const accepted = await store.consumeSessionStartAccepted(task.id, {
    protocolVersion: "1.2",
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-expired",
      operationId: prepared.operation.authority.operationId,
      requestHash: prepared.operation.requestHash,
    },
  });
  assert.equal(accepted.status, "ok");
  currentTime = issuedAt + 60_001;

  const consumed = await store.consumeSessionStartResult(task.id, {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-expired",
      operationId: prepared.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-1",
      result: {
        session_id: "browser-skill-session-1",
        browser_instance_id: "browser-primary",
        agent_window_id: 42,
      },
    },
  });

  assert.equal(consumed.status, "ok");
  if (consumed.status !== "ok") return;
  assert.equal(consumed.task.browserSkillSessionId, undefined);
  assert.equal(consumed.task.execution?.attemptStatus, "accepted_completed_unbound");
  assert.equal(consumed.task.execution?.hostResult?.payload.outcome, "completed");
});

test("the application retains a completed Host result as evidence after project membership drift without binding browser ownership", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-session-start-drift-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Drift Project");
  assert.ok(project);
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-session-start-drift",
      audience: [],
    },
    text: "/desktop-browser open the quarterly planning page",
  });
  const taskId = created.desktopBrowserActivity?.taskId;
  const authorityId = created.desktopBrowserActivity?.actionAuthority;
  assert.ok(taskId);
  assert.ok(authorityId);
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const reserved = await built.app.desktopBrowserReserveRegistration(taskId!, authorityId!, {
    devicePublicKey: `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });
  assert.equal(reserved.status, "ok");
  if (reserved.status !== "ok") return;
  const envelope = {
    registrationTuple: reserved.reservation.registrationTuple,
    publicIdentity: reserved.reservation.publicIdentity,
    confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    signatureAlgorithm: "ed25519" as const,
    signature: Buffer.from(
      sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
    ).toString("base64"),
  };
  await built.app.desktopBrowserStageRegistrationConfirmation(reserved.reservation.registrationTuple.registrationId, {
    browserRuntimeStatus: "ready",
    envelope,
  });
  const confirmed = await built.app.desktopBrowserConfirmRegistration(
    reserved.reservation.registrationTuple.registrationId,
    "owner",
    authorityId!,
    {
      taskId: taskId!,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    },
  );
  assert.equal(confirmed.status, "ok");
  await built.app.desktopBrowserPublishRelayConnection({
    connectionId: "connection-1",
    publicDeviceFingerprint: reserved.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    registrationState: "registered",
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-current",
    lastSeenAt: new Date().toISOString(),
  });
  const prepared = await built.app.desktopBrowserPrepareSessionStart(taskId!, authorityId!);
  assert.equal(prepared.status, "ok");
  if (prepared.status !== "ok") return;
  const accepted = await built.app.desktopBrowserConsumeSessionStartAccepted(taskId!, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-drift",
      operationId: prepared.operation.authority.operationId,
      requestHash: prepared.operation.requestHash,
    },
  });
  assert.equal(accepted.status, "ok");
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const consumed = await built.app.desktopBrowserConsumeSessionStartResult(taskId!, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-drift",
      operationId: prepared.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-current",
      result: {
        session_id: "browser-skill-session-current",
        browser_instance_id: "browser-primary",
        agent_window_id: 71,
      },
    },
  });

  assert.equal(consumed.status, "ok");
  if (consumed.status !== "ok") return;
  assert.equal(consumed.task.browserSkillSessionId, undefined);
  assert.equal(consumed.task.execution?.attemptStatus, "accepted_completed_unbound");
  assert.equal(consumed.task.execution?.hostResult?.payload.outcome, "completed");
  assert.equal((await built.desktopBrowserTasks.get(taskId!))?.browserSkillSessionId, undefined);
});

test("reserve rereads the current task inside the roster lock before registry mutation", async () => {
  const task = {
    id: "task-1",
    status: "waiting_for_broker",
    goal: "Open the shared browser",
    actorId: "owner",
    actorSnapshot: { id: "owner", displayName: "Owner" },
    projectId: "project-1",
    projectSnapshot: { id: "project-1", name: "Project" },
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: Date.now() + 60_000,
    sessionId: "session-1",
    threadRef: "thread-1",
    createdAt: 1,
    updatedAt: 1,
  } satisfies DesktopBrowserTask;
  let currentTask: DesktopBrowserTask | null = structuredClone(task);
  let reserveCalls = 0;
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (principalId: string) => ({ id: principalId, type: "internal" }),
        isInternal: () => true,
      },
      desktopBrowserTasks: {
        get: async () => (currentTask ? structuredClone(currentTask) : null),
      },
      desktopBrowserDeviceRegistry: {
        reserve: async () => {
          reserveCalls += 1;
          return { status: "refused", reason: "unexpected reserve" } as const;
        },
        taskRegistration: async () => null,
      },
      projects: {
        withRosterLock: async (_projectId: string, fn: (project: any) => Promise<any>) => {
          currentTask = { ...task, status: "canceled", updatedAt: task.updatedAt + 1 };
          return fn({
            id: task.projectId,
            orgId: "acme",
            ownerId: "owner",
            memberIds: ["owner"],
            channelMemberIds: [],
            updatedAt: 42,
          });
        },
      },
      publicWebUrl: "https://qm.example.com",
      auditLog: { record: () => undefined },
    } as any,
    {
      withAdminLink: async (value: any) => value,
      drive: () => ({ status: "failed", reason: "unused" }),
      approvalRecordIsCurrent: async () => false,
      approvalVisibleToViewer: async () => false,
      pendingApprovalForSession: async () => [],
      pendingApprovalResultForThread: async () => null,
      mayUseSharedScope: async () => false,
      viewerMayUseRun: async () => false,
      sessionsForViewer: async () => [],
      replayOrphanedRunSignals: async () => [],
    } as any,
    {
      shouldRouteToSpine: () => false,
      markTriggerHandled: () => undefined,
      addressedWakeText: async () => "",
    } as any,
  );

  const reserved = await app.desktopBrowserReserveRegistration(task.id, task.authorityId, {
    devicePublicKey: "ed25519:device",
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });

  assert.deepEqual(reserved, {
    status: "refused",
    reason: "Desktop Browser Task is no longer waiting",
  });
  assert.equal(reserveCalls, 0);
});

test("confirm rereads the current task inside the roster lock before registry mutation", async () => {
  const task = {
    id: "task-1",
    status: "waiting_for_broker",
    goal: "Open the shared browser",
    actorId: "owner",
    actorSnapshot: { id: "owner", displayName: "Owner" },
    projectId: "project-1",
    projectSnapshot: { id: "project-1", name: "Project" },
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: Date.now() + 60_000,
    sessionId: "session-1",
    threadRef: "thread-1",
    createdAt: 1,
    updatedAt: 1,
  } satisfies DesktopBrowserTask;
  let currentTask: DesktopBrowserTask | null = structuredClone(task);
  let confirmCalls = 0;
  const app = createTurnMethods(
    {
      identity: {
        refresh: async () => undefined,
        classify: (principalId: string) => ({ id: principalId, type: "internal" }),
        isInternal: () => true,
      },
      desktopBrowserTasks: {
        get: async (id: string) => {
          if (id === task.id) return currentTask ? structuredClone(currentTask) : null;
          return null;
        },
      },
      desktopBrowserDeviceRegistry: {
        get: async () => ({
          registrationId: "registration-1",
          waitingTaskId: task.id,
          actorId: task.actorId,
          projectId: task.projectId,
          membershipEpoch: 42,
          authorityId: task.authorityId,
          authorityExpiresAt: task.authorityExpiresAt,
          status: "pending",
          confirmationFingerprint: "fingerprint-1",
        }),
        stagedConfirmation: async () => ({
          browserRuntimeStatus: "ready",
          envelope: {
            registrationTuple: {
              registrationProtocolVersion: "1.0",
              deploymentCanonicalId: "qm://deployments/example",
              registrationId: "registration-1",
              actorId: task.actorId,
              originatingProjectId: task.projectId,
              membershipEpoch: 42,
              devicePublicKey: "ed25519:device",
              brokerInstanceId: "broker-1",
              browserInstanceId: "browser-1",
              connectionEpoch: 7,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
            publicIdentity: {
              publicIdentityVersion: "1.0",
              deploymentCanonicalId: "qm://deployments/example",
              devicePublicKey: "ed25519:device",
              brokerInstanceId: "broker-1",
              browserInstanceId: "browser-1",
            },
            confirmationFingerprint: "fingerprint-1",
            signatureAlgorithm: "ed25519",
            signature: "signature",
          },
        }),
        confirm: async () => {
          confirmCalls += 1;
          return { status: "refused", reason: "unexpected confirm" } as const;
        },
        invalidate: async () => undefined,
        taskRegistration: async () => null,
      },
      projects: {
        withRosterLock: async (_projectId: string, fn: (project: any) => Promise<any>) => {
          currentTask = { ...task, status: "canceled", updatedAt: task.updatedAt + 1 };
          return fn({
            id: task.projectId,
            orgId: "acme",
            ownerId: "owner",
            memberIds: ["owner"],
            channelMemberIds: [],
            updatedAt: 42,
          });
        },
      },
      publicWebUrl: "https://qm.example.com",
      auditLog: { record: () => undefined },
    } as any,
    {
      withAdminLink: async (value: any) => value,
      drive: () => ({ status: "failed", reason: "unused" }),
      approvalRecordIsCurrent: async () => false,
      approvalVisibleToViewer: async () => false,
      pendingApprovalForSession: async () => [],
      pendingApprovalResultForThread: async () => null,
      mayUseSharedScope: async () => false,
      viewerMayUseRun: async () => false,
      sessionsForViewer: async () => [],
      replayOrphanedRunSignals: async () => [],
    } as any,
    {
      shouldRouteToSpine: () => false,
      markTriggerHandled: () => undefined,
      addressedWakeText: async () => "",
    } as any,
  );

  const confirmed = await app.desktopBrowserConfirmRegistration("registration-1", task.actorId, task.authorityId, {
    taskId: task.id,
    confirmationFingerprint: "fingerprint-1",
  });

  assert.deepEqual(confirmed, {
    status: "refused",
    reason: "Desktop Browser Task is no longer waiting",
  });
  assert.equal(confirmCalls, 0);
});

test("the application retains a late completed Host result as evidence when the registered device rotates after preparation", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-session-start-rotation-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Rotation Project");
  assert.ok(project);
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-session-start-rotation",
      audience: [],
    },
    text: "/desktop-browser open the quarterly planning page",
  });
  const taskId = created.desktopBrowserActivity?.taskId;
  const authorityId = created.desktopBrowserActivity?.actionAuthority;
  assert.ok(taskId);
  assert.ok(authorityId);
  const firstKeys = generateKeyPairSync("ed25519");
  const reserveOne = await built.app.desktopBrowserReserveRegistration(taskId!, authorityId!, {
    devicePublicKey: `ed25519:${Buffer.from(firstKeys.publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });
  assert.equal(reserveOne.status, "ok");
  if (reserveOne.status !== "ok") return;
  const envelopeOne = {
    registrationTuple: reserveOne.reservation.registrationTuple,
    publicIdentity: reserveOne.reservation.publicIdentity,
    confirmationFingerprint: reserveOne.reservation.confirmationFingerprint,
    signatureAlgorithm: "ed25519" as const,
    signature: Buffer.from(
      sign(null, Buffer.from(reserveOne.reservation.verificationBytesBase64, "base64"), firstKeys.privateKey),
    ).toString("base64"),
  };
  await built.app.desktopBrowserStageRegistrationConfirmation(reserveOne.reservation.registrationTuple.registrationId, {
    browserRuntimeStatus: "ready",
    envelope: envelopeOne,
  });
  assert.equal(
    (
      await built.app.desktopBrowserConfirmRegistration(
        reserveOne.reservation.registrationTuple.registrationId,
        "owner",
        authorityId!,
        { taskId: taskId!, confirmationFingerprint: reserveOne.reservation.confirmationFingerprint },
      )
    ).status,
    "ok",
  );
  await built.app.desktopBrowserPublishRelayConnection({
    connectionId: "connection-1",
    publicDeviceFingerprint: reserveOne.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    registrationState: "registered",
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-current",
    lastSeenAt: new Date().toISOString(),
  });
  const prepared = await built.app.desktopBrowserPrepareSessionStart(taskId!, authorityId!);
  assert.equal(prepared.status, "ok");
  if (prepared.status !== "ok") return;

  const rotated = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-session-start-rotation-next",
      audience: [],
    },
    text: "/desktop-browser open the quarterly planning page again",
  });
  const rotatedTaskId = rotated.desktopBrowserActivity?.taskId;
  const rotatedAuthorityId = rotated.desktopBrowserActivity?.actionAuthority;
  assert.ok(rotatedTaskId);
  assert.ok(rotatedAuthorityId);

  const secondKeys = generateKeyPairSync("ed25519");
  const reserveTwo = await built.app.desktopBrowserReserveRegistration(rotatedTaskId!, rotatedAuthorityId!, {
    devicePublicKey: `ed25519:${Buffer.from(secondKeys.publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
    brokerInstanceId: "broker-2",
    browserInstanceId: "browser-secondary",
    connectionEpoch: 8,
    operatingSystem: "macos-arm64",
  });
  assert.equal(reserveTwo.status, "ok");
  if (reserveTwo.status !== "ok") return;
  const envelopeTwo = {
    registrationTuple: reserveTwo.reservation.registrationTuple,
    publicIdentity: reserveTwo.reservation.publicIdentity,
    confirmationFingerprint: reserveTwo.reservation.confirmationFingerprint,
    signatureAlgorithm: "ed25519" as const,
    signature: Buffer.from(
      sign(null, Buffer.from(reserveTwo.reservation.verificationBytesBase64, "base64"), secondKeys.privateKey),
    ).toString("base64"),
  };
  await built.app.desktopBrowserStageRegistrationConfirmation(reserveTwo.reservation.registrationTuple.registrationId, {
    browserRuntimeStatus: "ready",
    envelope: envelopeTwo,
  });
  assert.equal(
    (
      await built.app.desktopBrowserConfirmRegistration(
        reserveTwo.reservation.registrationTuple.registrationId,
        "owner",
        rotatedAuthorityId!,
        { taskId: rotatedTaskId!, confirmationFingerprint: reserveTwo.reservation.confirmationFingerprint },
      )
    ).status,
    "ok",
  );
  await built.app.desktopBrowserPublishRelayConnection({
    connectionId: "connection-2",
    publicDeviceFingerprint: reserveTwo.reservation.publicDeviceFingerprint,
    brokerInstanceId: "broker-2",
    browserInstanceId: "browser-secondary",
    connectionEpoch: 8,
    registrationState: "registered",
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    policyGrammarVersion: "1.0",
    brokerVersion: "2.0.0",
    bskVersion: "3.0.0",
    extensionVersion: "4.0.0",
    cliShapeHash: "sha256:cli-shape-current",
    lastSeenAt: new Date().toISOString(),
  });

  const accepted = await built.app.desktopBrowserConsumeSessionStartAccepted(taskId!, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.accepted",
    payload: {
      dispatchId: "dispatch-rotation",
      operationId: prepared.operation.authority.operationId,
      requestHash: prepared.operation.requestHash,
    },
  });
  assert.equal(accepted.status, "ok");
  const consumed = await built.app.desktopBrowserConsumeSessionStartResult(taskId!, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-rotation",
      operationId: prepared.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-rotation",
      result: {
        session_id: "browser-skill-session-rotation",
        browser_instance_id: "browser-primary",
        agent_window_id: 77,
      },
    },
  });

  assert.equal(consumed.status, "ok");
  if (consumed.status !== "ok") return;
  assert.equal(consumed.task.browserSkillSessionId, undefined);
  assert.equal(consumed.task.execution?.attemptStatus, "accepted_completed_unbound");
  assert.equal(consumed.task.execution?.hostResult?.payload.outcome, "completed");
  assert.equal((await built.desktopBrowserTasks.get(taskId!))?.browserSkillSessionId, undefined);
});

test("the task store retains a completed Host result as evidence when the current capability set drifts after preparation", async () => {
  const issuedAt = Date.parse("2026-08-27T12:00:00.000Z");
  const generatedIds = ["task-1", "attempt-1", "lease-1", "operation-1", "nonce-1"];
  let authorityState = {
    registration: {
      deploymentCanonicalId: "qm://deployments/example",
      registrationId: "registration-1",
      waitingTaskId: "task-1",
      actorId: "actor-1",
      projectId: "project-1",
      membershipEpoch: 42,
      authorityId: "authority-1",
      authorityExpiresAt: issuedAt + 120_000,
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
      protocolVersion: "1.2",
      policyGrammarVersion: "1.0",
      brokerVersion: "2.0.0",
      bskVersion: "3.0.0",
      extensionVersion: "4.0.0",
      cliShapeHash: "sha256:cli-shape-1",
      lastSeenAt: "2026-08-27T12:00:00.000Z",
    },
  };
  const store = createDesktopBrowserTaskStore(createMemoryMap(), {
    id: () => generatedIds.shift()!,
    now: () => issuedAt,
    sessionStartAuthority: async () => structuredClone(authorityState),
  });
  const task = await store.createWaiting({
    goal: "Open the shared browser",
    actorId: "actor-1",
    projectId: "project-1",
    projectName: "Apollo",
    projectMembershipVersion: "42",
    authorityId: "authority-1",
    authorityExpiresAt: issuedAt + 120_000,
    sessionId: "session-1",
    threadRef: "thread-1",
  });
  const prepared = await store.prepareSessionStart(task.id);
  assert.equal(prepared.status, "ok");
  if (prepared.status !== "ok") return;
  assert.equal(
    (
      await store.consumeSessionStartAccepted(task.id, {
        protocolVersion: "1.2",
        kind: "host.accepted",
        payload: {
          dispatchId: "dispatch-drift",
          operationId: prepared.operation.authority.operationId,
          requestHash: prepared.operation.requestHash,
        },
      })
    ).status,
    "ok",
  );

  authorityState = {
    ...authorityState,
    relayConnection: {
      ...authorityState.relayConnection,
      cliShapeHash: "sha256:cli-shape-2",
    },
  };

  const consumed = await store.consumeSessionStartResult(task.id, {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-drift",
      operationId: prepared.operation.authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-1",
      result: {
        session_id: "browser-skill-session-1",
        browser_instance_id: "browser-primary",
        agent_window_id: 42,
      },
    },
  });

  assert.equal(consumed.status, "ok");
  if (consumed.status !== "ok") return;
  assert.equal(consumed.task.browserSkillSessionId, undefined);
  assert.equal(consumed.task.execution?.attemptStatus, "accepted_completed_unbound");
  assert.equal(consumed.task.execution?.hostResult?.payload.outcome, "completed");
  assert.equal((await store.get(task.id))?.browserSkillSessionId, undefined);
});

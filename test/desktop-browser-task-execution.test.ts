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
  type HostResultMessage,
} from "qm-desktop-browser-contracts";
import { createDesktopBrowserTaskStore, type DesktopBrowserTask } from "../src/desktop-browser/browser-task-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

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
  const completed = await built.app.desktopBrowserConsumeSessionStartResult(taskId, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      operationId: first.operation.authority.operationId,
      accepted: true,
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
  const completed = {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      operationId: prepared.operation.authority.operationId,
      accepted: true,
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
        payload: { ...completed.payload, operationId: "operation-2" },
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

test("Host pre-fence failure and accepted unknown remain distinct without creating another operation", async () => {
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
      operationId: preFence.prepared.operation.authority.operationId,
      accepted: false,
      outcome: "failed",
      error: { code: "browser_cli_shape_changed", message: "CLI shape changed before acceptance" },
    },
  });
  assert.equal(preFenceResult.status, "ok");
  if (preFenceResult.status !== "ok") return;
  assert.equal(preFenceResult.task.execution?.attemptStatus, "pre_fence_failed");
  assert.equal(preFenceResult.task.browserSkillSessionId, undefined);
  assert.deepEqual(await preFence.store.prepareSessionStart(preFence.task.id), preFence.prepared);
  assert.deepEqual(preFence.generatedIds, []);

  const acceptedUnknown = await preparedStore("task-accepted-unknown");
  const unknownResult = await acceptedUnknown.store.consumeSessionStartResult(acceptedUnknown.task.id, {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      operationId: acceptedUnknown.prepared.operation.authority.operationId,
      accepted: true,
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

test("an expired prepared task refuses its first Host result without binding browser ownership", async () => {
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
  currentTime = issuedAt + 60_001;

  const consumed = await store.consumeSessionStartResult(task.id, {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      operationId: prepared.status === "ok" ? prepared.operation.authority.operationId : "unexpected",
      accepted: true,
      outcome: "completed",
      resultHash: "sha256:result-1",
      result: {
        session_id: "browser-skill-session-1",
        browser_instance_id: "browser-primary",
        agent_window_id: 42,
      },
    },
  });

  assert.deepEqual(consumed, {
    status: "refused",
    reason: "Desktop Browser Turn authority expired; start a new Turn",
  });
  assert.equal((await store.get(task.id))?.browserSkillSessionId, undefined);
});

test("the application refuses the first Host result after project membership drift", async () => {
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
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");

  const consumed = await built.app.desktopBrowserConsumeSessionStartResult(taskId!, {
    protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      operationId: prepared.status === "ok" ? prepared.operation.authority.operationId : "unexpected",
      accepted: true,
      outcome: "completed",
      resultHash: "sha256:result-current",
      result: {
        session_id: "browser-skill-session-current",
        browser_instance_id: "browser-primary",
        agent_window_id: 71,
      },
    },
  });

  assert.deepEqual(consumed, {
    status: "refused",
    reason: "Desktop Browser Task authorization is no longer current",
  });
  assert.equal((await built.desktopBrowserTasks.get(taskId!))?.browserSkillSessionId, undefined);
});

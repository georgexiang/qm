import "./support/auto-fake-sprites.ts";

import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { projectGroupRef } from "../src/projects/project-store.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";
import { CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";

test("an explicit Project desktop-browser turn creates one durable waiting activity without an Agent Run", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-waiting-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Launch Project");
  assert.ok(project);

  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Current Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-waiting",
      audience: [],
    },
    text: "  /desktop-browser   open the quarterly planning page  ",
    model: "not-an-approved-model",
  });

  assert.equal(result.status, "ok");
  assert.equal(result.runId, undefined);
  assert.ok(result.sessionId);
  assert.ok(result.desktopBrowserActivity?.taskId);
  assert.deepEqual(result.desktopBrowserActivity, {
    taskId: result.desktopBrowserActivity.taskId,
    status: "waiting_for_broker",
    connectCommand: "qm-host-broker connect https://qm.example.com",
    actionAuthority: result.desktopBrowserActivity.actionAuthority,
    actions: ["cancel"],
  });
  assert.match(result.reply ?? "", /qm-host-broker connect https:\/\/qm\.example\.com/);

  const tasks = await built.desktopBrowserTasks.list();
  assert.equal(tasks.length, 1);
  assert.deepEqual(tasks[0], {
    id: result.desktopBrowserActivity?.taskId,
    status: "waiting_for_broker",
    goal: "open the quarterly planning page",
    actorId: "owner",
    actorSnapshot: { id: "owner", displayName: "Current Owner" },
    projectId: project.id,
    projectSnapshot: { id: project.id, name: "Launch Project" },
    projectMembershipVersion: String(project.updatedAt),
    authorityId: tasks[0]!.authorityId,
    authorityExpiresAt: tasks[0]!.authorityExpiresAt,
    sessionId: result.sessionId,
    threadRef: "web:owner:desktop-browser-waiting",
    createdAt: tasks[0]!.createdAt,
    updatedAt: tasks[0]!.updatedAt,
  });
  assert.equal(Number.isFinite(tasks[0]!.createdAt), true);
  assert.equal(Number.isFinite(tasks[0]!.updatedAt), true);
  assert.ok(tasks[0]!.authorityId);
  assert.equal(result.desktopBrowserActivity.actionAuthority, tasks[0]!.authorityId);
  assert.ok(tasks[0]!.authorityExpiresAt > tasks[0]!.createdAt);
  assert.equal("operationId" in tasks[0]!, false);
  assert.equal("browserSkillSessionId" in tasks[0]!, false);
  assert.deepEqual(await built.runs.list(), []);
  const session = await built.app.getSession(result.sessionId);
  assert.deepEqual(
    session?.entries.map((entry) => entry.type),
    ["user", "assistant"],
  );
  assert.deepEqual(await built.sessions.listLlmRequests(result.sessionId), []);
  assert.equal(
    (session?.entries[1]?.payload as { desktopBrowserActivity?: { taskId?: string } } | undefined)
      ?.desktopBrowserActivity?.taskId,
    tasks[0]!.id,
  );
  assert.ok(
    (await built.auditLog.events()).some(
      (event) =>
        event.action === "desktop_browser.task.created" &&
        event.principalId === "owner" &&
        event.resource === tasks[0]!.id &&
        event.status === "waiting_for_broker",
    ),
  );
});

test("waiting task activity replays reservation fingerprint and staged confirmation readiness through one card", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-confirmation-activity-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Confirmation Project");
  assert.ok(project);
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner", displayName: "Owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-confirmation-activity",
      audience: [],
    },
    text: "/desktop-browser open the dashboard",
  });
  const taskId = created.desktopBrowserActivity?.taskId;
  const authorityId = created.desktopBrowserActivity?.actionAuthority;
  assert.ok(taskId);
  assert.ok(authorityId);

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const reserved = await built.app.desktopBrowserReserveRegistration(taskId!, authorityId!, {
    devicePublicKey: `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`,
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    operatingSystem: "macos-arm64",
  });
  assert.equal(reserved.status, "ok");
  if (reserved.status !== "ok") return;

  const afterReserve = await built.app.getSession(created.sessionId!);
  const reservedActivity = afterReserve?.entries.findLast((entry) => entry.type === "assistant")?.payload as
    | { desktopBrowserActivity?: { status?: string; registration?: { confirmReady?: boolean; confirmationFingerprint?: string } } }
    | undefined;
  assert.equal(reservedActivity?.desktopBrowserActivity?.status, "waiting_for_local_confirmation");
  assert.equal(reservedActivity?.desktopBrowserActivity?.registration?.confirmReady, false);
  assert.equal(
    reservedActivity?.desktopBrowserActivity?.registration?.confirmationFingerprint,
    reserved.reservation.confirmationFingerprint,
  );

  const envelope = {
    registrationTuple: reserved.reservation.registrationTuple,
    publicIdentity: reserved.reservation.publicIdentity,
    confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    signatureAlgorithm: "ed25519" as const,
    signature: Buffer.from(
      sign(null, Buffer.from(reserved.reservation.verificationBytesBase64, "base64"), privateKey),
    ).toString("base64"),
  };
  assert.deepEqual(
    await built.app.desktopBrowserStageRegistrationConfirmation(
      String(reserved.reservation.registrationTuple.registrationId),
      {
        browserRuntimeStatus: "ready",
        envelope,
      },
    ),
    {
      status: "ok",
      registration: {
        registrationId: String(reserved.reservation.registrationTuple.registrationId),
        confirmationFingerprint: reserved.reservation.confirmationFingerprint,
        expiresAt: String(reserved.reservation.registrationTuple.expiresAt),
        status: "ready_to_confirm",
      },
    },
  );

  const afterStage = await built.app.getSession(created.sessionId!);
  const stagedActivity = afterStage?.entries.findLast((entry) => entry.type === "assistant")?.payload as
    | { desktopBrowserActivity?: { status?: string; registration?: { confirmReady?: boolean } } }
    | undefined;
  assert.equal(stagedActivity?.desktopBrowserActivity?.status, "waiting_for_local_confirmation");
  assert.equal(stagedActivity?.desktopBrowserActivity?.registration?.confirmReady, true);

  const confirmed = await built.app.desktopBrowserConfirmRegistration(
    String(reserved.reservation.registrationTuple.registrationId),
    "owner",
    authorityId!,
    {
      taskId: taskId!,
      confirmationFingerprint: reserved.reservation.confirmationFingerprint,
    },
  );
  assert.equal(confirmed.status, "ok");
  assert.equal(confirmed.desktopBrowserActivity?.status, "registration_confirmed");
});

test("desktop browser routing stays explicit and current Project authorization fails closed", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-authorization-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
    { principalId: "outsider", displayName: "Outsider", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Authorized Project");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const conversation = {
    kind: "group" as const,
    channelRef: projectGroupRef(project.id),
    threadRef: "web:owner:desktop-browser-authorization",
    audience: [],
  };

  const ordinary = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation,
    text: "please use a desktop browser when you answer",
  });
  assert.equal(ordinary.status, "ok");
  assert.equal(ordinary.desktopBrowserActivity, undefined);
  assert.deepEqual(await built.desktopBrowserTasks.list(), []);

  const outsider = await built.app.turn({
    surface: "web",
    actor: { externalId: "outsider" },
    conversation,
    text: "/desktop-browser open the billing page",
  });
  assert.equal(outsider.status, "refused");

  assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
  const removed = await built.app.turn({
    surface: "web",
    actor: { externalId: "member" },
    conversation,
    text: "/desktop-browser continue existing-task",
  });
  assert.equal(removed.status, "refused");

  await built.identity.deactivate("owner");
  const deactivated = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation,
    text: "/desktop-browser open the billing page",
  });
  assert.equal(deactivated.status, "refused");
  assert.deepEqual(await built.desktopBrowserTasks.list(), []);
});

test("a current Project member derived from its linked channel can create a waiting task", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-derived-member-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "channel-member", displayName: "Channel Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Channel Project");
  assert.ok(project);
  assert.equal(
    (
      await built.projects.setSlackChannel(project.id, "owner", {
        channelId: "C-DESKTOP",
        channelName: "desktop-browser",
      })
    ).status,
    "ok",
  );
  assert.equal((await built.projects.syncChannelMembers(project.id, ["owner", "channel-member"])).status, "ok");

  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: "channel-member" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:channel-member:desktop-browser-derived-member",
      audience: [],
    },
    text: "/desktop-browser open the project dashboard",
  });

  assert.equal(result.status, "ok", result.reason);
  assert.equal(result.desktopBrowserActivity?.status, "waiting_for_broker");
  assert.equal((await built.desktopBrowserTasks.list())[0]?.actorId, "channel-member");
});

test("waiting-task cancellation revalidates actor, Project epoch, and Turn authority without creating a Run", async () => {
  const originalNow = Date.now;
  let now = 10_000;
  Date.now = () => now;
  try {
    const built = buildApp(
      testConfig({
        dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-actions-")),
        publicWebUrl: "https://qm.example.com",
      }),
    );
    await built.app.upsertDirectory([
      { principalId: "owner", displayName: "Owner", type: "internal" },
      { principalId: "outsider", displayName: "Outsider", type: "internal" },
    ]);
    const project = await built.app.createProject("owner", "Action Project");
    assert.ok(project);
    const created = await built.app.turn({
      surface: "web",
      actor: { externalId: "owner" },
      conversation: {
        kind: "group",
        channelRef: projectGroupRef(project.id),
        threadRef: "web:owner:desktop-browser-actions",
        audience: [],
      },
      text: "/desktop-browser open the project dashboard",
    });
    const taskId = created.desktopBrowserActivity?.taskId;
    assert.ok(taskId);

    const task = await built.desktopBrowserTasks.get(taskId);
    assert.ok(task);
    const outsider = await built.app.desktopBrowserTaskAction(taskId, "outsider", task.authorityId, "cancel");
    assert.equal(outsider.status, "refused");

    await built.identity.deactivate("owner");
    const deactivated = await built.app.desktopBrowserTaskAction(taskId, "owner", task.authorityId, "cancel");
    assert.equal(deactivated.status, "refused");
    await built.identity.reactivate("owner");

    const acquireLease = built.sessions.acquireLease.bind(built.sessions);
    built.sessions.acquireLease = async (...args) => {
      now += CAPABILITY_TTL_MS + 1;
      return acquireLease(...args);
    };
    const expired = await built.app.desktopBrowserTaskAction(taskId, "owner", task.authorityId, "cancel");
    assert.equal(expired.status, "refused");
    assert.match(expired.reason ?? "", /expired/);
    assert.equal((await built.desktopBrowserTasks.get(taskId))?.status, "waiting_for_broker");
    assert.deepEqual(await built.runs.list(), []);
  } finally {
    Date.now = originalNow;
  }
});

test("the authorized actor can cancel a waiting task without creating a Run", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-cancel-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Cancel Project");
  assert.ok(project);
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-cancel",
      audience: [],
    },
    text: "/desktop-browser open the project dashboard",
  });
  const taskId = created.desktopBrowserActivity?.taskId;
  assert.ok(taskId);

  const taskBeforeCancel = await built.desktopBrowserTasks.get(taskId);
  assert.ok(taskBeforeCancel);
  const forged = await built.app.desktopBrowserTaskAction(taskId, "owner", "wrong-authority", "cancel");
  assert.equal(forged.status, "refused");
  assert.equal((await built.desktopBrowserTasks.get(taskId))?.status, "waiting_for_broker");
  const canceled = await built.app.desktopBrowserTaskAction(taskId, "owner", taskBeforeCancel.authorityId, "cancel");
  assert.equal(canceled.status, "ok");
  assert.equal(canceled.desktopBrowserActivity?.status, "canceled");
  assert.deepEqual(canceled.desktopBrowserActivity?.actions, []);
  assert.equal((await built.desktopBrowserTasks.get(taskId))?.status, "canceled");
  assert.deepEqual(await built.runs.list(), []);
  const task = await built.desktopBrowserTasks.get(taskId);
  assert.ok(task);
  const entries = await built.sessions.getEntries(task.sessionId);
  assert.equal(entries.filter((entry) => entry.type === "assistant").length, 2);
  assert.equal(
    (entries.at(-1)?.payload as { desktopBrowserActivity?: { status?: string } } | undefined)?.desktopBrowserActivity
      ?.status,
    "canceled",
  );
});

test("a waiting task remains visible when the first activity append fails after task persistence", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-projection-heal-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Projection Project");
  assert.ok(project);
  const append = built.sessions.append.bind(built.sessions);
  let failAssistant = true;
  built.sessions.append = async (lease, entry) => {
    if (failAssistant && entry.type === "assistant") {
      failAssistant = false;
      throw new Error("activity append failed");
    }
    return append(lease, entry);
  };

  const result = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-projection-heal",
      audience: [],
    },
    text: "/desktop-browser open the dashboard",
  });
  assert.equal(result.status, "ok");
  assert.equal(result.desktopBrowserActivity?.status, "waiting_for_broker");
  built.sessions.append = append;

  const task = (await built.desktopBrowserTasks.list())[0];
  assert.ok(task);
  const healed = await built.app.getSession(task.sessionId);
  const activity = healed?.entries.find((entry) => entry.type === "assistant")?.payload as
    { desktopBrowserActivity?: { taskId?: string; status?: string } } | undefined;
  assert.equal(activity?.desktopBrowserActivity?.taskId, task.id);
  assert.equal(activity?.desktopBrowserActivity?.status, "waiting_for_broker");
});

test("membership loss racing session lease acquisition prevents cancellation", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-cancel-race-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([
    { principalId: "owner", displayName: "Owner", type: "internal" },
    { principalId: "member", displayName: "Member", type: "internal" },
  ]);
  const project = await built.app.createProject("owner", "Race Project");
  assert.ok(project);
  assert.equal((await built.app.addProjectMember(project.id, "owner", "member")).status, "ok");
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "member" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:member:desktop-browser-cancel-race",
      audience: [],
    },
    text: "/desktop-browser open the dashboard",
  });
  const task = await built.desktopBrowserTasks.get(created.desktopBrowserActivity!.taskId);
  assert.ok(task);
  const acquireLease = built.sessions.acquireLease.bind(built.sessions);
  let removed = false;
  built.sessions.acquireLease = async (...args) => {
    if (!removed) {
      removed = true;
      assert.equal((await built.app.removeProjectMember(project.id, "owner", "member")).status, "ok");
    }
    return acquireLease(...args);
  };

  const canceled = await built.app.desktopBrowserTaskAction(task.id, "member", task.authorityId, "cancel");
  assert.equal(canceled.status, "refused");
  assert.equal((await built.desktopBrowserTasks.get(task.id))?.status, "waiting_for_broker");
});

test("a canceled task projects its final state when the cancellation activity append fails", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-cancel-heal-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Cancel Heal Project");
  assert.ok(project);
  const created = await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation: {
      kind: "group",
      channelRef: projectGroupRef(project.id),
      threadRef: "web:owner:desktop-browser-cancel-heal",
      audience: [],
    },
    text: "/desktop-browser open the dashboard",
  });
  const task = await built.desktopBrowserTasks.get(created.desktopBrowserActivity!.taskId);
  assert.ok(task);
  const append = built.sessions.append.bind(built.sessions);
  built.sessions.append = async (_lease, entry) => {
    if (entry.type === "assistant") throw new Error("cancel activity append failed");
    return append(_lease, entry);
  };

  const canceled = await built.app.desktopBrowserTaskAction(task.id, "owner", task.authorityId, "cancel");
  assert.equal(canceled.status, "ok");
  assert.equal(canceled.desktopBrowserActivity?.status, "canceled");
  built.sessions.append = append;
  assert.equal((await built.desktopBrowserTasks.get(task.id))?.status, "canceled");
  const healed = await built.app.getSession(task.sessionId);
  const activity = healed?.entries.findLast((entry) => entry.type === "assistant")?.payload as
    { desktopBrowserActivity?: { status?: string; actions?: string[] } } | undefined;
  assert.equal(activity?.desktopBrowserActivity?.status, "canceled");
  assert.deepEqual(activity?.desktopBrowserActivity?.actions, []);
});

test("session projection self-heals every Desktop Browser Task independently", async () => {
  const built = buildApp(
    testConfig({
      dataDir: mkdtempSync(join(tmpdir(), "desktop-browser-multi-projection-")),
      publicWebUrl: "https://qm.example.com",
    }),
  );
  await built.app.upsertDirectory([{ principalId: "owner", displayName: "Owner", type: "internal" }]);
  const project = await built.app.createProject("owner", "Multi Task Project");
  assert.ok(project);
  const conversation = {
    kind: "group" as const,
    channelRef: projectGroupRef(project.id),
    threadRef: "web:owner:desktop-browser-multi-projection",
    audience: [],
  };
  await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation,
    text: "/desktop-browser open the first dashboard",
  });
  await built.app.turn({
    surface: "web",
    actor: { externalId: "owner" },
    conversation,
    text: "/desktop-browser open the second dashboard",
  });
  const [first, second] = await built.desktopBrowserTasks.list();
  assert.ok(first && second);
  const append = built.sessions.append.bind(built.sessions);
  built.sessions.append = async (_lease, entry) => {
    if (entry.type === "assistant") throw new Error("cancel activity append failed");
    return append(_lease, entry);
  };

  const canceled = await built.app.desktopBrowserTaskAction(first.id, "owner", first.authorityId, "cancel");
  assert.equal(canceled.status, "ok");
  built.sessions.append = append;
  const healed = await built.app.getSession(first.sessionId);
  const activities = healed?.entries.flatMap((entry) => {
    const activity = (entry.payload as { desktopBrowserActivity?: { taskId: string; status: string } } | null)
      ?.desktopBrowserActivity;
    return activity ? [activity] : [];
  });
  assert.deepEqual(
    activities?.map(({ taskId, status }) => ({ taskId, status })),
    [
      { taskId: first.id, status: "canceled" },
      { taskId: second.id, status: "waiting_for_broker" },
    ],
  );
});

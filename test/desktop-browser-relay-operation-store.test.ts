import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDesktopBrowserObserveArgv, computeDesktopBrowserRequestHash } from "qm-desktop-browser-contracts";
import {
  canonicalRelayJson,
  createMemoryDesktopBrowserRelayOperationBacking,
  createDesktopBrowserRelayOperationStore,
} from "../packages/qm-broker-relay/src/operation-store.ts";
import {
  desktopBrowserRelayInvocationFixture,
  desktopBrowserSessionStartAcceptedFixture,
  desktopBrowserSessionStartCompletedResultFixture,
} from "../packages/desktop-browser-contracts/src/fixtures.ts";
import type { HostLocalStopReceiptMessage } from "qm-desktop-browser-contracts";

test("Ticket 08 consumes Core request nonces atomically across Relay replicas", async () => {
  const backing = createMemoryDesktopBrowserRelayOperationBacking();
  const first = createDesktopBrowserRelayOperationStore(backing);
  const second = createDesktopBrowserRelayOperationStore(backing);

  const consumed = await Promise.all([
    first.consumeCoreNonce("shared-nonce", 301_000, 1_000),
    second.consumeCoreNonce("shared-nonce", 301_000, 1_000),
  ]);
  assert.deepEqual(consumed.sort(), [false, true]);
  assert.equal(await second.consumeCoreNonce("shared-nonce", 602_000, 302_000), true);
});

test("Ticket 11 persists Local Stop Receipt evidence and callback exactly once", async () => {
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking(), {
    now: () => 22_000,
  });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  const authority = desktopBrowserRelayInvocationFixture.payload.authority;
  const receipt: HostLocalStopReceiptMessage = {
    protocolVersion: "1.3",
    kind: "host.local-stop-receipt",
    payload: {
      receiptId: "local-stop-42-operation-1-20000",
      processEpoch: 42,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      operationId: authority.operationId,
      operationCategory: "session_start",
      requestedAt: 20_000,
      status: "canceled",
    },
  };

  const host = { publicDeviceFingerprint: authority.deviceId, browserInstanceId: authority.browserInstanceId };
  assert.equal(await store.recordLocalStopReceipt(receipt, host), "recorded");
  assert.equal(await store.recordLocalStopReceipt(receipt, host), "existing");
  assert.deepEqual(await store.localStopReceipts(), [{ message: receipt, receivedAt: 22_000 }]);
  assert.deepEqual(await store.pendingLocalStopCallbacks(), [
    {
      receiptId: receipt.payload.receiptId,
      message: receipt,
      createdAt: 22_000,
      deliveredAt: null,
      attempts: 0,
      nextAttemptAt: 22_000,
      claimOwner: null,
      claimExpiresAt: null,
      deadLetteredAt: null,
    },
  ]);
});

test("Ticket 11 canceled receipt supersedes a claimed requested callback without being lost", async () => {
  let now = 23_000;
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking(), {
    now: () => now,
  });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  const authority = desktopBrowserRelayInvocationFixture.payload.authority;
  const host = { publicDeviceFingerprint: authority.deviceId, browserInstanceId: authority.browserInstanceId };
  const requested = {
    protocolVersion: "1.3",
    kind: "host.local-stop-receipt",
    payload: {
      receiptId: "local-stop-monotonic",
      processEpoch: 42,
      taskId: authority.taskId,
      attemptId: authority.attemptId,
      operationId: authority.operationId,
      operationCategory: "session_start",
      requestedAt: 20_000,
      status: "requested",
    },
  } as const;
  await store.recordLocalStopReceipt(requested, host);
  const [claimed] = await store.claimLocalStopCallbacks("old-worker", 1, 30_000);
  assert.equal(claimed?.message.payload.status, "requested");
  now += 1;
  const canceled = { ...requested, payload: { ...requested.payload, status: "canceled" as const } };
  assert.equal(await store.recordLocalStopReceipt(canceled, host), "recorded");
  assert.equal(await store.markLocalStopCallbackDelivered(requested.payload.receiptId, "old-worker", "requested"), false);
  const [pending] = await store.pendingLocalStopCallbacks();
  assert.equal(pending?.message.payload.status, "canceled");
  assert.equal(pending?.claimOwner, null);
});

test("Ticket 07 persists one checkpoint, append-only evidence, scrubbed terminal state, and callback outbox", async () => {
  const backing = createMemoryDesktopBrowserRelayOperationBacking();
  const first = createDesktopBrowserRelayOperationStore(backing, { now: () => 1_000 });

  assert.deepEqual(await first.prepare(desktopBrowserRelayInvocationFixture), {
    status: "prepared",
    checkpoint: {
      attemptId: desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
      operationId: desktopBrowserRelayInvocationFixture.payload.authority.operationId,
      requestHash: desktopBrowserRelayInvocationFixture.payload.requestHash,
      state: "prepared",
      deliveryState: "not_started",
      invocation: desktopBrowserRelayInvocationFixture,
      updatedAt: 1_000,
    },
  });
  await first.markDeliveryStarted(
    desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
    desktopBrowserRelayInvocationFixture.payload.dispatchId,
  );
  await first.recordAccepted(desktopBrowserSessionStartAcceptedFixture);

  const restarted = createDesktopBrowserRelayOperationStore(backing, { now: () => 2_000 });
  assert.equal(
    (await restarted.checkpoint(desktopBrowserRelayInvocationFixture.payload.authority.attemptId))?.state,
    "accepted",
  );
  assert.deepEqual(await restarted.acceptedEvidence(), [
    {
      protocolVersion: desktopBrowserSessionStartAcceptedFixture.protocolVersion,
      operationId: desktopBrowserSessionStartAcceptedFixture.payload.operationId,
      dispatchId: desktopBrowserSessionStartAcceptedFixture.payload.dispatchId,
      requestHash: desktopBrowserSessionStartAcceptedFixture.payload.requestHash,
      acceptedAt: 1_000,
    },
  ]);

  await restarted.recordTerminal(desktopBrowserSessionStartCompletedResultFixture);
  const terminalCheckpoint = await restarted.checkpoint(
    desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
  );
  assert.deepEqual(terminalCheckpoint, {
    attemptId: desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
    operationId: desktopBrowserRelayInvocationFixture.payload.authority.operationId,
    requestHash: desktopBrowserRelayInvocationFixture.payload.requestHash,
    state: "terminal",
    deliveryState: "started",
    dispatchId: desktopBrowserRelayInvocationFixture.payload.dispatchId,
    terminalOutcome: "completed",
    resultHash: desktopBrowserSessionStartCompletedResultFixture.payload.resultHash,
    updatedAt: 2_000,
  });
  assert.equal("invocation" in terminalCheckpoint!, false);
  assert.deepEqual(await restarted.terminalEvidence(), [
    {
      operationId: desktopBrowserSessionStartCompletedResultFixture.payload.operationId,
      dispatchId: desktopBrowserSessionStartCompletedResultFixture.payload.dispatchId,
      resultHash: desktopBrowserSessionStartCompletedResultFixture.payload.resultHash,
      outcome: "completed",
      terminalAt: 2_000,
    },
  ]);
  assert.deepEqual(await restarted.pendingCallbacks(), [
    {
      taskId: desktopBrowserRelayInvocationFixture.payload.authority.taskId,
      operationId: desktopBrowserSessionStartCompletedResultFixture.payload.operationId,
      callbackType: "terminal",
      accepted: desktopBrowserSessionStartAcceptedFixture,
      result: desktopBrowserSessionStartCompletedResultFixture,
      createdAt: 2_000,
      deliveredAt: null,
      attempts: 0,
      nextAttemptAt: 2_000,
      claimOwner: null,
      claimExpiresAt: null,
      deadLetteredAt: null,
    },
  ]);

  const nextAuthority = {
    ...desktopBrowserRelayInvocationFixture.payload.authority,
    operationId: "operation-2",
    operationSequence: 2,
    leaseVersion: 4,
    nonce: "nonce-2",
  };
  const nextInvocation = {
    ...desktopBrowserRelayInvocationFixture,
    payload: {
      dispatchId: "dispatch-2",
      requestHash: computeDesktopBrowserRequestHash(nextAuthority),
      authority: nextAuthority,
    },
  };
  assert.equal((await restarted.prepare(nextInvocation)).status, "prepared");
  await restarted.markDeliveryStarted(nextAuthority.attemptId, nextInvocation.payload.dispatchId);
  await restarted.recordAccepted(desktopBrowserSessionStartAcceptedFixture);
  await restarted.recordTerminal(desktopBrowserSessionStartCompletedResultFixture);

  assert.deepEqual(await restarted.checkpoint(nextAuthority.attemptId), {
    attemptId: nextAuthority.attemptId,
    operationId: nextAuthority.operationId,
    requestHash: nextInvocation.payload.requestHash,
    state: "prepared",
    deliveryState: "started",
    dispatchId: nextInvocation.payload.dispatchId,
    invocation: nextInvocation,
    updatedAt: 2_000,
  });
  assert.equal((await restarted.acceptedEvidence()).length, 1);
  assert.equal((await restarted.terminalEvidence()).length, 1);
  assert.equal((await restarted.pendingCallbacks()).length, 1);
  await restarted.markCallbackDelivered(
    desktopBrowserSessionStartCompletedResultFixture.payload.operationId,
    "terminal",
  );
  await restarted.markCallbackDelivered(
    desktopBrowserSessionStartCompletedResultFixture.payload.operationId,
    "terminal",
  );
  assert.deepEqual(await restarted.pendingCallbacks(), []);
});

test("Ticket 07 terminalizes accepted disconnect as unknown with evidence and callback in one transaction", async () => {
  const backing = createMemoryDesktopBrowserRelayOperationBacking();
  const store = createDesktopBrowserRelayOperationStore(backing, { now: () => 3_000 });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  await store.markDeliveryStarted(
    desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
    desktopBrowserRelayInvocationFixture.payload.dispatchId,
  );
  await store.recordAccepted(desktopBrowserSessionStartAcceptedFixture);

  const result = await store.recordAcceptedUnknown(desktopBrowserSessionStartAcceptedFixture);

  assert.equal(result.payload.outcome, "unknown");
  assert.equal(
    (await store.checkpoint(desktopBrowserRelayInvocationFixture.payload.authority.attemptId))?.state,
    "accepted_unknown",
  );
  assert.equal((await store.terminalEvidence()).at(-1)?.outcome, "unknown");
  assert.equal((await store.pendingCallbacks()).at(-1)?.result?.payload.outcome, "unknown");
});

test("Ticket 16 Relay scrubs delivered observation text while retaining terminal metadata", async () => {
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking(), {
    now: () => 5_000,
  });
  const authority = {
    ...desktopBrowserRelayInvocationFixture.payload.authority,
    operationId: "operation-observation-scrub",
    operationSequence: 2,
    leaseVersion: 4,
    capabilitySet: { ...desktopBrowserRelayInvocationFixture.payload.authority.capabilitySet, protocolVersion: "1.3" as const },
    argv: buildDesktopBrowserObserveArgv("session-1"),
    effectClass: "observation" as const,
  };
  const invocation = {
    protocolVersion: "1.3" as const,
    kind: "relay.invoke" as const,
    payload: {
      dispatchId: "dispatch-observation-scrub",
      requestHash: computeDesktopBrowserRequestHash(authority, "1.3"),
      authority,
    },
  };
  const accepted = {
    protocolVersion: "1.3" as const,
    kind: "host.accepted" as const,
    payload: {
      dispatchId: invocation.payload.dispatchId,
      operationId: authority.operationId,
      requestHash: invocation.payload.requestHash,
    },
  };
  const result = {
    protocolVersion: "1.3" as const,
    kind: "host.result" as const,
    payload: {
      dispatchId: invocation.payload.dispatchId,
      operationId: authority.operationId,
      outcome: "completed" as const,
      resultHash: "sha256:observation-scrub",
      result: {
        schemaVersion: "1.0" as const,
        command: "observe" as const,
        completedAt: "2026-08-29T12:00:00.000Z",
        data: { tab_id: 7, text: "private observed page text", ref_count: 1, truncated: false },
      },
    },
  };
  await store.prepare(invocation);
  await store.markDeliveryStarted(authority.attemptId, invocation.payload.dispatchId);
  await store.recordAccepted(accepted);
  await store.recordTerminal(result);
  assert.doesNotMatch(JSON.stringify(await store.terminalEvidence()), /private observed page text/);
  assert.match(JSON.stringify(await store.pendingCallbacks()), /private observed page text/);

  await store.markCallbackDelivered(authority.operationId, "terminal");

  assert.doesNotMatch(JSON.stringify(await store.terminalEvidence()), /private observed page text/);
  assert.doesNotMatch(JSON.stringify(await store.attemptStatus(authority.attemptId)), /private observed page text/);
  assert.deepEqual(await store.pendingCallbacks(), []);
});

test("Ticket 07 keeps the first terminal fact when disconnect races a real result", async () => {
  const backing = createMemoryDesktopBrowserRelayOperationBacking();
  const store = createDesktopBrowserRelayOperationStore(backing, { now: () => 4_000 });
  await store.prepare(desktopBrowserRelayInvocationFixture);
  await store.markDeliveryStarted(
    desktopBrowserRelayInvocationFixture.payload.authority.attemptId,
    desktopBrowserRelayInvocationFixture.payload.dispatchId,
  );
  await store.recordAccepted(desktopBrowserSessionStartAcceptedFixture);
  await store.recordTerminal(desktopBrowserSessionStartCompletedResultFixture);

  const settled = await store.recordAcceptedUnknown(desktopBrowserSessionStartAcceptedFixture);

  assert.deepEqual(settled, desktopBrowserSessionStartCompletedResultFixture);
  assert.equal(
    (await store.checkpoint(desktopBrowserRelayInvocationFixture.payload.authority.attemptId))?.terminalOutcome,
    "completed",
  );
  assert.equal((await store.terminalEvidence()).length, 1);
  const conflicting = {
    ...desktopBrowserSessionStartCompletedResultFixture,
    payload: {
      ...desktopBrowserSessionStartCompletedResultFixture.payload,
      outcome: "failed" as const,
      error: { code: "conflict", message: "conflict" },
    },
  };
  delete (conflicting.payload as { result?: unknown }).result;
  await assert.rejects(store.recordTerminal(conflicting), /conflicts with persisted evidence/);
});

test("Ticket 07 permits only one concurrent current operation per Attempt", async () => {
  const store = createDesktopBrowserRelayOperationStore(createMemoryDesktopBrowserRelayOperationBacking());
  const competingAuthority = {
    ...desktopBrowserRelayInvocationFixture.payload.authority,
    operationId: "competing-operation",
    nonce: "competing-nonce",
  };
  const competing = {
    ...desktopBrowserRelayInvocationFixture,
    payload: {
      ...desktopBrowserRelayInvocationFixture.payload,
      requestHash: computeDesktopBrowserRequestHash(competingAuthority),
      authority: competingAuthority,
    },
  };

  const settled = await Promise.allSettled([
    store.prepare(desktopBrowserRelayInvocationFixture),
    store.prepare(competing),
  ]);

  assert.equal(settled.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(settled.filter((result) => result.status === "rejected").length, 1);
});

test("Ticket 07 canonical terminal comparison ignores JSONB key order", () => {
  assert.equal(
    canonicalRelayJson({ protocolVersion: "1.2", payload: { outcome: "completed", resultHash: "sha256:x" } }),
    canonicalRelayJson({ payload: { resultHash: "sha256:x", outcome: "completed" }, protocolVersion: "1.2" }),
  );
});

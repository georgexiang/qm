import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  buildDesktopBrowserSessionStartArgv,
  computeDesktopBrowserRequestHash,
  decodeDesktopBrowserMessage,
  encodeDesktopBrowserMessage,
  parseDesktopBrowserCapabilitySet,
  parseDesktopBrowserSessionStartAuthorityEnvelope,
  type DesktopBrowserCapabilitySet,
  type DesktopBrowserSessionStartAuthorityEnvelope,
} from "qm-desktop-browser-contracts";

const capabilitySet: DesktopBrowserCapabilitySet = {
  protocolVersion: "1.2",
  policyGrammarVersion: "1.0",
  bskVersion: "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c",
  extensionVersion: "2.0.19",
  cliShapeHash: "sha256:browser-cli-shape-v1",
};

const authority: DesktopBrowserSessionStartAuthorityEnvelope = {
  authorityVersion: "1.0",
  audience: DESKTOP_BROWSER_RELAY_AUDIENCE,
  deploymentCanonicalId: "qm://deployments/example",
  actorId: "actor-1",
  actorSnapshotHash: "sha256:actor-snapshot-1",
  projectId: "project-1",
  projectSnapshotHash: "sha256:project-snapshot-1",
  membershipEpoch: 42,
  taskId: "task-1",
  attemptId: "attempt-1",
  deviceId: "device-1",
  browserInstanceId: "browser-primary",
  leaseId: "lease-1",
  leaseVersion: 3,
  leaseExpiresAt: "2026-08-27T12:01:00.000Z",
  operationId: "0198f3d2-1950-7000-8000-000000000001",
  operationSequence: 1,
  capabilitySet,
  argv: ["--json", "session", "start", "--browser", "browser-primary"],
  brokerOptions: { forceSharedRuntime: false },
  effectClass: "local_effect",
  nonce: "nonce-1",
  issuedAt: "2026-08-27T12:00:00.000Z",
};

test("Ticket 05 publishes a strict capability identity and canonical 60-second session-start authority", () => {
  assert.deepEqual(parseDesktopBrowserCapabilitySet(capabilitySet), capabilitySet);
  assert.throws(
    () => parseDesktopBrowserCapabilitySet({ ...capabilitySet, protocolVersion: "1.1" }),
    /capability protocol version 1\.1 does not equal expected version 1\.2/,
  );
  assert.deepEqual(
    parseDesktopBrowserCapabilitySet(
      { ...capabilitySet, protocolVersion: "1.1", policyGrammarVersion: "0.9" },
      "1.1",
      "0.9",
    ),
    { ...capabilitySet, protocolVersion: "1.1", policyGrammarVersion: "0.9" },
  );
  const previousAuthority = {
    ...authority,
    capabilitySet: { ...capabilitySet, protocolVersion: "1.1" as const, policyGrammarVersion: "0.9" as const },
  };
  assert.deepEqual(
    parseDesktopBrowserSessionStartAuthorityEnvelope(previousAuthority, "1.1", "0.9"),
    previousAuthority,
  );
  const additiveAuthority = {
    ...authority,
    authorityVersion: "1.1" as const,
    futureAuthorityField: "rejected",
  };
  assert.throws(
    () => parseDesktopBrowserSessionStartAuthorityEnvelope(additiveAuthority),
    /desktop browser session-start authority envelope does not match its schema/,
  );
  assert.throws(
    () => parseDesktopBrowserSessionStartAuthorityEnvelope({ ...authority, futureAuthorityField: "not-yet-valid" }),
    /desktop browser session-start authority envelope does not match its schema/,
  );
  assert.deepEqual(buildDesktopBrowserSessionStartArgv("browser-primary"), authority.argv);
  assert.deepEqual(parseDesktopBrowserSessionStartAuthorityEnvelope(authority), authority);

  assert.throws(
    () => parseDesktopBrowserCapabilitySet({ ...capabilitySet, brokerVersion: "not-in-capability-identity" }),
    /desktop browser capability set does not match its schema/,
  );
  assert.throws(
    () =>
      parseDesktopBrowserSessionStartAuthorityEnvelope({
        ...authority,
        leaseExpiresAt: "2026-08-27T12:01:00.001Z",
      }),
    /lease must expire exactly 60 seconds after issuedAt/,
  );
  assert.throws(
    () =>
      parseDesktopBrowserSessionStartAuthorityEnvelope({
        ...authority,
        argv: ["--json", "session", "start"],
      }),
    /canonical session-start argv/,
  );
  assert.throws(
    () =>
      parseDesktopBrowserSessionStartAuthorityEnvelope({
        ...authority,
        brokerOptions: { forceSharedRuntime: true },
      }),
    /forceSharedRuntime must be false for Ticket 05/,
  );
});

test("Ticket 05 relay.invoke carries a strict authority plus dispatch identity and request hash", () => {
  const invocation = {
    protocolVersion: "1.2",
    kind: "relay.invoke",
    payload: {
      dispatchId: "0198f3d2-1950-7000-8000-000000000002",
      requestHash: computeDesktopBrowserRequestHash(authority),
      authority,
    },
  };

  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(invocation), "1.2"), invocation);
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(invocation), "1.0"),
    /relay\.invoke protocol version 1\.2 does not equal negotiated version 1\.0/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...invocation, traceContext: "not-valid-in-1.2" }), "1.2"),
    /relay\.invoke message does not match its schema/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...invocation,
          payload: { ...invocation.payload, deliveryHint: "not-valid-in-1.2" },
        }),
        "1.2",
      ),
    /relay\.invoke message does not match its schema/,
  );
  const newerGrammarAuthority = {
    ...authority,
    capabilitySet: { ...capabilitySet, policyGrammarVersion: "1.1" as const },
  };
  const newerGrammarInvocation = {
    ...invocation,
    payload: {
      ...invocation.payload,
      requestHash: computeDesktopBrowserRequestHash(newerGrammarAuthority, "1.2", "1.1"),
      authority: newerGrammarAuthority,
    },
  };
  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(newerGrammarInvocation), "1.2", "1.1"),
    newerGrammarInvocation,
  );
  const futureAuthority = {
    ...authority,
    capabilitySet: { ...capabilitySet, protocolVersion: "1.7" as const },
  };
  const additiveInvocation = {
    protocolVersion: "1.7",
    kind: "relay.invoke",
    traceContext: "ignored-after-validation",
    payload: {
      dispatchId: invocation.payload.dispatchId,
      requestHash: computeDesktopBrowserRequestHash(futureAuthority, "1.7"),
      authority: futureAuthority,
    },
  };
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(additiveInvocation), "1.2"),
    /relay\.invoke protocol version 1\.7 does not equal negotiated version 1\.2/,
  );
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(additiveInvocation), "1.7"), {
    protocolVersion: "1.7",
    kind: "relay.invoke",
    payload: {
      dispatchId: invocation.payload.dispatchId,
      requestHash: additiveInvocation.payload.requestHash,
      authority: futureAuthority,
    },
  });
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...additiveInvocation,
          payload: {
            ...additiveInvocation.payload,
            deliveryHint: "rejected-inside-operation-payload",
          },
        }),
        "1.7",
      ),
    /relay\.invoke message does not match its schema/,
  );
  for (const nestedAuthority of [
    {
      ...futureAuthority,
      capabilitySet: { ...futureAuthority.capabilitySet, futureCapabilityField: "rejected" },
    },
    {
      ...futureAuthority,
      brokerOptions: { ...futureAuthority.brokerOptions, futureBrokerOption: "rejected" },
    },
  ]) {
    assert.throws(
      () =>
        decodeDesktopBrowserMessage(
          JSON.stringify({
            ...additiveInvocation,
            payload: { ...additiveInvocation.payload, authority: nestedAuthority },
          }),
          "1.7",
        ),
      /relay\.invoke message does not match its schema/,
    );
  }
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...additiveInvocation,
          payload: {
            ...additiveInvocation.payload,
            authority: { ...futureAuthority, futureAuthorityField: "rejected" },
          },
        }),
        "1.7",
      ),
    /relay\.invoke message does not match its schema/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...invocation, protocolVersion: "1.0" }), "1.0"),
    /relay\.invoke requires Ticket 05 protocol version 1\.2 or newer compatible minor/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...invocation,
          payload: { ...invocation.payload, authority: { ...authority, connectionEpoch: 9 } },
        }),
        "1.2",
      ),
    /relay\.invoke message does not match its schema/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...invocation,
          payload: { ...invocation.payload, requestHash: `sha256:${"0".repeat(64)}` },
        }),
        "1.2",
      ),
    /requestHash .* does not match canonical request hash/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...invocation,
          payload: {
            ...invocation.payload,
            authority: { ...authority, taskId: "task-2" },
          },
        }),
        "1.2",
      ),
    /requestHash .* does not match canonical request hash/,
  );
});

test("Ticket 05 host.accepted carries the unique fsynced acceptance point", () => {
  const accepted = {
    protocolVersion: "1.2",
    kind: "host.accepted",
    payload: {
      dispatchId: "0198f3d2-1950-7000-8000-000000000002",
      operationId: authority.operationId,
      requestHash: computeDesktopBrowserRequestHash(authority),
    },
  };

  const replayedDispatch = {
    ...accepted,
    payload: {
      ...accepted.payload,
      dispatchId: "0198f3d2-1950-7000-8000-000000000099",
    },
  };

  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(accepted), "1.2"), accepted);
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(replayedDispatch), "1.2"), replayedDispatch);
  assert.equal(accepted.payload.operationId, replayedDispatch.payload.operationId);
  assert.equal(accepted.payload.requestHash, replayedDispatch.payload.requestHash);
  assert.notEqual(accepted.payload.dispatchId, replayedDispatch.payload.dispatchId);
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(accepted), "1.0"),
    /host\.accepted protocol version 1\.2 does not equal negotiated version 1\.0/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...accepted, protocolVersion: "1.0" }), "1.0"),
    /host\.accepted requires Ticket 05 protocol version 1\.2 or newer compatible minor/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...accepted, traceContext: "not-valid-in-1.2" }), "1.2"),
    /host\.accepted message does not match its schema/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...accepted,
          payload: { ...accepted.payload, acceptanceHint: "not-valid-in-1.2" },
        }),
        "1.2",
      ),
    /host\.accepted message does not match its schema/,
  );
  const additiveAccepted = {
    ...accepted,
    protocolVersion: "1.7",
    traceContext: "ignored-after-validation",
  };
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(additiveAccepted), "1.2"),
    /host\.accepted protocol version 1\.7 does not equal negotiated version 1\.2/,
  );
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(additiveAccepted), "1.7"), {
    ...accepted,
    protocolVersion: "1.7",
  });
  for (const field of ["dispatchId", "operationId", "requestHash"] as const) {
    const payload = { ...accepted.payload } as Record<string, unknown>;
    delete payload[field];
    assert.throws(
      () => decodeDesktopBrowserMessage(JSON.stringify({ ...accepted, payload }), "1.2"),
      /host\.accepted message does not match its schema/,
    );
  }
});

test("Ticket 05 host.result is terminal-only after host.accepted", () => {
  const completed = {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: "0198f3d2-1950-7000-8000-000000000002",
      operationId: authority.operationId,
      outcome: "completed",
      resultHash: "sha256:result-1",
      result: {
        session_id: "session-1",
        browser_instance_id: "browser-primary",
        agent_window_id: 42,
      },
    },
  };
  const failed = {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: completed.payload.dispatchId,
      operationId: authority.operationId,
      outcome: "failed",
      resultHash: "sha256:failed-1",
      error: { code: "browser_cli_failed", message: "Browser CLI failed after acceptance" },
    },
  };
  const unknown = {
    protocolVersion: "1.2",
    kind: "host.result",
    payload: {
      dispatchId: completed.payload.dispatchId,
      operationId: authority.operationId,
      outcome: "unknown",
      resultHash: "sha256:unknown-1",
    },
  };

  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(completed), "1.2"), completed);
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(failed), "1.2"), failed);
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(unknown), "1.2"), unknown);
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(completed), "1.0"),
    /host\.result protocol version 1\.2 does not equal negotiated version 1\.0/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(completed), "1.7"),
    /host\.result protocol version 1\.2 does not equal negotiated version 1\.7/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...completed, traceContext: "not-valid-in-1.2" }), "1.2"),
    /host\.result message does not match its schema/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({ ...completed, payload: { ...completed.payload, completionHint: "not-valid-in-1.2" } }),
        "1.2",
      ),
    /host\.result message does not match its schema/,
  );
  const additiveCompleted = {
    ...completed,
    protocolVersion: "1.7",
    traceContext: "ignored-after-validation",
  };
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify(additiveCompleted), "1.2"),
    /host\.result protocol version 1\.7 does not equal negotiated version 1\.2/,
  );
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(additiveCompleted), "1.7"), {
    ...completed,
    protocolVersion: "1.7",
  });
  const canonicalAdditiveCompleted = decodeDesktopBrowserMessage(JSON.stringify(additiveCompleted), "1.7");
  assert.deepEqual(decodeDesktopBrowserMessage(encodeDesktopBrowserMessage(canonicalAdditiveCompleted), "1.7"), {
    ...completed,
    protocolVersion: "1.7",
  });
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...additiveCompleted,
          payload: {
            ...additiveCompleted.payload,
            completionHint: "rejected-inside-operation-payload",
          },
        }),
        "1.7",
      ),
    /host\.result message does not match its schema/,
  );
  const additiveFailure = {
    ...failed,
    protocolVersion: "1.7",
    traceContext: "ignored-after-validation",
  };
  assert.deepEqual(decodeDesktopBrowserMessage(JSON.stringify(additiveFailure), "1.7"), {
    protocolVersion: "1.7",
    kind: "host.result",
    payload: {
      dispatchId: completed.payload.dispatchId,
      operationId: authority.operationId,
      outcome: "failed",
      resultHash: "sha256:failed-1",
      error: { code: "browser_cli_failed", message: "Browser CLI failed after acceptance" },
    },
  });
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...additiveCompleted,
          payload: {
            ...additiveCompleted.payload,
            result: { ...additiveCompleted.payload.result, windowType: "agent" },
          },
        }),
        "1.7",
      ),
    /host\.result message does not match its schema/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...additiveFailure,
          payload: {
            ...additiveFailure.payload,
            error: { ...additiveFailure.payload.error, retryable: false },
          },
        }),
        "1.7",
      ),
    /host\.result message does not match its schema/,
  );
  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...completed, protocolVersion: "1.0" }), "1.0"),
    /host\.result requires Ticket 05 protocol version 1\.2 or newer compatible minor/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...completed,
          payload: {
            ...completed.payload,
            error: { code: "unexpected_error", message: "completed results cannot also fail" },
          },
        }),
        "1.2",
      ),
    /host\.result message does not match its schema/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...completed,
          payload: { ...completed.payload, outcome: "failed" },
        }),
        "1.2",
      ),
    /result is only valid for completed session start/,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...completed,
          payload: { ...completed.payload, result: { ...completed.payload.result, extra: true } },
        }),
        "1.2",
      ),
    /host\.result message does not match its schema/,
  );
});

test("Ticket 05 host.result keeps dispatch identity distinct for the same operation", () => {
  const first = decodeDesktopBrowserMessage(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "host.result",
      payload: {
        dispatchId: "0198f3d2-1950-7000-8000-000000000002",
        operationId: authority.operationId,
        outcome: "completed",
        resultHash: "sha256:result-1",
        result: {
          session_id: "session-1",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
        },
      },
    }),
    "1.2",
  );
  const second = decodeDesktopBrowserMessage(
    JSON.stringify({
      protocolVersion: "1.2",
      kind: "host.result",
      payload: {
        dispatchId: "0198f3d2-1950-7000-8000-000000000099",
        operationId: authority.operationId,
        outcome: "completed",
        resultHash: "sha256:result-1",
        result: {
          session_id: "session-1",
          browser_instance_id: "browser-primary",
          agent_window_id: 42,
        },
      },
    }),
    "1.2",
  );

  assert.equal(first.kind, "host.result");
  assert.equal(second.kind, "host.result");
  assert.equal(first.payload.operationId, second.payload.operationId);
  assert.notEqual(first.payload.dispatchId, second.payload.dispatchId);
  assert.notDeepEqual(first, second);
});

test("Ticket 05 host.result rejects every invalid discriminator and field combination", () => {
  const operationId = authority.operationId;
  const error = { code: "browser_cli_failed", message: "Browser CLI failed" };
  const result = { session_id: "session-1", browser_instance_id: "browser-primary", agent_window_id: 42 };
  const invalidPayloads: Record<string, unknown>[] = [
    { dispatchId: "dispatch-1", accepted: false, operationId, outcome: "failed", error },
    { operationId, accepted: false, outcome: "failed", error },
    { dispatchId: "dispatch-1", operationId, outcome: "failed", error },
    { dispatchId: "dispatch-1", operationId, outcome: "completed", result },
    { operationId, outcome: "completed", result },
    { dispatchId: "dispatch-1", operationId, outcome: "completed", resultHash: "sha256:result", result, error },
    { dispatchId: "dispatch-1", operationId, outcome: "completed", resultHash: "sha256:result" },
    {
      dispatchId: "dispatch-1",
      operationId,
      outcome: "completed",
      resultHash: "sha256:result",
      result,
      accepted: true,
    },
    { dispatchId: "dispatch-1", operationId, outcome: "failed", resultHash: "sha256:failed", result },
    { dispatchId: "dispatch-1", operationId, outcome: "unknown", resultHash: "sha256:unknown", result },
    { dispatchId: "dispatch-1", operationId, outcome: "failed" },
    { dispatchId: "dispatch-1", operationId, outcome: "unknown" },
  ];

  for (const payload of invalidPayloads) {
    assert.throws(
      () =>
        decodeDesktopBrowserMessage(JSON.stringify({ protocolVersion: "1.2", kind: "host.result", payload }), "1.2"),
      /host\.result message does not match its schema/,
    );
  }
});

test("Ticket 05 request hash is deterministic over stable execution fields only", () => {
  const requestHash = computeDesktopBrowserRequestHash(authority);
  const reorderedAuthority = Object.fromEntries(Object.entries(authority).reverse());

  assert.equal(requestHash, "sha256:a92e983bb84260f920acc0a28b00848f0a9374a04b90da1fb25932f0ed45acee");
  assert.equal(computeDesktopBrowserRequestHash(reorderedAuthority), requestHash);

  for (const { field, request, policyGrammarVersion = "1.0" } of [
    { field: "deploymentCanonicalId", request: { ...authority, deploymentCanonicalId: "qm://deployments/other" } },
    { field: "taskId", request: { ...authority, taskId: "task-2" } },
    { field: "attemptId", request: { ...authority, attemptId: "attempt-2" } },
    { field: "deviceId", request: { ...authority, deviceId: "device-2" } },
    { field: "browserInstanceId", request: { ...authority, browserInstanceId: "browser-secondary" } },
    { field: "operationId", request: { ...authority, operationId: "0198f3d2-1950-7000-8000-000000000003" } },
    { field: "operationSequence", request: { ...authority, operationSequence: 2 } },
    {
      field: "capabilitySet",
      request: { ...authority, capabilitySet: { ...capabilitySet, cliShapeHash: "sha256:changed" } },
    },
    { field: "argv", request: { ...authority, argv: [...authority.argv, "--extra"] } },
    { field: "brokerOptions", request: { ...authority, brokerOptions: { forceSharedRuntime: true } } },
    { field: "effectClass", request: { ...authority, effectClass: "observation" } },
    { field: "requestSchemaVersion", request: { ...authority, authorityVersion: "1.1" } },
    {
      field: "policyGrammarVersion",
      request: { ...authority, capabilitySet: { ...capabilitySet, policyGrammarVersion: "1.1" } },
      policyGrammarVersion: "1.1",
    },
  ]) {
    assert.notEqual(
      computeDesktopBrowserRequestHash(request, "1.2", policyGrammarVersion),
      requestHash,
      `${field} must be included in the request hash projection`,
    );
  }

  for (const { field, request } of [
    { field: "actorId", request: { ...authority, actorId: "actor-2" } },
    { field: "actorSnapshotHash", request: { ...authority, actorSnapshotHash: "sha256:actor-snapshot-2" } },
    { field: "projectId", request: { ...authority, projectId: "project-2" } },
    { field: "projectSnapshotHash", request: { ...authority, projectSnapshotHash: "sha256:project-snapshot-2" } },
    { field: "membershipEpoch", request: { ...authority, membershipEpoch: 43 } },
    { field: "leaseId", request: { ...authority, leaseId: "lease-2" } },
    { field: "leaseVersion", request: { ...authority, leaseVersion: 4 } },
    { field: "leaseExpiresAt", request: { ...authority, leaseExpiresAt: "2026-08-27T12:02:00.000Z" } },
    { field: "issuedAt", request: { ...authority, issuedAt: "2026-08-27T12:01:00.000Z" } },
    { field: "nonce", request: { ...authority, nonce: "nonce-2" } },
    { field: "dispatchId", request: { ...authority, dispatchId: "dispatch-2" } },
    { field: "connectionEpoch", request: { ...authority, connectionEpoch: 99 } },
  ]) {
    assert.equal(
      computeDesktopBrowserRequestHash(request),
      requestHash,
      `${field} must be excluded from the request hash projection`,
    );
  }
});

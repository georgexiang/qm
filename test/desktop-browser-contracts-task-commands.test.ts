import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  buildDesktopBrowserNavigateArgv,
  buildDesktopBrowserObserveArgv,
  buildDesktopBrowserSessionStopArgv,
  computeDesktopBrowserRequestHash,
  decodeDesktopBrowserMessage,
  parseDesktopBrowserOperationAuthorityEnvelope,
  validateDesktopBrowserNavigateArgv,
  validateDesktopBrowserObserveArgv,
  validateDesktopBrowserPhaseFArgv,
  validateDesktopBrowserSessionStopArgv,
  type DesktopBrowserOperationAuthorityEnvelope,
} from "qm-desktop-browser-contracts";

test("Ticket 06 navigate argv is canonical and bound to the Task-owned session", () => {
  const expected = ["--json", "navigate", "https://example.test/path?q=1", "--session", "session-1"];

  assert.deepEqual(buildDesktopBrowserNavigateArgv("https://example.test/path?q=1", "session-1"), expected);
  assert.deepEqual(validateDesktopBrowserNavigateArgv(expected, "session-1"), expected);
  assert.throws(
    () => validateDesktopBrowserNavigateArgv([...expected.slice(0, -1), "session-2"], "session-1"),
    /canonical navigate argv/,
  );
  assert.throws(
    () => validateDesktopBrowserNavigateArgv(["--json", "navigate", "https://example.test/path?q=1"], "session-1"),
    /canonical navigate argv/,
  );
});

test("Ticket 16 navigate rejects local, active-content, credentialed, and browser-internal URLs", () => {
  for (const target of [
    "file:///Users/example/secret.txt",
    "javascript:alert(document.cookie)",
    "data:text/html,<script>alert(1)</script>",
    "chrome://settings",
    "edge://settings",
    "https://alice:secret@example.test/",
    "http://example.test/",
    "https://localhost/admin",
    "https://localhost./admin",
    "https://service.internal/admin",
    "https://service.internal./admin",
    "https://host.local./admin",
    "https://metadata.google.internal/computeMetadata/v1/",
    "https://127.0.0.1/admin",
    "https://[::1]/admin",
    "https://2130706433/admin",
    "/relative",
  ]) {
    assert.throws(() => buildDesktopBrowserNavigateArgv(target, "session-1"), /HTTPS/);
  }
  assert.deepEqual(buildDesktopBrowserNavigateArgv("https://example.test/path", "session-1"), [
    "--json",
    "navigate",
    "https://example.test/path",
    "--session",
    "session-1",
  ]);
});

test("Ticket 06 observe argv is canonical and bound to the Task-owned session", () => {
  const expected = ["--json", "observe", "--session", "session-1"];

  assert.deepEqual(buildDesktopBrowserObserveArgv("session-1"), expected);
  assert.deepEqual(validateDesktopBrowserObserveArgv(expected, "session-1"), expected);
  assert.throws(
    () => validateDesktopBrowserObserveArgv(["--json", "observe", "--session", "session-2"], "session-1"),
    /canonical observe argv/,
  );
  assert.throws(
    () => validateDesktopBrowserObserveArgv(["--json", "--session", "session-1", "observe"], "session-1"),
    /canonical observe argv/,
  );
});

test("Ticket 06 session stop cleans up only the Task-owned session", () => {
  const expected = ["--json", "session", "stop", "session-1"];

  assert.deepEqual(buildDesktopBrowserSessionStopArgv("session-1"), expected);
  assert.deepEqual(validateDesktopBrowserSessionStopArgv(expected, "session-1"), expected);
  assert.throws(
    () => validateDesktopBrowserSessionStopArgv(["--json", "session", "stop"], "session-1"),
    /canonical session-stop argv/,
  );
  assert.throws(
    () => validateDesktopBrowserSessionStopArgv(["--json", "session", "stop", "--all"], "session-1"),
    /canonical session-stop argv/,
  );
});

test("Ticket 06 policy grammar accepts only the four Phase F commands without rewriting argv", () => {
  const bindings = { browserInstanceId: "browser-primary", sessionId: "session-1" };
  const validArgv = [
    ["--json", "session", "start", "--browser", "browser-primary"],
    ["--json", "navigate", "https://example.test", "--session", "session-1"],
    ["--json", "observe", "--session", "session-1"],
    ["--json", "session", "stop", "session-1"],
  ];

  for (const argv of validArgv) {
    assert.deepEqual(validateDesktopBrowserPhaseFArgv(argv, bindings), argv);
  }
  assert.throws(
    () => validateDesktopBrowserPhaseFArgv(["--json", "click", "button"], bindings),
    /browser_cli_policy_missing/,
  );
  assert.throws(
    () => validateDesktopBrowserPhaseFArgv(["navigate", "https://example.test", "--session", "session-1"], bindings),
    /browser_cli_policy_missing/,
  );
});

test("Ticket 06 carries canonical navigate authority over the negotiated wire protocol", () => {
  const issuedAt = "2026-08-27T12:00:00.000Z";
  const authority: DesktopBrowserOperationAuthorityEnvelope = {
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
    operationId: "0198f3d2-1950-7000-8000-000000000003",
    operationSequence: 2,
    capabilitySet: {
      protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      policyGrammarVersion: "1.0",
      bskVersion: "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c",
      extensionVersion: "2.0.19",
      cliShapeHash: "sha256:browser-cli-shape-v1",
    },
    argv: buildDesktopBrowserNavigateArgv("https://example.test", "session-1"),
    brokerOptions: { forceSharedRuntime: false },
    effectClass: "browser_effect",
    nonce: "nonce-2",
    issuedAt,
  };
  const requestHash = computeDesktopBrowserRequestHash(authority, DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION);
  const invocation = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "relay.invoke",
    payload: { dispatchId: "dispatch-2", requestHash, authority },
  };

  assert.deepEqual(parseDesktopBrowserOperationAuthorityEnvelope(authority), authority);
  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(invocation), DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
    invocation,
  );
  assert.throws(
    () => parseDesktopBrowserOperationAuthorityEnvelope({ ...authority, effectClass: "observation" }),
    /effect class does not match navigate/,
  );
});

test("Ticket 06 host results carry only a strict sanitized observation envelope", () => {
  const completed = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-observe",
      operationId: "operation-observe",
      outcome: "completed",
      resultHash: "sha256:observe-result",
      result: {
        schemaVersion: "1.0",
        command: "observe",
        completedAt: "2026-08-27T12:00:01.000Z",
        data: { tab_id: 7, text: "Heading: Example", ref_count: 2, truncated: false },
      },
    },
  };

  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(completed), DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
    completed,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...completed,
          payload: {
            ...completed.payload,
            result: { ...completed.payload.result, data: { ...completed.payload.result.data, cookies: "secret" } },
          },
        }),
        DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      ),
    /host\.result message does not match its schema/,
  );
});

test("Ticket 06 navigate results expose browser state without URL or daemon diagnostics", () => {
  const completed = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-navigate",
      operationId: "operation-navigate",
      outcome: "completed",
      resultHash: "sha256:navigate-result",
      result: {
        schemaVersion: "1.0",
        command: "navigate",
        completedAt: "2026-08-27T12:00:01.000Z",
        data: { tab_id: 7, reached: "load" },
      },
    },
  };

  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(completed), DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
    completed,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...completed,
          payload: {
            ...completed.payload,
            result: {
              ...completed.payload.result,
              data: { ...completed.payload.result.data, url: "https://example.test/?token=secret" },
            },
          },
        }),
        DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      ),
    /host\.result message does not match its schema/,
  );
});

test("Ticket 06 session stop results expose cleanup facts without implying Task completion", () => {
  const completed = {
    protocolVersion: DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      dispatchId: "dispatch-stop",
      operationId: "operation-stop",
      outcome: "completed",
      resultHash: "sha256:stop-result",
      result: {
        schemaVersion: "1.0",
        command: "session.stop",
        completedAt: "2026-08-27T12:00:01.000Z",
        data: {
          returned_tab_ids: [7],
          return_failures: [{ tab_id: 8, code: "permission_denied" }],
        },
      },
    },
  };

  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(completed), DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION),
    completed,
  );
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          ...completed,
          payload: {
            ...completed.payload,
            result: {
              ...completed.payload.result,
              data: {
                ...completed.payload.result.data,
                return_failures: [{ tab_id: 8, code: "permission_denied", message: "token=secret" }],
              },
            },
          },
        }),
        DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
      ),
    /host\.result message does not match its schema/,
  );
});

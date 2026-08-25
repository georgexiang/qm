import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  decodeDesktopBrowserMessage,
  desktopBrowserMessageSchemas,
  encodeDesktopBrowserMessage,
  isDesktopBrowserProtocolCompatible,
  type DesktopBrowserMessage,
} from "qm-desktop-browser-contracts";

test("Core round-trips a versioned authority message through the public contract", () => {
  const message: DesktopBrowserMessage = {
    protocolVersion: "1.0",
    kind: "core.authority",
    payload: {
      requestId: "request-1",
      audience: "qm-desktop-broker-relay",
    },
  };

  assert.deepEqual(decodeDesktopBrowserMessage(encodeDesktopBrowserMessage(message)), message);
});

test("Core rejects an authority message that does not match its published schema", () => {
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          protocolVersion: "1.0",
          kind: "core.authority",
          payload: { requestId: "request-1" },
        }),
      ),
    /core\.authority message does not match its schema/,
  );
});

test("Core rejects protocol components longer than the published bound", () => {
  assert.throws(
    () => isDesktopBrowserProtocolCompatible("1234567890.0", DESKTOP_BROWSER_PROTOCOL_VERSION),
    /invalid desktop browser protocol version/,
  );
});

test("Core accepts compatible minor versions and rejects incompatible major versions", () => {
  const compatible = {
    protocolVersion: "1.7",
    kind: "core.authority",
    traceContext: "future-minor-field",
    payload: {
      requestId: "request-1",
      audience: "qm-desktop-broker-relay",
      authorityHint: "future-minor-field",
    },
  };
  assert.equal(isDesktopBrowserProtocolCompatible("1.7", DESKTOP_BROWSER_PROTOCOL_VERSION), true);
  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(compatible), DESKTOP_BROWSER_PROTOCOL_VERSION),
    compatible,
  );

  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...compatible, protocolVersion: "2.0" }), "1.0"),
    /protocol major 2 is incompatible with supported major 1/,
  );
});

test("Core publishes one schema for every Phase F message kind", () => {
  assert.deepEqual(Object.keys(desktopBrowserMessageSchemas).sort(), [
    "companion.status",
    "core.authority",
    "host.result",
    "relay.invoke",
  ]);
});

test("Core normalizes bounded protocol majors without numeric conversion", () => {
  assert.equal(isDesktopBrowserProtocolCompatible("000000001.0", "1.0"), true);
  assert.equal(isDesktopBrowserProtocolCompatible("000000002.0", "1.0"), false);
});

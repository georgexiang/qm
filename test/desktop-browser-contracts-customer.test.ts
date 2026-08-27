import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeDesktopBrowserMessage, encodeDesktopBrowserMessage } from "qm-desktop-browser-contracts";
import { phaseFContractFixtures } from "qm-desktop-browser-contracts/fixtures";

test("customer-side consumers round-trip every Phase F fixture through the public contract", () => {
  for (const message of phaseFContractFixtures) {
    const supportedVersion =
      message.kind === "relay.invoke" || message.kind === "host.result" ? message.protocolVersion : undefined;
    assert.deepEqual(decodeDesktopBrowserMessage(encodeDesktopBrowserMessage(message), supportedVersion), message);
  }
});

test("customer-side consumers reject an unknown message discriminator", () => {
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          protocolVersion: "1.0",
          kind: "relay.unknown",
          payload: {},
        }),
      ),
    /unsupported desktop browser message kind/,
  );
});

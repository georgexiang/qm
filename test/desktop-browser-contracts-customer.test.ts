import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeDesktopBrowserMessage,
  encodeDesktopBrowserMessage,
} from "../packages/desktop-browser-contracts/src/index.ts";
import { phaseFContractFixtures } from "../packages/desktop-browser-contracts/src/fixtures.ts";

test("customer-side consumers round-trip every Phase F fixture through the public contract", () => {
  for (const message of phaseFContractFixtures) {
    assert.deepEqual(decodeDesktopBrowserMessage(encodeDesktopBrowserMessage(message)), message);
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

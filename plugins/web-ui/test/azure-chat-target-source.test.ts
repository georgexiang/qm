import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const chat = readFileSync(new URL("../src/chat.ts", import.meta.url), "utf8");
const bridge = readFileSync(new URL("../src/core-bridge.ts", import.meta.url), "utf8");
const server = readFileSync(new URL("../server/index.ts", import.meta.url), "utf8");

test("Chat loads the active Scope Azure binding and sends a structured per-turn target", () => {
  assert.match(chat, /\/api\/azure\/default\?scopeId=/);
  assert.match(chat, /aria-label="Azure target for this chat"/);
  assert.match(chat, /azureOpsTarget: chatState\.azureTarget/);
  assert.match(bridge, /turnOptions\.azureOpsTarget \? \{ azureOpsTarget: turnOptions\.azureOpsTarget \}/);
  assert.match(server, /error: "invalid_azure_target"/);
  assert.match(server, /azureOpsTarget = \{ tenantId, subscriptionId \}/);
});

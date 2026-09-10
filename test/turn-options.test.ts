import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NON_INTERACTIVE_FAST_MODE,
  NON_INTERACTIVE_THINKING_LEVEL,
  turnModelOptions,
  validateWebTurnModelOptions,
  webTurnRuntimeModelRefusal,
} from "../src/core/turn-options.ts";
import { setCustomProviders } from "../src/model/custom-providers.ts";

test("triggered turns default to extra-high thinking and non-fast mode", () => {
  assert.deepEqual(turnModelOptions({ triggered: true }), {
    thinkingLevel: NON_INTERACTIVE_THINKING_LEVEL,
    fastMode: NON_INTERACTIVE_FAST_MODE,
  });
});

test("explicit turn model options win over triggered defaults", () => {
  assert.deepEqual(turnModelOptions({ triggered: true, thinkingLevel: "low", fastMode: true }), {
    thinkingLevel: "low",
    fastMode: true,
  });
});

test("web model controls are bounded by admin configuration", () => {
  assert.equal(
    validateWebTurnModelOptions({ model: "claude-sonnet-4-6" }, ["claude-opus-4-8"]),
    "that model is not enabled for the web UI",
  );
  assert.equal(validateWebTurnModelOptions({ thinkingLevel: "infinite" }, null), "unsupported thinking level");
  assert.equal(validateWebTurnModelOptions({ model: "claude-opus-4-8", thinkingLevel: "high" }, null), null);
});

test("registered custom models are enabled by the default web picker", () => {
  setCustomProviders([
    {
      id: "acme-gateway",
      name: "Acme Gateway",
      protocol: "openai",
      baseUrl: "https://llm.acme.internal/v1",
      models: [
        { id: "acme-large", name: "Acme Large" },
        { id: "claude-opus-4-6", name: "Colliding Model" },
      ],
    },
  ]);
  try {
    assert.equal(validateWebTurnModelOptions({ model: "acme-large" }, null), null);
    assert.equal(
      validateWebTurnModelOptions({ model: "claude-opus-4-6" }, null),
      "that model is not enabled for the web UI",
    );
    assert.equal(
      validateWebTurnModelOptions({ model: "acme-large" }, ["gpt-5.6-sol"]),
      "that model is not enabled for the web UI",
    );
  } finally {
    setCustomProviders([]);
  }
  assert.equal(validateWebTurnModelOptions({ model: "acme-large" }, null), "that model is not enabled for the web UI");
});

test("a resolved scope override outside the configured picker is refused, the org default is not", () => {
  const picker = ["claude-sonnet-4-6"];
  assert.equal(
    webTurnRuntimeModelRefusal("claude-opus-4-8", "claude-sonnet-4-6", picker),
    "that model is not enabled for the web UI",
  );
  assert.equal(webTurnRuntimeModelRefusal("claude-sonnet-4-6", "claude-opus-4-8", picker), null);
  assert.equal(webTurnRuntimeModelRefusal("claude-opus-4-8", "claude-opus-4-8", picker), null);
  assert.equal(webTurnRuntimeModelRefusal("claude-opus-4-8", "claude-sonnet-4-6", null), null);
  assert.equal(webTurnRuntimeModelRefusal("claude-opus-4-8", "claude-sonnet-4-6", []), null);
});

test("interactive turns do not force model options", () => {
  assert.deepEqual(turnModelOptions({}), {});
});

test("a triggered turn with an explicit low thinking level overrides the xhigh trigger default", () => {
  assert.deepEqual(turnModelOptions({ triggered: true, thinkingLevel: "low" }), {
    thinkingLevel: "low",
    fastMode: NON_INTERACTIVE_FAST_MODE,
  });
});

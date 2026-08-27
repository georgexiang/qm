import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileApproval as compileCliApproval,
  interpolateSplitEnv as interpolateCliSplitEnv,
  parseToolDescriptor as parseCliToolDescriptor,
} from "../cli/src/sandbox-layer.ts";
import {
  compileApproval as compileCoreApproval,
  interpolateSplitEnv as interpolateCoreSplitEnv,
  parseToolDescriptor as parseCoreToolDescriptor,
} from "../src/deployment/deployment-layer.ts";

const valid = [
  { id: "example" },
  { id: "tool", label: "Tool", egress: ["api.example.com"], install: { binary: "tool" } },
  {
    id: "tool",
    auth: {
      check: "check",
      reauth: "login",
      credentialPaths: [{ path: ".tool/token", kind: "file" }],
      splitEnv: { ACTOR: "{actingSlackUserId}" },
    },
  },
  {
    id: "tool-adapter",
    process: {
      executableId: "tool-adapter",
      protocolMajor: 2,
      launchSchema: { type: "object", properties: { taskId: { type: "string" } } },
    },
  },
];

const invalid = [
  "{}",
  '{"id":""}',
  '{"id":"Bad"}',
  '{"id":"tool","auth":{"check":"check"}}',
  '{"id":"tool","approvals":[{}]}',
  '{"id":"tool","install":{"binary":"evil; rm -rf /"}}',
  '{"id":"tool","process":{"executableId":"../adapter","protocolMajor":1,"launchSchema":{"type":"object"}}}',
  '{"id":"tool","process":{"executableId":"adapter","protocolMajor":0,"launchSchema":{"type":"object"}}}',
  "not json",
];

test("CLI deployment parser stays aligned with the Core deployment schema", () => {
  for (const descriptor of valid) {
    const raw = JSON.stringify(descriptor);
    assert.deepEqual(parseCliToolDescriptor(raw, "tool.json"), parseCoreToolDescriptor(raw, "tool.json"));
  }
  for (const raw of invalid) {
    const message = (parse: typeof parseCliToolDescriptor): string => {
      try {
        parse(raw, "tool.json");
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    assert.equal(message(parseCliToolDescriptor), message(parseCoreToolDescriptor), `parser drift on ${raw}`);
  }
  assert.deepEqual(
    compileCliApproval("tool", { command: "deploy" }),
    compileCoreApproval("tool", { command: "deploy" }),
  );
  assert.deepEqual(
    interpolateCliSplitEnv({ ACTOR: "{actingSlackUserId}" }, {}),
    interpolateCoreSplitEnv({ ACTOR: "{actingSlackUserId}" }, {}),
  );
});

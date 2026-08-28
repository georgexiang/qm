import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    calls.push({
      method: req.method ?? "GET",
      url: req.url ?? "",
      body: raw ? (JSON.parse(raw) as Record<string, unknown>) : {},
    });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        desktopBrowserActivity: {
          taskId: "task-1",
          status: "waiting_for_local_confirmation",
          connectCommand: "qm-host-broker connect https://qm.example.com",
          actionAuthority: "turn-authority",
          actions: ["confirm", "cancel"],
          registration: {
            registrationId: "reg-1",
            confirmationFingerprint: "4f8c52de91a3b10c",
            expiresAt: "2026-08-26T12:00:00.000Z",
            confirmReady: true,
          },
        },
      }),
    );
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "desktop-browser-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "desktop-browser-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("Desktop Browser actions bind the signed-in WebUI principal", async () => {
  const response = await fetch(`${base}/api/desktop-browser/tasks/task-1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "cancel", principalId: "mallory", authorityId: "turn-authority" }),
  });

  assert.equal(response.status, 200);
  const call = calls.find((candidate) => new URL(candidate.url, "http://core").pathname.endsWith("/actions"));
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, { principalId: "alice", authorityId: "turn-authority", action: "cancel" });
});

test("Desktop Browser Stop reaches Core with the signed-in WebUI principal", async () => {
  const response = await fetch(`${base}/api/desktop-browser/tasks/task-stop/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "stop", authorityId: "turn-authority" }),
  });

  assert.equal(response.status, 200);
  const call = calls.find((candidate) => candidate.url.includes("task-stop/actions"));
  assert.deepEqual(call?.body, { principalId: "alice", authorityId: "turn-authority", action: "stop" });
});

test("Desktop Browser Continue reaches Core with the signed-in WebUI principal", async () => {
  const response = await fetch(`${base}/api/desktop-browser/tasks/task-1/actions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ action: "continue", authorityId: "turn-authority" }),
  });

  assert.equal(response.status, 200);
  const call = calls.find((candidate) => candidate.url.includes("task-1/actions") && candidate.body.action === "continue");
  assert.deepEqual(call?.body, { principalId: "alice", authorityId: "turn-authority", action: "continue" });
});

test("Desktop Browser registration confirmation binds the signed-in WebUI principal", async () => {
  const response = await fetch(`${base}/api/desktop-browser/registrations/reg-1/confirm`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      principalId: "mallory",
      taskId: "task-1",
      authorityId: "turn-authority",
      confirmationFingerprint: "4f8c52de91a3b10c",
    }),
  });

  assert.equal(response.status, 200);
  const call = calls.find((candidate) => new URL(candidate.url, "http://core").pathname.endsWith("/confirm"));
  assert.ok(call);
  assert.equal(call.method, "POST");
  assert.deepEqual(call.body, {
    principalId: "alice",
    taskId: "task-1",
    authorityId: "turn-authority",
    confirmationFingerprint: "4f8c52de91a3b10c",
  });
});

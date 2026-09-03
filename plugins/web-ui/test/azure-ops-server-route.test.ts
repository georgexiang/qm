import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { mintPortalIdentity, PORTAL_IDENTITY_HEADER } from "../../chassis/src/portal-identity.ts";

function isNoncedCoreCall(url: string, pathname: string): boolean {
  const u = new URL(url, "http://core");
  if (u.pathname !== pathname) return false;
  const keys = [...u.searchParams.keys()];
  return (
    keys.length === 1 && keys[0] === "_sourceAuthNonce" && (u.searchParams.get("_sourceAuthNonce") ?? "").length > 0
  );
}

interface Call {
  method: string;
  url: string;
  body: Record<string, unknown>;
}

const calls: Call[] = [];
const core = createServer((req: IncomingMessage, res) => {
  if (req.method === "POST" && req.url?.startsWith("/v1/session-cap")) {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ token: "test-capability" }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    calls.push({ method: req.method ?? "GET", url: req.url ?? "", body });
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url?.startsWith("/v1/azure/credentials")) {
      res.end(JSON.stringify({ credentials: [] }));
      return;
    }
    if (req.url?.startsWith("/v1/azure/connections")) {
      res.end(JSON.stringify({ connectionId: "conn-1" }));
      return;
    }
    if (req.url?.startsWith("/v1/azure/default")) {
      res.end(JSON.stringify({ binding: null }));
      return;
    }
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise<void>((resolve) => core.listen(0, resolve));

process.env.CORE_API_URL = `http://localhost:${(core.address() as AddressInfo).port}`;
process.env.CORE_SIGNING_SECRET = "azure-web-route-test";
process.env.WEB_UI_PRINCIPALS = "alice";

const { handler } = await import("../server/index.ts");
const surface = createServer((req, res) => void handler(req, res));
await new Promise<void>((resolve) => surface.listen(0, resolve));
const base = `http://localhost:${(surface.address() as AddressInfo).port}`;
const headers = {
  [PORTAL_IDENTITY_HEADER]: mintPortalIdentity({ p: "alice", exp: Date.now() + 60_000 }, "azure-web-route-test"),
  "content-type": "application/json",
};

test.after(() => {
  surface.close();
  core.close();
});

test("azure web routes relay through session capability and never trust browser principal fields", async () => {
  let before = calls.length;
  await fetch(`${base}/api/azure/connections`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      credentialId: "cred-1",
      accountLabel: "Alice Azure",
      accountEmail: "alice@example.com",
      homeTenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3",
      tenantAccess: [],
      status: "active",
      principalId: "mallory",
      actorId: "mallory",
      ownerPrincipalId: "mallory",
    }),
  });
  const createCall = calls.slice(before).find((call) => call.url === "/v1/azure/connections");
  assert.equal(createCall?.method, "POST");
  assert.deepEqual(createCall?.body, {
    credentialId: "cred-1",
    accountLabel: "Alice Azure",
  });

  before = calls.length;
  await fetch(`${base}/api/azure/connections/conn-1`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      accountLabel: "Alice Azure refreshed",
      accountEmail: "mallory@example.com",
      homeTenantId: "00000000-0000-0000-0000-000000000000",
      tenantAccess: [{ tenantId: "fake", visibleSubscriptions: [] }],
      status: "revoked",
    }),
  });
  const updateCall = calls.slice(before).find((call) => call.url === "/v1/azure/connections/conn-1");
  assert.equal(updateCall?.method, "PUT");
  assert.deepEqual(updateCall?.body, {
    accountLabel: "Alice Azure refreshed",
  });

  before = calls.length;
  await fetch(`${base}/api/azure/default`, {
    method: "PUT",
    headers,
    body: JSON.stringify({
      scopeId: "group:web-project-p1",
      connectionId: "conn-1",
      defaultTarget: { tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3", subscriptionId: "sub-1" },
      targetAllowlist: [{ tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3", subscriptionIds: ["sub-1"] }],
      principalId: "mallory",
    }),
  });
  const bindingCall = calls.slice(before).find((call) => call.url === "/v1/azure/default");
  assert.deepEqual(bindingCall?.body, {
    scopeId: "group:web-project-p1",
    connectionId: "conn-1",
    confirmProjectSharing: false,
    defaultTarget: { tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3", subscriptionId: "sub-1" },
    targetAllowlist: [{ tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3", subscriptionIds: ["sub-1"] }],
  });

  before = calls.length;
  await fetch(`${base}/api/azure/default?scopeId=${encodeURIComponent("group:web-project-p1")}`, {
    method: "GET",
    headers,
  });
  assert.equal(
    calls.slice(before).some((call) => call.url === "/v1/azure/default?scopeId=group%3Aweb-project-p1"),
    true,
  );

  before = calls.length;
  await fetch(`${base}/api/azure/credentials`, { method: "GET", headers });
  assert.equal(
    calls.slice(before).some((call) => call.url === "/v1/azure/credentials"),
    true,
  );

  before = calls.length;
  await fetch(`${base}/api/projects`, { method: "POST", headers, body: JSON.stringify({ name: "Launch" }) });
  assert.equal(
    calls.slice(before).some((call) => isNoncedCoreCall(call.url, "/v1/projects")),
    true,
  );
});

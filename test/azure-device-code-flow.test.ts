import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { AzureDeviceCodeDriver } from "../src/azure/azure-device-code-flow.ts";
import type { Keychain } from "../src/credentials/keychain.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { buildApp } from "../src/wiring.ts";
import { testConfig } from "./support/test-config.ts";

const PORTAL_SECRET = "azure-device-code-portal-secret-for-tests";
const DEVICE_CODE = "DEVICE-CODE-SECRET";
const TOKEN_SECRET = "TOKEN-SECRET";
const TENANT = "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3";
const SUBSCRIPTION = "483ab1e0-a746-4f34-8276-53e640d6ab09";

function azureFiles(accountEmail = "alice@example.com") {
  return [
    {
      path: ".azure/azureProfile.json",
      contentBase64: Buffer.from(
        JSON.stringify({
          subscriptions: [
            {
              id: SUBSCRIPTION,
              name: "Production",
              state: "Enabled",
              tenantId: TENANT,
              homeTenantId: TENANT,
              user: { name: accountEmail, type: "user" },
            },
          ],
        }),
        "utf8",
      ).toString("base64"),
    },
    {
      path: ".azure/msal_token_cache.json",
      contentBase64: Buffer.from(TOKEN_SECRET, "utf8").toString("base64"),
    },
  ];
}

function fakeDriver(state: {
  keychain?: Keychain;
  pollStatus: "pending" | "ready" | "failed";
  pollCalls: number;
  captureCalls: number;
  accountEmail: string;
}): AzureDeviceCodeDriver {
  return {
    async start({ flowId }) {
      return {
        processRef: `process-${flowId}`,
        sessionRef: `session-${flowId}`,
        verificationUri: "https://microsoft.com/devicelogin",
        userCode: DEVICE_CODE,
      };
    },
    async poll() {
      state.pollCalls += 1;
      return state.pollStatus;
    },
    async capture(flow) {
      state.captureCalls += 1;
      if (!state.keychain) throw new Error("missing keychain");
      const credential = await state.keychain.save({
        ownerId: flow.principalId,
        service: "azure",
        files: azureFiles(state.accountEmail),
        credentialSlot: `device-code:${flow.flowId}`,
        origin: "device-flow-auto-capture",
      });
      return credential.id;
    },
  };
}

function buildWithFakeDriver() {
  const state = {
    pollStatus: "ready" as const,
    pollCalls: 0,
    captureCalls: 0,
    accountEmail: "alice@example.com",
  } as {
    keychain?: Keychain;
    pollStatus: "pending" | "ready" | "failed";
    pollCalls: number;
    captureCalls: number;
    accountEmail: string;
  };
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-device-code-")) }), {
    azureDeviceCodeDriver: fakeDriver(state),
  });
  state.keychain = built.keychain;
  return { built, state };
}

test("Azure Device Code startup failure leaves secret-free durable failed state", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-device-code-start-failure-")) }), {
    azureDeviceCodeDriver: {
      async start() {
        throw new Error(DEVICE_CODE);
      },
      async poll() {
        return "failed";
      },
      async capture() {
        throw new Error(TOKEN_SECRET);
      },
    },
  });

  assert.equal((await built.app.startAzureDeviceCodeFlow({ actorId: "alice" })).status, "failed");
  const flows = await built.azureDeviceCodeFlows.all();
  assert.equal(flows.length, 1);
  assert.equal(flows[0]?.status, "failed");
  assert.ok(!JSON.stringify(flows).includes(DEVICE_CODE));
  assert.ok(!JSON.stringify(await built.auditLog.events()).includes(DEVICE_CODE));
});

test("Azure Device Code completion removes a captured credential when registration fails", async () => {
  const state: { keychain?: Keychain } = {};
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-device-code-invalid-capture-")) }), {
    azureDeviceCodeDriver: {
      async start({ flowId }) {
        return {
          processRef: `process-${flowId}`,
          sessionRef: `session-${flowId}`,
          verificationUri: "https://microsoft.com/devicelogin",
          userCode: DEVICE_CODE,
        };
      },
      async poll() {
        return "ready";
      },
      async capture(flow) {
        if (!state.keychain) throw new Error("missing keychain");
        const credential = await state.keychain.save({
          ownerId: flow.principalId,
          service: "azure",
          files: [
            {
              path: ".azure/msal_token_cache.json",
              contentBase64: Buffer.from(TOKEN_SECRET).toString("base64"),
            },
          ],
          credentialSlot: `device-code:${flow.flowId}`,
          origin: "device-flow-auto-capture",
        });
        return credential.id;
      },
    },
  });
  state.keychain = built.keychain;

  const started = await built.app.startAzureDeviceCodeFlow({ actorId: "alice" });
  assert.equal(started.status, "ok");
  if (started.status !== "ok") return;
  assert.equal((await built.app.completeAzureDeviceCodeFlow(started.flow.flowId, "alice")).status, "failed");
  assert.equal((await built.keychain!.listByOwner("alice")).length, 0);
});

test("Azure Device Code methods bind actor and scope, enforce expiry, and keep durable state secret-free", async () => {
  const { built, state } = buildWithFakeDriver();
  const started = await built.app.startAzureDeviceCodeFlow({ actorId: "alice" });
  assert.equal(started.status, "ok");
  if (started.status !== "ok") return;
  assert.equal(started.flow.scopeId, "personal:alice");
  assert.equal(started.userCode, DEVICE_CODE);
  assert.equal((await built.app.pollAzureDeviceCodeFlow(started.flow.flowId, "mallory")).status, "forbidden");

  const stored = await built.azureDeviceCodeFlows.get(started.flow.flowId);
  assert.equal(stored?.principalId, "alice");
  assert.equal(stored?.intendedScopeId, "personal:alice");
  const serialized = JSON.stringify(stored);
  assert.ok(!serialized.includes(DEVICE_CODE));
  assert.ok(!serialized.includes(TOKEN_SECRET));
  assert.ok(!serialized.includes("contentBase64"));

  await built.azureDeviceCodeFlows.merge(started.flow.flowId, { expiresAt: Date.now() - 1 });
  assert.equal((await built.app.pollAzureDeviceCodeFlow(started.flow.flowId, "alice")).status, "expired");
  assert.equal((await built.app.completeAzureDeviceCodeFlow(started.flow.flowId, "alice")).status, "expired");
  assert.equal(state.pollCalls, 0);
  assert.equal(state.captureCalls, 0);
});

test("Azure Device Code completion is one-shot under concurrency and registers through Keychain validation", async () => {
  const { built, state } = buildWithFakeDriver();
  const started = await built.app.startAzureDeviceCodeFlow({ actorId: "alice" });
  assert.equal(started.status, "ok");
  if (started.status !== "ok") return;

  const results = await Promise.all([
    built.app.completeAzureDeviceCodeFlow(started.flow.flowId, "alice"),
    built.app.completeAzureDeviceCodeFlow(started.flow.flowId, "alice"),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ["conflict", "ok"]);
  assert.equal(state.captureCalls, 1);
  const connections = await built.app.listAzureAccountConnections("alice");
  assert.equal(connections.length, 1);
  assert.equal(connections[0]?.accountEmail, "alice@example.com");
  assert.deepEqual(
    (await built.keychain!.listByOwner("alice")).map((credential) => credential.id),
    [connections[0]!.credentialId],
  );
  assert.equal((await built.app.listAzureAccountConnections("mallory")).length, 0);

  const durableJson = JSON.stringify(await built.azureDeviceCodeFlows.get(started.flow.flowId));
  const auditJson = JSON.stringify(await built.auditLog.events());
  assert.ok(!durableJson.includes(DEVICE_CODE));
  assert.ok(!durableJson.includes(TOKEN_SECRET));
  assert.ok(!auditJson.includes(DEVICE_CODE));
  assert.ok(!auditJson.includes(TOKEN_SECRET));
  assert.ok((await built.auditLog.events()).some((event) => event.action === "azure.connection.start"));
  assert.ok((await built.auditLog.events()).some((event) => event.action === "azure.connection.complete"));
});

test("Azure Device Code reconnect rejects a different account and preserves the original connection", async () => {
  const { built, state } = buildWithFakeDriver();
  const initial = await built.app.startAzureDeviceCodeFlow({ actorId: "alice" });
  assert.equal(initial.status, "ok");
  if (initial.status !== "ok") return;
  assert.equal((await built.app.completeAzureDeviceCodeFlow(initial.flow.flowId, "alice")).status, "ok");
  const [original] = await built.app.listAzureAccountConnections("alice");
  assert.ok(original);

  state.accountEmail = "other@example.com";
  const reconnect = await built.app.startAzureDeviceCodeFlow({
    actorId: "alice",
    connectionId: original.connectionId,
  });
  assert.equal(reconnect.status, "ok");
  if (reconnect.status !== "ok") return;
  assert.equal((await built.app.completeAzureDeviceCodeFlow(reconnect.flow.flowId, "alice")).status, "failed");
  assert.deepEqual(await built.app.listAzureAccountConnections("alice"), [original]);
  assert.deepEqual(
    (await built.keychain!.listByOwner("alice")).map((credential) => credential.id),
    [original.credentialId],
  );
});

test("Azure Device Code routes derive authority from auth and deny another principal", async () => {
  const { built } = buildWithFakeDriver();
  const server = createInsecureTestServer(built.app, {
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    identity: built.identity,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const aliceToken = await mintSignedPayload({ p: "alice", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const malloryToken = await mintSignedPayload({ p: "mallory", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const aliceHeaders = { "content-type": "application/json", "x-portal-identity": aliceToken };
  const malloryHeaders = { "content-type": "application/json", "x-portal-identity": malloryToken };

  try {
    assert.equal((await fetch(`${base}/v1/azure/connections/device-code/start`, { method: "POST" })).status, 401);
    const startedResponse = await fetch(`${base}/v1/azure/connections/device-code/start`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ principalId: "mallory", scopeId: "personal:mallory" }),
    });
    assert.equal(startedResponse.status, 201);
    const started = (await startedResponse.json()) as {
      flow: { flowId: string; scopeId: string };
      userCode: string;
    };
    assert.equal(started.flow.scopeId, "personal:alice");
    assert.equal(started.userCode, DEVICE_CODE);
    assert.equal(
      (await fetch(`${base}/v1/azure/connections/device-code/${started.flow.flowId}`, { headers: malloryHeaders }))
        .status,
      403,
    );

    const completed = await fetch(`${base}/v1/azure/connections/device-code/${started.flow.flowId}/complete`, {
      method: "POST",
      headers: aliceHeaders,
      body: JSON.stringify({ principalId: "mallory", scopeId: "personal:mallory" }),
    });
    assert.equal(completed.status, 200);
    const body = await completed.text();
    assert.ok(!body.includes(DEVICE_CODE));
    assert.ok(!body.includes(TOKEN_SECRET));
    assert.ok(!body.includes("contentBase64"));
    assert.equal(
      (
        await fetch(`${base}/v1/azure/connections/device-code/${started.flow.flowId}/complete`, {
          method: "POST",
          headers: aliceHeaders,
        })
      ).status,
      409,
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

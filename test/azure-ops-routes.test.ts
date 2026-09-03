import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import { buildApp } from "../src/wiring.ts";
import { createInsecureTestServer } from "../src/api/server.ts";
import { mintSignedPayload } from "../src/auth/signed-token.ts";
import { testConfig } from "./support/test-config.ts";

const PORTAL_SECRET = "azure-ops-portal-identity-secret-for-tests";
const SUBSCRIPTION = "483ab1e0-a746-4f34-8276-53e640d6ab09";
const TENANT = "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3";
const ACCOUNT_EMAIL = "alice@example.com";
const SUBSCRIPTION_TWO = "8bc5a152-8843-4f24-a3cc-388b4b738529";
const TENANT_TWO = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const ACCOUNT_EMAIL_TWO = "bob@example.com";

test("Azure connection routes derive ownership, expose multi-tenant metadata, and block referenced deletion", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-routes-")) }));
  const credential = await built.keychain!.save({
    ownerId: "alice",
    service: "azure",
    files: [
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
                user: { name: ACCOUNT_EMAIL, type: "user" },
              },
            ],
          }),
          "utf8",
        ).toString("base64"),
      },
      {
        path: ".azure/msal_token_cache.json",
        contentBase64: Buffer.from("route-secret-marker").toString("base64"),
      },
    ],
    accountLabel: "Captured Azure CLI",
    origin: "device-flow-auto-capture",
  });
  const server = createInsecureTestServer(built.app, {
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    identity: built.identity,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const token = await mintSignedPayload({ p: "alice", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const malloryToken = await mintSignedPayload({ p: "mallory", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const headers = { "content-type": "application/json", "x-portal-identity": token };
  const malloryHeaders = { "content-type": "application/json", "x-portal-identity": malloryToken };
  try {
    assert.equal((await fetch(`${base}/v1/azure/connections`)).status, 401);
    const credentials = await fetch(`${base}/v1/azure/credentials`, { headers });
    assert.equal(credentials.status, 200);
    const credentialsBody = await credentials.text();
    assert.ok(credentialsBody.includes(credential.id));
    assert.ok(!credentialsBody.includes("route-secret-marker"));
    assert.ok(!credentialsBody.includes("contentBase64"));

    const registered = await fetch(`${base}/v1/azure/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        credentialId: credential.id,
        ownerPrincipalId: "mallory",
        accountLabel: "Alice Azure",
        accountEmail: "mallory@example.com",
        homeTenantId: "00000000-0000-0000-0000-000000000000",
        status: "revoked",
        tenantAccess: [
          {
            tenantId: "00000000-0000-0000-0000-000000000000",
            displayName: "Forged",
            objectId: "forged",
            status: "unavailable",
            visibleSubscriptions: [{ id: "00000000-0000-0000-0000-000000000000", name: "forged", state: "Gone" }],
          },
        ],
      }),
    });
    assert.equal(registered.status, 201);
    const connection = (await registered.json()) as {
      connectionId: string;
      ownerPrincipalId: string;
      accountEmail: string;
      homeTenantId?: string;
      status: string;
      tenantAccess: Array<{
        objectId: string | null;
        displayName: string;
        visibleSubscriptions: Array<{ name: string }>;
      }>;
    };
    assert.equal(connection.ownerPrincipalId, "alice");
    assert.equal(connection.accountEmail, ACCOUNT_EMAIL);
    assert.equal(connection.homeTenantId, TENANT);
    assert.equal(connection.status, "active");
    assert.equal(connection.tenantAccess[0]?.objectId, null);
    assert.equal(connection.tenantAccess[0]?.displayName, TENANT);
    assert.equal(connection.tenantAccess[0]?.visibleSubscriptions[0]?.name, "Production");

    const ownerList = await fetch(`${base}/v1/azure/connections`, { headers });
    assert.equal(ownerList.status, 200);
    const ownerBody = await ownerList.text();
    assert.ok(ownerBody.includes(ACCOUNT_EMAIL));
    assert.ok(ownerBody.includes("Production"));
    assert.ok(!ownerBody.includes("route-secret-marker"));
    const otherList = await fetch(`${base}/v1/azure/connections`, { headers: malloryHeaders });
    assert.deepEqual(await otherList.json(), { connections: [] });

    const refreshed = await fetch(`${base}/v1/azure/connections/${connection.connectionId}`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        accountLabel: "Alice Azure refreshed",
        accountEmail: "mallory@example.com",
        homeTenantId: "00000000-0000-0000-0000-000000000000",
        status: "revoked",
        tenantAccess: [
          {
            tenantId: "00000000-0000-0000-0000-000000000000",
            displayName: "Forged",
            objectId: "forged",
            status: "unavailable",
            visibleSubscriptions: [{ id: "00000000-0000-0000-0000-000000000000", name: "forged", state: "Gone" }],
          },
        ],
      }),
    });
    assert.equal(refreshed.status, 200);
    assert.equal(((await refreshed.json()) as { accountLabel: string }).accountLabel, "Alice Azure refreshed");

    const put = await fetch(`${base}/v1/azure/default`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        scopeId: "personal:alice",
        connectionId: connection.connectionId,
        defaultTarget: { tenantId: TENANT, subscriptionId: SUBSCRIPTION },
        targetAllowlist: [{ tenantId: TENANT, subscriptionIds: [SUBSCRIPTION] }],
        principalId: "mallory",
      }),
    });
    assert.equal(put.status, 200);
    const putBody = await put.text();
    assert.ok(!putBody.includes("route-secret-marker"));
    assert.ok(!putBody.includes("contentBase64"));
    assert.ok(!putBody.includes("secretEnc"));

    const blockedDelete = await fetch(`${base}/v1/azure/connections/${connection.connectionId}`, {
      method: "DELETE",
      headers,
    });
    assert.equal(blockedDelete.status, 409);
    assert.deepEqual(((await blockedDelete.json()) as { bindingScopes: string[] }).bindingScopes, ["personal:alice"]);
    assert.equal(
      (
        await fetch(`${base}/v1/azure/connections/${connection.connectionId}`, {
          method: "PUT",
          headers: malloryHeaders,
          body: JSON.stringify({ accountLabel: "Mallory overwrite" }),
        })
      ).status,
      404,
    );

    const get = await fetch(`${base}/v1/azure/default?scopeId=personal:alice`, { headers });
    assert.equal(get.status, 200);
    assert.equal(((await get.json()) as { available: boolean }).available, true);

    const badAllowlist = await fetch(`${base}/v1/azure/default`, {
      method: "PUT",
      headers,
      body: JSON.stringify({
        scopeId: "personal:alice",
        connectionId: connection.connectionId,
        defaultTarget: { tenantId: TENANT, subscriptionId: SUBSCRIPTION },
        targetAllowlist: [],
      }),
    });
    assert.equal(badAllowlist.status, 400);

    assert.equal(
      (
        await fetch(`${base}/v1/azure/default?scopeId=${encodeURIComponent("personal:alice")}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(`${base}/v1/azure/connections/${connection.connectionId}`, {
          method: "DELETE",
          headers,
        })
      ).status,
      200,
    );
    assert.equal(await built.keychain!.getCredential(credential.id), null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Azure connection routes return distinct profile-validation errors", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-routes-errors-")) }));
  const noProfileCredential = await built.keychain!.save({
    ownerId: "alice",
    service: "azure",
    files: [
      {
        path: ".azure/msal_token_cache.json",
        contentBase64: Buffer.from("route-secret-marker").toString("base64"),
      },
    ],
    accountLabel: "Missing profile",
    origin: "device-flow-auto-capture",
  });
  const badProfileCredential = await built.keychain!.save({
    ownerId: "alice",
    service: "azure",
    files: [
      {
        path: ".azure/azureProfile.json",
        contentBase64: Buffer.from("{bad-json", "utf8").toString("base64"),
      },
      {
        path: ".azure/msal_token_cache.json",
        contentBase64: Buffer.from("route-secret-marker").toString("base64"),
      },
    ],
    accountLabel: "Bad profile",
    credentialSlot: "bad-profile",
    origin: "device-flow-auto-capture",
  });

  const server = createInsecureTestServer(built.app, {
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    identity: built.identity,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const token = await mintSignedPayload({ p: "alice", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const headers = { "content-type": "application/json", "x-portal-identity": token };
  try {
    const verificationRequired = await fetch(`${base}/v1/azure/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId: noProfileCredential.id, accountLabel: "No profile" }),
    });
    assert.equal(verificationRequired.status, 409);
    assert.deepEqual(await verificationRequired.json(), { error: "verification_required" });

    const invalidProfile = await fetch(`${base}/v1/azure/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId: badProfileCredential.id, accountLabel: "Bad profile" }),
    });
    assert.equal(invalidProfile.status, 400);
    assert.deepEqual(await invalidProfile.json(), { error: "invalid_profile" });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("Azure registration archives captured default credentials into account-specific slots and keeps accounts independent", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-routes-slots-")) }));
  const server = createInsecureTestServer(built.app, {
    portalIdentitySecret: PORTAL_SECRET,
    requireSignedPortalIdentity: true,
    identity: built.identity,
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const token = await mintSignedPayload({ p: "alice", exp: Date.now() + 60_000 }, PORTAL_SECRET);
  const headers = { "content-type": "application/json", "x-portal-identity": token };

  const capture = async (email: string, tenantId: string, subscriptionId: string, marker: string) =>
    built.keychain!.save({
      ownerId: "alice",
      service: "azure",
      files: [
        {
          path: ".azure/azureProfile.json",
          contentBase64: Buffer.from(
            JSON.stringify({
              subscriptions: [
                {
                  id: subscriptionId,
                  name: `${marker}-subscription`,
                  state: "Enabled",
                  tenantId,
                  homeTenantId: tenantId,
                  user: { name: email, type: "user" },
                },
              ],
            }),
            "utf8",
          ).toString("base64"),
        },
        {
          path: ".azure/msal_token_cache.json",
          contentBase64: Buffer.from(`route-secret-${marker}`, "utf8").toString("base64"),
        },
      ],
      origin: "device-flow-auto-capture",
    });

  try {
    const firstCapture = await capture(ACCOUNT_EMAIL, TENANT, SUBSCRIPTION, "alice");
    const firstRegistration = await fetch(`${base}/v1/azure/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId: firstCapture.id, accountLabel: "Alice account" }),
    });
    assert.equal(firstRegistration.status, 201);
    const firstConnection = (await firstRegistration.json()) as { connectionId: string; credentialId: string };

    const secondCapture = await capture(ACCOUNT_EMAIL_TWO, TENANT_TWO, SUBSCRIPTION_TWO, "bob");
    const secondRegistration = await fetch(`${base}/v1/azure/connections`, {
      method: "POST",
      headers,
      body: JSON.stringify({ credentialId: secondCapture.id, accountLabel: "Bob account" }),
    });
    assert.equal(secondRegistration.status, 201);
    const secondConnection = (await secondRegistration.json()) as { connectionId: string; credentialId: string };

    assert.notEqual(firstConnection.credentialId, secondConnection.credentialId);

    const firstMaterialized = await built.keychain!.materializeOwnById(
      "alice",
      firstConnection.credentialId,
      "personal:alice",
    );
    const secondMaterialized = await built.keychain!.materializeOwnById(
      "alice",
      secondConnection.credentialId,
      "personal:alice",
    );
    assert.equal(firstMaterialized.kind, "file");
    assert.equal(secondMaterialized.kind, "file");
    if (firstMaterialized.kind !== "file" || secondMaterialized.kind !== "file") return;
    assert.ok(
      firstMaterialized.files.some((file) =>
        Buffer.from(file.contentBase64, "base64").toString("utf8").includes("route-secret-alice"),
      ),
    );
    assert.ok(
      secondMaterialized.files.some((file) =>
        Buffer.from(file.contentBase64, "base64").toString("utf8").includes("route-secret-bob"),
      ),
    );

    const refreshedAliceCapture = await capture(ACCOUNT_EMAIL, TENANT, SUBSCRIPTION, "alice-refresh");
    assert.ok(refreshedAliceCapture.id !== firstConnection.credentialId);
    const refreshAlice = await fetch(
      `${base}/v1/azure/connections/${encodeURIComponent(firstConnection.connectionId)}`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({ accountLabel: "Alice account" }),
      },
    );
    assert.equal(refreshAlice.status, 200);

    const refreshedFirst = await built.keychain!.materializeOwnById(
      "alice",
      firstConnection.credentialId,
      "personal:alice",
    );
    const retainedSecond = await built.keychain!.materializeOwnById(
      "alice",
      secondConnection.credentialId,
      "personal:alice",
    );
    assert.equal(refreshedFirst.kind, "file");
    assert.equal(retainedSecond.kind, "file");
    if (refreshedFirst.kind !== "file" || retainedSecond.kind !== "file") return;
    assert.ok(
      refreshedFirst.files.some((file) =>
        Buffer.from(file.contentBase64, "base64").toString("utf8").includes("route-secret-alice-refresh"),
      ),
    );
    assert.ok(
      retainedSecond.files.some((file) =>
        Buffer.from(file.contentBase64, "base64").toString("utf8").includes("route-secret-bob"),
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

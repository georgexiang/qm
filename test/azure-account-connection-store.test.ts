import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureAccountConnectionStore } from "../src/azure/azure-account-connection-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

const HOME_TENANT = "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3";
const GUEST_TENANT = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const SUBSCRIPTION = "483ab1e0-a746-4f34-8276-53e640d6ab09";

test("Azure account connection store preserves multi-tenant metadata without secrets", async () => {
  let now = 100;
  const store = createAzureAccountConnectionStore(createMemoryMap(), {
    now: () => now,
    id: () => "connection-one",
  });
  const created = await store.save({
    credentialId: "credential-one",
    ownerPrincipalId: "alice",
    accountLabel: "Contoso reader",
    accountEmail: "alice@example.com",
    homeTenantId: HOME_TENANT,
    status: "active",
    tenantAccess: [
      {
        tenantId: GUEST_TENANT,
        displayName: "Guest tenant",
        objectId: "guest-object-id",
        status: "verification_required",
        visibleSubscriptions: [],
      },
      {
        tenantId: HOME_TENANT,
        displayName: "Home tenant",
        objectId: "home-object-id",
        status: "active",
        visibleSubscriptions: [{ id: SUBSCRIPTION, name: "Production", state: "Enabled" }],
      },
    ],
  });
  assert.equal(created.connectionId, "connection-one");
  assert.equal(created.authenticationType, "azure-cli-device-code");
  assert.deepEqual(
    created.tenantAccess.map((tenant) => tenant.tenantId),
    [HOME_TENANT, GUEST_TENANT],
  );
  assert.equal(JSON.stringify(created).includes("secret"), false);

  now = 200;
  const refreshed = await store.save({
    ...created,
    accountLabel: "Contoso read account",
    status: "verification_required",
  });
  assert.equal(refreshed.createdAt, 100);
  assert.equal(refreshed.updatedAt, 200);
  assert.equal(refreshed.lastVerifiedAt, 200);
  assert.equal(refreshed.status, "verification_required");
  assert.deepEqual(await store.listByOwner("alice"), [refreshed]);
  assert.deepEqual(await store.listByOwner("bob"), []);
});

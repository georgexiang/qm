import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureOpsLegacyMutation } from "../src/azure/azure-ops-legacy-mutation.ts";
import { AZURE_OPS_SKILL_NAME, type AzureOpsBinding } from "../src/azure/azure-ops-binding-store.ts";
import type { KeychainGrant } from "../src/credentials/keychain.ts";
import { createMemoryMap, type DurableMap } from "../src/persistence/durable-map.ts";

const SCOPE = "group:web-project-legacy" as const;
const TENANT = "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3";
const SUBSCRIPTION = "483ab1e0-a746-4f34-8276-53e640d6ab09";

function fixture() {
  const grant: KeychainGrant = {
    id: "legacy-grant",
    credentialId: "credential-one",
    ownerId: "owner",
    audienceScopeId: SCOPE,
    mode: "standing",
    purpose: "Legacy Azure Project binding",
    status: "active",
    createdAt: 1,
  };
  const binding: AzureOpsBinding = {
    bindingId: "binding-one",
    scopeId: SCOPE,
    skillName: AZURE_OPS_SKILL_NAME,
    connectionId: "connection-one",
    grantId: grant.id,
    defaultTarget: { tenantId: TENANT, subscriptionId: SUBSCRIPTION },
    targetAllowlist: [{ tenantId: TENANT, subscriptionIds: [SUBSCRIPTION] }],
    createdBy: "owner",
    updatedBy: "owner",
    createdAt: 1,
    updatedAt: 1,
    status: "active",
  };
  return { grant, binding };
}

test("legacy binding replacement rolls back grant revocation when binding persistence fails", async () => {
  const { grant, binding } = fixture();
  const grants = createMemoryMap<KeychainGrant>();
  const bindings = createMemoryMap<AzureOpsBinding>();
  await grants.put(grant.id, grant);
  await bindings.put(binding.scopeId, binding);
  let failPut = true;
  const failingBindings: DurableMap<AzureOpsBinding> = {
    ...bindings,
    async put(id, value) {
      if (failPut) {
        failPut = false;
        throw new Error("binding write failed");
      }
      return bindings.put(id, value);
    },
  };
  const mutation = createAzureOpsLegacyMutation({ grants, bindings: failingBindings, now: () => 2 });

  await assert.rejects(
    mutation.replace({
      grant,
      binding,
      next: {
        scopeId: SCOPE,
        connectionId: "connection-two",
        grantId: null,
        defaultTarget: binding.defaultTarget,
        targetAllowlist: binding.targetAllowlist,
        actorId: "owner",
      },
    }),
    /binding write failed/,
  );
  assert.deepEqual(await grants.get(grant.id), grant);
  assert.deepEqual(await bindings.get(binding.scopeId), binding);
});

test("legacy binding removal rolls back grant revocation when binding deletion fails", async () => {
  const { grant, binding } = fixture();
  const grants = createMemoryMap<KeychainGrant>();
  const bindings = createMemoryMap<AzureOpsBinding>();
  await grants.put(grant.id, grant);
  await bindings.put(binding.scopeId, binding);
  let failDelete = true;
  const failingBindings: DurableMap<AzureOpsBinding> = {
    ...bindings,
    async delete(id) {
      if (failDelete) {
        failDelete = false;
        throw new Error("binding delete failed");
      }
      return bindings.delete(id);
    },
  };
  const mutation = createAzureOpsLegacyMutation({ grants, bindings: failingBindings, now: () => 2 });

  await assert.rejects(mutation.remove({ grant, binding }), /binding delete failed/);
  assert.deepEqual(await grants.get(grant.id), grant);
  assert.deepEqual(await bindings.get(binding.scopeId), binding);
});

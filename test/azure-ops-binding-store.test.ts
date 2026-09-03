import { test } from "node:test";
import assert from "node:assert/strict";
import { createAzureOpsBindingStore } from "../src/azure/azure-ops-binding-store.ts";
import { createMemoryMap } from "../src/persistence/durable-map.ts";

test("Azure Ops binding store replaces one metadata-only default per supported scope", async () => {
  let now = 100;
  const store = createAzureOpsBindingStore(createMemoryMap(), {
    now: () => now,
    id: () => `binding-${now}`,
  });

  const first = await store.set({
    scopeId: "personal:alice",
    connectionId: "credential-one",
    grantId: "grant-one",
    defaultTarget: {
      tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3",
      subscriptionId: "483ab1e0-a746-4f34-8276-53e640d6ab09",
    },
    targetAllowlist: [
      {
        tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3",
        subscriptionIds: ["483ab1e0-a746-4f34-8276-53e640d6ab09", "f93a1566-6d9d-40ec-893d-b0c7a4f32c21"],
      },
      {
        tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        subscriptionIds: ["a8af42d5-b229-4360-9620-682eec610bc5"],
      },
    ],
    actorId: "alice",
  });
  assert.equal(first.skillName, "azure-ops");
  assert.equal(first.createdAt, 100);
  assert.equal(first.grantId, "grant-one");

  now = 200;
  const replacement = await store.set({
    scopeId: "personal:alice",
    connectionId: "credential-two",
    defaultTarget: {
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      subscriptionId: "8bc5a152-8843-4f24-a3cc-388b4b738529",
    },
    targetAllowlist: [
      {
        tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        subscriptionIds: ["8bc5a152-8843-4f24-a3cc-388b4b738529"],
      },
    ],
    actorId: "alice",
  });
  assert.equal(replacement.bindingId, first.bindingId);
  assert.equal(replacement.createdAt, first.createdAt);
  assert.equal(replacement.updatedAt, 200);
  assert.equal(replacement.grantId, "grant-one");
  assert.deepEqual(await store.get("personal:alice"), replacement);
  assert.ok(!JSON.stringify(replacement).toLowerCase().includes("secret"));

  now = 300;
  const cleared = await store.set({
    scopeId: "personal:alice",
    connectionId: "credential-three",
    grantId: null,
    defaultTarget: {
      tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
      subscriptionId: "8bc5a152-8843-4f24-a3cc-388b4b738529",
    },
    targetAllowlist: [
      {
        tenantId: "72f988bf-86f1-41af-91ab-2d7cd011db47",
        subscriptionIds: ["8bc5a152-8843-4f24-a3cc-388b4b738529"],
      },
    ],
    actorId: "alice",
  });
  assert.equal(cleared.grantId, undefined);

  await assert.rejects(
    store.set({
      scopeId: "personal:alice",
      connectionId: "credential-three",
      defaultTarget: {
        tenantId: "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3",
        subscriptionId: "483ab1e0-a746-4f34-8276-53e640d6ab09",
      },
      targetAllowlist: [],
      actorId: "alice",
    }),
    /default target.*allowlist/i,
  );
});

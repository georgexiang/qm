import { test } from "node:test";
import assert from "node:assert/strict";
import { parseAzureCliProfile } from "../src/azure/azure-cli-profile-parser.ts";

const TENANT_HOME = "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3";
const TENANT_GUEST = "72f988bf-86f1-41af-91ab-2d7cd011db47";
const SUB_A = "483ab1e0-a746-4f34-8276-53e640d6ab09";
const SUB_B = "8bc5a152-8843-4f24-a3cc-388b4b738529";

function b64Json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64");
}

test("parseAzureCliProfile groups subscriptions by tenant and derives stable metadata", () => {
  const parsed = parseAzureCliProfile([
    {
      path: "captured/home/.azure/azureProfile.json",
      contentBase64: b64Json({
        subscriptions: [
          {
            id: SUB_A,
            name: "Prod",
            state: "Enabled",
            tenantId: TENANT_HOME,
            homeTenantId: TENANT_HOME,
            user: { name: "alice@example.com", type: "user" },
          },
          {
            id: SUB_B,
            name: "Sandbox",
            state: "Warned",
            tenantId: TENANT_GUEST,
            homeTenantId: TENANT_HOME,
            user: { name: "alice@example.com", type: "user" },
          },
        ],
      }),
    },
  ]);
  assert.equal(parsed.status, "ok");
  if (parsed.status !== "ok") return;
  assert.equal(parsed.profile.accountEmail, "alice@example.com");
  assert.equal(parsed.profile.homeTenantId, TENANT_HOME);
  assert.deepEqual(
    parsed.profile.tenantAccess.map((tenant) => ({
      tenantId: tenant.tenantId,
      displayName: tenant.displayName,
      objectId: tenant.objectId,
      status: tenant.status,
      subscriptionIds: tenant.visibleSubscriptions.map((subscription) => subscription.id),
    })),
    [
      {
        tenantId: TENANT_HOME,
        displayName: TENANT_HOME,
        objectId: null,
        status: "active",
        subscriptionIds: [SUB_A],
      },
      {
        tenantId: TENANT_GUEST,
        displayName: TENANT_GUEST,
        objectId: null,
        status: "active",
        subscriptionIds: [SUB_B],
      },
    ],
  );
});

test("parseAzureCliProfile rejects mixed-account subscriptions", () => {
  const parsed = parseAzureCliProfile([
    {
      path: ".azure/azureProfile.json",
      contentBase64: b64Json({
        subscriptions: [
          {
            id: SUB_A,
            name: "Prod",
            state: "Enabled",
            tenantId: TENANT_HOME,
            homeTenantId: TENANT_HOME,
            user: { name: "alice@example.com", type: "user" },
          },
          {
            id: SUB_B,
            name: "Sandbox",
            state: "Enabled",
            tenantId: TENANT_HOME,
            homeTenantId: TENANT_HOME,
            user: { name: "bob@example.com", type: "user" },
          },
        ],
      }),
    },
  ]);
  assert.deepEqual(parsed, { status: "invalid_profile" });
});

test("parseAzureCliProfile normalizes profile path variants and requires usable subscriptions", () => {
  const noUsable = parseAzureCliProfile([
    {
      path: "azureProfile.json",
      contentBase64: b64Json({
        subscriptions: [
          {
            id: "",
            name: "Bad",
            state: "Enabled",
            tenantId: TENANT_HOME,
            homeTenantId: TENANT_HOME,
            user: { name: "alice@example.com", type: "user" },
          },
        ],
      }),
    },
  ]);
  assert.deepEqual(noUsable, { status: "verification_required" });

  const invalidJson = parseAzureCliProfile([
    {
      path: "~/.azure/azureProfile.json",
      contentBase64: Buffer.from("{not-json", "utf8").toString("base64"),
    },
  ]);
  assert.deepEqual(invalidJson, { status: "invalid_profile" });
});

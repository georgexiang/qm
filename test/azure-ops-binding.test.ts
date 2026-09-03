import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp } from "../src/wiring.ts";
import { createAzureOpsMethods } from "../src/api/app-azure.ts";
import type { AppDeps } from "../src/api/app-types.ts";
import { projectScopeId } from "../src/projects/project-store.ts";
import { testConfig } from "./support/test-config.ts";

const SUBSCRIPTION_ONE = "483ab1e0-a746-4f34-8276-53e640d6ab09";
const SUBSCRIPTION_TWO = "8bc5a152-8843-4f24-a3cc-388b4b738529";
const TENANT_ONE = "35fab2a8-2b8f-416a-b5c0-7578d2dfa1e3";
const TENANT_TWO = "72f988bf-86f1-41af-91ab-2d7cd011db47";

const targets = (tenantId: string, subscriptionId: string) => ({
  defaultTarget: { tenantId, subscriptionId },
  targetAllowlist: [{ tenantId, subscriptionIds: [subscriptionId] }],
});

async function azureConnection(
  built: ReturnType<typeof buildApp>,
  ownerId: string,
  label: string,
  tenantId: string,
  subscriptionId: string,
) {
  const credential = await built.keychain!.save({
    ownerId,
    service: "azure",
    files: [
      {
        path: ".azure/azureProfile.json",
        contentBase64: Buffer.from(
          JSON.stringify({
            subscriptions: [
              {
                id: subscriptionId,
                name: `${label} subscription`,
                state: "Enabled",
                tenantId,
                homeTenantId: tenantId,
                user: { name: `${ownerId}@example.com`, type: "user" },
              },
            ],
          }),
          "utf8",
        ).toString("base64"),
      },
      { path: ".azure/msal_token_cache.json", contentBase64: Buffer.from(`secret-${label}`).toString("base64") },
    ],
    accountLabel: label,
    origin: "device-flow-auto-capture",
  });
  const saved = await built.app.saveAzureAccountConnection({
    credentialId: credential.id,
    actorId: ownerId,
    accountLabel: label,
  });
  assert.equal(saved.status, "ok");
  if (saved.status !== "ok") throw new Error("failed to register Azure connection fixture");
  const persisted = await built.keychain!.getCredential(saved.connection.credentialId);
  assert.ok(persisted);
  if (!persisted) throw new Error("missing persisted Azure fixture credential");
  return { credential: persisted, connection: saved.connection };
}

test("Core enforces personal ownership and atomically updates the Azure Ops default", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-personal-")) }));
  const first = await azureConnection(built, "alice", "alice-one", TENANT_ONE, SUBSCRIPTION_ONE);

  assert.equal(
    (
      await built.app.setAzureOpsBinding({
        scopeId: "personal:alice",
        connectionId: first.connection.connectionId,
        ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
        actorId: "bob",
      })
    ).status,
    "forbidden",
  );
  const created = await built.app.setAzureOpsBinding({
    scopeId: "personal:alice",
    connectionId: first.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    actorId: "alice",
  });
  assert.equal(created.status, "ok");
  assert.equal((await built.app.getAzureOpsBinding("personal:alice", "bob")).status, "forbidden");

  await built.keychain!.saveFileById({
    ownerId: "alice",
    credentialId: first.credential.id,
    files: [
      {
        path: ".azure/azureProfile.json",
        contentBase64: Buffer.from(
          JSON.stringify({
            subscriptions: [
              {
                id: SUBSCRIPTION_TWO,
                name: "alice-two subscription",
                state: "Enabled",
                tenantId: TENANT_TWO,
                homeTenantId: TENANT_TWO,
                user: { name: "alice@example.com", type: "user" },
              },
            ],
          }),
          "utf8",
        ).toString("base64"),
      },
      { path: ".azure/msal_token_cache.json", contentBase64: Buffer.from("secret-alice-one").toString("base64") },
    ],
    origin: "device-flow-auto-capture",
  });

  const refreshed = await built.app.saveAzureAccountConnection({
    connectionId: first.connection.connectionId,
    actorId: "alice",
    accountLabel: "alice-one",
  });
  assert.equal(refreshed.status, "ok");

  const replaced = await built.app.setAzureOpsBinding({
    scopeId: "personal:alice",
    connectionId: first.connection.connectionId,
    ...targets(TENANT_TWO, SUBSCRIPTION_TWO),
    actorId: "alice",
  });
  assert.equal(replaced.status, "ok");
  if (created.status !== "ok" || replaced.status !== "ok") return;
  assert.equal(replaced.binding.binding.bindingId, created.binding.binding.bindingId);
  assert.equal(replaced.binding.binding.connectionId, first.connection.connectionId);
  assert.equal(replaced.binding.binding.defaultTarget.tenantId, TENANT_TWO);
  assert.ok(!JSON.stringify(replaced).includes("secret-alice"));
  assert.equal((await built.app.deleteAzureOpsBinding("personal:alice", "bob")).status, "forbidden");
  assert.equal((await built.app.deleteAzureOpsBinding("personal:alice", "alice")).status, "ok");
  assert.equal((await built.app.getAzureOpsBinding("personal:alice", "alice")).status, "not_found");
});

test("Project owner mutates while current members read and standing grant revocation makes the binding unavailable", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-project-")) }));
  const project = await built.projects.create({ name: "Azure review", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  await built.projects.addMember(project.id, "project-owner", "project-member");
  const shared = await azureConnection(built, "credential-owner", "shared-account", TENANT_ONE, SUBSCRIPTION_ONE);
  const grant = await built.keychain!.createGrant({
    credentialId: shared.credential.id,
    ownerId: "credential-owner",
    audienceScopeId: projectScope,
    mode: "standing",
    purpose: "Azure Ops for this Project",
  });

  assert.equal(
    (
      await built.app.setAzureOpsBinding({
        scopeId: projectScope,
        connectionId: shared.connection.connectionId,
        ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
        actorId: "project-member",
      })
    ).status,
    "forbidden",
  );
  assert.equal(
    (
      await built.app.setAzureOpsBinding({
        scopeId: projectScope,
        connectionId: shared.connection.connectionId,
        ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
        actorId: "project-owner",
      })
    ).status,
    "ok",
  );
  const memberRead = await built.app.getAzureOpsBinding(projectScope, "project-member");
  assert.equal(memberRead.status, "ok");
  if (memberRead.status !== "ok") return;
  assert.equal(memberRead.binding.available, true);
  assert.equal(memberRead.binding.connection?.accountLabel, "shared-account");
  assert.equal(memberRead.binding.connection?.accountEmail, undefined);
  assert.equal(memberRead.binding.connection?.credentialId, undefined);
  assert.equal(memberRead.binding.connection?.ownerPrincipalId, undefined);
  assert.equal("grantId" in memberRead.binding.binding, false);
  assert.equal("createdBy" in memberRead.binding.binding, false);
  assert.equal("updatedBy" in memberRead.binding.binding, false);
  assert.deepEqual(
    memberRead.binding.connection?.tenantAccess?.map((tenant) => tenant.tenantId),
    [TENANT_ONE],
  );
  assert.deepEqual(
    memberRead.binding.connection?.tenantAccess?.[0]?.visibleSubscriptions.map((item) => item.id),
    [SUBSCRIPTION_ONE],
  );
  assert.ok(!JSON.stringify(memberRead).includes("secret-shared-account"));
  assert.equal((await built.app.getAzureOpsBinding(projectScope, "outsider")).status, "forbidden");

  await built.keychain!.revokeGrant("credential-owner", grant.id);
  const revoked = await built.app.getAzureOpsBinding(projectScope, "project-member");
  assert.equal(revoked.status, "ok");
  if (revoked.status !== "ok") return;
  assert.equal(revoked.binding.available, false);

  await built.keychain!.remove("credential-owner", shared.credential.id);
  const missing = await built.app.getAzureOpsBinding(projectScope, "project-member");
  assert.equal(missing.status, "ok");
  if (missing.status !== "ok") return;
  assert.equal(missing.binding.available, false);
  assert.equal(missing.binding.connection?.accountLabel, "shared-account");
  assert.equal((await built.app.deleteAzureOpsBinding(projectScope, "project-member")).status, "forbidden");
  assert.equal((await built.app.deleteAzureOpsBinding(projectScope, "project-owner")).status, "ok");
});

test("Project Owner binding their own Azure connection requires confirmation without creating a generic grant", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-project-owner-grant-")) }));
  const project = await built.projects.create({ name: "Azure owner", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  await built.projects.addMember(project.id, "project-owner", "project-member");
  const ownerConnection = await azureConnection(built, "project-owner", "owner-account", TENANT_ONE, SUBSCRIPTION_ONE);

  const denied = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: ownerConnection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    actorId: "project-owner",
  });
  assert.equal(denied.status, "sharing_confirmation_required");

  const allowed = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: ownerConnection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  assert.equal(allowed.status, "ok");
  if (allowed.status !== "ok") return;
  assert.equal(
    (await built.keychain!.listGrants({ ownerId: "project-owner", audienceScopeId: projectScope })).length,
    0,
  );

  const unavailable = await built.app.getAzureOpsBinding(projectScope, "project-member");
  assert.equal(unavailable.status, "ok");
  if (unavailable.status !== "ok") return;
  assert.equal(unavailable.binding.available, true);

  assert.equal((await built.app.deleteAzureOpsBinding(projectScope, "project-owner")).status, "ok");

  const rebound = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: ownerConnection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  assert.equal(rebound.status, "ok");
  if (rebound.status !== "ok") return;

  const externalGrant = await built.keychain!.createGrant({
    credentialId: ownerConnection.credential.id,
    ownerId: "project-owner",
    audienceScopeId: projectScope,
    mode: "standing",
    purpose: "External standing grant",
  });
  const switched = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: ownerConnection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  assert.equal(switched.status, "ok");

  const removeBinding = await built.app.deleteAzureOpsBinding(projectScope, "project-owner");
  assert.equal(removeBinding.status, "ok");
  const externalAfter = await built.keychain!.getGrant(externalGrant.id);
  assert.equal(externalAfter?.status, "active");
  assert.equal((await built.app.getAzureOpsBinding(projectScope, "project-member")).status, "not_found");
});

test("Replacing a project binding across two owner connections needs no generic grants", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-project-replace-grants-")) }));
  const project = await built.projects.create({ name: "Azure replace", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const first = await azureConnection(built, "project-owner", "owner-account-one", TENANT_ONE, SUBSCRIPTION_ONE);
  const second = await azureConnection(built, "project-owner", "owner-account-two", TENANT_TWO, SUBSCRIPTION_TWO);

  const initial = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: first.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  assert.equal(initial.status, "ok");
  if (initial.status !== "ok") return;

  const replaced = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: second.connection.connectionId,
    ...targets(TENANT_TWO, SUBSCRIPTION_TWO),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  assert.equal(replaced.status, "ok");
  if (replaced.status !== "ok") return;
  assert.equal(
    (await built.keychain!.listGrants({ ownerId: "project-owner", audienceScopeId: projectScope })).length,
    0,
  );
  assert.equal(replaced.binding.binding.connectionId, second.connection.connectionId);
});

test("Project binding persistence failure creates no generic standing grant", async () => {
  const projectScope = projectScopeId("proj-fail");
  const auditEvents: Array<{ action: string; detail?: string }> = [];
  const credentialId = "credential-a";
  const connectionId = "connection-a";

  const deps = {
    auditLog: {
      record: (event: { action: string; detail?: string }) => {
        auditEvents.push({ action: event.action, detail: event.detail });
      },
      events: async () => [],
      tail: async () => [],
    },
    projects: {
      get: async (id: string) => (id === "proj-fail" ? { id, ownerId: "project-owner" } : null),
      membership: async () => false,
    },
    azureAccountConnections: {
      get: async (id: string) =>
        id === connectionId
          ? {
              connectionId,
              credentialId,
              ownerPrincipalId: "project-owner",
              accountLabel: "owner",
              accountEmail: "owner@example.com",
              homeTenantId: TENANT_ONE,
              tenantAccess: [
                {
                  tenantId: TENANT_ONE,
                  displayName: "Tenant one",
                  objectId: null,
                  status: "active",
                  visibleSubscriptions: [{ id: SUBSCRIPTION_ONE, name: "Sub one", state: "Enabled" }],
                },
              ],
              lastVerifiedAt: 1,
              status: "active",
              createdAt: 1,
              updatedAt: 1,
            }
          : null,
    },
    azureOpsBindings: {
      get: async () => null,
      set: async () => {
        throw new Error("store-failure");
      },
    },
    keychain: {
      getCredential: async (id: string) =>
        id === credentialId
          ? {
              id,
              ownerId: "project-owner",
              service: "azure",
              kind: "file",
              origin: "device-flow-auto-capture",
              secretEnc: "secret-a",
              fingerprint: "fp-a",
              createdAt: 1,
              updatedAt: 1,
            }
          : null,
      grantsForScope: async () => [],
      revokeGrant: async () => true,
      getGrant: async () => null,
    },
  } as unknown as AppDeps;

  const methods = createAzureOpsMethods(deps);
  const result = await methods.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId,
    defaultTarget: { tenantId: TENANT_ONE, subscriptionId: SUBSCRIPTION_ONE },
    targetAllowlist: [{ tenantId: TENANT_ONE, subscriptionIds: [SUBSCRIPTION_ONE] }],
    confirmProjectSharing: true,
    actorId: "project-owner",
  });

  assert.equal(result.status, "invalid_allowlist");
  assert.equal(
    auditEvents.some((event) => event.action === "azure.binding.grant.create"),
    false,
  );
});

test("Same-millisecond replacement is audited as replace and includes metadata-only binding details without secrets", async () => {
  const scope = "personal:alice" as const;
  const connectionId = "connection-a";
  const credentialId = "credential-a";
  const priorBinding = {
    bindingId: "binding-a",
    scopeId: scope,
    skillName: "azure-ops",
    connectionId,
    defaultTarget: { tenantId: TENANT_ONE, subscriptionId: SUBSCRIPTION_ONE },
    targetAllowlist: [{ tenantId: TENANT_ONE, subscriptionIds: [SUBSCRIPTION_ONE] }],
    createdBy: "alice",
    updatedBy: "alice",
    createdAt: 77,
    updatedAt: 77,
    status: "active",
  } as const;
  const storedBinding = {
    ...priorBinding,
    defaultTarget: { tenantId: TENANT_ONE, subscriptionId: SUBSCRIPTION_TWO },
    targetAllowlist: [
      { tenantId: TENANT_ONE, subscriptionIds: [SUBSCRIPTION_ONE, SUBSCRIPTION_TWO] },
      { tenantId: TENANT_TWO, subscriptionIds: [SUBSCRIPTION_TWO] },
    ],
    updatedAt: 77,
  };

  const events: Array<{ action: string; detail?: string }> = [];
  let currentBinding: typeof storedBinding | typeof priorBinding = priorBinding;
  const deps = {
    auditLog: {
      record: (event: { action: string; detail?: string }) => {
        events.push({ action: event.action, detail: event.detail });
      },
      events: async () => [],
      tail: async () => [],
    },
    azureOpsBindings: {
      get: async () => currentBinding,
      set: async () => {
        currentBinding = storedBinding;
        return storedBinding;
      },
    },
    azureAccountConnections: {
      get: async (id: string) =>
        id === connectionId
          ? {
              connectionId,
              credentialId,
              ownerPrincipalId: "alice",
              accountLabel: "alice-account",
              accountEmail: "alice@example.com",
              homeTenantId: TENANT_ONE,
              tenantAccess: [
                {
                  tenantId: TENANT_ONE,
                  displayName: "Tenant one",
                  objectId: null,
                  status: "active",
                  visibleSubscriptions: [
                    { id: SUBSCRIPTION_ONE, name: "Sub one", state: "Enabled" },
                    { id: SUBSCRIPTION_TWO, name: "Sub two", state: "Enabled" },
                  ],
                },
                {
                  tenantId: TENANT_TWO,
                  displayName: "Tenant two",
                  objectId: null,
                  status: "active",
                  visibleSubscriptions: [{ id: SUBSCRIPTION_TWO, name: "Sub two", state: "Enabled" }],
                },
              ],
              lastVerifiedAt: 77,
              status: "active",
              createdAt: 77,
              updatedAt: 77,
            }
          : null,
    },
    keychain: {
      getCredential: async (id: string) =>
        id === credentialId
          ? {
              id,
              ownerId: "alice",
              service: "azure",
              kind: "file",
              origin: "device-flow-auto-capture",
              secretEnc: "secret-value",
              fingerprint: "fp-a",
              createdAt: 77,
              updatedAt: 77,
            }
          : null,
      grantsForScope: async () => [],
      getGrant: async () => null,
      revokeGrant: async () => false,
      createGrant: async () => ({ id: "grant-new" }),
    },
  } as unknown as AppDeps;

  const methods = createAzureOpsMethods(deps);
  const result = await methods.setAzureOpsBinding({
    scopeId: scope,
    connectionId,
    defaultTarget: { tenantId: TENANT_ONE, subscriptionId: SUBSCRIPTION_TWO },
    targetAllowlist: [
      { tenantId: TENANT_ONE, subscriptionIds: [SUBSCRIPTION_ONE, SUBSCRIPTION_TWO] },
      { tenantId: TENANT_TWO, subscriptionIds: [SUBSCRIPTION_TWO] },
    ],
    actorId: "alice",
  });

  assert.equal(result.status, "ok");
  const bindingEvent = events.find((event) => event.action.startsWith("azure.binding."));
  assert.ok(bindingEvent);
  assert.equal(bindingEvent?.action, "azure.binding.replace");
  const detail = JSON.parse(bindingEvent?.detail ?? "{}") as {
    metadataOnly?: boolean;
    defaultTarget?: { tenantId: string; subscriptionId: string };
    targetAllowlist?: Array<{ tenantId: string; subscriptionIds: string[] }>;
  };
  assert.equal(detail.metadataOnly, true);
  assert.deepEqual(detail.defaultTarget, { tenantId: TENANT_ONE, subscriptionId: SUBSCRIPTION_TWO });
  assert.deepEqual(detail.targetAllowlist, [
    { tenantId: TENANT_ONE, subscriptionIds: [SUBSCRIPTION_ONE, SUBSCRIPTION_TWO] },
    { tenantId: TENANT_TWO, subscriptionIds: [SUBSCRIPTION_TWO] },
  ]);
  assert.ok(!(bindingEvent?.detail ?? "").includes("secret-value"));
});

test("Concurrent Project owner binding writes serialize without generic standing grants", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-project-concurrent-")) }));
  const project = await built.projects.create({ name: "Azure concurrent", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const connection = await azureConnection(built, "project-owner", "concurrent-account", TENANT_ONE, SUBSCRIPTION_ONE);
  const input = {
    scopeId: projectScope,
    connectionId: connection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    confirmProjectSharing: true,
    actorId: "project-owner",
  };

  const results = await Promise.all([built.app.setAzureOpsBinding(input), built.app.setAzureOpsBinding(input)]);
  assert.deepEqual(
    results.map((result) => result.status),
    ["ok", "ok"],
  );
  const active = await built.keychain!.listGrants({ ownerId: "project-owner", audienceScopeId: projectScope });
  assert.equal(active.length, 0);
  const binding = await built.app.getAzureOpsBinding(projectScope, "project-owner");
  assert.equal(binding.status, "ok");
});

test("Legacy tracked Project grant disconnect fails closed and preserves its binding when revocation fails", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-project-revoke-fail-")) }));
  const project = await built.projects.create({ name: "Azure revoke", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const connection = await azureConnection(built, "project-owner", "revoke-account", TENANT_ONE, SUBSCRIPTION_ONE);
  const legacyGrant = await built.keychain!.createGrant({
    credentialId: connection.credential.id,
    ownerId: "project-owner",
    audienceScopeId: projectScope,
    mode: "standing",
    purpose: "Legacy Azure Project binding",
  });
  await built.azureOpsBindings.set({
    scopeId: projectScope,
    connectionId: connection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    grantId: legacyGrant.id,
    actorId: "project-owner",
  });

  const originalRevoke = built.keychain!.revokeGrant.bind(built.keychain!);
  built.keychain!.revokeGrant = async () => {
    throw new Error("storage unavailable");
  };
  const disconnected = await built.app.deleteAzureOpsBinding(projectScope, "project-owner");
  built.keychain!.revokeGrant = originalRevoke;

  assert.equal(disconnected.status, "invalid_credential");
  assert.equal((await built.app.getAzureOpsBinding(projectScope, "project-owner")).status, "ok");
  assert.equal(
    (await built.auditLog.events()).some(
      (event) => event.action === "azure.binding.revoke" && event.scopeLabel === projectScope,
    ),
    false,
  );
});

test("Legacy tracked Project grant replacement leaves the prior binding untouched when revocation fails", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-legacy-replace-fail-")) }));
  const project = await built.projects.create({ name: "Azure legacy replace", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const first = await azureConnection(built, "project-owner", "legacy-first", TENANT_ONE, SUBSCRIPTION_ONE);
  const second = await azureConnection(built, "project-owner", "legacy-second", TENANT_TWO, SUBSCRIPTION_TWO);
  const legacyGrant = await built.keychain!.createGrant({
    credentialId: first.credential.id,
    ownerId: "project-owner",
    audienceScopeId: projectScope,
    mode: "standing",
    purpose: "Legacy Azure Project binding",
  });
  await built.azureOpsBindings.set({
    scopeId: projectScope,
    connectionId: first.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    grantId: legacyGrant.id,
    actorId: "project-owner",
  });

  const originalRevoke = built.keychain!.revokeGrant.bind(built.keychain!);
  built.keychain!.revokeGrant = async () => false;
  const replaced = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: second.connection.connectionId,
    ...targets(TENANT_TWO, SUBSCRIPTION_TWO),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  built.keychain!.revokeGrant = originalRevoke;

  assert.equal(replaced.status, "invalid_credential");
  const internal = await built.azureOpsBindings.get(projectScope);
  assert.equal(internal?.connectionId, first.connection.connectionId);
  assert.equal(internal?.grantId, legacyGrant.id);
  assert.equal((await built.keychain!.getGrant(legacyGrant.id))?.status, "active");
  assert.equal(
    (await built.auditLog.events()).some(
      (event) => event.action === "azure.binding.replace" && event.scopeLabel === projectScope,
    ),
    false,
  );
});

test("Legacy tracked Project grant is revoked before a successful replacement", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-legacy-replace-ok-")) }));
  const project = await built.projects.create({ name: "Azure legacy success", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const first = await azureConnection(built, "project-owner", "legacy-first", TENANT_ONE, SUBSCRIPTION_ONE);
  const second = await azureConnection(built, "project-owner", "legacy-second", TENANT_TWO, SUBSCRIPTION_TWO);
  const legacyGrant = await built.keychain!.createGrant({
    credentialId: first.credential.id,
    ownerId: "project-owner",
    audienceScopeId: projectScope,
    mode: "standing",
    purpose: "Legacy Azure Project binding",
  });
  await built.azureOpsBindings.set({
    scopeId: projectScope,
    connectionId: first.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    grantId: legacyGrant.id,
    actorId: "project-owner",
  });

  const replaced = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: second.connection.connectionId,
    ...targets(TENANT_TWO, SUBSCRIPTION_TWO),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });

  assert.equal(replaced.status, "ok");
  assert.equal((await built.keychain!.getGrant(legacyGrant.id))?.status, "revoked");
  assert.equal((await built.azureOpsBindings.get(projectScope))?.connectionId, second.connection.connectionId);
});

test("Legacy Project binding cannot revoke a mismatched same-owner grant", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-legacy-mismatch-")) }));
  const project = await built.projects.create({ name: "Azure legacy mismatch", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const boundConnection = await azureConnection(built, "project-owner", "legacy-bound", TENANT_ONE, SUBSCRIPTION_ONE);
  const otherConnection = await azureConnection(built, "project-owner", "legacy-other", TENANT_TWO, SUBSCRIPTION_TWO);
  const unrelatedGrant = await built.keychain!.createGrant({
    credentialId: otherConnection.credential.id,
    ownerId: "project-owner",
    audienceScopeId: projectScope,
    mode: "standing",
    purpose: "Unrelated Project credential",
  });
  await built.azureOpsBindings.set({
    scopeId: projectScope,
    connectionId: boundConnection.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    grantId: unrelatedGrant.id,
    actorId: "project-owner",
  });

  const disconnected = await built.app.deleteAzureOpsBinding(projectScope, "project-owner");
  assert.equal(disconnected.status, "invalid_credential");
  assert.equal((await built.keychain!.getGrant(unrelatedGrant.id))?.status, "active");
  assert.equal((await built.azureOpsBindings.get(projectScope))?.connectionId, boundConnection.connection.connectionId);
});

test("Legacy Project binding replacement cannot revoke a one-time grant", async () => {
  const built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "azure-binding-legacy-once-")) }));
  const project = await built.projects.create({ name: "Azure legacy once", ownerId: "project-owner" });
  const projectScope = projectScopeId(project.id);
  const first = await azureConnection(built, "project-owner", "legacy-once-first", TENANT_ONE, SUBSCRIPTION_ONE);
  const second = await azureConnection(built, "project-owner", "legacy-once-second", TENANT_TWO, SUBSCRIPTION_TWO);
  const onceGrant = await built.keychain!.createGrant({
    credentialId: first.credential.id,
    ownerId: "project-owner",
    audienceScopeId: projectScope,
    mode: "once",
    purpose: "Unrelated one-time grant",
  });
  await built.azureOpsBindings.set({
    scopeId: projectScope,
    connectionId: first.connection.connectionId,
    ...targets(TENANT_ONE, SUBSCRIPTION_ONE),
    grantId: onceGrant.id,
    actorId: "project-owner",
  });

  const replaced = await built.app.setAzureOpsBinding({
    scopeId: projectScope,
    connectionId: second.connection.connectionId,
    ...targets(TENANT_TWO, SUBSCRIPTION_TWO),
    confirmProjectSharing: true,
    actorId: "project-owner",
  });
  assert.equal(replaced.status, "invalid_credential");
  assert.equal((await built.keychain!.getGrant(onceGrant.id))?.status, "active");
  assert.equal((await built.azureOpsBindings.get(projectScope))?.connectionId, first.connection.connectionId);
});

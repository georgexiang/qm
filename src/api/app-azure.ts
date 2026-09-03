import { randomUUID } from "node:crypto";
import type {
  App,
  AppDeps,
  AzureAccountConnectionResult,
  AzureBindingConnectionView,
  AzureOpsBindingResult,
  AzureOpsBindingView,
} from "./app-types.ts";
import { samePerson } from "../directory/person.ts";
import { projectIdFromGroupRef } from "../projects/project-store.ts";
import { parseScopeId, scopeId, type ScopeId } from "../types.ts";
import { DEVICE_FLOW_ORIGIN } from "../credentials/device-flow-persist.ts";
import { parseAzureCliProfile } from "../azure/azure-cli-profile-parser.ts";
import { hashId } from "../util/crypto.ts";
import { createKeyedQueue } from "../util/async.ts";

type AzureScopeAuthorization =
  { kind: "personal" | "project"; ownerId: string } | { error: "forbidden" | "invalid_scope" | "not_found" };

function isCapturedAzureCredential(credential: Awaited<ReturnType<NonNullable<AppDeps["keychain"]>["getCredential"]>>) {
  return credential?.service === "azure" && credential.kind === "file" && credential.origin === DEVICE_FLOW_ORIGIN;
}

function normalizeAccountEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizeHomeTenant(homeTenantId?: string): string {
  return (homeTenantId ?? "").trim().toLowerCase();
}

function azureAccountIdentity(profile: { accountEmail: string; homeTenantId?: string }): string {
  return `${normalizeAccountEmail(profile.accountEmail)}|${normalizeHomeTenant(profile.homeTenantId)}`;
}

function azureAccountCredentialSlot(profile: { accountEmail: string; homeTenantId?: string }): string {
  return `account:${hashId([normalizeAccountEmail(profile.accountEmail), normalizeHomeTenant(profile.homeTenantId)], 24)}`;
}

function defaultAzureCapturedCredentialId(ownerId: string): string {
  return hashId([ownerId, "azure", "file"]);
}

function bindingConnectionView(
  connection: Awaited<ReturnType<NonNullable<AppDeps["azureAccountConnections"]>["get"]>>,
): AzureBindingConnectionView | null {
  if (!connection) return null;
  return {
    connectionId: connection.connectionId,
    credentialId: connection.credentialId,
    ownerPrincipalId: connection.ownerPrincipalId,
    accountLabel: connection.accountLabel,
    accountEmail: connection.accountEmail,
    ...(connection.homeTenantId ? { homeTenantId: connection.homeTenantId } : {}),
    tenantAccess: connection.tenantAccess.map((tenant) => ({
      tenantId: tenant.tenantId,
      displayName: tenant.displayName,
      status: tenant.status,
      visibleSubscriptions: tenant.visibleSubscriptions.map((subscription) => ({
        id: subscription.id,
        name: subscription.name,
        state: subscription.state,
      })),
    })),
    lastVerifiedAt: connection.lastVerifiedAt,
    status: connection.status,
  };
}

function redactedBindingConnectionView(
  connection: Awaited<ReturnType<NonNullable<AppDeps["azureAccountConnections"]>["get"]>>,
  allowlist: AzureOpsBindingView["binding"]["targetAllowlist"],
): AzureBindingConnectionView | null {
  if (!connection) return null;
  const allowedByTenant = new Map(allowlist.map((target) => [target.tenantId, new Set(target.subscriptionIds)]));
  return {
    accountLabel: connection.accountLabel,
    status: connection.status,
    tenantAccess: connection.tenantAccess
      .map((tenant) => {
        const allowedSubscriptions = allowedByTenant.get(tenant.tenantId);
        if (!allowedSubscriptions) return null;
        const visibleSubscriptions = tenant.visibleSubscriptions.filter((subscription) =>
          allowedSubscriptions.has(subscription.id),
        );
        if (!visibleSubscriptions.length) return null;
        return {
          tenantId: tenant.tenantId,
          displayName: tenant.displayName,
          status: tenant.status,
          visibleSubscriptions: visibleSubscriptions.map((subscription) => ({
            id: subscription.id,
            name: subscription.name,
            state: subscription.state,
          })),
        };
      })
      .filter((tenant): tenant is NonNullable<typeof tenant> => tenant !== null),
  };
}

export function createAzureOpsMethods(
  deps: AppDeps,
): Pick<
  App,
  | "listAzureCapturedCredentials"
  | "listAzureAccountConnections"
  | "saveAzureAccountConnection"
  | "deleteAzureAccountConnection"
  | "getAzureOpsBinding"
  | "setAzureOpsBinding"
  | "deleteAzureOpsBinding"
> {
  const bindingQueue = createKeyedQueue<ScopeId>();
  const accountIdentityQueue = createKeyedQueue<string>();
  const connectionQueue = createKeyedQueue<string>();
  const withBindingLock = <T>(targetScopeId: ScopeId, fn: () => Promise<T>): Promise<T> =>
    bindingQueue(targetScopeId, () => deps.advisoryLock?.withLock(`azure-binding:${targetScopeId}`, fn) ?? fn());
  const withAccountIdentityLock = <T>(ownerId: string, identity: string, fn: () => Promise<T>): Promise<T> => {
    const lockId = `${ownerId.trim().toLowerCase()}:${identity}`;
    return accountIdentityQueue(lockId, () => deps.advisoryLock?.withLock(`azure-account:${lockId}`, fn) ?? fn());
  };
  const withConnectionLock = <T>(connectionId: string, fn: () => Promise<T>): Promise<T> =>
    connectionQueue(connectionId, () => deps.advisoryLock?.withLock(`azure-connection:${connectionId}`, fn) ?? fn());

  async function authorization(
    targetScopeId: ScopeId,
    actorId: string,
    mutate: boolean,
  ): Promise<AzureScopeAuthorization> {
    const parsed = parseScopeId(targetScopeId);
    if (parsed.kind === "personal") {
      return samePerson(parsed.ref, actorId)
        ? { kind: "personal" as const, ownerId: parsed.ref }
        : { error: "forbidden" as const };
    }
    const projectId = parsed.kind === "group" ? projectIdFromGroupRef(parsed.ref) : null;
    if (!projectId || !deps.projects) return { error: "invalid_scope" as const };
    const project = await deps.projects.get(projectId);
    if (!project) return { error: "not_found" as const };
    if (mutate) {
      return samePerson(project.ownerId, actorId)
        ? { kind: "project" as const, ownerId: project.ownerId }
        : { error: "forbidden" as const };
    }
    return (await deps.projects.membership(parsed.ref, actorId)) === true
      ? { kind: "project" as const, ownerId: project.ownerId }
      : { error: "forbidden" as const };
  }

  async function view(
    scopeId: ScopeId,
    actorId: string,
    authKind: "personal" | "project",
  ): Promise<AzureOpsBindingView | null> {
    const binding = await deps.azureOpsBindings?.get(scopeId);
    if (!binding) return null;
    const connection = (await deps.azureAccountConnections?.get(binding.connectionId)) ?? null;
    const credential = connection ? await deps.keychain?.getCredential(connection.credentialId) : null;
    let available = false;
    if (connection?.status === "active" && credential && isCapturedAzureCredential(credential)) {
      const parsed = parseScopeId(scopeId);
      if (parsed.kind === "personal") {
        available = samePerson(connection.ownerPrincipalId, parsed.ref) && samePerson(credential.ownerId, parsed.ref);
      } else {
        const projectId = parsed.kind === "group" ? projectIdFromGroupRef(parsed.ref) : null;
        const project = projectId ? await deps.projects?.get(projectId) : null;
        const grants = await deps.keychain?.grantsForScope(scopeId);
        available =
          !!project &&
          ((samePerson(project.ownerId, connection.ownerPrincipalId) &&
            samePerson(project.ownerId, credential.ownerId)) ||
            !!grants?.some(
              ({ grant }) =>
                grant.credentialId === credential.id && grant.mode === "standing" && grant.status === "active",
            ));
      }
    }
    const canInspectFullConnection = !!connection && samePerson(actorId, connection.ownerPrincipalId);
    const connectionView =
      authKind === "project" && !canInspectFullConnection
        ? redactedBindingConnectionView(connection, binding.targetAllowlist)
        : bindingConnectionView(connection);
    const { grantId: _grantId, createdBy: _createdBy, updatedBy: _updatedBy, ...publicBinding } = binding;
    return {
      binding: publicBinding,
      available,
      ...(connectionView ? { connection: connectionView } : {}),
    };
  }

  async function saveConnection(
    input: Parameters<App["saveAzureAccountConnection"]>[0],
  ): Promise<AzureAccountConnectionResult> {
    if (!deps.azureAccountConnections || !deps.keychain) return { status: "not_found" };
    const prior = input.connectionId ? await deps.azureAccountConnections.get(input.connectionId) : null;
    if (input.connectionId && (!prior || !samePerson(prior.ownerPrincipalId, input.actorId))) {
      return { status: "not_found" };
    }
    const requestedCredentialId = input.credentialId?.trim();
    let sourceCredentialId = requestedCredentialId;
    if (!sourceCredentialId && prior) {
      const captures = (await deps.keychain.listByOwner(input.actorId))
        .filter(isCapturedAzureCredential)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      sourceCredentialId = captures.find((capture) => capture.id !== prior.credentialId)?.id ?? prior.credentialId;
    }
    const credentialId = sourceCredentialId ?? "";
    const credential = await deps.keychain.getCredential(credentialId);
    if (!credential || !samePerson(credential.ownerId, input.actorId) || !isCapturedAzureCredential(credential)) {
      return { status: "invalid_credential" };
    }
    let materialized;
    try {
      materialized = await deps.keychain.materializeOwnById(
        input.actorId,
        credentialId,
        scopeId("personal", input.actorId),
      );
    } catch {
      return { status: "invalid_credential" };
    }
    if (materialized.kind !== "file") return { status: "invalid_credential" };
    const parsedProfile = parseAzureCliProfile(materialized.files);
    if (parsedProfile.status !== "ok") return { status: parsedProfile.status };
    const profileIdentity = azureAccountIdentity(parsedProfile.profile);
    if (prior && azureAccountIdentity(prior) !== profileIdentity) return { status: "invalid_metadata" };

    const persist = async (): Promise<AzureAccountConnectionResult> => {
      const allOwnedConnections = await deps.azureAccountConnections!.listByOwner(input.actorId);
      const existingByAccount = allOwnedConnections.find(
        (connection) => azureAccountIdentity(connection) === profileIdentity,
      );
      const existing = prior ?? existingByAccount;
      if (prior && existingByAccount && prior.connectionId !== existingByAccount.connectionId) {
        return { status: "invalid_metadata" };
      }
      const requestedLabel = input.accountLabel?.trim();
      const accountLabel =
        requestedLabel ||
        existing?.accountLabel ||
        credential.accountLabel?.trim() ||
        parsedProfile.profile.accountEmail;
      const temporaryCapturedCredentialId = defaultAzureCapturedCredentialId(input.actorId);
      const shouldPurgeTemporaryCapture = credential.id === temporaryCapturedCredentialId;
      const persistentSlot = azureAccountCredentialSlot(parsedProfile.profile);
      let createdPersistentCredentialId: string | undefined;
      let targetCredentialId: string;
      if (existing) {
        const refreshed = await deps.keychain!.save({
          ownerId: input.actorId,
          service: "azure",
          files: materialized.files,
          accountLabel,
          credentialSlot: `${persistentSlot}:refresh:${randomUUID()}`,
          origin: DEVICE_FLOW_ORIGIN,
        });
        createdPersistentCredentialId = refreshed.id;
        targetCredentialId = refreshed.id;
      } else {
        const persisted = await deps.keychain!.save({
          ownerId: input.actorId,
          service: "azure",
          files: materialized.files,
          accountLabel,
          credentialSlot: persistentSlot,
          origin: DEVICE_FLOW_ORIGIN,
        });
        createdPersistentCredentialId = persisted.id;
        targetCredentialId = persisted.id;
      }
      let connection;
      try {
        connection = await deps.azureAccountConnections!.save({
          ...(existing ? { connectionId: existing.connectionId } : {}),
          ...(existing ? { previousCredentialId: existing.credentialId } : {}),
          credentialId: targetCredentialId,
          ownerPrincipalId: input.actorId,
          accountLabel,
          accountEmail: parsedProfile.profile.accountEmail,
          homeTenantId: parsedProfile.profile.homeTenantId,
          tenantAccess: parsedProfile.profile.tenantAccess,
          status: "active",
        });
      } catch {
        if (createdPersistentCredentialId) {
          await deps.keychain!.remove(input.actorId, createdPersistentCredentialId).catch(() => false);
        }
        return { status: "invalid_metadata" };
      }
      if (existing && existing.credentialId !== targetCredentialId) {
        await deps.keychain!.remove(input.actorId, existing.credentialId).catch(() => false);
      }
      if (shouldPurgeTemporaryCapture && credential.id !== targetCredentialId) {
        await deps.keychain!.remove(input.actorId, credential.id).catch(() => false);
      }
      deps.auditLog.record({
        at: connection.updatedAt,
        principalId: input.actorId,
        action: existing ? "azure.connection.verify" : "azure.connection.complete",
        resource: connection.connectionId,
        scopeLabel: scopeId("personal", input.actorId),
      });
      return { status: "ok", connection, created: !existing };
    };

    return prior
      ? withConnectionLock(prior.connectionId, persist)
      : withAccountIdentityLock(input.actorId, profileIdentity, persist);
  }

  return {
    async listAzureCapturedCredentials(actorId) {
      if (!deps.keychain) return [];
      return (await deps.keychain.listByOwner(actorId)).filter(isCapturedAzureCredential).map((credential) => ({
        credentialId: credential.id,
        ...(credential.accountLabel ? { accountLabel: credential.accountLabel } : {}),
        createdAt: credential.createdAt,
        updatedAt: credential.updatedAt,
      }));
    },
    async listAzureAccountConnections(actorId) {
      return (await deps.azureAccountConnections?.listByOwner(actorId)) ?? [];
    },
    saveAzureAccountConnection: saveConnection,
    async deleteAzureAccountConnection(connectionId, actorId): Promise<AzureAccountConnectionResult> {
      return withConnectionLock(connectionId, async () => {
        if (!deps.azureAccountConnections || !deps.azureOpsBindings || !deps.keychain) return { status: "not_found" };
        const connection = await deps.azureAccountConnections.get(connectionId);
        if (!connection || !samePerson(connection.ownerPrincipalId, actorId)) return { status: "not_found" };
        const references = await deps.azureOpsBindings.listByConnection(connectionId);
        if (references.length) {
          return { status: "conflict", bindingScopes: references.map((binding) => binding.scopeId) };
        }
        const revoked = await deps.azureAccountConnections.save({
          connectionId: connection.connectionId,
          credentialId: connection.credentialId,
          ownerPrincipalId: connection.ownerPrincipalId,
          accountLabel: connection.accountLabel,
          accountEmail: connection.accountEmail,
          ...(connection.homeTenantId ? { homeTenantId: connection.homeTenantId } : {}),
          tenantAccess: connection.tenantAccess,
          status: "revoked",
        });
        try {
          await deps.keychain.remove(connection.ownerPrincipalId, connection.credentialId);
          await deps.azureAccountConnections.remove(connectionId);
        } catch {
          return { status: "invalid_metadata" };
        }
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId,
          action: "azure.connection.revoke",
          resource: connectionId,
          scopeLabel: scopeId("personal", actorId),
        });
        return { status: "ok", connection: revoked };
      });
    },
    async getAzureOpsBinding(scopeId, actorId): Promise<AzureOpsBindingResult> {
      const auth = await authorization(scopeId, actorId, false);
      if ("error" in auth) return { status: auth.error };
      const binding = await view(scopeId, actorId, auth.kind);
      return binding ? { status: "ok", binding } : { status: "not_found" };
    },
    setAzureOpsBinding(input): Promise<AzureOpsBindingResult> {
      return withBindingLock(input.scopeId, async () => {
        const auth = await authorization(input.scopeId, input.actorId, true);
        if ("error" in auth) return { status: auth.error };
        if (!deps.azureAccountConnections || !deps.azureOpsBindings || !deps.keychain) return { status: "not_found" };
        return withConnectionLock(input.connectionId, async () => {
          const priorBinding = await deps.azureOpsBindings!.get(input.scopeId);
          const priorTrackedGrantId = priorBinding?.grantId;
          const priorConnection = priorBinding
            ? await deps.azureAccountConnections!.get(priorBinding.connectionId)
            : null;
          const connection = await deps.azureAccountConnections!.get(input.connectionId);
          const credential = connection ? await deps.keychain!.getCredential(connection.credentialId) : null;
          if (!connection || connection.status !== "active" || !credential || !isCapturedAzureCredential(credential)) {
            return { status: "invalid_credential" };
          }
          const ownerConnection =
            samePerson(connection.ownerPrincipalId, auth.ownerId) && samePerson(credential.ownerId, auth.ownerId);
          let authorized = ownerConnection;
          if (auth.kind === "project") {
            const scopeGrants = await deps.keychain!.grantsForScope(input.scopeId);
            const standingGrants = scopeGrants.filter(
              ({ grant }) =>
                grant.credentialId === credential.id && grant.mode === "standing" && grant.status === "active",
            );
            const trackedGrant = standingGrants.find(({ grant }) => grant.id === priorTrackedGrantId);
            const standingGrant = trackedGrant ?? standingGrants[0];
            if (ownerConnection) {
              if (input.confirmProjectSharing !== true) return { status: "sharing_confirmation_required" };
              authorized = true;
            } else {
              authorized = Boolean(standingGrant);
            }
          }
          if (!authorized) return { status: "invalid_credential" };
          const allowed = input.targetAllowlist.every((target) => {
            const tenant = connection.tenantAccess.find(
              (candidate) => candidate.tenantId.toLowerCase() === target.tenantId.trim().toLowerCase(),
            );
            return (
              tenant?.status === "active" &&
              target.subscriptionIds.every((subscriptionId) =>
                tenant.visibleSubscriptions.some(
                  (subscription) => subscription.id.toLowerCase() === subscriptionId.trim().toLowerCase(),
                ),
              )
            );
          });
          if (!allowed) return { status: "invalid_allowlist" };
          let grantPatch: { grantId: string | null } | undefined;
          if (auth.kind === "project") {
            grantPatch = { grantId: null };
          }
          let activePriorGrant;
          if (priorTrackedGrantId) {
            if (!priorConnection) return { status: "invalid_credential" };
            const priorGrant = await deps.keychain!.getGrant(priorTrackedGrantId);
            if (
              !priorGrant ||
              priorGrant.ownerId !== priorConnection.ownerPrincipalId ||
              priorGrant.credentialId !== priorConnection.credentialId ||
              priorGrant.audienceScopeId !== input.scopeId ||
              priorGrant.mode !== "standing"
            ) {
              return { status: "invalid_credential" };
            }
            if (priorGrant.status === "active") activePriorGrant = priorGrant;
          }
          let stored;
          const next = { ...input, ...(grantPatch ?? {}) };
          if (activePriorGrant && priorBinding) {
            if (!deps.azureOpsLegacyMutation) return { status: "invalid_credential" };
            try {
              stored = await deps.azureOpsLegacyMutation.replace({
                grant: activePriorGrant,
                binding: priorBinding,
                next,
              });
              if (!stored) return { status: "invalid_credential" };
            } catch {
              return { status: "invalid_credential" };
            }
          } else {
            try {
              stored = await deps.azureOpsBindings!.set(next);
            } catch {
              return { status: "invalid_allowlist" };
            }
          }
          const metadataOnly =
            !!priorBinding &&
            priorBinding.connectionId === stored.connectionId &&
            (priorBinding.grantId ?? null) === (stored.grantId ?? null);
          deps.auditLog.record({
            at: stored.updatedAt,
            principalId: input.actorId,
            action: priorBinding ? "azure.binding.replace" : "azure.binding.create",
            resource: stored.scopeId,
            scopeLabel: stored.scopeId,
            detail: JSON.stringify({
              connectionId: stored.connectionId,
              defaultTarget: stored.defaultTarget,
              targetAllowlist: stored.targetAllowlist,
              metadataOnly,
            }),
          });
          return { status: "ok", binding: (await view(input.scopeId, input.actorId, auth.kind))! };
        });
      });
    },
    deleteAzureOpsBinding(scopeId, actorId): Promise<AzureOpsBindingResult> {
      return withBindingLock(scopeId, async () => {
        const auth = await authorization(scopeId, actorId, true);
        if ("error" in auth) return { status: auth.error };
        const current = await view(scopeId, actorId, auth.kind);
        const internalBinding = await deps.azureOpsBindings?.get(scopeId);
        if (!current || !internalBinding || !deps.azureOpsBindings) return { status: "not_found" };
        let removedByLegacyMutation = false;
        if (internalBinding.grantId && deps.azureAccountConnections && deps.keychain) {
          const connection = await deps.azureAccountConnections.get(internalBinding.connectionId);
          if (!connection) return { status: "invalid_credential" };
          const grant = await deps.keychain.getGrant(internalBinding.grantId);
          if (
            !grant ||
            grant.ownerId !== connection.ownerPrincipalId ||
            grant.credentialId !== connection.credentialId ||
            grant.audienceScopeId !== scopeId ||
            grant.mode !== "standing"
          ) {
            return { status: "invalid_credential" };
          }
          if (grant.status === "active") {
            if (!deps.azureOpsLegacyMutation) return { status: "invalid_credential" };
            try {
              const removed = await deps.azureOpsLegacyMutation.remove({ grant, binding: internalBinding });
              if (!removed) return { status: "invalid_credential" };
              removedByLegacyMutation = true;
            } catch {
              return { status: "invalid_credential" };
            }
          }
        }
        if (!removedByLegacyMutation) await deps.azureOpsBindings.remove(scopeId);
        deps.auditLog.record({
          at: Date.now(),
          principalId: actorId,
          action: "azure.binding.revoke",
          resource: current.binding.scopeId,
          scopeLabel: scopeId,
          detail: `connection=${current.binding.connectionId}`,
        });
        return { status: "ok", binding: current };
      });
    },
  };
}

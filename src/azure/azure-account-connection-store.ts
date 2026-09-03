import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import { samePerson } from "../directory/person.ts";

export type AzureAccountConnectionStatus = "active" | "verification_required" | "revoked";
export type AzureTenantAccessStatus = "active" | "verification_required" | "unavailable";

export interface AzureVisibleSubscription {
  id: string;
  name: string;
  state: string;
}

export interface AzureTenantAccess {
  tenantId: string;
  displayName: string;
  objectId: string | null;
  status: AzureTenantAccessStatus;
  visibleSubscriptions: AzureVisibleSubscription[];
}

export interface AzureAccountConnection {
  connectionId: string;
  credentialId: string;
  ownerPrincipalId: string;
  authenticationType: "azure-cli-device-code";
  accountLabel: string;
  accountEmail: string;
  homeTenantId?: string;
  tenantAccess: AzureTenantAccess[];
  createdAt: number;
  updatedAt: number;
  lastVerifiedAt: number;
  status: AzureAccountConnectionStatus;
}

export interface SaveAzureAccountConnectionInput {
  connectionId?: string;
  previousCredentialId?: string;
  credentialId: string;
  ownerPrincipalId: string;
  accountLabel: string;
  accountEmail: string;
  homeTenantId?: string;
  tenantAccess: AzureTenantAccess[];
  status: AzureAccountConnectionStatus;
}

export interface AzureAccountConnectionStore {
  get(connectionId: string): Promise<AzureAccountConnection | null>;
  listByOwner(ownerPrincipalId: string): Promise<AzureAccountConnection[]>;
  save(input: SaveAzureAccountConnectionInput): Promise<AzureAccountConnection>;
  remove(connectionId: string): Promise<AzureAccountConnection | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONNECTION_STATUSES = new Set<AzureAccountConnectionStatus>(["active", "verification_required", "revoked"]);
const TENANT_STATUSES = new Set<AzureTenantAccessStatus>(["active", "verification_required", "unavailable"]);

function visible(connection: AzureAccountConnection): AzureAccountConnection {
  return {
    ...connection,
    tenantAccess: connection.tenantAccess.map((tenant) => ({
      ...tenant,
      visibleSubscriptions: tenant.visibleSubscriptions.map((subscription) => ({ ...subscription })),
    })),
  };
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new Error(`${field} required`);
  return normalized;
}

function uuid(value: string, field: string): string {
  const normalized = required(value, field).toLowerCase();
  if (!UUID.test(normalized)) throw new Error(`${field} must be a UUID`);
  return normalized;
}

function normalizeTenantAccess(tenantAccess: AzureTenantAccess[]): AzureTenantAccess[] {
  const tenants = new Map<string, AzureTenantAccess>();
  for (const rawTenant of tenantAccess) {
    const tenantId = uuid(rawTenant.tenantId, "tenantId");
    if (tenants.has(tenantId)) throw new Error("tenantAccess tenant IDs must be unique");
    if (!TENANT_STATUSES.has(rawTenant.status)) throw new Error("invalid tenant status");
    const subscriptions = new Map<string, AzureVisibleSubscription>();
    for (const rawSubscription of rawTenant.visibleSubscriptions) {
      const id = uuid(rawSubscription.id, "subscriptionId");
      if (subscriptions.has(id)) throw new Error("subscription IDs must be unique within a tenant");
      subscriptions.set(id, {
        id,
        name: required(rawSubscription.name, "subscription name"),
        state: required(rawSubscription.state, "subscription state"),
      });
    }
    tenants.set(tenantId, {
      tenantId,
      displayName: required(rawTenant.displayName, "tenant displayName"),
      objectId: rawTenant.objectId === null ? null : required(rawTenant.objectId, "tenant objectId"),
      status: rawTenant.status,
      visibleSubscriptions: [...subscriptions.values()].sort((left, right) => left.id.localeCompare(right.id)),
    });
  }
  if (!tenants.size) throw new Error("tenantAccess required");
  return [...tenants.values()].sort((left, right) => left.tenantId.localeCompare(right.tenantId));
}

export function createAzureAccountConnectionStore(
  backing: DurableMap<AzureAccountConnection>,
  opts: { now?: () => number; id?: () => string } = {},
): AzureAccountConnectionStore {
  const now = opts.now ?? Date.now;
  const nextId = opts.id ?? randomUUID;
  return {
    async get(connectionId) {
      const connection = await backing.get(connectionId);
      return connection ? visible(connection) : null;
    },
    async listByOwner(ownerPrincipalId) {
      return (await backing.all())
        .filter((connection) => samePerson(connection.ownerPrincipalId, ownerPrincipalId))
        .sort((left, right) => left.createdAt - right.createdAt)
        .map(visible);
    },
    async save(input) {
      if (!CONNECTION_STATUSES.has(input.status)) throw new Error("invalid connection status");
      const prior = input.connectionId ? await backing.get(input.connectionId) : null;
      if (input.connectionId && !prior) throw new Error("connection not found");
      if (prior && prior.ownerPrincipalId !== input.ownerPrincipalId) throw new Error("connection owner cannot change");
      if (prior && prior.credentialId !== input.credentialId && input.previousCredentialId !== prior.credentialId) {
        throw new Error("connection credential rotation requires the current credential ID");
      }
      const at = now();
      const homeTenantId = input.homeTenantId ? uuid(input.homeTenantId, "homeTenantId") : undefined;
      const tenantAccess = normalizeTenantAccess(input.tenantAccess);
      if (homeTenantId && !tenantAccess.some((tenant) => tenant.tenantId === homeTenantId)) {
        throw new Error("homeTenantId must appear in tenantAccess");
      }
      const connection: AzureAccountConnection = {
        connectionId: prior?.connectionId ?? nextId(),
        credentialId: required(input.credentialId, "credentialId"),
        ownerPrincipalId: required(input.ownerPrincipalId, "ownerPrincipalId"),
        authenticationType: "azure-cli-device-code",
        accountLabel: required(input.accountLabel, "accountLabel"),
        accountEmail: required(input.accountEmail, "accountEmail"),
        ...(homeTenantId ? { homeTenantId } : {}),
        tenantAccess,
        createdAt: prior?.createdAt ?? at,
        updatedAt: at,
        lastVerifiedAt: at,
        status: input.status,
      };
      await backing.put(connection.connectionId, connection);
      return visible(connection);
    },
    async remove(connectionId) {
      const connection = await backing.take(connectionId);
      return connection ? visible(connection) : null;
    },
  };
}

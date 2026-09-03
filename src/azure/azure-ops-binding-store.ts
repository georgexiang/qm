import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";
import type { ScopeId } from "../types.ts";

export const AZURE_OPS_SKILL_NAME = "azure-ops";

export interface AzureOpsTarget {
  tenantId: string;
  subscriptionId: string;
}

export interface AzureOpsTargetAllowlist {
  tenantId: string;
  subscriptionIds: string[];
}

export interface AzureOpsBinding {
  bindingId: string;
  scopeId: ScopeId;
  skillName: typeof AZURE_OPS_SKILL_NAME;
  connectionId: string;
  grantId?: string;
  defaultTarget: AzureOpsTarget;
  targetAllowlist: AzureOpsTargetAllowlist[];
  createdBy: string;
  updatedBy: string;
  createdAt: number;
  updatedAt: number;
  status: "active";
}

export interface SetAzureOpsBindingInput {
  scopeId: ScopeId;
  connectionId: string;
  grantId?: string | null;
  defaultTarget: AzureOpsTarget;
  targetAllowlist: AzureOpsTargetAllowlist[];
  actorId: string;
}

export interface AzureOpsBindingStore {
  get(scopeId: ScopeId): Promise<AzureOpsBinding | null>;
  listByConnection(connectionId: string): Promise<AzureOpsBinding[]>;
  set(input: SetAzureOpsBindingInput): Promise<AzureOpsBinding>;
  remove(scopeId: ScopeId): Promise<AzureOpsBinding | null>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSONAL_SCOPE = /^personal:[^:]+$/;
const PROJECT_SCOPE = /^group:web-project-[^:]+$/;

function visible(binding: AzureOpsBinding): AzureOpsBinding {
  return {
    ...binding,
    defaultTarget: { ...binding.defaultTarget },
    targetAllowlist: binding.targetAllowlist.map((target) => ({
      ...target,
      subscriptionIds: [...target.subscriptionIds],
    })),
  };
}

function normalizedInput(input: SetAzureOpsBindingInput): SetAzureOpsBindingInput {
  const connectionId = input.connectionId.trim();
  const grantId = input.grantId === null ? null : input.grantId?.trim();
  const actorId = input.actorId.trim();
  const defaultTarget = {
    tenantId: input.defaultTarget.tenantId.trim().toLowerCase(),
    subscriptionId: input.defaultTarget.subscriptionId.trim().toLowerCase(),
  };
  const targets = new Map<string, Set<string>>();
  for (const target of input.targetAllowlist) {
    const tenantId = target.tenantId.trim().toLowerCase();
    if (!UUID.test(tenantId)) throw new Error("target allowlist tenant IDs must be UUIDs");
    const subscriptions = targets.get(tenantId) ?? new Set<string>();
    for (const rawId of target.subscriptionIds) {
      const subscriptionId = rawId.trim().toLowerCase();
      if (!UUID.test(subscriptionId)) throw new Error("target allowlist subscription IDs must be UUIDs");
      subscriptions.add(subscriptionId);
    }
    targets.set(tenantId, subscriptions);
  }
  const targetAllowlist = [...targets]
    .map(([tenantId, subscriptionIds]) => ({ tenantId, subscriptionIds: [...subscriptionIds].sort() }))
    .filter((target) => target.subscriptionIds.length > 0)
    .sort((left, right) => left.tenantId.localeCompare(right.tenantId));
  if (!PERSONAL_SCOPE.test(input.scopeId) && !PROJECT_SCOPE.test(input.scopeId)) {
    throw new Error("Azure Ops bindings require a personal or web-project scope");
  }
  if (!connectionId || !actorId) throw new Error("connectionId and actorId required");
  if (!UUID.test(defaultTarget.tenantId) || !UUID.test(defaultTarget.subscriptionId)) {
    throw new Error("default target tenant and subscription IDs must be UUIDs");
  }
  if (
    !targetAllowlist.some(
      (target) =>
        target.tenantId === defaultTarget.tenantId && target.subscriptionIds.includes(defaultTarget.subscriptionId),
    )
  ) {
    throw new Error("default target must be included in the target allowlist");
  }
  const normalized: SetAzureOpsBindingInput = {
    ...input,
    connectionId,
    actorId,
    defaultTarget,
    targetAllowlist,
  };
  if (grantId === null) normalized.grantId = null;
  else if (grantId) normalized.grantId = grantId;
  return normalized;
}

export function prepareAzureOpsBinding(
  rawInput: SetAzureOpsBindingInput,
  prior: AzureOpsBinding | null,
  at: number,
  bindingId: string,
): AzureOpsBinding {
  const input = normalizedInput(rawInput);
  let grantId: string | undefined;
  if (input.grantId !== null) grantId = input.grantId ?? prior?.grantId;
  return {
    bindingId: prior?.bindingId ?? bindingId,
    scopeId: input.scopeId,
    skillName: AZURE_OPS_SKILL_NAME,
    connectionId: input.connectionId,
    ...(grantId ? { grantId } : {}),
    defaultTarget: input.defaultTarget,
    targetAllowlist: input.targetAllowlist,
    createdBy: prior?.createdBy ?? input.actorId,
    updatedBy: input.actorId,
    createdAt: prior?.createdAt ?? at,
    updatedAt: at,
    status: "active",
  };
}

export function createAzureOpsBindingStore(
  backing: DurableMap<AzureOpsBinding>,
  opts: { now?: () => number; id?: () => string } = {},
): AzureOpsBindingStore {
  const now = opts.now ?? Date.now;
  const nextId = opts.id ?? randomUUID;
  return {
    async get(scopeId) {
      const binding = await backing.get(scopeId);
      return binding ? visible(binding) : null;
    },
    async listByConnection(connectionId) {
      return (await backing.all())
        .filter((binding) => binding.connectionId === connectionId && binding.status === "active")
        .sort((left, right) => left.scopeId.localeCompare(right.scopeId))
        .map(visible);
    },
    async set(rawInput) {
      const prior = await backing.get(rawInput.scopeId);
      const at = now();
      const binding = prepareAzureOpsBinding(rawInput, prior, at, nextId());
      await backing.put(binding.scopeId, binding);
      return visible(binding);
    },
    async remove(scopeId) {
      const binding = await backing.take(scopeId);
      return binding ? visible(binding) : null;
    },
  };
}

import type { CredentialFile } from "../credentials/keychain.ts";
import type { AzureTenantAccess } from "./azure-account-connection-store.ts";

interface ProfileSubscription {
  id?: unknown;
  name?: unknown;
  state?: unknown;
  tenantId?: unknown;
  homeTenantId?: unknown;
  user?: unknown;
}

interface ParsedProfile {
  accountEmail: string;
  homeTenantId?: string;
  tenantAccess: AzureTenantAccess[];
}

export type AzureCliProfileParseResult =
  { status: "ok"; profile: ParsedProfile } | { status: "invalid_profile" | "verification_required" };

function normalizeProfilePath(path: string): string {
  return path
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.(?=\/)/, "")
    .replace(/^~(?=\/|$)/, "")
    .replace(/^\/+/, "")
    .replace(/\/+/g, "/")
    .toLowerCase();
}

function profilePathRank(path: string): number {
  const normalized = normalizeProfilePath(path);
  if (normalized.endsWith("/.azure/azureprofile.json")) return 0;
  if (normalized === ".azure/azureprofile.json") return 0;
  if (normalized.endsWith("/azureprofile.json")) return 1;
  if (normalized === "azureprofile.json") return 1;
  return 2;
}

function getProfileFile(files: readonly CredentialFile[]): CredentialFile | null {
  let selected: CredentialFile | null = null;
  let selectedRank = 3;
  for (const file of files) {
    const rank = profilePathRank(file.path);
    if (rank > 1) continue;
    if (!selected || rank < selectedRank) {
      selected = file;
      selectedRank = rank;
    }
  }
  return selected;
}

function requiredText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

function parseJson(contentBase64: string): unknown {
  const raw = Buffer.from(contentBase64, "base64").toString("utf8");
  return JSON.parse(raw);
}

function parseSubscriptions(doc: unknown): ProfileSubscription[] | null {
  if (!doc || typeof doc !== "object") return null;
  const subscriptions = (doc as { subscriptions?: unknown }).subscriptions;
  if (!Array.isArray(subscriptions)) return null;
  return subscriptions as ProfileSubscription[];
}

function parseAccountEmail(subscription: ProfileSubscription): string | null {
  if (!subscription.user || typeof subscription.user !== "object") return null;
  return requiredText((subscription.user as { name?: unknown }).name);
}

export function parseAzureCliProfile(files: readonly CredentialFile[]): AzureCliProfileParseResult {
  const profileFile = getProfileFile(files);
  if (!profileFile) return { status: "verification_required" };
  let subscriptions: ProfileSubscription[];
  try {
    const doc = parseJson(profileFile.contentBase64);
    const parsed = parseSubscriptions(doc);
    if (!parsed) return { status: "invalid_profile" };
    subscriptions = parsed;
  } catch {
    return { status: "invalid_profile" };
  }

  const tenants = new Map<string, AzureTenantAccess>();
  let accountEmail: string | null = null;
  let homeTenantId: string | undefined;

  for (const subscription of subscriptions) {
    const email = parseAccountEmail(subscription);
    if (!email) continue;
    if (accountEmail === null) accountEmail = email;
    else if (accountEmail.localeCompare(email, undefined, { sensitivity: "accent" }) !== 0) {
      return { status: "invalid_profile" };
    }

    const tenantId = requiredText(subscription.tenantId);
    const subscriptionId = requiredText(subscription.id);
    const subscriptionName = requiredText(subscription.name);
    const state = requiredText(subscription.state);
    if (!tenantId || !subscriptionId || !subscriptionName || !state) continue;

    const homeTenantCandidate = requiredText(subscription.homeTenantId);
    if (homeTenantCandidate) {
      if (!homeTenantId) homeTenantId = homeTenantCandidate;
      else if (homeTenantId.localeCompare(homeTenantCandidate, undefined, { sensitivity: "accent" }) !== 0) {
        return { status: "invalid_profile" };
      }
    }

    const existing = tenants.get(tenantId) ?? {
      tenantId,
      displayName: tenantId,
      objectId: null,
      status: "active" as const,
      visibleSubscriptions: [],
    };
    if (
      !existing.visibleSubscriptions.some(
        (candidate) => candidate.id.localeCompare(subscriptionId, undefined, { sensitivity: "accent" }) === 0,
      )
    ) {
      existing.visibleSubscriptions.push({ id: subscriptionId, name: subscriptionName, state });
    }
    tenants.set(tenantId, existing);
  }

  if (!accountEmail || !tenants.size) return { status: "verification_required" };

  const tenantAccess = [...tenants.values()]
    .map((tenant) => ({
      ...tenant,
      visibleSubscriptions: tenant.visibleSubscriptions.sort((left, right) => left.id.localeCompare(right.id)),
    }))
    .sort((left, right) => left.tenantId.localeCompare(right.tenantId));

  return {
    status: "ok",
    profile: {
      accountEmail,
      ...(homeTenantId ? { homeTenantId } : {}),
      tenantAccess,
    },
  };
}

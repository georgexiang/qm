import type { ActorAssertion, Principal } from "../types.ts";
import { createMemoryMap, type DurableMap } from "../persistence/durable-map.ts";
import { personKey } from "../directory/person.ts";

interface IdentityProvider {
  resolve(actor: ActorAssertion): Principal;
  classify(externalId: string, isExternalGuest?: boolean): Principal;
}

type DeactivationSource = "manual" | "directory-sync";

export interface DeactivationRecord {
  principalId: string;
  source: DeactivationSource;
  at: number;
}

export interface PrincipalProfile {
  principalId: string;
  displayName: string;
  aliases?: string[];
  updatedAt: number;
}

export function principalProfileNames(profile: PrincipalProfile): string[] {
  return [...new Set([profile.displayName, ...(profile.aliases ?? [])].map((value) => value.trim()).filter(Boolean))];
}

interface DirectorySyncOutcome {
  deactivated: string[];
  reactivated: string[];
}

export interface IdentityService extends IdentityProvider {
  isInternal(p: Principal): boolean;
  audienceIsAllInternal(audience: Principal[]): boolean;
  deactivate(externalId: string, source?: DeactivationSource): Promise<void>;
  reactivate(externalId: string): Promise<void>;
  recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome>;
  upsertProfile(principalId: string, displayName: string, observedAt?: number): Promise<PrincipalProfile>;
  profile(principalId: string): Promise<PrincipalProfile | null>;
  profiles(): Promise<PrincipalProfile[]>;
  hydrate(): Promise<void>;
  refresh(): Promise<void>;
}

export function createIdentityService(
  backing?: DurableMap<DeactivationRecord>,
  opts: { directorySyncProtected?: readonly string[]; profileBacking?: DurableMap<PrincipalProfile> } = {},
): IdentityService {
  const store = backing ?? createMemoryMap<DeactivationRecord>();
  const profileStore = opts.profileBacking ?? createMemoryMap<PrincipalProfile>();
  const deactivated = new Map<string, DeactivationRecord>();
  const directorySyncProtected = new Set((opts.directorySyncProtected ?? []).map(personKey).filter(Boolean));
  const REFRESH_TTL_MS = 10_000;
  let refreshedAt = 0;
  let refreshP: Promise<void> | null = null;
  let hydrateP: Promise<void> | null = null;

  function classify(externalId: string, isExternalGuest?: boolean): Principal {
    const record = deactivated.get(personKey(externalId));
    const inactive =
      record?.source === "manual" ||
      (record?.source === "directory-sync" && !directorySyncProtected.has(personKey(externalId)));
    const type: Principal["type"] = inactive || isExternalGuest ? "guest" : "internal";
    return { id: externalId, type };
  }

  async function deactivate(externalId: string, source: DeactivationSource = "manual"): Promise<void> {
    const key = personKey(externalId);
    const existing = deactivated.get(key);
    if (existing && (existing.source === "manual" || existing.source === source)) return;
    const record: DeactivationRecord = { principalId: externalId, source, at: Date.now() };
    deactivated.set(key, record);
    await store.put(key, record);
  }

  async function reactivate(externalId: string): Promise<void> {
    const key = personKey(externalId);
    deactivated.delete(key);
    await store.delete(key);
  }

  return {
    classify,
    deactivate,
    reactivate,
    async recordDirectorySync(removedIds: string[], presentIds: string[]): Promise<DirectorySyncOutcome> {
      const outcome: DirectorySyncOutcome = { deactivated: [], reactivated: [] };
      for (const id of removedIds) {
        if (directorySyncProtected.has(personKey(id)) || deactivated.has(personKey(id))) continue;
        await deactivate(id, "directory-sync");
        outcome.deactivated.push(id);
      }
      for (const id of presentIds) {
        if (deactivated.get(personKey(id))?.source !== "directory-sync") continue;
        await reactivate(id);
        outcome.reactivated.push(id);
      }
      return outcome;
    },
    async upsertProfile(principalId, displayName, observedAt = Date.now()) {
      const key = personKey(principalId);
      const nextName = displayName.trim();
      const nextObservedAt = Number.isFinite(observedAt) ? observedAt : Date.now();
      const initial: PrincipalProfile = { principalId, displayName: nextName, aliases: [], updatedAt: nextObservedAt };
      await profileStore.putIfAbsent(key, initial);
      const mergeProfile = (current: PrincipalProfile): PrincipalProfile => {
        const isCurrent = nextObservedAt >= current.updatedAt;
        const primaryName = isCurrent ? nextName : current.displayName;
        const aliases = [
          ...new Set(
            [...principalProfileNames(current), nextName].filter(
              (value) => personKey(value) !== personKey(primaryName),
            ),
          ),
        ];
        return {
          principalId: current.principalId,
          displayName: primaryName,
          aliases,
          updatedAt: isCurrent ? nextObservedAt : current.updatedAt,
        };
      };
      if (profileStore.update) return (await profileStore.update(key, mergeProfile)) ?? initial;
      const current = (await profileStore.get(key)) ?? initial;
      const profile = mergeProfile(current);
      await profileStore.put(key, profile);
      return profile;
    },
    profile(principalId) {
      return profileStore.get(personKey(principalId));
    },
    profiles() {
      return profileStore.all();
    },
    hydrate(): Promise<void> {
      if (!hydrateP) {
        hydrateP = store.all().then((records) => {
          for (const r of records) {
            const key = personKey(r.principalId);
            if (!deactivated.has(key)) deactivated.set(key, r);
          }
        });
      }
      return hydrateP;
    },
    async refresh(): Promise<void> {
      const now = Date.now();
      if (refreshP) return refreshP;
      if (now - refreshedAt < REFRESH_TTL_MS) return;
      refreshP = store
        .all()
        .then((records) => {
          deactivated.clear();
          for (const record of records) deactivated.set(personKey(record.principalId), record);
          refreshedAt = Date.now();
        })
        .finally(() => {
          refreshP = null;
        });
      return refreshP;
    },
    resolve(actor: ActorAssertion): Principal {
      const p = classify(actor.externalId, actor.isExternalGuest);
      return {
        ...p,
        ...(actor.teamIds ? { teamIds: actor.teamIds } : {}),
        ...(actor.displayName ? { displayName: actor.displayName } : {}),
      };
    },
    isInternal(p: Principal): boolean {
      return p.type === "internal";
    },
    audienceIsAllInternal(audience: Principal[]): boolean {
      return audience.length > 0 && audience.every((p) => p.type === "internal");
    },
  };
}

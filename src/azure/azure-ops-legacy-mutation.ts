import { randomUUID } from "node:crypto";
import type { KeychainGrant } from "../credentials/keychain.ts";
import { jsonbStringify, type DurableMap } from "../persistence/durable-map.ts";
import type { PgPool, PoolClient } from "../persistence/pg-pool.ts";
import {
  prepareAzureOpsBinding,
  type AzureOpsBinding,
  type SetAzureOpsBindingInput,
} from "./azure-ops-binding-store.ts";

const GRANTS_TABLE = "keychain_grants";
const BINDINGS_TABLE = "azure_ops_default_bindings";
const VERSIONS_TABLE = "durable_map_versions";

export interface AzureOpsLegacyMutation {
  replace(input: {
    grant: KeychainGrant;
    binding: AzureOpsBinding;
    next: SetAzureOpsBindingInput;
  }): Promise<AzureOpsBinding | null>;
  remove(input: { grant: KeychainGrant; binding: AzureOpsBinding }): Promise<AzureOpsBinding | null>;
}

function matches(
  grant: KeychainGrant | null,
  binding: AzureOpsBinding | null,
  expectedGrant: KeychainGrant,
  expectedBinding: AzureOpsBinding,
): boolean {
  return (
    grant?.id === expectedGrant.id &&
    grant.status === "active" &&
    grant.ownerId === expectedGrant.ownerId &&
    grant.credentialId === expectedGrant.credentialId &&
    grant.audienceScopeId === expectedGrant.audienceScopeId &&
    grant.mode === "standing" &&
    binding?.bindingId === expectedBinding.bindingId &&
    binding.grantId === expectedGrant.id &&
    binding.scopeId === expectedBinding.scopeId
  );
}

async function bump(client: PoolClient, table: string): Promise<void> {
  await client.query(
    `INSERT INTO ${VERSIONS_TABLE} (tbl, v) VALUES ($1, 1)
     ON CONFLICT (tbl) DO UPDATE SET v = ${VERSIONS_TABLE}.v + 1`,
    [table],
  );
}

export function createAzureOpsLegacyMutation(input: {
  grants: DurableMap<KeychainGrant>;
  bindings: DurableMap<AzureOpsBinding>;
  pg?: PgPool;
  now?: () => number;
  id?: () => string;
}): AzureOpsLegacyMutation {
  const now = input.now ?? Date.now;
  const nextId = input.id ?? randomUUID;

  async function memoryMutation(
    expectedGrant: KeychainGrant,
    expectedBinding: AzureOpsBinding,
    next: AzureOpsBinding | null,
  ): Promise<AzureOpsBinding | null> {
    const [grant, binding] = await Promise.all([
      input.grants.get(expectedGrant.id),
      input.bindings.get(expectedBinding.scopeId),
    ]);
    if (!matches(grant, binding, expectedGrant, expectedBinding)) return null;
    const revoked = { ...grant!, status: "revoked" as const, revokedAt: now() };
    await input.grants.put(revoked.id, revoked);
    try {
      if (next) await input.bindings.put(next.scopeId, next);
      else await input.bindings.delete(expectedBinding.scopeId);
    } catch (error) {
      await input.grants.put(grant!.id, grant!);
      await input.bindings.put(binding!.scopeId, binding!);
      throw error;
    }
    return next ?? binding;
  }

  async function postgresMutation(
    expectedGrant: KeychainGrant,
    expectedBinding: AzureOpsBinding,
    next: AzureOpsBinding | null,
  ): Promise<AzureOpsBinding | null> {
    const client = await (await input.pg!.pool()).connect();
    try {
      await client.query("BEGIN");
      const grantResult = await client.query(`SELECT json FROM ${GRANTS_TABLE} WHERE id = $1 FOR UPDATE`, [
        expectedGrant.id,
      ]);
      const bindingResult = await client.query(`SELECT json FROM ${BINDINGS_TABLE} WHERE id = $1 FOR UPDATE`, [
        expectedBinding.scopeId,
      ]);
      const grant = (grantResult.rows[0]?.json as KeychainGrant | undefined) ?? null;
      const binding = (bindingResult.rows[0]?.json as AzureOpsBinding | undefined) ?? null;
      if (!matches(grant, binding, expectedGrant, expectedBinding)) {
        await client.query("ROLLBACK");
        return null;
      }
      const revoked = { ...grant!, status: "revoked" as const, revokedAt: now() };
      await client.query(`UPDATE ${GRANTS_TABLE} SET json = $2 WHERE id = $1`, [revoked.id, jsonbStringify(revoked)]);
      if (next) {
        await client.query(
          `INSERT INTO ${BINDINGS_TABLE} (id, json) VALUES ($1, $2)
           ON CONFLICT (id) DO UPDATE SET json = EXCLUDED.json`,
          [next.scopeId, jsonbStringify(next)],
        );
      } else {
        await client.query(`DELETE FROM ${BINDINGS_TABLE} WHERE id = $1`, [expectedBinding.scopeId]);
      }
      await bump(client, GRANTS_TABLE);
      await bump(client, BINDINGS_TABLE);
      await client.query("COMMIT");
      return next ?? binding;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async function mutate(
    grant: KeychainGrant,
    binding: AzureOpsBinding,
    next: AzureOpsBinding | null,
  ): Promise<AzureOpsBinding | null> {
    return input.pg ? postgresMutation(grant, binding, next) : memoryMutation(grant, binding, next);
  }

  return {
    async replace({ grant, binding, next }) {
      const replacement = prepareAzureOpsBinding(next, binding, now(), nextId());
      return mutate(grant, binding, replacement);
    },
    async remove({ grant, binding }) {
      return mutate(grant, binding, null);
    },
  };
}

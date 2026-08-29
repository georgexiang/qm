import pg, { type PoolClient } from "pg";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type {
  HostAcceptedMessage,
  HostLocalStopReceiptMessage,
  HostResultMessage,
  RelayInvocationMessage,
} from "qm-desktop-browser-contracts";
import type {
  DesktopBrowserRelayAcceptedEvidence,
  DesktopBrowserRelayCallbackOutboxEntry,
  DesktopBrowserRelayLocalStopCallbackEntry,
  DesktopBrowserRelayLocalStopEvidence,
  DesktopBrowserRelayOperationCheckpoint,
  DesktopBrowserRelayOperationStore,
  DesktopBrowserRelayTerminalEvidence,
} from "./operation-store.ts";
import { canonicalRelayJson } from "./operation-store.ts";

export interface PostgresDesktopBrowserRelayOperationStore extends DesktopBrowserRelayOperationStore {
  check(): Promise<void>;
  close(): Promise<void>;
}

function checkpoint(row: Record<string, unknown>): DesktopBrowserRelayOperationCheckpoint {
  return {
    attemptId: String(row.attempt_id),
    operationId: String(row.operation_id),
    requestHash: String(row.request_hash),
    state: row.state as DesktopBrowserRelayOperationCheckpoint["state"],
    deliveryState: row.delivery_state as DesktopBrowserRelayOperationCheckpoint["deliveryState"],
    ...(row.invocation == null ? {} : { invocation: structuredClone(row.invocation) as RelayInvocationMessage }),
    ...(row.dispatch_id == null ? {} : { dispatchId: String(row.dispatch_id) }),
    ...(row.terminal_outcome == null
      ? {}
      : { terminalOutcome: row.terminal_outcome as DesktopBrowserRelayOperationCheckpoint["terminalOutcome"] }),
    ...(row.result_hash == null ? {} : { resultHash: String(row.result_hash) }),
    updatedAt: Number(row.updated_at),
  };
}

function callback(row: Record<string, unknown>): DesktopBrowserRelayCallbackOutboxEntry {
  return {
    taskId: String(row.task_id),
    operationId: String(row.operation_id),
    callbackType: "terminal",
    accepted: structuredClone(row.accepted) as HostAcceptedMessage,
    result: structuredClone(row.result) as HostResultMessage,
    createdAt: Number(row.created_at),
    deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
    attempts: Number(row.attempts),
    nextAttemptAt: Number(row.next_attempt_at),
    claimOwner: row.claim_owner == null ? null : String(row.claim_owner),
    claimExpiresAt: row.claim_expires_at == null ? null : Number(row.claim_expires_at),
    deadLetteredAt: row.dead_lettered_at == null ? null : Number(row.dead_lettered_at),
  };
}

function localStopCategory(effectClass: unknown): HostLocalStopReceiptMessage["payload"]["operationCategory"] {
  if (effectClass === "observation") return "observation";
  if (effectClass === "cleanup") return "session_cleanup";
  if (effectClass === "local_effect") return "session_start";
  return "browser_effect";
}

async function transaction<T>(pool: pg.Pool, run: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await run(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

function schemaName(value: string): string {
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(value)) {
    throw new Error("QM_RELAY_DATABASE_SCHEMA must be a lowercase PostgreSQL identifier");
  }
  return `"${value}"`;
}

function schemaStatements(schema: string): string[] {
  return [
    `CREATE SCHEMA IF NOT EXISTS ${schema}`,
    `CREATE TABLE IF NOT EXISTS ${schema}.operation_checkpoints(
      attempt_id TEXT PRIMARY KEY, operation_id TEXT UNIQUE NOT NULL, request_hash TEXT NOT NULL,
      state TEXT NOT NULL, delivery_state TEXT NOT NULL, invocation JSONB, dispatch_id TEXT,
      terminal_outcome TEXT, result_hash TEXT, updated_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.operations(
      operation_id TEXT PRIMARY KEY, attempt_id TEXT NOT NULL, task_id TEXT NOT NULL,
      protocol_version TEXT NOT NULL, operation_sequence BIGINT NOT NULL, lease_version BIGINT NOT NULL,
      lease_id TEXT NOT NULL, request_hash TEXT NOT NULL, dispatch_id TEXT, state TEXT NOT NULL,
      result_hash TEXT, terminal_result JSONB, revoked_at BIGINT,
      device_id TEXT, browser_instance_id TEXT, effect_class TEXT
    )`,
    `ALTER TABLE ${schema}.operations ADD COLUMN IF NOT EXISTS device_id TEXT`,
    `ALTER TABLE ${schema}.operations ADD COLUMN IF NOT EXISTS browser_instance_id TEXT`,
    `ALTER TABLE ${schema}.operations ADD COLUMN IF NOT EXISTS effect_class TEXT`,
    `UPDATE ${schema}.operations o SET
       device_id=COALESCE(o.device_id, c.invocation->'payload'->'authority'->>'deviceId'),
       browser_instance_id=COALESCE(o.browser_instance_id, c.invocation->'payload'->'authority'->>'browserInstanceId'),
       effect_class=COALESCE(o.effect_class, c.invocation->'payload'->'authority'->>'effectClass')
     FROM ${schema}.operation_checkpoints c WHERE c.operation_id=o.operation_id
       AND (o.device_id IS NULL OR o.browser_instance_id IS NULL OR o.effect_class IS NULL)`,
     `DO $$ BEGIN
       IF EXISTS (SELECT 1 FROM ${schema}.operations WHERE device_id IS NULL OR browser_instance_id IS NULL OR effect_class IS NULL)
       THEN RAISE EXCEPTION 'Relay operation authority migration requires draining or archiving legacy terminal operations';
       END IF;
      END $$`,
     `ALTER TABLE ${schema}.operations ALTER COLUMN device_id SET NOT NULL`,
     `ALTER TABLE ${schema}.operations ALTER COLUMN browser_instance_id SET NOT NULL`,
     `ALTER TABLE ${schema}.operations ALTER COLUMN effect_class SET NOT NULL`,
    `CREATE TABLE IF NOT EXISTS ${schema}.accepted_evidence(
      operation_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, protocol_version TEXT NOT NULL,
      request_hash TEXT NOT NULL, accepted_at BIGINT NOT NULL, PRIMARY KEY(operation_id, dispatch_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.terminal_evidence(
      operation_id TEXT NOT NULL, dispatch_id TEXT NOT NULL, result_hash TEXT NOT NULL,
      outcome TEXT NOT NULL, result JSONB NOT NULL, terminal_at BIGINT NOT NULL,
      PRIMARY KEY(operation_id, dispatch_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.callback_outbox(
      operation_id TEXT NOT NULL, callback_type TEXT NOT NULL, task_id TEXT NOT NULL,
      accepted JSONB NOT NULL, result JSONB NOT NULL, created_at BIGINT NOT NULL, delivered_at BIGINT,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL, claim_owner TEXT,
      claim_expires_at BIGINT, dead_lettered_at BIGINT, PRIMARY KEY(operation_id, callback_type)
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.core_request_nonces(
      nonce TEXT PRIMARY KEY, expires_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.connection_owners(
      identity_key TEXT PRIMARY KEY, connection_id TEXT NOT NULL, connection_epoch BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.local_stop_evidence(
      receipt_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, attempt_id TEXT NOT NULL,
      operation_id TEXT NOT NULL, message JSONB NOT NULL, received_at BIGINT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS ${schema}.local_stop_callback_outbox(
      receipt_id TEXT PRIMARY KEY, message JSONB NOT NULL, created_at BIGINT NOT NULL, delivered_at BIGINT,
      attempts INTEGER NOT NULL DEFAULT 0, next_attempt_at BIGINT NOT NULL, claim_owner TEXT,
      claim_expires_at BIGINT, dead_lettered_at BIGINT
    )`,
    `CREATE INDEX IF NOT EXISTS local_stop_callback_outbox_ready
      ON ${schema}.local_stop_callback_outbox(next_attempt_at, created_at)
      WHERE delivered_at IS NULL AND dead_lettered_at IS NULL`,
    `CREATE INDEX IF NOT EXISTS callback_outbox_ready ON ${schema}.callback_outbox(next_attempt_at, created_at)
      WHERE delivered_at IS NULL AND dead_lettered_at IS NULL`,
  ];
}

export async function migratePostgresDesktopBrowserRelayOperationStore(options: {
  connectionString: string;
  schema: string;
  runtimeRole: string;
}): Promise<void> {
  const runtimeRole = schemaName(options.runtimeRole);
  const schema = schemaName(options.schema);
  const pool = new pg.Pool({ connectionString: options.connectionString });
  try {
    for (const statement of schemaStatements(schema)) await pool.query(statement);
    await pool.query(`GRANT USAGE ON SCHEMA ${schema} TO ${runtimeRole}`);
    await pool.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA ${schema} TO ${runtimeRole}`);
  } finally {
    await pool.end();
  }
}

export function createPostgresDesktopBrowserRelayOperationStore(options: {
  connectionString: string;
  schema: string;
  now?: () => number;
}): PostgresDesktopBrowserRelayOperationStore {
  const now = options.now ?? Date.now;
  const schema = schemaName(options.schema);
  const pool = new pg.Pool({ connectionString: options.connectionString });
  const ready = Promise.resolve();
  const transactionClient = new AsyncLocalStorage<PoolClient>();
  const runTransaction = <T>(run: (client: PoolClient) => Promise<T>): Promise<T> => {
    const active = transactionClient.getStore();
    if (active) return run(active);
    return transaction(pool, (client) => transactionClient.run(client, () => run(client)));
  };
  const connectionKey = (input: { devicePublicKey: string; brokerInstanceId: string }) =>
    createHash("sha256").update(`${input.devicePublicKey}\0${input.brokerInstanceId}`).digest("hex");

  const getOperation = async (client: PoolClient, operationId: string) => {
    const selected = await client.query(`SELECT * FROM ${schema}.operations WHERE operation_id = $1 FOR UPDATE`, [
      operationId,
    ]);
    const row = selected.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("desktop browser Relay operation not found");
    return row;
  };

  return {
    async connectionOwner(input) {
      await ready;
      const query = transactionClient.getStore() ?? pool;
      const result = await query.query(
        `SELECT connection_id, connection_epoch FROM ${schema}.connection_owners WHERE identity_key=$1`,
        [connectionKey(input)],
      );
      const row = result.rows[0];
      return row
        ? { connectionId: String(row.connection_id), connectionEpoch: Number(row.connection_epoch) }
        : null;
    },
    async claimConnectionOwner(input) {
      await ready;
      return runTransaction(async (client) => {
        const key = connectionKey(input);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
        const selected = await client.query(
          `SELECT connection_id, connection_epoch FROM ${schema}.connection_owners WHERE identity_key=$1 FOR UPDATE`,
          [key],
        );
        const current = selected.rows[0];
        let expected = input.initialEpoch;
        if (current && String(current.connection_id) === input.connectionId) expected = Number(current.connection_epoch);
        else if (current) expected = Number(current.connection_epoch) + 1;
        if (input.connectionEpoch !== expected) return false;
        await client.query(
          `INSERT INTO ${schema}.connection_owners(identity_key, connection_id, connection_epoch)
           VALUES($1,$2,$3)
           ON CONFLICT(identity_key) DO UPDATE SET connection_id=EXCLUDED.connection_id,
             connection_epoch=EXCLUDED.connection_epoch`,
          [key, input.connectionId, input.connectionEpoch],
        );
        return true;
      });
    },
    async isConnectionOwner(input) {
      const owner = await this.connectionOwner(input);
      return owner?.connectionId === input.connectionId && owner.connectionEpoch === input.connectionEpoch;
    },
    async withConnectionOwner(input, run) {
      await ready;
      return runTransaction(async (client) => {
        const key = connectionKey(input);
        await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [key]);
        const selected = await client.query(
          `SELECT connection_id, connection_epoch FROM ${schema}.connection_owners WHERE identity_key=$1`,
          [key],
        );
        const owner = selected.rows[0];
        if (
          !owner ||
          String(owner.connection_id) !== input.connectionId ||
          Number(owner.connection_epoch) !== input.connectionEpoch
        ) {
          return { status: "superseded" as const };
        }
        return { status: "ok" as const, result: await run() };
      });
    },
    async consumeCoreNonce(nonce, expiresAt, now) {
      return runTransaction(async (client) => {
        await client.query(`DELETE FROM ${schema}.core_request_nonces WHERE expires_at <= $1`, [now]);
        const inserted = await client.query(
          `INSERT INTO ${schema}.core_request_nonces(nonce, expires_at) VALUES($1, $2)
           ON CONFLICT(nonce) DO NOTHING RETURNING nonce`,
          [nonce, expiresAt],
        );
        return inserted.rowCount === 1;
      });
    },
    async prepare(invocation) {
      await ready;
      return runTransaction(async (client) => {
        const authority = invocation.payload.authority;
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [authority.attemptId]);
        const selected = await client.query(
          `SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id = $1 FOR UPDATE`,
          [authority.attemptId],
        );
        const current = selected.rows[0] as Record<string, unknown> | undefined;
        if (current) {
          if (
            String(current.operation_id) === authority.operationId &&
            String(current.request_hash) === invocation.payload.requestHash
          ) {
            return { status: "existing" as const, checkpoint: checkpoint(current) };
          }
          const previous = await client.query(
            `SELECT operation_sequence, lease_version FROM ${schema}.operations WHERE operation_id = $1`,
            [current.operation_id],
          );
          if (
            !["terminal", "accepted_unknown"].includes(String(current.state)) ||
            authority.operationSequence <= Number(previous.rows[0]?.operation_sequence) ||
            authority.leaseVersion <= Number(previous.rows[0]?.lease_version)
          ) {
            throw new Error("desktop browser Relay Attempt already has a different current operation");
          }
        }
        await client.query(
          `INSERT INTO ${schema}.operations(operation_id, attempt_id, task_id, protocol_version, operation_sequence,
             lease_version, lease_id, request_hash, state, device_id, browser_instance_id, effect_class)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'prepared',$9,$10,$11)`,
          [
            authority.operationId,
            authority.attemptId,
            authority.taskId,
            invocation.protocolVersion,
            authority.operationSequence,
            authority.leaseVersion,
            authority.leaseId,
            invocation.payload.requestHash,
            authority.deviceId,
            authority.browserInstanceId,
            authority.effectClass,
          ],
        );
        const at = now();
        const saved = await client.query(
          `INSERT INTO ${schema}.operation_checkpoints(attempt_id, operation_id, request_hash, state, delivery_state, invocation, updated_at)
           VALUES ($1,$2,$3,'prepared','not_started',$4::jsonb,$5)
           ON CONFLICT (attempt_id) DO UPDATE SET operation_id=EXCLUDED.operation_id, request_hash=EXCLUDED.request_hash,
             state='prepared', delivery_state='not_started', invocation=EXCLUDED.invocation, dispatch_id=NULL,
             terminal_outcome=NULL, result_hash=NULL, updated_at=EXCLUDED.updated_at RETURNING *`,
          [authority.attemptId, authority.operationId, invocation.payload.requestHash, JSON.stringify(invocation), at],
        );
        return { status: "prepared" as const, checkpoint: checkpoint(saved.rows[0] as Record<string, unknown>) };
      });
    },
    async markDeliveryStartedIfOwner(owner, attemptId, dispatchId) {
      const result = await this.withConnectionOwner(owner, () => this.markDeliveryStarted(attemptId, dispatchId));
      return result.status === "ok" ? result.result : null;
    },
    async markDeliveryStarted(attemptId, dispatchId) {
      await ready;
      return runTransaction(async (client) => {
        const selected = await client.query(
          `SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id=$1 FOR UPDATE`,
          [attemptId],
        );
        const current = selected.rows[0] as Record<string, unknown> | undefined;
        if (!current) throw new Error("desktop browser Relay operation checkpoint not found");
        if (current.dispatch_id != null && String(current.dispatch_id) !== dispatchId) {
          throw new Error("desktop browser Relay operation delivery already started under another dispatch");
        }
        const saved = await client.query(
          `UPDATE ${schema}.operation_checkpoints SET delivery_state='started', dispatch_id=$2, updated_at=$3 WHERE attempt_id=$1 RETURNING *`,
          [attemptId, dispatchId, now()],
        );
        await client.query(`UPDATE ${schema}.operations SET dispatch_id=$2 WHERE operation_id=$1`, [
          current.operation_id,
          dispatchId,
        ]);
        return checkpoint(saved.rows[0] as Record<string, unknown>);
      });
    },
    async markDeliveryNotStarted(attemptId, dispatchId) {
      await ready;
      return runTransaction(async (client) => {
        const selected = await client.query(
          `SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id=$1 FOR UPDATE`,
          [attemptId],
        );
        const current = selected.rows[0] as Record<string, unknown> | undefined;
        if (!current || current.state !== "prepared" || current.dispatch_id !== dispatchId) {
          throw new Error("desktop browser Relay delivery can no longer return to not_started");
        }
        const saved = await client.query(
          `UPDATE ${schema}.operation_checkpoints SET delivery_state='not_started', dispatch_id=NULL, updated_at=$2 WHERE attempt_id=$1 RETURNING *`,
          [attemptId, now()],
        );
        await client.query(`UPDATE ${schema}.operations SET dispatch_id=NULL WHERE operation_id=$1`, [
          current.operation_id,
        ]);
        return checkpoint(saved.rows[0] as Record<string, unknown>);
      });
    },
    async recordAccepted(message) {
      await ready;
      return runTransaction(async (client) => {
        const operation = await getOperation(client, message.payload.operationId);
        if (
          operation.request_hash !== message.payload.requestHash ||
          operation.dispatch_id !== message.payload.dispatchId
        ) {
          throw new Error("desktop browser Relay acceptance does not match checkpoint");
        }
        await client.query(
          `INSERT INTO ${schema}.accepted_evidence(operation_id, dispatch_id, protocol_version, request_hash, accepted_at)
           VALUES ($1,$2,$3,$4,$5) ON CONFLICT (operation_id, dispatch_id) DO NOTHING`,
          [
            message.payload.operationId,
            message.payload.dispatchId,
            message.protocolVersion,
            message.payload.requestHash,
            now(),
          ],
        );
        const evidence = await client.query(
          `SELECT protocol_version, request_hash FROM ${schema}.accepted_evidence WHERE operation_id=$1 AND dispatch_id=$2`,
          [message.payload.operationId, message.payload.dispatchId],
        );
        if (
          evidence.rows[0]?.protocol_version !== message.protocolVersion ||
          evidence.rows[0]?.request_hash !== message.payload.requestHash
        ) {
          throw new Error("desktop browser Relay acceptance conflicts with persisted evidence");
        }
        await client.query(
          `UPDATE ${schema}.operations SET state='accepted' WHERE operation_id=$1 AND state='prepared'`,
          [message.payload.operationId],
        );
        const saved = await client.query(
          `UPDATE ${schema}.operation_checkpoints SET state='accepted', updated_at=$2
           WHERE attempt_id=$1 AND operation_id=$3 AND state='prepared' RETURNING *`,
          [operation.attempt_id, now(), message.payload.operationId],
        );
        if (saved.rows[0]) return checkpoint(saved.rows[0] as Record<string, unknown>);
        const current = await client.query(`SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id=$1`, [
          operation.attempt_id,
        ]);
        return checkpoint(current.rows[0] as Record<string, unknown>);
      });
    },
    async recordAcceptedUnknown(message) {
      await ready;
      return runTransaction(async (client) => {
        const operation = await getOperation(client, message.payload.operationId);
        if (
          operation.request_hash !== message.payload.requestHash ||
          operation.dispatch_id !== message.payload.dispatchId
        ) {
          throw new Error("desktop browser Relay accepted-unknown does not match checkpoint");
        }
        if (operation.terminal_result) return structuredClone(operation.terminal_result) as HostResultMessage;
        const resultHash = `sha256:${createHash("sha256")
          .update(`accepted_unknown:${message.payload.operationId}:${message.payload.requestHash}`)
          .digest("hex")}`;
        const result: HostResultMessage = {
          protocolVersion: message.protocolVersion,
          kind: "host.result",
          payload: {
            dispatchId: message.payload.dispatchId,
            operationId: message.payload.operationId,
            outcome: "unknown",
            resultHash,
            error: {
              code: "relay_accepted_unknown",
              message: "Host accepted the operation but Relay did not receive a terminal result",
            },
          },
        };
        const at = now();
        await client.query(
          `INSERT INTO ${schema}.terminal_evidence(operation_id, dispatch_id, result_hash, outcome, result, terminal_at)
           VALUES ($1,$2,$3,'unknown',$4::jsonb,$5) ON CONFLICT (operation_id, dispatch_id) DO NOTHING`,
          [message.payload.operationId, message.payload.dispatchId, resultHash, JSON.stringify(result), at],
        );
        await client.query(
          `INSERT INTO ${schema}.callback_outbox(operation_id, callback_type, task_id, accepted, result, created_at, next_attempt_at)
           VALUES ($1,'terminal',$2,$3::jsonb,$4::jsonb,$5,$5) ON CONFLICT (operation_id, callback_type) DO NOTHING`,
          [message.payload.operationId, operation.task_id, JSON.stringify(message), JSON.stringify(result), at],
        );
        await client.query(
          `UPDATE ${schema}.operations SET state='terminal', result_hash=$2, terminal_result=$3::jsonb WHERE operation_id=$1`,
          [message.payload.operationId, resultHash, JSON.stringify(result)],
        );
        await client.query(
          `UPDATE ${schema}.operation_checkpoints SET state='accepted_unknown', terminal_outcome='unknown', result_hash=$3,
             invocation=NULL, updated_at=$4 WHERE attempt_id=$1 AND operation_id=$2`,
          [operation.attempt_id, message.payload.operationId, resultHash, at],
        );
        return result;
      });
    },
    async recordLeaseRevocation(input) {
      await ready;
      return runTransaction(async (client) => {
        const selected = await client.query(
          `SELECT o.* FROM ${schema}.operation_checkpoints c
           JOIN ${schema}.operations o ON o.operation_id=c.operation_id
           WHERE c.attempt_id=$1 FOR UPDATE OF o`,
          [input.attemptId],
        );
        const operation = selected.rows[0] as Record<string, unknown> | undefined;
        if (!operation) throw new Error("desktop browser Relay revocation Attempt not found");
        if (
          operation.task_id !== input.taskId ||
          operation.lease_id !== input.leaseId ||
          input.leaseVersion !== Number(operation.lease_version) + 1
        ) {
          throw new Error("desktop browser Relay revocation Lease is stale");
        }
        if (operation.revoked_at != null) return "already_revoked" as const;
        await client.query(`UPDATE ${schema}.operations SET revoked_at=$2 WHERE operation_id=$1`, [
          operation.operation_id,
          now(),
        ]);
        return "revoked" as const;
      });
    },
    async recordLocalStopReceipt(message, host) {
      await ready;
      return runTransaction(async (client) => {
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [message.payload.receiptId]);
        const operation = await getOperation(client, message.payload.operationId);
        const expectedCategory = localStopCategory(operation.effect_class);
        if (
          operation.task_id !== message.payload.taskId ||
          operation.attempt_id !== message.payload.attemptId ||
          operation.device_id !== host.publicDeviceFingerprint ||
          operation.browser_instance_id !== host.browserInstanceId ||
          message.payload.operationCategory !== expectedCategory
        ) {
          throw new Error("desktop browser Local Stop Receipt does not match Relay operation authority");
        }
        const existing = await client.query(
          `SELECT message FROM ${schema}.local_stop_evidence WHERE receipt_id=$1 FOR UPDATE`,
          [message.payload.receiptId],
        );
        if (existing.rows[0]) {
          const existingMessage = existing.rows[0].message as HostLocalStopReceiptMessage;
          if (
            existingMessage.payload.status === "requested" &&
            message.payload.status === "canceled" &&
            canonicalRelayJson({ ...existingMessage, payload: { ...existingMessage.payload, status: "canceled" } }) ===
              canonicalRelayJson(message)
          ) {
            await client.query(`UPDATE ${schema}.local_stop_evidence SET message=$2::jsonb WHERE receipt_id=$1`, [
              message.payload.receiptId,
              JSON.stringify(message),
            ]);
            await client.query(
              `UPDATE ${schema}.local_stop_callback_outbox SET message=$2::jsonb, delivered_at=NULL,
                 claim_owner=NULL, claim_expires_at=NULL, next_attempt_at=$3, dead_lettered_at=NULL WHERE receipt_id=$1`,
              [message.payload.receiptId, JSON.stringify(message), now()],
            );
            return "recorded" as const;
          }
          if (canonicalRelayJson(existing.rows[0].message) !== canonicalRelayJson(message)) {
            throw new Error("desktop browser Local Stop Receipt identity already has different evidence");
          }
          return "existing" as const;
        }
        const at = now();
        await client.query(
          `INSERT INTO ${schema}.local_stop_evidence(receipt_id, task_id, attempt_id, operation_id, message, received_at)
           VALUES($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            message.payload.receiptId,
            message.payload.taskId,
            message.payload.attemptId,
            message.payload.operationId,
            JSON.stringify(message),
            at,
          ],
        );
        await client.query(
          `INSERT INTO ${schema}.local_stop_callback_outbox(receipt_id, message, created_at, next_attempt_at)
           VALUES($1,$2::jsonb,$3,$3)`,
          [message.payload.receiptId, JSON.stringify(message), at],
        );
        return "recorded" as const;
      });
    },
    async localStopReceipts() {
      await ready;
      const selected = await pool.query(
        `SELECT message, received_at FROM ${schema}.local_stop_evidence ORDER BY received_at, receipt_id`,
      );
      return selected.rows.map(
        (row): DesktopBrowserRelayLocalStopEvidence => ({
          message: structuredClone(row.message),
          receivedAt: Number(row.received_at),
        }),
      );
    },
    async pendingLocalStopCallbacks() {
      await ready;
      const selected = await pool.query(
        `SELECT * FROM ${schema}.local_stop_callback_outbox
         WHERE delivered_at IS NULL AND dead_lettered_at IS NULL ORDER BY created_at, receipt_id`,
      );
      return selected.rows.map(
        (row): DesktopBrowserRelayLocalStopCallbackEntry => ({
          receiptId: String(row.receipt_id),
          message: structuredClone(row.message),
          createdAt: Number(row.created_at),
          deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at),
          attempts: Number(row.attempts),
          nextAttemptAt: Number(row.next_attempt_at),
          claimOwner: row.claim_owner == null ? null : String(row.claim_owner),
          claimExpiresAt: row.claim_expires_at == null ? null : Number(row.claim_expires_at),
          deadLetteredAt: row.dead_lettered_at == null ? null : Number(row.dead_lettered_at),
        }),
      );
    },
    async claimLocalStopCallbacks(owner, limit, leaseMs) {
      await ready;
      if (!owner || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new Error("desktop browser Local Stop callback claim bounds are invalid");
      }
      return runTransaction(async (client) => {
        const at = now();
        const selected = await client.query(
          `WITH candidates AS (
             SELECT receipt_id FROM ${schema}.local_stop_callback_outbox
             WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at <= $1
               AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
             ORDER BY created_at, receipt_id FOR UPDATE SKIP LOCKED LIMIT $2
           )
           UPDATE ${schema}.local_stop_callback_outbox o
           SET claim_owner=$3, claim_expires_at=$4, attempts=o.attempts+1
           FROM candidates c WHERE o.receipt_id=c.receipt_id RETURNING o.*`,
          [at, limit, owner, at + leaseMs],
        );
        return selected.rows.map(
          (row): DesktopBrowserRelayLocalStopCallbackEntry => ({
            receiptId: String(row.receipt_id), message: structuredClone(row.message), createdAt: Number(row.created_at),
            deliveredAt: row.delivered_at == null ? null : Number(row.delivered_at), attempts: Number(row.attempts),
            nextAttemptAt: Number(row.next_attempt_at), claimOwner: row.claim_owner == null ? null : String(row.claim_owner),
            claimExpiresAt: row.claim_expires_at == null ? null : Number(row.claim_expires_at),
            deadLetteredAt: row.dead_lettered_at == null ? null : Number(row.dead_lettered_at),
          }),
        );
      });
    },
    async releaseLocalStopCallback(receiptId, owner, status, retryAt, deadLetter) {
      await ready;
      const updated = await pool.query(
        `UPDATE ${schema}.local_stop_callback_outbox SET claim_owner=NULL, claim_expires_at=NULL, next_attempt_at=$4,
         dead_lettered_at=CASE WHEN $5 THEN $6 ELSE dead_lettered_at END
         WHERE receipt_id=$1 AND claim_owner=$2 AND message->'payload'->>'status'=$3`,
        [receiptId, owner, status, retryAt, deadLetter, now()],
      );
      return (updated.rowCount ?? 0) === 1;
    },
    async markLocalStopCallbackDelivered(receiptId, owner, status) {
      await ready;
      const updated = await pool.query(
        `UPDATE ${schema}.local_stop_callback_outbox SET delivered_at=$4, claim_owner=NULL, claim_expires_at=NULL
         WHERE receipt_id=$1 AND claim_owner=$2 AND delivered_at IS NULL AND message->'payload'->>'status'=$3`,
        [receiptId, owner, status, now()],
      );
      return (updated.rowCount ?? 0) === 1;
    },
    async recordTerminal(message) {
      await ready;
      return runTransaction(async (client) => {
        const operation = await getOperation(client, message.payload.operationId);
        if (operation.dispatch_id !== message.payload.dispatchId) {
          throw new Error("desktop browser Relay terminal dispatch does not match checkpoint");
        }
        if (operation.terminal_result) {
          if (canonicalRelayJson(operation.terminal_result) !== canonicalRelayJson(message)) {
            throw new Error("desktop browser Relay terminal result conflicts with persisted evidence");
          }
          const current = await client.query(`SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id=$1`, [
            operation.attempt_id,
          ]);
          return checkpoint(current.rows[0] as Record<string, unknown>);
        }
        const accepted = await client.query(
          `SELECT * FROM ${schema}.accepted_evidence WHERE operation_id=$1 AND dispatch_id=$2`,
          [message.payload.operationId, message.payload.dispatchId],
        );
        const acceptance = accepted.rows[0] as Record<string, unknown> | undefined;
        if (!acceptance) throw new Error("desktop browser Relay terminal requires Accepted Evidence");
        const acceptedMessage: HostAcceptedMessage = {
          protocolVersion: String(acceptance.protocol_version) as `${number}.${number}`,
          kind: "host.accepted",
          payload: {
            dispatchId: String(acceptance.dispatch_id),
            operationId: String(acceptance.operation_id),
            requestHash: String(acceptance.request_hash),
          },
        };
        const at = now();
        await client.query(
          `INSERT INTO ${schema}.terminal_evidence(operation_id, dispatch_id, result_hash, outcome, result, terminal_at)
           VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
          [
            message.payload.operationId,
            message.payload.dispatchId,
            message.payload.resultHash,
            message.payload.outcome,
            JSON.stringify(message),
            at,
          ],
        );
        await client.query(
          `INSERT INTO ${schema}.callback_outbox(operation_id, callback_type, task_id, accepted, result, created_at, next_attempt_at)
           VALUES ($1,'terminal',$2,$3::jsonb,$4::jsonb,$5,$5)`,
          [
            message.payload.operationId,
            operation.task_id,
            JSON.stringify(acceptedMessage),
            JSON.stringify(message),
            at,
          ],
        );
        await client.query(
          `UPDATE ${schema}.operations SET state='terminal', result_hash=$2, terminal_result=$3::jsonb WHERE operation_id=$1`,
          [message.payload.operationId, message.payload.resultHash, JSON.stringify(message)],
        );
        const saved = await client.query(
          `UPDATE ${schema}.operation_checkpoints SET state='terminal', terminal_outcome=$3, result_hash=$4,
             invocation=NULL, updated_at=$5 WHERE attempt_id=$1 AND operation_id=$2 RETURNING *`,
          [operation.attempt_id, message.payload.operationId, message.payload.outcome, message.payload.resultHash, at],
        );
        if (saved.rows[0]) return checkpoint(saved.rows[0] as Record<string, unknown>);
        const current = await client.query(`SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id=$1`, [
          operation.attempt_id,
        ]);
        return checkpoint(current.rows[0] as Record<string, unknown>);
      });
    },
    async checkpoint(attemptId) {
      await ready;
      const selected = await pool.query(`SELECT * FROM ${schema}.operation_checkpoints WHERE attempt_id=$1`, [
        attemptId,
      ]);
      return selected.rows[0] ? checkpoint(selected.rows[0] as Record<string, unknown>) : null;
    },
    async attemptStatus(attemptId) {
      await ready;
      const selected = await pool.query(
        `SELECT c.*, o.protocol_version, o.terminal_result,
          a.dispatch_id AS accepted_dispatch_id, a.request_hash AS accepted_request_hash
         FROM ${schema}.operation_checkpoints c
         JOIN ${schema}.operations o ON o.operation_id=c.operation_id
         LEFT JOIN ${schema}.accepted_evidence a ON a.operation_id=c.operation_id
         WHERE c.attempt_id=$1 ORDER BY a.accepted_at DESC LIMIT 1`,
        [attemptId],
      );
      const row = selected.rows[0] as Record<string, unknown> | undefined;
      if (!row) return null;
      return {
        checkpoint: checkpoint(row),
        ...(row.accepted_dispatch_id == null
          ? {}
          : {
              accepted: {
                protocolVersion: String(row.protocol_version) as `${number}.${number}`,
                kind: "host.accepted" as const,
                payload: {
                  operationId: String(row.operation_id),
                  dispatchId: String(row.accepted_dispatch_id),
                  requestHash: String(row.accepted_request_hash),
                },
              },
            }),
        ...(row.terminal_result == null ? {} : { result: structuredClone(row.terminal_result) as HostResultMessage }),
      };
    },
    async acceptedEvidence() {
      await ready;
      const selected = await pool.query(`SELECT * FROM ${schema}.accepted_evidence ORDER BY accepted_at, operation_id`);
      return selected.rows.map((row): DesktopBrowserRelayAcceptedEvidence => ({
        protocolVersion: String(row.protocol_version) as `${number}.${number}`,
        operationId: String(row.operation_id),
        dispatchId: String(row.dispatch_id),
        requestHash: String(row.request_hash),
        acceptedAt: Number(row.accepted_at),
      }));
    },
    async terminalEvidence() {
      await ready;
      const selected = await pool.query(`SELECT * FROM ${schema}.terminal_evidence ORDER BY terminal_at, operation_id`);
      return selected.rows.map((row): DesktopBrowserRelayTerminalEvidence => ({
        operationId: String(row.operation_id),
        dispatchId: String(row.dispatch_id),
        resultHash: String(row.result_hash),
        outcome: row.outcome as DesktopBrowserRelayTerminalEvidence["outcome"],
        result: structuredClone(row.result) as HostResultMessage,
        terminalAt: Number(row.terminal_at),
      }));
    },
    async pendingCallbacks() {
      await ready;
      const selected = await pool.query(
        `SELECT * FROM ${schema}.callback_outbox WHERE delivered_at IS NULL AND dead_lettered_at IS NULL ORDER BY created_at, operation_id`,
      );
      return selected.rows.map((row) => callback(row as Record<string, unknown>));
    },
    async deadLetters() {
      await ready;
      const selected = await pool.query(
        `SELECT * FROM ${schema}.callback_outbox WHERE delivered_at IS NULL AND dead_lettered_at IS NOT NULL ORDER BY dead_lettered_at, operation_id`,
      );
      return selected.rows.map((row) => callback(row as Record<string, unknown>));
    },
    async claimCallbacks(owner, limit, leaseMs) {
      await ready;
      if (!owner || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(leaseMs) || leaseMs < 1) {
        throw new Error("desktop browser Relay callback claim bounds are invalid");
      }
      return runTransaction(async (client) => {
        const at = now();
        const selected = await client.query(
          `WITH candidates AS (
             SELECT operation_id, callback_type FROM ${schema}.callback_outbox
             WHERE delivered_at IS NULL AND dead_lettered_at IS NULL AND next_attempt_at <= $1
               AND (claim_expires_at IS NULL OR claim_expires_at <= $1)
             ORDER BY created_at, operation_id FOR UPDATE SKIP LOCKED LIMIT $2
           )
           UPDATE ${schema}.callback_outbox o SET claim_owner=$3, claim_expires_at=$4, attempts=o.attempts+1
           FROM candidates c WHERE o.operation_id=c.operation_id AND o.callback_type=c.callback_type RETURNING o.*`,
          [at, limit, owner, at + leaseMs],
        );
        return selected.rows.map((row) => callback(row as Record<string, unknown>));
      });
    },
    async releaseCallback(operationId, callbackType, owner, retryAt, deadLetter) {
      await ready;
      const updated = await pool.query(
        `UPDATE ${schema}.callback_outbox SET claim_owner=NULL, claim_expires_at=NULL, next_attempt_at=$4,
           dead_lettered_at=CASE WHEN $5 THEN $6 ELSE dead_lettered_at END
         WHERE operation_id=$1 AND callback_type=$2 AND claim_owner=$3`,
        [operationId, callbackType, owner, retryAt, deadLetter, now()],
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error("desktop browser Relay callback claim does not match");
    },
    async markCallbackDelivered(operationId, callbackType, owner) {
      await ready;
      const params: unknown[] = [operationId, callbackType, now()];
      const ownerClause = owner === undefined ? "" : ` AND claim_owner=$${params.push(owner)}`;
      const updated = await pool.query(
        `UPDATE ${schema}.callback_outbox SET delivered_at=$3, claim_owner=NULL, claim_expires_at=NULL
         WHERE operation_id=$1 AND callback_type=$2 AND delivered_at IS NULL${ownerClause}`,
        params,
      );
      if ((updated.rowCount ?? 0) === 0 && owner !== undefined) {
        throw new Error("desktop browser Relay callback claim does not match");
      }
    },
    async check() {
      await ready;
      await pool.query(`SELECT 1 FROM ${schema}.operation_checkpoints LIMIT 1`);
      await pool.query(`SELECT 1 FROM ${schema}.connection_owners LIMIT 1`);
    },
    async close() {
      await ready.catch(() => undefined);
      await pool.end();
    },
  };
}

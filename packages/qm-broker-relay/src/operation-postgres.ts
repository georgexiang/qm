import pg, { type PoolClient } from "pg";
import { createHash } from "node:crypto";
import type { HostAcceptedMessage, HostResultMessage, RelayInvocationMessage } from "qm-desktop-browser-contracts";
import type {
  DesktopBrowserRelayAcceptedEvidence,
  DesktopBrowserRelayCallbackOutboxEntry,
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
      protocol_version TEXT NOT NULL, operation_sequence BIGINT NOT NULL, request_hash TEXT NOT NULL,
      dispatch_id TEXT, state TEXT NOT NULL, result_hash TEXT, terminal_result JSONB
    )`,
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

  const getOperation = async (client: PoolClient, operationId: string) => {
    const selected = await client.query(`SELECT * FROM ${schema}.operations WHERE operation_id = $1 FOR UPDATE`, [
      operationId,
    ]);
    const row = selected.rows[0] as Record<string, unknown> | undefined;
    if (!row) throw new Error("desktop browser Relay operation not found");
    return row;
  };

  return {
    async prepare(invocation) {
      await ready;
      return transaction(pool, async (client) => {
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
            `SELECT operation_sequence FROM ${schema}.operations WHERE operation_id = $1`,
            [current.operation_id],
          );
          if (
            !["terminal", "accepted_unknown"].includes(String(current.state)) ||
            authority.operationSequence <= Number(previous.rows[0]?.operation_sequence)
          ) {
            throw new Error("desktop browser Relay Attempt already has a different current operation");
          }
        }
        await client.query(
          `INSERT INTO ${schema}.operations(operation_id, attempt_id, task_id, protocol_version, operation_sequence, request_hash, state)
           VALUES ($1,$2,$3,$4,$5,$6,'prepared')`,
          [
            authority.operationId,
            authority.attemptId,
            authority.taskId,
            invocation.protocolVersion,
            authority.operationSequence,
            invocation.payload.requestHash,
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
    async markDeliveryStarted(attemptId, dispatchId) {
      await ready;
      return transaction(pool, async (client) => {
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
      return transaction(pool, async (client) => {
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
      return transaction(pool, async (client) => {
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
      return transaction(pool, async (client) => {
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
    async recordTerminal(message) {
      await ready;
      return transaction(pool, async (client) => {
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
      return transaction(pool, async (client) => {
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
    },
    async close() {
      await ready.catch(() => undefined);
      await pool.end();
    },
  };
}

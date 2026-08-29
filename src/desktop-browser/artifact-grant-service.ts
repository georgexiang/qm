import { createHash, randomBytes } from "node:crypto";
import { posix } from "node:path";
import type {
  DesktopBrowserArtifactIntent,
  DesktopBrowserArtifactReference,
  RelayArtifactGrantMessage,
} from "qm-desktop-browser-contracts";
import { DESKTOP_BROWSER_MAX_ARTIFACT_BYTES } from "qm-desktop-browser-contracts";
import { artifactPath, fileArtifactId, type FileArtifact, type FileArtifactStore } from "../files/file-artifact-store.ts";
import type { DurableByteStore } from "../files/durable-byte-store.ts";
import { POSTGRES_FILE_ARTIFACT_SCHEMA } from "../files/postgres-file-artifact-store.ts";
import { jsonbStringify, type DurableMap } from "../persistence/durable-map.ts";
import { type PgPool, withPgTransaction } from "../persistence/pg-pool.ts";
import { projectScopeId } from "../projects/project-store.ts";
import { collectBytes, type ByteSource } from "../util/bytes.ts";

export interface DesktopBrowserArtifactGrantRecord {
  tokenHash: string;
  intent: DesktopBrowserArtifactIntent;
  status: "issued" | "redeeming" | "redeemed" | "failed";
  issuedAt: number;
  expiresAt: number;
  artifactId?: string;
}

type IntentValidation = { status: "ok" } | { status: "refused"; reason: string };

interface ArtifactCommitInput {
  tokenHash: string;
  record: DesktopBrowserArtifactGrantRecord;
  artifactId: string;
  name: string;
  data: Buffer;
  at: number;
}

export type DesktopBrowserArtifactRedemptionCommitter = (input: ArtifactCommitInput) => Promise<FileArtifact>;

export interface DesktopBrowserArtifactGrantService {
  issue(
    intent: DesktopBrowserArtifactIntent,
    uploadUrl: string,
  ): Promise<
    | { status: "ok"; grant: RelayArtifactGrantMessage["payload"] }
    | { status: "refused"; reason: string }
  >;
  redeem(input: {
    bearerToken: string;
    deviceId: string;
    contentType: string;
    data: ByteSource;
  }): Promise<{ status: "ok"; artifact: FileArtifact; reference: DesktopBrowserArtifactReference } | { status: "refused"; reason: string }>;
  records(): Promise<DesktopBrowserArtifactGrantRecord[]>;
}

export function createDesktopBrowserArtifactGrantService(options: {
  grants: DurableMap<DesktopBrowserArtifactGrantRecord>;
  files: FileArtifactStore;
  validateIntent: (intent: DesktopBrowserArtifactIntent) => Promise<IntentValidation>;
  now?: () => number;
  token?: () => string;
  ttlMs?: number;
  commitRedemption?: DesktopBrowserArtifactRedemptionCommitter;
}): DesktopBrowserArtifactGrantService {
  const now = options.now ?? Date.now;
  const token = options.token ?? (() => randomBytes(32).toString("base64url"));
  const ttlMs = options.ttlMs ?? 60_000;
  const tokenHash = (value: string): string => createHash("sha256").update(value).digest("hex");

  return {
    async issue(intent, uploadUrl) {
      if (
        intent.sizeBytes < 1 ||
        intent.sizeBytes > DESKTOP_BROWSER_MAX_ARTIFACT_BYTES ||
        !/^[0-9a-f]{64}$/.test(intent.expectedSha256) ||
        !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(intent.contentType) ||
        posix.basename(intent.name) !== intent.name ||
        Buffer.byteLength(intent.name, "utf8") > 255
      ) {
        return { status: "refused", reason: "Artifact intent metadata is invalid" };
      }
      const validation = await options.validateIntent(intent);
      if (validation.status === "refused") return validation;
      const bearerToken = token();
      if (Buffer.byteLength(bearerToken, "utf8") < 43) {
        return { status: "refused", reason: "Artifact grant entropy is insufficient" };
      }
      const issuedAt = now();
      const expiresAt = Math.min(issuedAt + ttlMs, Date.parse(intent.leaseExpiresAt));
      if (!Number.isFinite(expiresAt) || expiresAt <= issuedAt) {
        return { status: "refused", reason: "Artifact grant Lease has expired" };
      }
      const hash = tokenHash(bearerToken);
      const inserted = await options.grants.insertIfAbsent?.(hash, {
        tokenHash: hash,
        intent: structuredClone(intent),
        status: "issued",
        issuedAt,
        expiresAt,
      });
      if (inserted !== true) return { status: "refused", reason: "Artifact grant could not be issued" };
      return {
        status: "ok",
        grant: {
          artifactIntentId: intent.artifactIntentId,
          operationId: intent.operationId,
          uploadUrl,
          bearerToken,
          expiresAt: new Date(expiresAt).toISOString(),
        },
      };
    },

    async redeem(input) {
      if (!options.grants.update) throw new Error("desktop browser artifact grants require atomic updates");
      const hash = tokenHash(input.bearerToken);
      let claimed: DesktopBrowserArtifactGrantRecord | null = null;
      await options.grants.update(hash, (current) => {
        if (current.status !== "issued" || current.expiresAt <= now()) return current;
        claimed = { ...current, status: "redeeming" };
        return claimed;
      });
      if (!claimed) return { status: "refused", reason: "Artifact grant is not redeemable" };
      const record: DesktopBrowserArtifactGrantRecord = claimed;
      const fail = async (reason: string) => {
        await options.grants.update!(hash, (current) =>
          current.status === "redeeming" ? { ...current, status: "failed" } : current,
        );
        return { status: "refused" as const, reason };
      };
      if (input.deviceId !== record.intent.deviceId) return fail("Artifact grant Device does not match");
      if (input.contentType !== record.intent.contentType) return fail("Artifact content type does not match");
      let collected;
      try {
        collected = await collectBytes(input.data, { maxBytes: record.intent.sizeBytes });
      } catch {
        return fail("Artifact upload size does not match");
      }
      if (collected.sizeBytes !== record.intent.sizeBytes) return fail("Artifact upload size does not match");
      if (collected.sha256 !== record.intent.expectedSha256) return fail("Artifact upload hash does not match");
      if (record.expiresAt <= now()) return fail("Artifact grant expired during upload");
      const artifactId = fileArtifactId(
        `${record.intent.taskId}:${record.intent.attemptId}:${record.intent.operationId}:${record.intent.artifactIntentId}:${hash}`,
        "out",
        0,
      );
      const name = posix.basename(record.intent.name);
      const project = projectScopeId(record.intent.projectId);
      let artifact: FileArtifact;
      try {
        if (options.commitRedemption) {
          artifact = await options.commitRedemption({
            tokenHash: hash,
            record,
            artifactId,
            name,
            data: collected.data,
            at: now(),
          });
        } else {
          const stored = await options.files.put({
            id: artifactId,
            ownerScopeId: project,
            createdBy: record.intent.actorId,
            name,
            path: artifactPath(artifactId, name),
            mimetype: record.intent.contentType,
            data: collected.data,
            direction: "out",
            createdInScope: project,
            createdAt: now(),
            maxBytes: record.intent.sizeBytes,
          });
          artifact = stored.artifact;
          await options.grants.update(hash, (current) =>
            current.status === "redeeming" ? { ...current, status: "redeemed", artifactId } : current,
          );
        }
      } catch {
        return fail("Artifact redemption could not be committed");
      }
      return {
        status: "ok",
        artifact,
        reference: {
          artifactId: artifact.id,
          name: artifact.name,
          contentType: artifact.mimetype,
          sizeBytes: artifact.sizeBytes,
          sha256: artifact.sha256!,
        },
      };
    },

    records: () => options.grants.all(),
  };
}

export function createPostgresDesktopBrowserArtifactRedemptionCommitter(options: {
  pg: PgPool;
  bytes: DurableByteStore;
}): DesktopBrowserArtifactRedemptionCommitter {
  let ready: Promise<void> | null = null;
  const ensureSchema = () =>
    (ready ??= (async () => {
      for (const statement of POSTGRES_FILE_ARTIFACT_SCHEMA) await options.pg.schema?.(statement);
    })());
  return async ({ tokenHash, record, artifactId, name, data, at }) => {
    await ensureSchema();
    const blob = await options.bytes.put(data, { maxBytes: record.intent.sizeBytes });
    const project = projectScopeId(record.intent.projectId);
    const artifact: FileArtifact = {
      id: artifactId,
      ownerScopeId: project,
      createdBy: record.intent.actorId,
      name,
      path: artifactPath(artifactId, name),
      mimetype: record.intent.contentType,
      sizeBytes: blob.sizeBytes,
      blobKey: blob.blobKey,
      sha256: blob.sha256,
      direction: "out",
      source: "live",
      createdInScope: project,
      createdAt: at,
      updatedAt: at,
      enabled: true,
    };
    const pool = await options.pg.pool();
    await withPgTransaction(pool, async (client) => {
      const selected = await client.query(
        "SELECT json FROM desktop_browser_artifact_grants WHERE id = $1 FOR UPDATE",
        [tokenHash],
      );
      const current = selected.rows[0]?.json as DesktopBrowserArtifactGrantRecord | undefined;
      if (!current || current.status !== "redeeming") throw new Error("Artifact grant is not redeeming");
      const commitTime = Date.now();
      if (current.expiresAt <= commitTime || Date.parse(current.intent.leaseExpiresAt) <= commitTime) {
        throw new Error("Artifact grant expired before commit");
      }
      await client.query(
        `INSERT INTO file_artifacts
           (id, kind, owner_scope_id, path, name, mimetype, size_bytes, blob_key, sha256,
            direction, created_by, created_in_scope, created_at, updated_at, enabled, source)
         VALUES ($1,'file',$2,$3,$4,$5,$6,$7,$8,'out',$9,$10,$11,$11,TRUE,'live')`,
        [
          artifact.id,
          artifact.ownerScopeId,
          artifact.path,
          artifact.name,
          artifact.mimetype,
          artifact.sizeBytes,
          artifact.blobKey,
          artifact.sha256,
          artifact.createdBy,
          artifact.createdInScope,
          artifact.createdAt,
        ],
      );
      await client.query("UPDATE desktop_browser_artifact_grants SET json = $2::jsonb WHERE id = $1", [
        tokenHash,
        jsonbStringify({ ...current, status: "redeemed", artifactId }),
      ]);
      await client.query(
        `INSERT INTO durable_map_versions (tbl, v) VALUES ('desktop_browser_artifact_grants', 1)
         ON CONFLICT (tbl) DO UPDATE SET v = durable_map_versions.v + 1`,
      );
    });
    return artifact;
  };
}
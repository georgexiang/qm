import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BLOB_TRANSFER_AUD,
  CAPABILITY_TTL_MS,
  mintCapabilityToken,
  verifyBlobTransferCapability,
  verifyCapabilityToken,
  verifyRetainedAuthorityCapability,
  type CapabilityClaims,
} from "../src/auth/capability-token.ts";

const SECRET = "test-signing-secret";
const claims = (over: Partial<CapabilityClaims> = {}): CapabilityClaims => ({
  actorId: "U1",
  scopeId: "personal:U1",
  destination: { type: "slack", target: "D123", audienceScopeId: "personal:U1" },
  exp: Date.now() + CAPABILITY_TTL_MS,
  ...over,
});

test("mint → verify round-trips the claims", async () => {
  const c = claims();
  const got = await verifyCapabilityToken(await mintCapabilityToken(c, SECRET), SECRET);
  assert.deepEqual(got, { orgId: "default-org", ...c });
});

test("grants round-trip and reject malformed claims", async () => {
  const granted = claims({ grants: ["admin.sessions.read"] });
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(granted, SECRET), SECRET), {
    orgId: "default-org",
    ...granted,
  });
  for (const grants of ["admin.sessions.read", ["admin.sessions.read", 1]]) {
    assert.equal(
      await verifyCapabilityToken(
        await mintCapabilityToken(claims({ grants } as unknown as Partial<CapabilityClaims>), SECRET),
        SECRET,
      ),
      null,
    );
  }
});

test("timezone claims must be valid IANA timezone strings", async () => {
  const c = claims({ timezone: "America/Los_Angeles" });
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(c, SECRET), SECRET), {
    orgId: "default-org",
    ...c,
  });

  for (const timezone of ["", " America/Los_Angeles ", "not-a-zone", "x".repeat(65), 12]) {
    assert.equal(
      await verifyCapabilityToken(
        await mintCapabilityToken(claims({ timezone } as Partial<CapabilityClaims>), SECRET),
        SECRET,
      ),
      null,
    );
  }
});

test("scope authorization metadata is type-checked", async () => {
  assert.ok(await verifyCapabilityToken(await mintCapabilityToken(claims({ scopeVersion: "42" }), SECRET), SECRET));
  assert.equal(
    await verifyCapabilityToken(
      await mintCapabilityToken(claims({ scopeVersion: 42 } as unknown as Partial<CapabilityClaims>), SECRET),
      SECRET,
    ),
    null,
  );
});

test("authority lineage round-trips and rejects malformed fields", async () => {
  const lineage = {
    authorityId: "auth-123",
    sessionId: "session-123",
    turnId: "turn-123",
    runId: "run-123",
  };
  const valid = claims(lineage as unknown as Partial<CapabilityClaims>);
  assert.deepEqual(await verifyCapabilityToken(await mintCapabilityToken(valid, SECRET), SECRET), {
    orgId: "default-org",
    ...valid,
  });

  for (const [field, value] of [
    ["authorityId", 1],
    ["authorityId", ""],
    ["sessionId", []],
    ["turnId", {}],
    ["runId", false],
  ] as const) {
    assert.equal(
      await verifyCapabilityToken(
        await mintCapabilityToken(
          claims({ ...lineage, [field]: value } as unknown as Partial<CapabilityClaims>),
          SECRET,
        ),
        SECRET,
      ),
      null,
      `${field} must be a string`,
    );
  }

  for (const partial of [
    { authorityId: lineage.authorityId },
    { sessionId: lineage.sessionId },
    { turnId: lineage.turnId },
    { ...lineage, sessionId: undefined },
  ]) {
    const token = await mintCapabilityToken(claims(partial as Partial<CapabilityClaims>), SECRET);
    assert.ok(await verifyCapabilityToken(token, SECRET), "generic audiences accept typed optional lineage");
    assert.equal(await verifyRetainedAuthorityCapability(token, SECRET), null);
  }

  assert.equal(await verifyRetainedAuthorityCapability(await mintCapabilityToken(claims(), SECRET), SECRET), null);
  const withoutRun = claims({ authorityId: "auth-123", sessionId: "session-123", turnId: "turn-123" });
  assert.deepEqual(await verifyRetainedAuthorityCapability(await mintCapabilityToken(withoutRun, SECRET), SECRET), {
    orgId: "default-org",
    ...withoutRun,
  });
});

test("a tampered payload fails verification", async () => {
  const token = await mintCapabilityToken(claims(), SECRET);
  const [header, payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify(claims({ actorId: "U2" })), "utf8").toString("base64url");
  assert.equal(await verifyCapabilityToken(`${header}.${forged}.${sig}`, SECRET), null);
  const tamperedSignature = Buffer.from(sig!, "base64url");
  tamperedSignature[0] = tamperedSignature[0]! ^ 1;
  assert.equal(
    await verifyCapabilityToken(`${header}.${payload}.${tamperedSignature.toString("base64url")}`, SECRET),
    null,
  );
});

test("the wrong secret fails verification", async () => {
  assert.equal(await verifyCapabilityToken(await mintCapabilityToken(claims(), SECRET), "other-secret"), null);
});

test("an expired token fails closed", async () => {
  assert.equal(
    await verifyCapabilityToken(await mintCapabilityToken(claims({ exp: Date.now() - 1 }), SECRET), SECRET),
    null,
  );
});

test("malformed tokens return null, not throw", async () => {
  for (const t of ["not-a-token", "", ".", "YQ.deadbeef"]) assert.equal(await verifyCapabilityToken(t, SECRET), null);
});

test("blob-transfer verification enforces its audience-specific grant", async () => {
  const id = "a".repeat(32);
  const read = await mintCapabilityToken(claims({ aud: BLOB_TRANSFER_AUD, blob: { dir: "read", id } }), SECRET);
  assert.ok(await verifyBlobTransferCapability(read, SECRET, { dir: "read", id }));
  assert.equal(await verifyBlobTransferCapability(read, SECRET, { dir: "read", id: "b".repeat(32) }), null);
  assert.equal(await verifyBlobTransferCapability(read, SECRET, { dir: "write" }), null);

  const malformed = await mintCapabilityToken(
    claims({ aud: BLOB_TRANSFER_AUD, blob: { dir: "read", id: "../etc/passwd" } }),
    SECRET,
  );
  assert.equal(await verifyBlobTransferCapability(malformed, SECRET, { dir: "read", id: "../etc/passwd" }), null);

  const write = await mintCapabilityToken(claims({ aud: BLOB_TRANSFER_AUD, blob: { dir: "write" } }), SECRET);
  assert.ok(await verifyBlobTransferCapability(write, SECRET, { dir: "write" }));
  assert.equal(
    await verifyBlobTransferCapability(await mintCapabilityToken(claims({ blob: { dir: "write" } }), SECRET), SECRET, {
      dir: "write",
    }),
    null,
  );
});

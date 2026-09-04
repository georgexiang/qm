import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildApp, type BuiltApp } from "../src/wiring.ts";
import { createServer } from "../src/api/server.ts";
import { mintCapabilityToken, CAPABILITY_TTL_MS } from "../src/auth/capability-token.ts";
import { testConfig } from "./support/test-config.ts";

const SECRET = "directory-resolve-secret".repeat(3);

describe("GET /v1/directory/resolve (agent looks up a teammate's mention id)", async () => {
  let server: Server;
  let base: string;
  let built: BuiltApp;

  const cap = await mintCapabilityToken(
    { actorId: "U1", scopeId: "personal:U1", exp: Date.now() + CAPABILITY_TTL_MS },
    SECRET,
  );

  before(async () => {
    built = buildApp(testConfig({ dataDir: mkdtempSync(join(tmpdir(), "dir-resolve-")), signingSecret: SECRET }));
    server = createServer(built.app, {
      signingSecret: SECRET,
      scheduler: built.scheduler,
      identity: built.identity,
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    base = `http://localhost:${(server.address() as AddressInfo).port}`;
    await built.app.upsertDirectory([
      { principalId: "carol@acme.com", displayName: "Carol Example", type: "internal", slackId: "U0CAROL" },
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U0ALICE" },
      { principalId: "jordan@acme.com", displayName: "Jordan", type: "internal", slackId: "U0JORDAN" },
      { principalId: "joan@acme.com", displayName: "Joan", type: "internal", slackId: "U0JOAN" },
    ]);
  });

  after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const get = (path: string) => fetch(`${base}${path}`, { headers: { "x-agent-capability": cap } });

  it("resolves a name to a single match carrying the slackId needed to @-mention", async () => {
    const res = await get("/v1/directory/resolve?q=carol");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string; slackId?: string }> };
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.principalId, "carol@acme.com");
    assert.equal(matches[0]!.slackId, "U0CAROL");
  });

  it("resolves an Entra profile by email when the Slack directory has no match", async () => {
    const principalId = "entra:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    await built.identity.upsertProfile(principalId, "old@example.com", 100);
    await built.identity.upsertProfile(principalId, "alex@example.com", 200);
    for (const query of ["alex%40example.com", "old%40example.com"]) {
      const res = await get(`/v1/directory/resolve?q=${query}`);
      assert.equal(res.status, 200);
      const { matches } = (await res.json()) as {
        matches: Array<{ principalId: string; displayName: string; type: string; slackId?: string }>;
      };
      assert.deepEqual(matches, [{ principalId, displayName: "alex@example.com", type: "internal" }]);
    }
  });

  it("prefers the stable Entra principal when a Slack row has the same email", async () => {
    const principalId = "entra:11111111-1111-4111-8111-111111111111:22222222-2222-4222-8222-222222222222";
    await built.app.upsertDirectory([
      { principalId: "alex@example.com", displayName: "Alex Example", type: "internal" },
    ]);
    for (const query of ["alex%40example.com", "Alex%20Example", "alex"]) {
      const res = await get(`/v1/directory/resolve?q=${query}`);
      assert.equal(res.status, 200);
      const { matches } = (await res.json()) as { matches: Array<{ principalId: string; displayName: string }> };
      assert.deepEqual(matches, [{ principalId, displayName: "alex@example.com", type: "internal" }]);
    }
  });

  it("does not offer a deactivated Entra profile", async () => {
    const principalId = "entra:11111111-1111-4111-8111-111111111111:00000000-0000-4000-8000-000000000001";
    await built.identity.upsertProfile(principalId, "former.user@example.com");
    await built.identity.deactivate(principalId);
    await built.app.upsertDirectory([
      { principalId: "former.user@example.com", displayName: "Former User", type: "internal" },
    ]);
    for (const query of ["former.user%40example.com", "Former%20User", "former.user"]) {
      const res = await get(`/v1/directory/resolve?q=${query}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { matches: [] });
    }
  });

  it("recovers the mention id from the principal id in slack-id identity mode (no slackId field)", async () => {
    await built.app.upsertDirectory([{ principalId: "U0SLACKID", displayName: "Morgan", type: "internal" }]);
    const res = await get("/v1/directory/resolve?q=Morgan");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string; slackId?: string }> };
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.slackId, "U0SLACKID");
    await built.app.upsertDirectory([
      { principalId: "carol@acme.com", displayName: "Carol Example", type: "internal", slackId: "U0CAROL" },
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U0ALICE" },
      { principalId: "jordan@acme.com", displayName: "Jordan", type: "internal", slackId: "U0JORDAN" },
      { principalId: "joan@acme.com", displayName: "Joan", type: "internal", slackId: "U0JOAN" },
    ]);
  });

  it("does not fabricate a mention id from a principal id that isn't Slack-id-shaped", async () => {
    await built.app.upsertDirectory([{ principalId: "USER123", displayName: "Pat", type: "internal" }]);
    const res = await get("/v1/directory/resolve?q=Pat");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string; slackId?: string }> };
    assert.equal(matches.length, 1);
    assert.equal(matches[0]!.slackId, undefined, "a too-short id (U+6) must not be mistaken for a mention handle");
    await built.app.upsertDirectory([
      { principalId: "carol@acme.com", displayName: "Carol Example", type: "internal", slackId: "U0CAROL" },
      { principalId: "alice@acme.com", displayName: "Alice", type: "internal", slackId: "U0ALICE" },
      { principalId: "jordan@acme.com", displayName: "Jordan", type: "internal", slackId: "U0JORDAN" },
      { principalId: "joan@acme.com", displayName: "Joan", type: "internal", slackId: "U0JOAN" },
    ]);
  });

  it("returns the candidate set for an ambiguous prefix", async () => {
    const res = await get("/v1/directory/resolve?q=jo");
    assert.equal(res.status, 200);
    const { matches } = (await res.json()) as { matches: Array<{ principalId: string }> };
    assert.ok(matches.length >= 2, "an ambiguous prefix returns multiple candidates");
    assert.ok(matches.every((m) => m.principalId));
  });

  it("returns an empty match set for an unknown name (agent falls back to plain text)", async () => {
    const res = await get("/v1/directory/resolve?q=nobody-here");
    assert.equal(res.status, 200);
    assert.deepEqual((await res.json()) as { matches: unknown[] }, { matches: [] });
  });

  it("rejects a missing query with 400", async () => {
    const res = await get("/v1/directory/resolve");
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: string }).error, "bad_request");
  });

  it("rejects a request without a capability token (gated like the rest of the agent API)", async () => {
    const res = await fetch(`${base}/v1/directory/resolve?q=carol`);
    assert.equal(res.status, 401);
  });
});

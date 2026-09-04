import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import type { AddressInfo } from "node:net";
import { exportJWK, SignJWT } from "jose";
import { verifyPortalIdentity } from "../../chassis/src/portal-identity.ts";

const PUBLIC = "http://portal.test";
process.env.PORTAL_PUBLIC_URL = PUBLIC;
process.env.PORTAL_BRAND_NAME = "Acme";
process.env.PORTAL_SESSION_SECRET = "multi-provider-portal-secret";
process.env.CORE_SIGNING_SECRET = "multi-provider-core-secret";
process.env.PORTAL_IDENTITY_SECRET = "multi-provider-identity-secret";
process.env.OIDC_CLIENT_ID = "qm-portal";
process.env.OIDC_CLIENT_SECRET = "broker-client-secret";
process.env.ENTRA_OIDC_TENANT_ID = "16b3c013-d300-468d-ac64-7eda0820b6d3";
process.env.ENTRA_OIDC_CLIENT_ID = "16686705-c414-45c4-bd29-94fd67c128bd";
process.env.ENTRA_OIDC_CLIENT_AUTH_METHOD = "client_secret";
process.env.ENTRA_OIDC_CLIENT_SECRET = "rotated-entra-secret-value";
process.env.ENTRA_OIDC_CLIENT_ASSERTION_JWK = "dormant-invalid-jwk";

const { isPrivateNetworkUrl, server } = await import("../src/index.ts");
const { deriveKey, open } = await import("../src/session.ts");
await new Promise<void>((resolve) => server.listen(0, resolve));
const base = `http://localhost:${(server.address() as AddressInfo).port}`;
const tmpKey = deriveKey("multi-provider-portal-secret", "portal.tmp.v1");
const sessionKey = deriveKey("multi-provider-portal-secret", "portal.session.v1");

test.after(() => server.close());

test("the built-in Docker auth service is treated as private", () => {
  assert.equal(isPrivateNetworkUrl("http://auth:8080/token"), true);
});

function providerFrom(response: Response): string | undefined {
  const cookie = response.headers.get("set-cookie") ?? "";
  const token = /portal_oidc_tmp=([^;]+)/.exec(cookie)?.[1] ?? "";
  return open(decodeURIComponent(token), tmpKey)?.provider as string | undefined;
}

test("dual-provider login offers Entra and email with provider-bound authorization requests", async () => {
  const choice = await fetch(`${base}/auth/login?returnTo=/web-ui/`, { redirect: "manual" });
  assert.equal(choice.status, 200);
  const html = await choice.text();
  assert.match(html, /Sign in to Acme/);
  assert.match(html, /Continue with Microsoft Entra ID/);
  assert.match(html, /Administrator email link/);

  const entra = await fetch(`${base}/auth/login/entra?returnTo=/web-ui/`, { redirect: "manual" });
  assert.equal(entra.status, 302);
  const entraLocation = new URL(entra.headers.get("location") ?? "");
  assert.equal(
    entraLocation.origin + entraLocation.pathname,
    "https://login.microsoftonline.com/16b3c013-d300-468d-ac64-7eda0820b6d3/oauth2/v2.0/authorize",
  );
  assert.equal(providerFrom(entra), "entra");

  const email = await fetch(`${base}/auth/login/email?returnTo=/web-ui/`, { redirect: "manual" });
  assert.equal(email.status, 302);
  const emailLocation = new URL(email.headers.get("location") ?? "");
  assert.equal(emailLocation.origin + emailLocation.pathname, "https://slack.com/openid/connect/authorize");
  assert.equal(providerFrom(email), "email");
});

test("environment-configured Entra callback exchanges and verifies tokens with the selected client auth mode", async () => {
  const login = await fetch(`${base}/auth/login/entra`, { redirect: "manual" });
  const authorize = new URL(login.headers.get("location") ?? "");
  const state = authorize.searchParams.get("state") ?? "";
  const nonce = authorize.searchParams.get("nonce") ?? "";
  const tmp = /portal_oidc_tmp=([^;]+)/.exec(login.headers.get("set-cookie") ?? "")?.[1] ?? "";
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicJwk = { ...(await exportJWK(publicKey)), kid: "entra-key", alg: "EdDSA", use: "sig" };
  const idToken = await new SignJWT({
    nonce,
    tid: "16b3c013-d300-468d-ac64-7eda0820b6d3",
    oid: "a67c5962-20f5-42c8-8384-c00000000000",
    email: "Entra.User@Example.com",
  })
    .setProtectedHeader({ alg: "EdDSA", kid: "entra-key" })
    .setIssuer("https://login.microsoftonline.com/16b3c013-d300-468d-ac64-7eda0820b6d3/v2.0")
    .setAudience("16686705-c414-45c4-bd29-94fd67c128bd")
    .setSubject("entra-subject")
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  const originalFetch = globalThis.fetch;
  const claimed = new Set<string>();
  let tokenAuthorization = "";
  let tokenBody = "";
  let profileIdentity = "";
  let profileAttempts = 0;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
    if (url.origin === new URL(base).origin) return originalFetch(input, init);
    if (url.pathname === "/v1/auth/broker/claim") {
      const ids = (JSON.parse(String(init?.body)) as { ids: string[] }).ids;
      const first = ids.find((id) => !claimed.has(id));
      if (first) claimed.add(first);
      return new Response(JSON.stringify({ claimed: first ?? null }), { status: 200 });
    }
    if (url.pathname === "/v1/principal-profile") {
      profileAttempts++;
      profileIdentity = (init?.headers as Record<string, string>)["x-portal-identity"] ?? "";
      if (profileAttempts === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
        });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }
    if (url.pathname.endsWith("/oauth2/v2.0/token")) {
      tokenAuthorization = (init?.headers as Record<string, string>).authorization ?? "";
      tokenBody = String(init?.body);
      return new Response(JSON.stringify({ access_token: "ENTRA_AT", id_token: idToken }), { status: 200 });
    }
    if (url.pathname.endsWith("/discovery/v2.0/keys")) {
      return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 });
    }
    if (url.origin === "https://graph.microsoft.com" && url.pathname === "/oidc/userinfo") {
      return new Response(JSON.stringify({ sub: "entra-subject", name: "Entra User" }), { status: 200 });
    }
    throw new Error(`unexpected fetch ${url}`);
  }) as typeof fetch;
  try {
    const callbackStartedAt = Date.now();
    const response = await fetch(`${base}/auth/callback?code=ENTRA_CODE&state=${encodeURIComponent(state)}`, {
      headers: { cookie: `portal_oidc_tmp=${tmp}` },
      redirect: "manual",
    });
    assert.equal(response.status, 302);
    assert.ok(Date.now() - callbackStartedAt < 1_000, "a stalled profile write must not stall Entra login");
    assert.equal(
      tokenAuthorization,
      `Basic ${Buffer.from("16686705-c414-45c4-bd29-94fd67c128bd:rotated-entra-secret-value").toString("base64")}`,
    );
    const body = new URLSearchParams(tokenBody);
    assert.equal(body.get("client_assertion"), null);
    assert.equal(body.get("client_assertion_type"), null);
    const session = /portal_session=([^;]+)/.exec(response.headers.get("set-cookie") ?? "")?.[1] ?? "";
    assert.equal(
      open(decodeURIComponent(session), sessionKey)?.sub,
      "entra:16b3c013-d300-468d-ac64-7eda0820b6d3:a67c5962-20f5-42c8-8384-c00000000000",
    );
    assert.equal(
      verifyPortalIdentity(profileIdentity, "multi-provider-identity-secret", Date.now())?.p,
      "entra:16b3c013-d300-468d-ac64-7eda0820b6d3:a67c5962-20f5-42c8-8384-c00000000000",
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    assert.equal(profileAttempts, 2, "a transient profile failure is retried without blocking login");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

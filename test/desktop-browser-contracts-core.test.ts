import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { test } from "node:test";
import {
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  decodeDesktopBrowserMessage,
  desktopBrowserMessageSchemas,
  encodeHostChallengeResponseSigningBytes,
  encodeDesktopBrowserMessage,
  verifyHostChallengeResponseMessage,
  isDesktopBrowserProtocolCompatible,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserRelayRegistryBinding,
  type DesktopBrowserMessage,
} from "qm-desktop-browser-contracts";

test("Core advertises Ticket 05 before the legacy handshake protocol", () => {
  assert.deepEqual([...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS], ["1.2", "1.0"]);
});

test("Core round-trips a versioned authority message through the public contract", () => {
  const message: DesktopBrowserMessage = {
    protocolVersion: "1.0",
    kind: "core.authority",
    payload: {
      requestId: "request-1",
      audience: "qm-desktop-broker-relay",
    },
  };

  assert.deepEqual(decodeDesktopBrowserMessage(encodeDesktopBrowserMessage(message)), message);
});

test("Core rejects an authority message that does not match its published schema", () => {
  assert.throws(
    () =>
      decodeDesktopBrowserMessage(
        JSON.stringify({
          protocolVersion: "1.0",
          kind: "core.authority",
          payload: { requestId: "request-1" },
        }),
      ),
    /core\.authority message does not match its schema/,
  );
});

test("Core rejects a relay challenge missing any authoritative binding field", () => {
  const challenge = {
    protocolVersion: "1.0",
    kind: "relay.challenge",
    payload: {
      relayInstanceId: "relay-a",
      challengeNonce: "nonce-1",
      deploymentCanonicalId: "qm://deployments/example",
      brokerInstanceId: "broker-local-1",
      browserInstanceId: "browser-primary",
      connectionEpoch: 7,
    },
  } satisfies DesktopBrowserMessage;

  for (const field of [
    "relayInstanceId",
    "challengeNonce",
    "deploymentCanonicalId",
    "brokerInstanceId",
    "browserInstanceId",
    "connectionEpoch",
  ] as const) {
    const payload = { ...challenge.payload } as Record<string, unknown>;
    delete payload[field];
    assert.throws(
      () => decodeDesktopBrowserMessage(JSON.stringify({ ...challenge, payload })),
      /relay\.challenge message does not match its schema/,
    );
  }
});

test("Core rejects a host challenge-response missing any signed binding field", () => {
  const response = {
    protocolVersion: "1.0",
    kind: "host.challenge-response",
    payload: {
      relayInstanceId: "relay-a",
      challengeNonce: "nonce-1",
      deploymentCanonicalId: "qm://deployments/example",
      devicePublicKey: "ed25519:device-public-key-abc",
      brokerInstanceId: "broker-local-1",
      browserInstanceId: "browser-primary",
      connectionEpoch: 7,
      signatureAlgorithm: "ed25519",
      signature: "base64:signature-1",
    },
  } satisfies DesktopBrowserMessage;

  for (const field of [
    "relayInstanceId",
    "deploymentCanonicalId",
    "devicePublicKey",
    "brokerInstanceId",
    "browserInstanceId",
    "connectionEpoch",
    "challengeNonce",
  ] as const) {
    const payload = { ...response.payload } as Record<string, unknown>;
    delete payload[field];
    assert.throws(
      () => decodeDesktopBrowserMessage(JSON.stringify({ ...response, payload })),
      /host\.challenge-response message does not match its schema/,
    );
  }
});

test("Core rejects protocol components longer than the published bound", () => {
  assert.throws(
    () => isDesktopBrowserProtocolCompatible("1234567890.0", DESKTOP_BROWSER_PROTOCOL_VERSION),
    /invalid desktop browser protocol version/,
  );
});

test("Core accepts compatible minor versions and rejects incompatible major versions", () => {
  const compatible = {
    protocolVersion: "1.7",
    kind: "core.authority",
    traceContext: "future-minor-field",
    payload: {
      requestId: "request-1",
      audience: "qm-desktop-broker-relay",
      authorityHint: "future-minor-field",
    },
  };
  assert.equal(isDesktopBrowserProtocolCompatible("1.7", DESKTOP_BROWSER_PROTOCOL_VERSION), true);
  assert.deepEqual(
    decodeDesktopBrowserMessage(JSON.stringify(compatible), DESKTOP_BROWSER_PROTOCOL_VERSION),
    compatible,
  );

  assert.throws(
    () => decodeDesktopBrowserMessage(JSON.stringify({ ...compatible, protocolVersion: "2.0" }), "1.0"),
    /protocol major 2 is incompatible with supported major 1/,
  );
});

test("Core publishes one schema for every Phase F message kind", () => {
  assert.deepEqual(Object.keys(desktopBrowserMessageSchemas).sort(), [
    "companion.status",
    "core.authority",
    "host.accepted",
    "host.challenge-response",
    "host.hello",
    "host.result",
    "relay.challenge",
    "relay.invoke",
  ]);
});

test("Core normalizes bounded protocol majors without numeric conversion", () => {
  assert.equal(isDesktopBrowserProtocolCompatible("000000001.0", "1.0"), true);
  assert.equal(isDesktopBrowserProtocolCompatible("000000002.0", "1.0"), false);
});

test("Core fails host challenge-response verification when any signed tuple field is mutated", () => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const devicePublicKey = `ed25519:${Buffer.from(publicKey.export({ format: "der", type: "spki" })).toString("base64")}`;
  const payload = {
    relayInstanceId: "relay-a",
    deploymentCanonicalId: "qm://deployments/example",
    devicePublicKey,
    brokerInstanceId: "broker-local-1",
    browserInstanceId: "browser-primary",
    connectionEpoch: 7,
    challengeNonce: "nonce-1",
  };
  const message = {
    protocolVersion: "1.0",
    kind: "host.challenge-response",
    payload: {
      ...payload,
      signatureAlgorithm: "ed25519",
      signature: Buffer.from(
        sign(
          null,
          Buffer.from(encodeHostChallengeResponseSigningBytes({ protocolVersion: "1.0", payload })),
          privateKey,
        ),
      ).toString("base64url"),
    },
  } satisfies DesktopBrowserMessage;

  assert.equal(verifyHostChallengeResponseMessage(message), true);
  assert.equal(
    verifyHostChallengeResponseMessage({
      ...message,
      payload: { ...message.payload, browserInstanceId: "browser-secondary" },
    }),
    false,
  );
});

test("Core relay adapter contracts keep the raw device key out of connection projection payloads", () => {
  const binding: DesktopBrowserRelayRegistryBinding = {
    registrationId: "reg-1",
    registrationState: "registered",
    devicePublicKey: "ed25519:device-public-key-abc",
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
  };
  const projection: DesktopBrowserRelayConnectionProjection = {
    connectionId: "connection-1",
    publicDeviceFingerprint: "fp-1",
    brokerInstanceId: "broker-1",
    browserInstanceId: "browser-1",
    connectionEpoch: 7,
    registrationState: "pending",
    protocolVersion: "1.2",
    policyGrammarVersion: "1.1",
    brokerVersion: "0.0.0-test",
    bskVersion: "bsk-1",
    extensionVersion: "ext-1",
    cliShapeHash: "shape-1",
    lastSeenAt: "2026-08-26T12:00:00.000Z",
  };

  assert.equal(binding.registrationState, "registered");
  assert.equal("devicePublicKey" in projection, false);
  assert.equal(projection.registrationState, "pending");
});

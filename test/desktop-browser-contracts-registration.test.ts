import assert from "node:assert/strict";
import { TextDecoder } from "node:util";
import { test } from "node:test";
import {
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  encodeDesktopBrowserPublicIdentityBytes,
  encodeDesktopBrowserRegistrationConfirmationSigningBytes,
  encodeDesktopBrowserRegistrationReservationTupleBytes,
  parseDesktopBrowserOnlineDeviceProjection,
  parseDesktopBrowserPublicIdentity,
  parseDesktopBrowserRegistrationConfirmationEnvelope,
  parseDesktopBrowserRegistrationReservationTuple,
  projectDesktopBrowserPublicIdentity,
} from "qm-desktop-browser-contracts";
import {
  desktopBrowserOnlineDeviceProjectionFixture,
  desktopBrowserPublicIdentityFixture,
  desktopBrowserRegistrationConfirmationEnvelopeFixture,
  desktopBrowserRegistrationReservationTupleFixture,
} from "qm-desktop-browser-contracts/fixtures";

const textDecoder = new TextDecoder();

function assertCanonicalInstantContractError(fn: () => unknown, field: string): void {
  let error: unknown;
  try {
    fn();
  } catch (thrown) {
    error = thrown;
  }
  assert.notEqual(error, undefined);
  assert.ok(error instanceof Error);
  assert.equal(error instanceof RangeError, false);
  assert.match(error.message, new RegExp(`^${field} must use canonical UTC millisecond instant form$`));
}

test("registration fixtures validate through the public contract seam", () => {
  assert.deepEqual(
    parseDesktopBrowserRegistrationReservationTuple(desktopBrowserRegistrationReservationTupleFixture),
    desktopBrowserRegistrationReservationTupleFixture,
  );
  assert.deepEqual(
    parseDesktopBrowserRegistrationConfirmationEnvelope(desktopBrowserRegistrationConfirmationEnvelopeFixture),
    desktopBrowserRegistrationConfirmationEnvelopeFixture,
  );
  assert.deepEqual(parseDesktopBrowserPublicIdentity(desktopBrowserPublicIdentityFixture), desktopBrowserPublicIdentityFixture);
  assert.deepEqual(
    parseDesktopBrowserOnlineDeviceProjection(desktopBrowserOnlineDeviceProjectionFixture),
    desktopBrowserOnlineDeviceProjectionFixture,
  );
  assert.deepEqual(
    projectDesktopBrowserPublicIdentity(desktopBrowserRegistrationReservationTupleFixture),
    desktopBrowserPublicIdentityFixture,
  );
});

test("registration confirmation signing bytes, confirmation fingerprint, and public device fingerprint stay canonical", () => {
  assert.equal(
    textDecoder.decode(
      encodeDesktopBrowserRegistrationReservationTupleBytes(desktopBrowserRegistrationReservationTupleFixture),
    ),
    '{"registrationProtocolVersion":"1.0","deploymentCanonicalId":"qm://deployments/example","registrationId":"reg_01j0example","actorId":"user_123","originatingProjectId":"project_alpha","membershipEpoch":42,"devicePublicKey":"ed25519:device-public-key-abc","brokerInstanceId":"broker-macbook-pro","browserInstanceId":"browser-primary","connectionEpoch":7,"expiresAt":"2026-08-26T12:00:00.000Z"}',
  );
  assert.equal(
    textDecoder.decode(
      encodeDesktopBrowserRegistrationConfirmationSigningBytes(desktopBrowserRegistrationReservationTupleFixture),
    ),
    '{"registrationProtocolVersion":"1.0","deploymentCanonicalId":"qm://deployments/example","registrationId":"reg_01j0example","actorId":"user_123","originatingProjectId":"project_alpha","membershipEpoch":42,"devicePublicKey":"ed25519:device-public-key-abc","brokerInstanceId":"broker-macbook-pro","browserInstanceId":"browser-primary","connectionEpoch":7,"expiresAt":"2026-08-26T12:00:00.000Z"}',
  );
  assert.equal(
    computeDesktopBrowserRegistrationConfirmationFingerprint(desktopBrowserRegistrationReservationTupleFixture),
    "9d1f8823ef8ae138",
  );
  assert.equal(
    textDecoder.decode(encodeDesktopBrowserPublicIdentityBytes(desktopBrowserPublicIdentityFixture)),
    '{"publicIdentityVersion":"1.0","deploymentCanonicalId":"qm://deployments/example","devicePublicKey":"ed25519:device-public-key-abc","brokerInstanceId":"broker-macbook-pro","browserInstanceId":"browser-primary"}',
  );
  assert.equal(computeDesktopBrowserPublicDeviceFingerprint(desktopBrowserPublicIdentityFixture), "563266dd23cc255a");
});

test("same-major 1.x additive fields are accepted but ignored by the canonical registration seams", () => {
  const additiveTuple = {
    ...desktopBrowserRegistrationReservationTupleFixture,
    registrationProtocolVersion: "1.7" as const,
    relayHost: "relay.local",
  };
  const additiveIdentity = {
    ...desktopBrowserPublicIdentityFixture,
    publicIdentityVersion: "1.7" as const,
    relayHost: "relay.local",
  };
  const additiveProjection = {
    ...desktopBrowserOnlineDeviceProjectionFixture,
    relayHost: "relay.local",
  };

  assert.deepEqual(parseDesktopBrowserRegistrationReservationTuple(additiveTuple), {
    ...desktopBrowserRegistrationReservationTupleFixture,
    registrationProtocolVersion: "1.7",
  });
  assert.equal(
    textDecoder.decode(encodeDesktopBrowserRegistrationReservationTupleBytes(additiveTuple)),
    '{"registrationProtocolVersion":"1.7","deploymentCanonicalId":"qm://deployments/example","registrationId":"reg_01j0example","actorId":"user_123","originatingProjectId":"project_alpha","membershipEpoch":42,"devicePublicKey":"ed25519:device-public-key-abc","brokerInstanceId":"broker-macbook-pro","browserInstanceId":"browser-primary","connectionEpoch":7,"expiresAt":"2026-08-26T12:00:00.000Z"}',
  );
  assert.deepEqual(parseDesktopBrowserPublicIdentity(additiveIdentity), {
    ...desktopBrowserPublicIdentityFixture,
    publicIdentityVersion: "1.7",
  });
  assert.equal(
    textDecoder.decode(encodeDesktopBrowserPublicIdentityBytes(additiveIdentity)),
    '{"publicIdentityVersion":"1.7","deploymentCanonicalId":"qm://deployments/example","devicePublicKey":"ed25519:device-public-key-abc","brokerInstanceId":"broker-macbook-pro","browserInstanceId":"browser-primary"}',
  );
  assert.deepEqual(
    parseDesktopBrowserRegistrationConfirmationEnvelope({
      ...desktopBrowserRegistrationConfirmationEnvelopeFixture,
      registrationTuple: additiveTuple,
      publicIdentity: additiveIdentity,
      confirmationFingerprint: computeDesktopBrowserRegistrationConfirmationFingerprint(additiveTuple),
      relayHost: "relay.local",
    }),
    {
      ...desktopBrowserRegistrationConfirmationEnvelopeFixture,
      registrationTuple: {
        ...desktopBrowserRegistrationReservationTupleFixture,
        registrationProtocolVersion: "1.7",
      },
      publicIdentity: {
        ...desktopBrowserPublicIdentityFixture,
        publicIdentityVersion: "1.7",
      },
      confirmationFingerprint: computeDesktopBrowserRegistrationConfirmationFingerprint(additiveTuple),
    },
  );
  assert.deepEqual(parseDesktopBrowserOnlineDeviceProjection(additiveProjection), desktopBrowserOnlineDeviceProjectionFixture);
});

test("exact 1.0 tuple and public identity records still fail closed on unknown fields", () => {
  assert.throws(
    () =>
      parseDesktopBrowserRegistrationReservationTuple({
        ...desktopBrowserRegistrationReservationTupleFixture,
        unexpectedField: true,
      }),
    /does not match its schema/,
  );
  assert.throws(
    () =>
      parseDesktopBrowserPublicIdentity({
        ...desktopBrowserPublicIdentityFixture,
        deviceId: "hidden-device-id",
      }),
    /does not match its schema/,
  );
});

test("registration confirmation envelope requires the exact public identity projection and exact confirmation fingerprint", () => {
  assert.throws(
    () =>
      parseDesktopBrowserRegistrationConfirmationEnvelope({
        ...desktopBrowserRegistrationConfirmationEnvelopeFixture,
        publicIdentity: {
          ...desktopBrowserPublicIdentityFixture,
          browserInstanceId: "browser-secondary",
        },
      }),
    /public identity must exactly project the registration tuple/,
  );

  assert.throws(
    () =>
      parseDesktopBrowserRegistrationConfirmationEnvelope({
        ...desktopBrowserRegistrationConfirmationEnvelopeFixture,
        confirmationFingerprint: desktopBrowserOnlineDeviceProjectionFixture.publicDeviceFingerprint,
      }),
    /confirmationFingerprint .* does not match tuple confirmation fingerprint/,
  );
});

test("canonical hashed lexical fields reject non-canonical representations", () => {
  assert.throws(
    () =>
      parseDesktopBrowserRegistrationReservationTuple({
        ...desktopBrowserRegistrationReservationTupleFixture,
        registrationProtocolVersion: "01.0",
      }),
    /does not match its schema/,
  );

  assert.throws(
    () =>
      parseDesktopBrowserRegistrationReservationTuple({
        ...desktopBrowserRegistrationReservationTupleFixture,
        expiresAt: "2026-08-26T12:00:00Z",
      }),
    /does not match its schema/,
  );

  assert.throws(
    () =>
      parseDesktopBrowserOnlineDeviceProjection({
        ...desktopBrowserOnlineDeviceProjectionFixture,
        lastSeenAt: "2026-02-30T11:58:00.000Z",
      }),
    /must use canonical UTC millisecond instant form/,
  );
});

test("semantic timestamp validation fails with contract errors instead of RangeError", () => {
  assertCanonicalInstantContractError(
    () =>
      parseDesktopBrowserRegistrationReservationTuple({
        ...desktopBrowserRegistrationReservationTupleFixture,
        expiresAt: "2026-02-30T12:00:00.000Z",
      }),
    "expiresAt",
  );

  assertCanonicalInstantContractError(
    () =>
      parseDesktopBrowserRegistrationReservationTuple({
        ...desktopBrowserRegistrationReservationTupleFixture,
        expiresAt: "2026-01-32T12:00:00.000Z",
      }),
    "expiresAt",
  );

  assertCanonicalInstantContractError(
    () =>
      parseDesktopBrowserOnlineDeviceProjection({
        ...desktopBrowserOnlineDeviceProjectionFixture,
        lastSeenAt: "2026-02-30T11:58:00.000Z",
      }),
    "lastSeenAt",
  );

  assertCanonicalInstantContractError(
    () =>
      parseDesktopBrowserOnlineDeviceProjection({
        ...desktopBrowserOnlineDeviceProjectionFixture,
        lastSeenAt: "2026-01-32T11:58:00.000Z",
      }),
    "lastSeenAt",
  );
});

test("additive fields never relax registration discriminators or tuple/public projection coherence", () => {
  const additiveTuple = {
    ...desktopBrowserRegistrationReservationTupleFixture,
    registrationProtocolVersion: "1.7" as const,
    relayHost: "relay.local",
  };

  assert.throws(
    () =>
      parseDesktopBrowserRegistrationConfirmationEnvelope({
        ...desktopBrowserRegistrationConfirmationEnvelopeFixture,
        registrationTuple: additiveTuple,
        publicIdentity: {
          ...desktopBrowserPublicIdentityFixture,
          publicIdentityVersion: "1.7",
          browserInstanceId: "browser-secondary",
          relayHost: "relay.local",
        },
        confirmationFingerprint: computeDesktopBrowserRegistrationConfirmationFingerprint(additiveTuple),
        relayHost: "relay.local",
      }),
    /public identity must exactly project the registration tuple/,
  );

  assert.throws(
    () =>
      parseDesktopBrowserRegistrationConfirmationEnvelope({
        ...desktopBrowserRegistrationConfirmationEnvelopeFixture,
        registrationTuple: additiveTuple,
        publicIdentity: {
          ...desktopBrowserPublicIdentityFixture,
          publicIdentityVersion: "1.7",
          relayHost: "relay.local",
        },
        confirmationFingerprint: computeDesktopBrowserRegistrationConfirmationFingerprint(additiveTuple),
        signatureAlgorithm: "rsa",
        relayHost: "relay.local",
      }),
    /does not match its schema/,
  );
});
import {
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  type DesktopBrowserMessage,
  type DesktopBrowserOnlineDeviceProjection,
  type DesktopBrowserPublicIdentity,
  type DesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRegistrationReservationTuple,
} from "./index.ts";

export const phaseFContractFixtures: readonly DesktopBrowserMessage[] = [
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "core.authority",
    payload: {
      requestId: "request-1",
      audience: "qm-desktop-broker-relay",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "host.hello",
    payload: {
      devicePublicKey: "ed25519:device-public-key-abc",
      brokerInstanceId: "broker-macbook-pro",
      brokerVersion: "0.1.0",
      supportedProtocolVersions: [DESKTOP_BROWSER_PROTOCOL_VERSION],
      supportedPolicyGrammarVersions: ["phase-f-1"],
      bskVersion: "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c",
      extensionVersion: "2.0.19",
      cliShapeHash: "sha256:browser-cli-shape-v1",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "relay.challenge",
    payload: {
      relayInstanceId: "relay-1",
      challengeNonce: "nonce-1",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "host.challenge-response",
    payload: {
      devicePublicKey: "ed25519:device-public-key-abc",
      brokerInstanceId: "broker-macbook-pro",
      challengeNonce: "nonce-1",
      signatureAlgorithm: "ed25519",
      signature: "base64:signature-1",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "relay.invoke",
    payload: {
      dispatchId: "dispatch-1",
      operationId: "operation-1",
      requestHash: "sha256:request-1",
      argv: ["--json", "session", "start"],
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "host.result",
    payload: {
      operationId: "operation-1",
      outcome: "completed",
      resultHash: "sha256:result-1",
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "companion.status",
    payload: {
      brokerStatus: "ready",
      browserSkillStatus: "ready",
      currentTaskPresent: true,
    },
  },
];

export const desktopBrowserRegistrationReservationTupleFixture: DesktopBrowserRegistrationReservationTuple = {
  registrationProtocolVersion: DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION,
  deploymentCanonicalId: "qm://deployments/example",
  registrationId: "reg_01j0example",
  actorId: "user_123",
  originatingProjectId: "project_alpha",
  membershipEpoch: 42,
  devicePublicKey: "ed25519:device-public-key-abc",
  brokerInstanceId: "broker-macbook-pro",
  browserInstanceId: "browser-primary",
  connectionEpoch: 7,
  expiresAt: "2026-08-26T12:00:00.000Z",
};

export const desktopBrowserPublicIdentityFixture: DesktopBrowserPublicIdentity = {
  publicIdentityVersion: desktopBrowserRegistrationReservationTupleFixture.registrationProtocolVersion,
  deploymentCanonicalId: desktopBrowserRegistrationReservationTupleFixture.deploymentCanonicalId,
  devicePublicKey: desktopBrowserRegistrationReservationTupleFixture.devicePublicKey,
  brokerInstanceId: desktopBrowserRegistrationReservationTupleFixture.brokerInstanceId,
  browserInstanceId: desktopBrowserRegistrationReservationTupleFixture.browserInstanceId,
};

export const desktopBrowserRegistrationConfirmationEnvelopeFixture: DesktopBrowserRegistrationConfirmationEnvelope = {
  registrationTuple: desktopBrowserRegistrationReservationTupleFixture,
  publicIdentity: desktopBrowserPublicIdentityFixture,
  confirmationFingerprint: computeDesktopBrowserRegistrationConfirmationFingerprint(
    desktopBrowserRegistrationReservationTupleFixture,
  ),
  signatureAlgorithm: "ed25519",
  signature: "base64:registration-signature-1",
};

export const desktopBrowserOnlineDeviceProjectionFixture: DesktopBrowserOnlineDeviceProjection = {
  publicDeviceFingerprint: computeDesktopBrowserPublicDeviceFingerprint(desktopBrowserPublicIdentityFixture),
  browserInstanceId: desktopBrowserPublicIdentityFixture.browserInstanceId,
  operatingSystem: "macos-arm64",
  status: "online",
  browserRuntimeStatus: "ready",
  lastSeenAt: "2026-08-26T11:58:00.000Z",
};

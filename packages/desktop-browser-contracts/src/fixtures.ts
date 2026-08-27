import {
  DESKTOP_BROWSER_AUTHORITY_VERSION,
  DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS,
  DESKTOP_BROWSER_PROTOCOL_VERSION,
  DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION,
  DESKTOP_BROWSER_RELAY_AUDIENCE,
  DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  computeDesktopBrowserPublicDeviceFingerprint,
  computeDesktopBrowserRegistrationConfirmationFingerprint,
  computeDesktopBrowserRequestHash,
  type DesktopBrowserCapabilitySet,
  type DesktopBrowserSessionStartAuthorityEnvelope,
  type DesktopBrowserRelayConnectionProjection,
  type DesktopBrowserRelayRegistryBinding,
  type DesktopBrowserMessage,
  type DesktopBrowserOnlineDeviceProjection,
  type DesktopBrowserPublicIdentity,
  type DesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRegistrationReservationTuple,
} from "./index.ts";

export const desktopBrowserCapabilitySetFixture: DesktopBrowserCapabilitySet = {
  protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  policyGrammarVersion: "1.0",
  bskVersion: "4b6cdde168f9e46ebff78e8cccaa75c75814cb7c",
  extensionVersion: "2.0.19",
  cliShapeHash: "sha256:browser-cli-shape-v1",
};

export const desktopBrowserSessionStartAuthorityFixture: DesktopBrowserSessionStartAuthorityEnvelope = {
  authorityVersion: DESKTOP_BROWSER_AUTHORITY_VERSION,
  audience: DESKTOP_BROWSER_RELAY_AUDIENCE,
  deploymentCanonicalId: "qm://deployments/example",
  actorId: "actor-1",
  actorSnapshotHash: "sha256:actor-snapshot-1",
  projectId: "project-1",
  projectSnapshotHash: "sha256:project-snapshot-1",
  membershipEpoch: 42,
  taskId: "task-1",
  attemptId: "attempt-1",
  deviceId: "device-1",
  browserInstanceId: "browser-primary",
  leaseId: "lease-1",
  leaseVersion: 3,
  leaseExpiresAt: "2026-08-27T12:01:00.000Z",
  operationId: "0198f3d2-1950-7000-8000-000000000001",
  operationSequence: 1,
  capabilitySet: desktopBrowserCapabilitySetFixture,
  argv: ["--json", "session", "start", "--browser", "browser-primary"],
  brokerOptions: { forceSharedRuntime: false },
  effectClass: "local_effect",
  nonce: "nonce-1",
  issuedAt: "2026-08-27T12:00:00.000Z",
};

export const desktopBrowserRelayInvocationFixture = {
  protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  kind: "relay.invoke",
  payload: {
    dispatchId: "0198f3d2-1950-7000-8000-000000000002",
    requestHash: computeDesktopBrowserRequestHash(desktopBrowserSessionStartAuthorityFixture),
    authority: desktopBrowserSessionStartAuthorityFixture,
  },
} as const satisfies DesktopBrowserMessage;

export const desktopBrowserSessionStartCompletedResultFixture = {
  protocolVersion: DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  kind: "host.result",
  payload: {
    operationId: desktopBrowserSessionStartAuthorityFixture.operationId,
    accepted: true,
    outcome: "completed",
    resultHash: "sha256:result-1",
    result: {
      session_id: "session-1",
      browser_instance_id: desktopBrowserSessionStartAuthorityFixture.browserInstanceId,
      agent_window_id: 42,
    },
  },
} as const satisfies DesktopBrowserMessage;

export const phaseFContractFixtures = [
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
      supportedProtocolVersions: [...DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS],
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
      deploymentCanonicalId: "qm://deployments/example",
      brokerInstanceId: "broker-macbook-pro",
      browserInstanceId: "browser-primary",
      connectionEpoch: 7,
    },
  },
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "host.challenge-response",
    payload: {
      relayInstanceId: "relay-1",
      deploymentCanonicalId: "qm://deployments/example",
      devicePublicKey: "ed25519:device-public-key-abc",
      brokerInstanceId: "broker-macbook-pro",
      browserInstanceId: "browser-primary",
      connectionEpoch: 7,
      challengeNonce: "nonce-1",
      signatureAlgorithm: "ed25519",
      signature: "base64:signature-1",
    },
  },
  desktopBrowserRelayInvocationFixture,
  desktopBrowserSessionStartCompletedResultFixture,
  {
    protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
    kind: "companion.status",
    payload: {
      brokerStatus: "ready",
      browserSkillStatus: "ready",
      currentTaskPresent: true,
    },
  },
] as const satisfies readonly DesktopBrowserMessage[];

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

export const desktopBrowserRelayRegistryBindingFixture: DesktopBrowserRelayRegistryBinding = {
  registrationId: desktopBrowserRegistrationReservationTupleFixture.registrationId,
  registrationState: "pending",
  devicePublicKey: desktopBrowserRegistrationReservationTupleFixture.devicePublicKey,
  brokerInstanceId: desktopBrowserRegistrationReservationTupleFixture.brokerInstanceId,
  browserInstanceId: desktopBrowserRegistrationReservationTupleFixture.browserInstanceId,
  connectionEpoch: desktopBrowserRegistrationReservationTupleFixture.connectionEpoch,
};

export const desktopBrowserRelayConnectionProjectionFixture: DesktopBrowserRelayConnectionProjection = {
  connectionId: "connection-1",
  publicDeviceFingerprint: computeDesktopBrowserPublicDeviceFingerprint(desktopBrowserPublicIdentityFixture),
  brokerInstanceId: desktopBrowserPublicIdentityFixture.brokerInstanceId,
  browserInstanceId: desktopBrowserPublicIdentityFixture.browserInstanceId,
  connectionEpoch: desktopBrowserRegistrationReservationTupleFixture.connectionEpoch,
  registrationState: "registered",
  protocolVersion: DESKTOP_BROWSER_PROTOCOL_VERSION,
  policyGrammarVersion: "1.0",
  brokerVersion: "0.1.0",
  bskVersion: "bsk-1",
  extensionVersion: "extension-1",
  cliShapeHash: "shape-1",
  lastSeenAt: "2026-08-26T11:59:00.000Z",
};

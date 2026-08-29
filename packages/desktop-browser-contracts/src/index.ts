import { createHash, createPublicKey, verify } from "node:crypto";
import { fromJSONSchema } from "zod";

export interface CoreAuthorityMessage {
  protocolVersion: `${number}.${number}`;
  kind: "core.authority";
  payload: {
    requestId: string;
    audience: string;
  };
}

export interface HostHelloMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.hello";
  payload: {
    devicePublicKey: string;
    brokerInstanceId: string;
    brokerVersion: string;
    supportedProtocolVersions: string[];
    supportedPolicyGrammarVersions: string[];
    bskVersion: string;
    extensionVersion: string;
    cliShapeHash: string;
  };
}

export interface RelayChallengeMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.challenge";
  payload: {
    relayInstanceId: string;
    challengeNonce: string;
    deploymentCanonicalId: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
  };
}

export interface HostChallengeResponseMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.challenge-response";
  payload: {
    relayInstanceId: string;
    deploymentCanonicalId: string;
    devicePublicKey: string;
    brokerInstanceId: string;
    browserInstanceId: string;
    connectionEpoch: number;
    challengeNonce: string;
    signatureAlgorithm: "ed25519";
    signature: string;
  };
}

export interface DesktopBrowserCapabilitySet {
  protocolVersion: `${number}.${number}`;
  policyGrammarVersion: `${number}.${number}`;
  bskVersion: string;
  extensionVersion: string;
  cliShapeHash: string;
}

export interface DesktopBrowserBrokerOptions {
  forceSharedRuntime: boolean;
}

export type DesktopBrowserSessionStartArgv = ["--json", "session", "start", "--browser", string];
export type DesktopBrowserNavigateArgv = ["--json", "navigate", string, "--session", string];
export type DesktopBrowserObserveArgv = ["--json", "observe", "--session", string];
export type DesktopBrowserSessionStopArgv = ["--json", "session", "stop", string];
export type DesktopBrowserPhaseFArgv =
  | DesktopBrowserSessionStartArgv
  | DesktopBrowserNavigateArgv
  | DesktopBrowserObserveArgv
  | DesktopBrowserSessionStopArgv;

export interface DesktopBrowserPhaseFArgvBindings {
  browserInstanceId: string;
  sessionId?: string;
}

export type DesktopBrowserEffectClass = "local_effect" | "browser_effect" | "observation" | "cleanup";

export interface DesktopBrowserOperationAuthorityEnvelope {
  authorityVersion: `${number}.${number}`;
  audience: typeof DESKTOP_BROWSER_RELAY_AUDIENCE;
  deploymentCanonicalId: string;
  actorId: string;
  actorSnapshotHash: string;
  projectId: string;
  projectSnapshotHash: string;
  membershipEpoch: number;
  taskId: string;
  attemptId: string;
  deviceId: string;
  browserInstanceId: string;
  leaseId: string;
  leaseVersion: number;
  leaseExpiresAt: string;
  operationId: string;
  operationSequence: number;
  capabilitySet: DesktopBrowserCapabilitySet;
  argv: DesktopBrowserPhaseFArgv;
  brokerOptions: DesktopBrowserBrokerOptions;
  effectClass: DesktopBrowserEffectClass;
  nonce: string;
  issuedAt: string;
}

export type DesktopBrowserSessionStartAuthorityEnvelope = Omit<
  DesktopBrowserOperationAuthorityEnvelope,
  "argv" | "effectClass"
> & {
  argv: DesktopBrowserSessionStartArgv;
  effectClass: "local_effect";
};

export interface RelayInvocationMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.invoke";
  payload: {
    dispatchId: string;
    requestHash: string;
    authority: DesktopBrowserOperationAuthorityEnvelope;
  };
}

export interface HostAcceptedMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.accepted";
  payload: {
    dispatchId: string;
    operationId: string;
    requestHash: string;
  };
}

export interface DesktopBrowserArtifactIntent {
  artifactIntentId: string;
  taskId: string;
  attemptId: string;
  operationId: string;
  requestHash: string;
  deviceId: string;
  actorId: string;
  projectId: string;
  leaseId: string;
  leaseVersion: number;
  leaseExpiresAt: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  expectedSha256: string;
}

export interface HostArtifactIntentMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.artifact-intent";
  payload: DesktopBrowserArtifactIntent;
}

export interface RelayArtifactGrantMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.artifact-grant";
  payload: {
    artifactIntentId: string;
    operationId: string;
    uploadUrl: string;
    bearerToken: string;
    expiresAt: string;
  };
}

export interface RelayArtifactGrantFailedMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.artifact-grant-failed";
  payload: {
    artifactIntentId: string;
    operationId: string;
    error: DesktopBrowserArtifactWarning;
  };
}

export interface DesktopBrowserArtifactReference {
  artifactId: string;
  name: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
}

export interface DesktopBrowserArtifactWarning {
  code: string;
  message: string;
}

export interface DesktopBrowserSessionStartResult {
  session_id: string;
  browser_instance_id: string;
  agent_window_id: number;
}

export interface DesktopBrowserSanitizedObservationResult {
  schemaVersion: "1.0";
  command: "observe";
  completedAt: string;
  data: {
    tab_id: number;
    text: string;
    ref_count: number;
    truncated: boolean;
  };
}

export interface DesktopBrowserSanitizedNavigateResult {
  schemaVersion: "1.0";
  command: "navigate";
  completedAt: string;
  data: {
    tab_id: number;
    reached: string;
  };
}

export interface DesktopBrowserSanitizedSessionStopResult {
  schemaVersion: "1.0";
  command: "session.stop";
  completedAt: string;
  data: {
    returned_tab_ids: number[];
    return_failures: Array<{ tab_id: number; code: string }>;
  };
}

export type DesktopBrowserCompletedResult =
  | DesktopBrowserSessionStartResult
  | DesktopBrowserSanitizedNavigateResult
  | DesktopBrowserSanitizedObservationResult
  | DesktopBrowserSanitizedSessionStopResult;

export interface DesktopBrowserHostFailure {
  code: string;
  message: string;
}

export type HostResultMessage = {
  protocolVersion: `${number}.${number}`;
  kind: "host.result";
} & {
  payload:
    | {
        dispatchId: string;
        operationId: string;
        outcome: "completed";
        resultHash: string;
        result: DesktopBrowserCompletedResult;
        artifact?: DesktopBrowserArtifactReference;
        artifactWarning?: DesktopBrowserArtifactWarning;
      }
    | {
        dispatchId: string;
        operationId: string;
        outcome: "failed" | "unknown";
        resultHash: string;
        error?: DesktopBrowserHostFailure;
      };
};

export interface CompanionStatusMessage {
  protocolVersion: `${number}.${number}`;
  kind: "companion.status";
  payload: {
    brokerStatus: "ready" | "paused" | "disconnected";
    browserSkillStatus: "ready" | "offline";
    currentTaskPresent: boolean;
  };
}

export interface HostLocalStopReceiptMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.local-stop-receipt";
  payload: {
    receiptId: string;
    processEpoch: number;
    taskId: string;
    attemptId: string;
    operationId: string;
    operationCategory: "session_start" | "browser_effect" | "observation" | "session_cleanup";
    requestedAt: number;
    status: "requested" | "canceled";
  };
}

export interface RelayLocalStopAckMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.local-stop-ack";
  payload: { receiptId: string };
}

export interface RelayResultAckMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.result-ack";
  payload: { operationId: string; resultHash: string };
}

export interface HostDeviceReconciledMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.device-reconciled";
  payload: { reconciliationId: string; processEpoch: number; confirmedAt: number };
}

export interface RelayDeviceReconcileAckMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.device-reconcile-ack";
  payload: { reconciliationId: string };
}

export interface DesktopBrowserRegistrationReservationTuple {
  registrationProtocolVersion: `${number}.${number}`;
  deploymentCanonicalId: string;
  registrationId: string;
  actorId: string;
  originatingProjectId: string;
  membershipEpoch: number;
  devicePublicKey: string;
  brokerInstanceId: string;
  browserInstanceId: string;
  connectionEpoch: number;
  expiresAt: string;
}

export interface DesktopBrowserPublicIdentity {
  publicIdentityVersion: `${number}.${number}`;
  deploymentCanonicalId: string;
  devicePublicKey: string;
  brokerInstanceId: string;
  browserInstanceId: string;
}

export interface DesktopBrowserRegistrationConfirmationEnvelope {
  registrationTuple: DesktopBrowserRegistrationReservationTuple;
  publicIdentity: DesktopBrowserPublicIdentity;
  confirmationFingerprint: string;
  signatureAlgorithm: "ed25519";
  signature: string;
}

export interface DesktopBrowserOnlineDeviceProjection {
  publicDeviceFingerprint: string;
  browserInstanceId: string;
  operatingSystem: string;
  status: "online" | "busy" | "offline";
  browserRuntimeStatus: "ready" | "offline";
  lastSeenAt: string;
}

export interface DesktopBrowserRelayRegistryBinding {
  registrationId: string;
  registrationState: "pending" | "registered";
  devicePublicKey: string;
  brokerInstanceId: string;
  browserInstanceId: string;
  connectionEpoch: number;
  ownerConnectionId?: string;
}

export interface DesktopBrowserRelayConnectionProjection {
  connectionId: string;
  publicDeviceFingerprint: string;
  brokerInstanceId: string;
  browserInstanceId: string;
  connectionEpoch: number;
  registrationState: "pending" | "registered";
  protocolVersion: string;
  policyGrammarVersion: string;
  brokerVersion: string;
  bskVersion: string;
  extensionVersion: string;
  cliShapeHash: string;
  lastSeenAt: string;
}

export interface DesktopBrowserRelayBindingResolveRequest {
  devicePublicKey: string;
  brokerInstanceId: string;
}

export interface DesktopBrowserRelayBindingResolveResponse {
  binding: DesktopBrowserRelayRegistryBinding;
}

export interface DesktopBrowserRelayConnectionPublishRequest {
  projection: DesktopBrowserRelayConnectionProjection;
}

export type DesktopBrowserMessage =
  | CoreAuthorityMessage
  | HostHelloMessage
  | RelayChallengeMessage
  | HostChallengeResponseMessage
  | RelayInvocationMessage
  | HostAcceptedMessage
  | HostArtifactIntentMessage
  | RelayArtifactGrantMessage
  | RelayArtifactGrantFailedMessage
  | HostResultMessage
  | HostLocalStopReceiptMessage
  | RelayLocalStopAckMessage
  | RelayResultAckMessage
  | HostDeviceReconciledMessage
  | RelayDeviceReconcileAckMessage
  | CompanionStatusMessage;

type DesktopBrowserMessageKind = DesktopBrowserMessage["kind"];

export const DESKTOP_BROWSER_PROTOCOL_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION = "1.2" as const;
export const DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION = "1.3" as const;
export const DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_PROTOCOL_VERSIONS = [
  DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  DESKTOP_BROWSER_PROTOCOL_VERSION,
] as const;
export const DESKTOP_BROWSER_PHASE_F_DEFAULT_SUPPORTED_POLICY_GRAMMAR_VERSIONS = [
  DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION,
] as const;
export const DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_PUBLIC_IDENTITY_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_AUTHORITY_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_RELAY_AUDIENCE = "qm-desktop-broker-relay" as const;
export const DESKTOP_BROWSER_RELAY_WSS_PATH = "/v1/device" as const;
export const DESKTOP_BROWSER_TASK_LEASE_DURATION_MS = 60_000 as const;
export const DESKTOP_BROWSER_MAX_ARTIFACT_BYTES = 10 * 1024 * 1024;

const PROTOCOL_VERSION_PATTERN = "^([0-9]{1,9})\\.([0-9]{1,9})$";
const CANONICAL_PROTOCOL_VERSION_PATTERN = "^(0|[1-9][0-9]{0,8})\\.(0|[1-9][0-9]{0,8})$";
const CANONICAL_LEXICAL_STRING_PATTERN = "^(?:\\S(?:.*\\S)?)$";
const CANONICAL_UTC_MILLISECOND_INSTANT_PATTERN = "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\\.[0-9]{3}Z$";
const protocolVersionPattern = new RegExp(PROTOCOL_VERSION_PATTERN);
const canonicalProtocolVersionPattern = new RegExp(CANONICAL_PROTOCOL_VERSION_PATTERN);
const canonicalUtcMillisecondInstantPattern = new RegExp(CANONICAL_UTC_MILLISECOND_INSTANT_PATTERN);

const objectSchema = <const Required extends readonly string[], const Properties extends Record<string, unknown>>(
  required: Required,
  properties: Properties,
  additionalProperties: boolean,
) => ({
  type: "object" as const,
  additionalProperties,
  required,
  properties,
});

const messageSchema = <const Kind extends DesktopBrowserMessageKind, const Payload extends Record<string, unknown>>(
  kind: Kind,
  payload: Payload,
) =>
  objectSchema(
    ["protocolVersion", "kind", "payload"],
    {
      protocolVersion: { type: "string", pattern: PROTOCOL_VERSION_PATTERN },
      kind: { const: kind },
      payload,
    },
    true,
  );

const strictMessageSchema = <
  const Kind extends DesktopBrowserMessageKind,
  const Payload extends Record<string, unknown>,
>(
  kind: Kind,
  payload: Payload,
) =>
  strictObjectSchema(["protocolVersion", "kind", "payload"], {
    protocolVersion: { type: "string", pattern: PROTOCOL_VERSION_PATTERN },
    kind: { const: kind },
    payload,
  });

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;
const canonicalLexicalStringSchema = {
  type: "string",
  minLength: 1,
  pattern: CANONICAL_LEXICAL_STRING_PATTERN,
} as const;
const canonicalProtocolVersionSchema = {
  type: "string",
  pattern: CANONICAL_PROTOCOL_VERSION_PATTERN,
} as const;
const canonicalUtcMillisecondInstantSchema = {
  type: "string",
  pattern: CANONICAL_UTC_MILLISECOND_INSTANT_PATTERN,
} as const;
const nonNegativeIntegerSchema = { type: "integer", minimum: 0 } as const;
const positiveIntegerSchema = { type: "integer", minimum: 1 } as const;
const nonEmptyStringArraySchema = { type: "array", minItems: 1, items: nonEmptyStringSchema } as const;

const strictObjectSchema = <const Required extends readonly string[], const Properties extends Record<string, unknown>>(
  required: Required,
  properties: Properties,
) => objectSchema(required, properties, false);

export const desktopBrowserCapabilitySetSchema = strictObjectSchema(
  ["protocolVersion", "policyGrammarVersion", "bskVersion", "extensionVersion", "cliShapeHash"],
  {
    protocolVersion: canonicalProtocolVersionSchema,
    policyGrammarVersion: canonicalProtocolVersionSchema,
    bskVersion: canonicalLexicalStringSchema,
    extensionVersion: canonicalLexicalStringSchema,
    cliShapeHash: canonicalLexicalStringSchema,
  },
);

export const desktopBrowserBrokerOptionsSchema = strictObjectSchema(["forceSharedRuntime"], {
  forceSharedRuntime: { type: "boolean" },
});

export const desktopBrowserSessionStartAuthorityEnvelopeSchema = strictObjectSchema(
  [
    "authorityVersion",
    "audience",
    "deploymentCanonicalId",
    "actorId",
    "actorSnapshotHash",
    "projectId",
    "projectSnapshotHash",
    "membershipEpoch",
    "taskId",
    "attemptId",
    "deviceId",
    "browserInstanceId",
    "leaseId",
    "leaseVersion",
    "leaseExpiresAt",
    "operationId",
    "operationSequence",
    "capabilitySet",
    "argv",
    "brokerOptions",
    "effectClass",
    "nonce",
    "issuedAt",
  ],
  {
    authorityVersion: canonicalProtocolVersionSchema,
    audience: { const: DESKTOP_BROWSER_RELAY_AUDIENCE },
    deploymentCanonicalId: canonicalLexicalStringSchema,
    actorId: canonicalLexicalStringSchema,
    actorSnapshotHash: canonicalLexicalStringSchema,
    projectId: canonicalLexicalStringSchema,
    projectSnapshotHash: canonicalLexicalStringSchema,
    membershipEpoch: nonNegativeIntegerSchema,
    taskId: canonicalLexicalStringSchema,
    attemptId: canonicalLexicalStringSchema,
    deviceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
    leaseId: canonicalLexicalStringSchema,
    leaseVersion: positiveIntegerSchema,
    leaseExpiresAt: canonicalUtcMillisecondInstantSchema,
    operationId: canonicalLexicalStringSchema,
    operationSequence: positiveIntegerSchema,
    capabilitySet: desktopBrowserCapabilitySetSchema,
    argv: { type: "array", minItems: 1, items: { type: "string" } },
    brokerOptions: desktopBrowserBrokerOptionsSchema,
    effectClass: { const: "local_effect" },
    nonce: canonicalLexicalStringSchema,
    issuedAt: canonicalUtcMillisecondInstantSchema,
  },
);

export const desktopBrowserOperationAuthorityEnvelopeSchema = strictObjectSchema(
  [
    "authorityVersion",
    "audience",
    "deploymentCanonicalId",
    "actorId",
    "actorSnapshotHash",
    "projectId",
    "projectSnapshotHash",
    "membershipEpoch",
    "taskId",
    "attemptId",
    "deviceId",
    "browserInstanceId",
    "leaseId",
    "leaseVersion",
    "leaseExpiresAt",
    "operationId",
    "operationSequence",
    "capabilitySet",
    "argv",
    "brokerOptions",
    "effectClass",
    "nonce",
    "issuedAt",
  ],
  {
    authorityVersion: canonicalProtocolVersionSchema,
    audience: { const: DESKTOP_BROWSER_RELAY_AUDIENCE },
    deploymentCanonicalId: canonicalLexicalStringSchema,
    actorId: canonicalLexicalStringSchema,
    actorSnapshotHash: canonicalLexicalStringSchema,
    projectId: canonicalLexicalStringSchema,
    projectSnapshotHash: canonicalLexicalStringSchema,
    membershipEpoch: nonNegativeIntegerSchema,
    taskId: canonicalLexicalStringSchema,
    attemptId: canonicalLexicalStringSchema,
    deviceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
    leaseId: canonicalLexicalStringSchema,
    leaseVersion: positiveIntegerSchema,
    leaseExpiresAt: canonicalUtcMillisecondInstantSchema,
    operationId: canonicalLexicalStringSchema,
    operationSequence: positiveIntegerSchema,
    capabilitySet: desktopBrowserCapabilitySetSchema,
    argv: { type: "array", minItems: 1, items: { type: "string" } },
    brokerOptions: desktopBrowserBrokerOptionsSchema,
    effectClass: { enum: ["local_effect", "browser_effect", "observation", "cleanup"] },
    nonce: canonicalLexicalStringSchema,
    issuedAt: canonicalUtcMillisecondInstantSchema,
  },
);

export const desktopBrowserSessionStartResultSchema = strictObjectSchema(
  ["session_id", "browser_instance_id", "agent_window_id"],
  {
    session_id: canonicalLexicalStringSchema,
    browser_instance_id: canonicalLexicalStringSchema,
    agent_window_id: nonNegativeIntegerSchema,
  },
);

const desktopBrowserSanitizedObservationDataSchema = strictObjectSchema(["tab_id", "text", "ref_count", "truncated"], {
  tab_id: nonNegativeIntegerSchema,
  text: { type: "string" },
  ref_count: nonNegativeIntegerSchema,
  truncated: { type: "boolean" },
});

export const desktopBrowserSanitizedObservationResultSchema = strictObjectSchema(
  ["schemaVersion", "command", "completedAt", "data"],
  {
    schemaVersion: { const: "1.0" },
    command: { const: "observe" },
    completedAt: canonicalUtcMillisecondInstantSchema,
    data: desktopBrowserSanitizedObservationDataSchema,
  },
);

const desktopBrowserSanitizedNavigateDataSchema = strictObjectSchema(["tab_id", "reached"], {
  tab_id: nonNegativeIntegerSchema,
  reached: canonicalLexicalStringSchema,
});

export const desktopBrowserSanitizedNavigateResultSchema = strictObjectSchema(
  ["schemaVersion", "command", "completedAt", "data"],
  {
    schemaVersion: { const: "1.0" },
    command: { const: "navigate" },
    completedAt: canonicalUtcMillisecondInstantSchema,
    data: desktopBrowserSanitizedNavigateDataSchema,
  },
);

const desktopBrowserSanitizedSessionStopFailureSchema = strictObjectSchema(["tab_id", "code"], {
  tab_id: nonNegativeIntegerSchema,
  code: canonicalLexicalStringSchema,
});

const desktopBrowserSanitizedSessionStopDataSchema = strictObjectSchema(["returned_tab_ids", "return_failures"], {
  returned_tab_ids: { type: "array", items: nonNegativeIntegerSchema },
  return_failures: { type: "array", items: desktopBrowserSanitizedSessionStopFailureSchema },
});

export const desktopBrowserSanitizedSessionStopResultSchema = strictObjectSchema(
  ["schemaVersion", "command", "completedAt", "data"],
  {
    schemaVersion: { const: "1.0" },
    command: { const: "session.stop" },
    completedAt: canonicalUtcMillisecondInstantSchema,
    data: desktopBrowserSanitizedSessionStopDataSchema,
  },
);

export const desktopBrowserHostFailureSchema = strictObjectSchema(["code", "message"], {
  code: canonicalLexicalStringSchema,
  message: canonicalLexicalStringSchema,
});

export const desktopBrowserRegistrationReservationTupleSchema = strictObjectSchema(
  [
    "registrationProtocolVersion",
    "deploymentCanonicalId",
    "registrationId",
    "actorId",
    "originatingProjectId",
    "membershipEpoch",
    "devicePublicKey",
    "brokerInstanceId",
    "browserInstanceId",
    "connectionEpoch",
    "expiresAt",
  ],
  {
    registrationProtocolVersion: canonicalProtocolVersionSchema,
    deploymentCanonicalId: canonicalLexicalStringSchema,
    registrationId: canonicalLexicalStringSchema,
    actorId: canonicalLexicalStringSchema,
    originatingProjectId: canonicalLexicalStringSchema,
    membershipEpoch: nonNegativeIntegerSchema,
    devicePublicKey: canonicalLexicalStringSchema,
    brokerInstanceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
    connectionEpoch: positiveIntegerSchema,
    expiresAt: canonicalUtcMillisecondInstantSchema,
  },
);

const desktopBrowserRegistrationReservationTupleAdditiveSchema = objectSchema(
  [
    "registrationProtocolVersion",
    "deploymentCanonicalId",
    "registrationId",
    "actorId",
    "originatingProjectId",
    "membershipEpoch",
    "devicePublicKey",
    "brokerInstanceId",
    "browserInstanceId",
    "connectionEpoch",
    "expiresAt",
  ],
  {
    registrationProtocolVersion: canonicalProtocolVersionSchema,
    deploymentCanonicalId: canonicalLexicalStringSchema,
    registrationId: canonicalLexicalStringSchema,
    actorId: canonicalLexicalStringSchema,
    originatingProjectId: canonicalLexicalStringSchema,
    membershipEpoch: nonNegativeIntegerSchema,
    devicePublicKey: canonicalLexicalStringSchema,
    brokerInstanceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
    connectionEpoch: positiveIntegerSchema,
    expiresAt: canonicalUtcMillisecondInstantSchema,
  },
  true,
);

export const desktopBrowserPublicIdentitySchema = strictObjectSchema(
  ["publicIdentityVersion", "deploymentCanonicalId", "devicePublicKey", "brokerInstanceId", "browserInstanceId"],
  {
    publicIdentityVersion: canonicalProtocolVersionSchema,
    deploymentCanonicalId: canonicalLexicalStringSchema,
    devicePublicKey: canonicalLexicalStringSchema,
    brokerInstanceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
  },
);

const desktopBrowserPublicIdentityAdditiveSchema = objectSchema(
  ["publicIdentityVersion", "deploymentCanonicalId", "devicePublicKey", "brokerInstanceId", "browserInstanceId"],
  {
    publicIdentityVersion: canonicalProtocolVersionSchema,
    deploymentCanonicalId: canonicalLexicalStringSchema,
    devicePublicKey: canonicalLexicalStringSchema,
    brokerInstanceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
  },
  true,
);

export const desktopBrowserRegistrationConfirmationEnvelopeSchema = strictObjectSchema(
  ["registrationTuple", "publicIdentity", "confirmationFingerprint", "signatureAlgorithm", "signature"],
  {
    registrationTuple: desktopBrowserRegistrationReservationTupleSchema,
    publicIdentity: desktopBrowserPublicIdentitySchema,
    confirmationFingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
    signatureAlgorithm: { const: "ed25519" },
    signature: canonicalLexicalStringSchema,
  },
);

const desktopBrowserRegistrationConfirmationEnvelopeAdditiveSchema = objectSchema(
  ["registrationTuple", "publicIdentity", "confirmationFingerprint", "signatureAlgorithm", "signature"],
  {
    registrationTuple: desktopBrowserRegistrationReservationTupleAdditiveSchema,
    publicIdentity: desktopBrowserPublicIdentityAdditiveSchema,
    confirmationFingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
    signatureAlgorithm: { const: "ed25519" },
    signature: canonicalLexicalStringSchema,
  },
  true,
);

export const desktopBrowserOnlineDeviceProjectionSchema = strictObjectSchema(
  ["publicDeviceFingerprint", "browserInstanceId", "operatingSystem", "status", "browserRuntimeStatus", "lastSeenAt"],
  {
    publicDeviceFingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
    browserInstanceId: canonicalLexicalStringSchema,
    operatingSystem: canonicalLexicalStringSchema,
    status: { enum: ["online", "busy", "offline"] },
    browserRuntimeStatus: { enum: ["ready", "offline"] },
    lastSeenAt: canonicalUtcMillisecondInstantSchema,
  },
);

export const desktopBrowserRelayConnectionProjectionSchema = strictObjectSchema(
  [
    "connectionId",
    "publicDeviceFingerprint",
    "brokerInstanceId",
    "browserInstanceId",
    "connectionEpoch",
    "registrationState",
    "protocolVersion",
    "policyGrammarVersion",
    "brokerVersion",
    "bskVersion",
    "extensionVersion",
    "cliShapeHash",
    "lastSeenAt",
  ],
  {
    connectionId: canonicalLexicalStringSchema,
    publicDeviceFingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
    brokerInstanceId: canonicalLexicalStringSchema,
    browserInstanceId: canonicalLexicalStringSchema,
    connectionEpoch: positiveIntegerSchema,
    registrationState: { enum: ["pending", "registered"] },
    protocolVersion: canonicalProtocolVersionSchema,
    policyGrammarVersion: canonicalProtocolVersionSchema,
    brokerVersion: nonEmptyStringSchema,
    bskVersion: nonEmptyStringSchema,
    extensionVersion: nonEmptyStringSchema,
    cliShapeHash: nonEmptyStringSchema,
    lastSeenAt: canonicalUtcMillisecondInstantSchema,
  },
);

export const desktopBrowserRelayConnectionPublishRequestSchema = strictObjectSchema(["projection"], {
  projection: desktopBrowserRelayConnectionProjectionSchema,
});

const desktopBrowserOnlineDeviceProjectionAdditiveSchema = objectSchema(
  ["publicDeviceFingerprint", "browserInstanceId", "operatingSystem", "status", "browserRuntimeStatus", "lastSeenAt"],
  {
    publicDeviceFingerprint: { type: "string", pattern: "^[0-9a-f]{16}$" },
    browserInstanceId: canonicalLexicalStringSchema,
    operatingSystem: canonicalLexicalStringSchema,
    status: { enum: ["online", "busy", "offline"] },
    browserRuntimeStatus: { enum: ["ready", "offline"] },
    lastSeenAt: canonicalUtcMillisecondInstantSchema,
  },
  true,
);

export const desktopBrowserMessageSchemas = {
  "core.authority": messageSchema(
    "core.authority",
    objectSchema(
      ["requestId", "audience"],
      {
        requestId: nonEmptyStringSchema,
        audience: nonEmptyStringSchema,
      },
      true,
    ),
  ),
  "host.hello": messageSchema(
    "host.hello",
    objectSchema(
      [
        "devicePublicKey",
        "brokerInstanceId",
        "brokerVersion",
        "supportedProtocolVersions",
        "supportedPolicyGrammarVersions",
        "bskVersion",
        "extensionVersion",
        "cliShapeHash",
      ],
      {
        devicePublicKey: nonEmptyStringSchema,
        brokerInstanceId: nonEmptyStringSchema,
        brokerVersion: nonEmptyStringSchema,
        supportedProtocolVersions: nonEmptyStringArraySchema,
        supportedPolicyGrammarVersions: nonEmptyStringArraySchema,
        bskVersion: nonEmptyStringSchema,
        extensionVersion: nonEmptyStringSchema,
        cliShapeHash: nonEmptyStringSchema,
      },
      true,
    ),
  ),
  "relay.challenge": messageSchema(
    "relay.challenge",
    objectSchema(
      [
        "relayInstanceId",
        "challengeNonce",
        "deploymentCanonicalId",
        "brokerInstanceId",
        "browserInstanceId",
        "connectionEpoch",
      ],
      {
        relayInstanceId: nonEmptyStringSchema,
        challengeNonce: nonEmptyStringSchema,
        deploymentCanonicalId: canonicalLexicalStringSchema,
        brokerInstanceId: canonicalLexicalStringSchema,
        browserInstanceId: canonicalLexicalStringSchema,
        connectionEpoch: positiveIntegerSchema,
      },
      true,
    ),
  ),
  "host.challenge-response": messageSchema(
    "host.challenge-response",
    objectSchema(
      [
        "relayInstanceId",
        "deploymentCanonicalId",
        "devicePublicKey",
        "brokerInstanceId",
        "browserInstanceId",
        "connectionEpoch",
        "challengeNonce",
        "signatureAlgorithm",
        "signature",
      ],
      {
        relayInstanceId: nonEmptyStringSchema,
        deploymentCanonicalId: canonicalLexicalStringSchema,
        devicePublicKey: nonEmptyStringSchema,
        brokerInstanceId: nonEmptyStringSchema,
        browserInstanceId: canonicalLexicalStringSchema,
        connectionEpoch: positiveIntegerSchema,
        challengeNonce: nonEmptyStringSchema,
        signatureAlgorithm: { const: "ed25519" },
        signature: nonEmptyStringSchema,
      },
      true,
    ),
  ),
  "relay.invoke": strictMessageSchema(
    "relay.invoke",
    strictObjectSchema(["dispatchId", "requestHash", "authority"], {
      dispatchId: nonEmptyStringSchema,
      requestHash: nonEmptyStringSchema,
      authority: desktopBrowserSessionStartAuthorityEnvelopeSchema,
    }),
  ),
  "host.accepted": strictMessageSchema(
    "host.accepted",
    strictObjectSchema(["dispatchId", "operationId", "requestHash"], {
      dispatchId: nonEmptyStringSchema,
      operationId: nonEmptyStringSchema,
      requestHash: nonEmptyStringSchema,
    }),
  ),
  "host.artifact-intent": strictMessageSchema(
    "host.artifact-intent",
    strictObjectSchema(
      [
        "artifactIntentId",
        "taskId",
        "attemptId",
        "operationId",
        "requestHash",
        "deviceId",
        "actorId",
        "projectId",
        "leaseId",
        "leaseVersion",
        "leaseExpiresAt",
        "name",
        "contentType",
        "sizeBytes",
        "expectedSha256",
      ],
      {
        artifactIntentId: canonicalLexicalStringSchema,
        taskId: canonicalLexicalStringSchema,
        attemptId: canonicalLexicalStringSchema,
        operationId: canonicalLexicalStringSchema,
        requestHash: canonicalLexicalStringSchema,
        deviceId: canonicalLexicalStringSchema,
        actorId: canonicalLexicalStringSchema,
        projectId: canonicalLexicalStringSchema,
        leaseId: canonicalLexicalStringSchema,
        leaseVersion: positiveIntegerSchema,
        leaseExpiresAt: canonicalUtcMillisecondInstantSchema,
        name: canonicalLexicalStringSchema,
        contentType: canonicalLexicalStringSchema,
        sizeBytes: { type: "integer", minimum: 1, maximum: DESKTOP_BROWSER_MAX_ARTIFACT_BYTES },
        expectedSha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      },
    ),
  ),
  "relay.artifact-grant": strictMessageSchema(
    "relay.artifact-grant",
    strictObjectSchema(["artifactIntentId", "operationId", "uploadUrl", "bearerToken", "expiresAt"], {
      artifactIntentId: canonicalLexicalStringSchema,
      operationId: canonicalLexicalStringSchema,
      uploadUrl: { type: "string", pattern: "^https://\\S+$" },
      bearerToken: canonicalLexicalStringSchema,
      expiresAt: canonicalUtcMillisecondInstantSchema,
    }),
  ),
  "relay.artifact-grant-failed": strictMessageSchema(
    "relay.artifact-grant-failed",
    strictObjectSchema(["artifactIntentId", "operationId", "error"], {
      artifactIntentId: canonicalLexicalStringSchema,
      operationId: canonicalLexicalStringSchema,
      error: desktopBrowserHostFailureSchema,
    }),
  ),
  "host.result": strictMessageSchema(
    "host.result",
    strictObjectSchema(["dispatchId", "operationId", "outcome", "resultHash"], {
      dispatchId: nonEmptyStringSchema,
      operationId: nonEmptyStringSchema,
      outcome: { enum: ["completed", "failed", "unknown"] },
      resultHash: nonEmptyStringSchema,
      result: desktopBrowserSessionStartResultSchema,
      error: desktopBrowserHostFailureSchema,
      artifact: strictObjectSchema(["artifactId", "name", "contentType", "sizeBytes", "sha256"], {
        artifactId: { type: "string", pattern: "^[0-9a-f]{32}$" },
        name: canonicalLexicalStringSchema,
        contentType: canonicalLexicalStringSchema,
        sizeBytes: positiveIntegerSchema,
        sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
      }),
      artifactWarning: desktopBrowserHostFailureSchema,
    }),
  ),
  "host.local-stop-receipt": strictMessageSchema(
    "host.local-stop-receipt",
    strictObjectSchema(
      [
        "receiptId",
        "processEpoch",
        "taskId",
        "attemptId",
        "operationId",
        "operationCategory",
        "requestedAt",
        "status",
      ],
      {
        receiptId: canonicalLexicalStringSchema,
        processEpoch: positiveIntegerSchema,
        taskId: canonicalLexicalStringSchema,
        attemptId: canonicalLexicalStringSchema,
        operationId: canonicalLexicalStringSchema,
        operationCategory: { enum: ["session_start", "browser_effect", "observation", "session_cleanup"] },
        requestedAt: positiveIntegerSchema,
        status: { enum: ["requested", "canceled"] },
      },
    ),
  ),
  "relay.local-stop-ack": strictMessageSchema(
    "relay.local-stop-ack",
    strictObjectSchema(["receiptId"], { receiptId: canonicalLexicalStringSchema }),
  ),
  "relay.result-ack": strictMessageSchema(
    "relay.result-ack",
    strictObjectSchema(["operationId", "resultHash"], {
      operationId: canonicalLexicalStringSchema,
      resultHash: canonicalLexicalStringSchema,
    }),
  ),
  "host.device-reconciled": strictMessageSchema(
    "host.device-reconciled",
    strictObjectSchema(["reconciliationId", "processEpoch", "confirmedAt"], {
      reconciliationId: canonicalLexicalStringSchema,
      processEpoch: positiveIntegerSchema,
      confirmedAt: positiveIntegerSchema,
    }),
  ),
  "relay.device-reconcile-ack": strictMessageSchema(
    "relay.device-reconcile-ack",
    strictObjectSchema(["reconciliationId"], { reconciliationId: canonicalLexicalStringSchema }),
  ),
  "companion.status": messageSchema(
    "companion.status",
    objectSchema(
      ["brokerStatus", "browserSkillStatus", "currentTaskPresent"],
      {
        brokerStatus: { enum: ["ready", "paused", "disconnected"] },
        browserSkillStatus: { enum: ["ready", "offline"] },
        currentTaskPresent: { type: "boolean" },
      },
      true,
    ),
  ),
} as const;

const relayInvocationAdditiveMessageSchema = messageSchema(
  "relay.invoke",
  strictObjectSchema(["dispatchId", "requestHash", "authority"], {
    dispatchId: nonEmptyStringSchema,
    requestHash: nonEmptyStringSchema,
    authority: desktopBrowserOperationAuthorityEnvelopeSchema,
  }),
);

const hostAcceptedAdditiveMessageSchema = messageSchema(
  "host.accepted",
  strictObjectSchema(["dispatchId", "operationId", "requestHash"], {
    dispatchId: nonEmptyStringSchema,
    operationId: nonEmptyStringSchema,
    requestHash: nonEmptyStringSchema,
  }),
);

const hostResultAdditiveMessageSchema = messageSchema(
  "host.result",
  strictObjectSchema(["dispatchId", "operationId", "outcome", "resultHash"], {
    dispatchId: nonEmptyStringSchema,
    operationId: nonEmptyStringSchema,
    outcome: { enum: ["completed", "failed", "unknown"] },
    resultHash: nonEmptyStringSchema,
    result: {
      anyOf: [
        desktopBrowserSessionStartResultSchema,
        desktopBrowserSanitizedNavigateResultSchema,
        desktopBrowserSanitizedObservationResultSchema,
        desktopBrowserSanitizedSessionStopResultSchema,
      ],
    },
    error: desktopBrowserHostFailureSchema,
    artifact: strictObjectSchema(["artifactId", "name", "contentType", "sizeBytes", "sha256"], {
      artifactId: { type: "string", pattern: "^[0-9a-f]{32}$" },
      name: canonicalLexicalStringSchema,
      contentType: canonicalLexicalStringSchema,
      sizeBytes: positiveIntegerSchema,
      sha256: { type: "string", pattern: "^[0-9a-f]{64}$" },
    }),
    artifactWarning: desktopBrowserHostFailureSchema,
  }),
);

const messageParsers = Object.fromEntries(
  Object.entries(desktopBrowserMessageSchemas).map(([kind, schema]) => [
    kind,
    fromJSONSchema(schema as unknown as Parameters<typeof fromJSONSchema>[0]),
  ]),
) as Record<DesktopBrowserMessageKind, ReturnType<typeof fromJSONSchema>>;
const relayInvocationAdditiveMessageParser = fromJSONSchema(
  relayInvocationAdditiveMessageSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const hostAcceptedAdditiveMessageParser = fromJSONSchema(
  hostAcceptedAdditiveMessageSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const hostResultAdditiveMessageParser = fromJSONSchema(
  hostResultAdditiveMessageSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);

const registrationReservationTupleParser = fromJSONSchema(
  desktopBrowserRegistrationReservationTupleSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const registrationReservationTupleAdditiveParser = fromJSONSchema(
  desktopBrowserRegistrationReservationTupleAdditiveSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const publicIdentityParser = fromJSONSchema(
  desktopBrowserPublicIdentitySchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const publicIdentityAdditiveParser = fromJSONSchema(
  desktopBrowserPublicIdentityAdditiveSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const registrationConfirmationEnvelopeParser = fromJSONSchema(
  desktopBrowserRegistrationConfirmationEnvelopeSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const registrationConfirmationEnvelopeAdditiveParser = fromJSONSchema(
  desktopBrowserRegistrationConfirmationEnvelopeAdditiveSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const onlineDeviceProjectionAdditiveParser = fromJSONSchema(
  desktopBrowserOnlineDeviceProjectionAdditiveSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const relayConnectionProjectionParser = fromJSONSchema(
  desktopBrowserRelayConnectionProjectionSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const relayConnectionPublishRequestParser = fromJSONSchema(
  desktopBrowserRelayConnectionPublishRequestSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const capabilitySetParser = fromJSONSchema(
  desktopBrowserCapabilitySetSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const brokerOptionsParser = fromJSONSchema(
  desktopBrowserBrokerOptionsSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const sessionStartAuthorityEnvelopeParser = fromJSONSchema(
  desktopBrowserSessionStartAuthorityEnvelopeSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
const operationAuthorityEnvelopeParser = fromJSONSchema(
  desktopBrowserOperationAuthorityEnvelopeSchema as unknown as Parameters<typeof fromJSONSchema>[0],
);
export function encodeDesktopBrowserMessage(message: DesktopBrowserMessage): string {
  return JSON.stringify(message);
}

function protocolMajor(version: string): string {
  const match = protocolVersionPattern.exec(version);
  if (!match) throw new Error(`invalid desktop browser protocol version ${JSON.stringify(version)}`);
  return match[1]!.replace(/^0+(?=[0-9])/, "");
}

function protocolMinor(version: string): number {
  const match = protocolVersionPattern.exec(version);
  if (!match) throw new Error(`invalid desktop browser protocol version ${JSON.stringify(version)}`);
  return Number(match[2]);
}

function assertCanonicalProtocolVersion(version: string, label: string): void {
  if (!canonicalProtocolVersionPattern.test(version)) {
    throw new Error(`${label} must use canonical major.minor lexical form`);
  }
}

function assertCanonicalUtcMillisecondInstant(value: string, label: string): void {
  if (!canonicalUtcMillisecondInstantPattern.test(value)) {
    throw new Error(`${label} must use canonical UTC millisecond instant form`);
  }
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime()) || instant.toISOString() !== value) {
    throw new Error(`${label} must use canonical UTC millisecond instant form`);
  }
}

function isCompatibleAdditiveMinorVersion(version: unknown, supportedVersion: string): version is string {
  if (typeof version !== "string") return false;
  try {
    return (
      isDesktopBrowserProtocolCompatible(version, supportedVersion) &&
      protocolMinor(version) > protocolMinor(supportedVersion)
    );
  } catch {
    return false;
  }
}

export function isDesktopBrowserProtocolCompatible(remoteVersion: string, supportedVersion: string): boolean {
  return protocolMajor(remoteVersion) === protocolMajor(supportedVersion);
}

function assertTicket05OperationVersion(
  message: RelayInvocationMessage | HostAcceptedMessage | HostResultMessage,
): void {
  assertCanonicalProtocolVersion(message.protocolVersion, "protocolVersion");
  if (
    !isDesktopBrowserProtocolCompatible(message.protocolVersion, DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION) ||
    protocolMinor(message.protocolVersion) < protocolMinor(DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION)
  ) {
    throw new Error(
      `${message.kind} requires Ticket 05 protocol version ${DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION} or newer compatible minor`,
    );
  }
}

function pickDesktopBrowserMessageParser(
  kind: DesktopBrowserMessageKind,
  supportedVersion: string,
): ReturnType<typeof fromJSONSchema> {
  if (
    kind === "relay.invoke" &&
    isCompatibleAdditiveMinorVersion(supportedVersion, DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION)
  ) {
    return relayInvocationAdditiveMessageParser;
  }
  if (
    kind === "host.accepted" &&
    isCompatibleAdditiveMinorVersion(supportedVersion, DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION)
  ) {
    return hostAcceptedAdditiveMessageParser;
  }
  if (
    kind === "host.result" &&
    isCompatibleAdditiveMinorVersion(supportedVersion, DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION)
  ) {
    return hostResultAdditiveMessageParser;
  }
  return messageParsers[kind];
}

function assertNegotiatedOperationVersion(
  kind: DesktopBrowserMessageKind,
  raw: Record<string, unknown>,
  supportedVersion: string,
): void {
  if (kind !== "relay.invoke" && kind !== "host.accepted" && kind !== "host.result") return;
  assertCanonicalProtocolVersion(supportedVersion, "supportedVersion");
  if (typeof raw.protocolVersion === "string" && raw.protocolVersion !== supportedVersion) {
    throw new Error(
      `${kind} protocol version ${raw.protocolVersion} does not equal negotiated version ${supportedVersion}`,
    );
  }
}

export function decodeDesktopBrowserMessage(
  encoded: string,
  supportedVersion: string = DESKTOP_BROWSER_PROTOCOL_VERSION,
  expectedPolicyGrammarVersion: string = DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION,
): DesktopBrowserMessage {
  const raw: unknown = JSON.parse(encoded);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("desktop browser message must be a JSON object");
  }
  const kind = (raw as Record<string, unknown>)["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(messageParsers, kind)) {
    throw new Error(`unsupported desktop browser message kind ${JSON.stringify(kind)}`);
  }
  assertNegotiatedOperationVersion(kind as DesktopBrowserMessageKind, raw as Record<string, unknown>, supportedVersion);
  const parsed = pickDesktopBrowserMessageParser(kind as DesktopBrowserMessageKind, supportedVersion).safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${kind} message does not match its schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  const message = parsed.data as DesktopBrowserMessage;
  if (!isDesktopBrowserProtocolCompatible(message.protocolVersion, supportedVersion)) {
    throw new Error(
      `protocol major ${protocolMajor(message.protocolVersion)} is incompatible with supported major ${protocolMajor(supportedVersion)}`,
    );
  }
  if (message.kind === "relay.invoke") {
    assertTicket05OperationVersion(message);
    const authority =
      protocolMinor(supportedVersion) >= protocolMinor(DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION)
        ? parseDesktopBrowserOperationAuthorityEnvelope(
            message.payload.authority,
            supportedVersion,
            expectedPolicyGrammarVersion,
          )
        : parseDesktopBrowserSessionStartAuthorityEnvelope(
            message.payload.authority,
            supportedVersion,
            expectedPolicyGrammarVersion,
          );
    const canonicalRequestHash = computeDesktopBrowserRequestHash(
      authority,
      supportedVersion,
      expectedPolicyGrammarVersion,
    );
    if (message.payload.requestHash !== canonicalRequestHash) {
      throw new Error(
        `relay.invoke requestHash ${JSON.stringify(message.payload.requestHash)} does not match canonical request hash ${JSON.stringify(canonicalRequestHash)}`,
      );
    }
    return {
      protocolVersion: message.protocolVersion,
      kind: message.kind,
      payload: {
        dispatchId: message.payload.dispatchId,
        requestHash: canonicalRequestHash,
        authority,
      },
    };
  }
  if (message.kind === "host.accepted") {
    assertTicket05OperationVersion(message);
    return canonicalizeDesktopBrowserHostAccepted(message);
  }
  if (message.kind === "host.result") {
    assertTicket05OperationVersion(message);
    assertDesktopBrowserHostResult(message);
    return canonicalizeDesktopBrowserHostResult(message);
  }
  return message;
}

function canonicalizeDesktopBrowserHostAccepted(message: HostAcceptedMessage): HostAcceptedMessage {
  return {
    protocolVersion: message.protocolVersion,
    kind: message.kind,
    payload: {
      dispatchId: message.payload.dispatchId,
      operationId: message.payload.operationId,
      requestHash: message.payload.requestHash,
    },
  };
}

function canonicalizeDesktopBrowserHostResult(message: HostResultMessage): HostResultMessage {
  const payload = message.payload;
  if (payload.outcome === "completed") {
    let artifactMetadata: Pick<typeof payload, "artifact" | "artifactWarning"> = {};
    if (payload.artifact) {
      artifactMetadata = {
        artifact: {
          artifactId: payload.artifact.artifactId,
          name: payload.artifact.name,
          contentType: payload.artifact.contentType,
          sizeBytes: payload.artifact.sizeBytes,
          sha256: payload.artifact.sha256,
        },
      };
    } else if (payload.artifactWarning) {
      artifactMetadata = {
        artifactWarning: { code: payload.artifactWarning.code, message: payload.artifactWarning.message },
      };
    }
    if ("schemaVersion" in payload.result && payload.result.command === "session.stop") {
      return {
        protocolVersion: message.protocolVersion,
        kind: message.kind,
        payload: {
          dispatchId: payload.dispatchId,
          operationId: payload.operationId,
          outcome: "completed",
          resultHash: payload.resultHash,
          ...artifactMetadata,
          result: {
            schemaVersion: payload.result.schemaVersion,
            command: payload.result.command,
            completedAt: payload.result.completedAt,
            data: {
              returned_tab_ids: [...payload.result.data.returned_tab_ids],
              return_failures: payload.result.data.return_failures.map((failure) => ({
                tab_id: failure.tab_id,
                code: failure.code,
              })),
            },
          },
        },
      };
    }
    if ("schemaVersion" in payload.result && payload.result.command === "navigate") {
      return {
        protocolVersion: message.protocolVersion,
        kind: message.kind,
        payload: {
          dispatchId: payload.dispatchId,
          operationId: payload.operationId,
          outcome: "completed",
          resultHash: payload.resultHash,
          ...artifactMetadata,
          result: {
            schemaVersion: payload.result.schemaVersion,
            command: payload.result.command,
            completedAt: payload.result.completedAt,
            data: {
              tab_id: payload.result.data.tab_id,
              reached: payload.result.data.reached,
            },
          },
        },
      };
    }
    if ("schemaVersion" in payload.result) {
      return {
        protocolVersion: message.protocolVersion,
        kind: message.kind,
        payload: {
          dispatchId: payload.dispatchId,
          operationId: payload.operationId,
          outcome: "completed",
          resultHash: payload.resultHash,
          ...artifactMetadata,
          result: {
            schemaVersion: payload.result.schemaVersion,
            command: payload.result.command,
            completedAt: payload.result.completedAt,
            data: {
              tab_id: payload.result.data.tab_id,
              text: payload.result.data.text,
              ref_count: payload.result.data.ref_count,
              truncated: payload.result.data.truncated,
            },
          },
        },
      };
    }
    return {
      protocolVersion: message.protocolVersion,
      kind: message.kind,
      payload: {
        dispatchId: payload.dispatchId,
        operationId: payload.operationId,
        outcome: "completed",
        resultHash: payload.resultHash,
        ...artifactMetadata,
        result: {
          session_id: payload.result.session_id,
          browser_instance_id: payload.result.browser_instance_id,
          agent_window_id: payload.result.agent_window_id,
        },
      },
    };
  }
  return {
    protocolVersion: message.protocolVersion,
    kind: message.kind,
    payload: {
      dispatchId: payload.dispatchId,
      operationId: payload.operationId,
      outcome: payload.outcome,
      resultHash: payload.resultHash,
      ...(payload.error === undefined ? {} : { error: { code: payload.error.code, message: payload.error.message } }),
    },
  };
}

function assertDesktopBrowserHostResult(message: HostResultMessage): void {
  const payload = message.payload as unknown as Record<string, unknown>;
  if (payload.outcome === "completed") {
    if (payload.result === undefined) {
      throw new Error("host.result message does not match its schema: completed session start requires result");
    }
    if (payload.error !== undefined) {
      throw new Error("host.result message does not match its schema: completed session start cannot include error");
    }
    if (payload.artifact !== undefined && payload.artifactWarning !== undefined) {
      throw new Error("host.result message cannot include both artifact and artifactWarning");
    }
    return;
  }
  if (payload.result !== undefined || payload.artifact !== undefined || payload.artifactWarning !== undefined) {
    throw new Error("host.result message does not match its schema: result is only valid for completed session start");
  }
}

function parseDesktopBrowserRecord<T>(parser: ReturnType<typeof fromJSONSchema>, label: string, raw: unknown): T {
  const parsed = parser.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${label} does not match its schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data as T;
}

function pickRegistrationTupleParser(raw: unknown): ReturnType<typeof fromJSONSchema> {
  const version =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).registrationProtocolVersion : undefined;
  return isCompatibleAdditiveMinorVersion(version, DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION)
    ? registrationReservationTupleAdditiveParser
    : registrationReservationTupleParser;
}

function pickPublicIdentityParser(raw: unknown): ReturnType<typeof fromJSONSchema> {
  const version = raw && typeof raw === "object" ? (raw as Record<string, unknown>).publicIdentityVersion : undefined;
  return isCompatibleAdditiveMinorVersion(version, DESKTOP_BROWSER_PUBLIC_IDENTITY_VERSION)
    ? publicIdentityAdditiveParser
    : publicIdentityParser;
}

function pickRegistrationConfirmationEnvelopeParser(raw: unknown): ReturnType<typeof fromJSONSchema> {
  const registrationTuple =
    raw && typeof raw === "object" ? (raw as Record<string, unknown>).registrationTuple : undefined;
  const version =
    registrationTuple && typeof registrationTuple === "object"
      ? (registrationTuple as Record<string, unknown>).registrationProtocolVersion
      : undefined;
  return isCompatibleAdditiveMinorVersion(version, DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION)
    ? registrationConfirmationEnvelopeAdditiveParser
    : registrationConfirmationEnvelopeParser;
}

export function parseDesktopBrowserRegistrationReservationTuple(
  raw: unknown,
): DesktopBrowserRegistrationReservationTuple {
  const tuple = parseDesktopBrowserRecord<DesktopBrowserRegistrationReservationTuple>(
    pickRegistrationTupleParser(raw),
    "desktop browser registration reservation tuple",
    raw,
  );
  if (
    !isDesktopBrowserProtocolCompatible(
      tuple.registrationProtocolVersion,
      DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION,
    )
  ) {
    throw new Error(
      `registration protocol major ${protocolMajor(tuple.registrationProtocolVersion)} is incompatible with supported major ${protocolMajor(DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION)}`,
    );
  }
  assertCanonicalProtocolVersion(tuple.registrationProtocolVersion, "registrationProtocolVersion");
  assertCanonicalUtcMillisecondInstant(tuple.expiresAt, "expiresAt");
  return canonicalizeDesktopBrowserRegistrationReservationTuple(tuple);
}

export function parseDesktopBrowserPublicIdentity(raw: unknown): DesktopBrowserPublicIdentity {
  const identity = parseDesktopBrowserRecord<DesktopBrowserPublicIdentity>(
    pickPublicIdentityParser(raw),
    "desktop browser public identity",
    raw,
  );
  if (!isDesktopBrowserProtocolCompatible(identity.publicIdentityVersion, DESKTOP_BROWSER_PUBLIC_IDENTITY_VERSION)) {
    throw new Error(
      `public identity protocol major ${protocolMajor(identity.publicIdentityVersion)} is incompatible with supported major ${protocolMajor(DESKTOP_BROWSER_PUBLIC_IDENTITY_VERSION)}`,
    );
  }
  assertCanonicalProtocolVersion(identity.publicIdentityVersion, "publicIdentityVersion");
  return canonicalizeDesktopBrowserPublicIdentity(identity);
}

export function projectDesktopBrowserPublicIdentity(raw: unknown): DesktopBrowserPublicIdentity {
  const tuple = parseDesktopBrowserRegistrationReservationTuple(raw);
  return {
    publicIdentityVersion: tuple.registrationProtocolVersion,
    deploymentCanonicalId: tuple.deploymentCanonicalId,
    devicePublicKey: tuple.devicePublicKey,
    brokerInstanceId: tuple.brokerInstanceId,
    browserInstanceId: tuple.browserInstanceId,
  };
}

export function parseDesktopBrowserRegistrationConfirmationEnvelope(
  raw: unknown,
): DesktopBrowserRegistrationConfirmationEnvelope {
  const envelope = parseDesktopBrowserRecord<DesktopBrowserRegistrationConfirmationEnvelope>(
    pickRegistrationConfirmationEnvelopeParser(raw),
    "desktop browser registration confirmation envelope",
    raw,
  );
  const tuple = parseDesktopBrowserRegistrationReservationTuple(envelope.registrationTuple);
  const publicIdentity = parseDesktopBrowserPublicIdentity(envelope.publicIdentity);
  const projectedPublicIdentity = projectDesktopBrowserPublicIdentity(tuple);
  if (
    JSON.stringify(canonicalizeDesktopBrowserPublicIdentity(publicIdentity)) !== JSON.stringify(projectedPublicIdentity)
  ) {
    throw new Error(
      "desktop browser registration confirmation envelope public identity must exactly project the registration tuple",
    );
  }
  const tupleConfirmationFingerprint = computeDesktopBrowserRegistrationConfirmationFingerprint(tuple);
  if (envelope.confirmationFingerprint !== tupleConfirmationFingerprint) {
    throw new Error(
      `desktop browser registration confirmation envelope confirmationFingerprint ${JSON.stringify(envelope.confirmationFingerprint)} does not match tuple confirmation fingerprint ${JSON.stringify(tupleConfirmationFingerprint)}`,
    );
  }
  return {
    registrationTuple: tuple,
    publicIdentity: projectedPublicIdentity,
    confirmationFingerprint: tupleConfirmationFingerprint,
    signatureAlgorithm: envelope.signatureAlgorithm,
    signature: envelope.signature,
  };
}

export function parseDesktopBrowserOnlineDeviceProjection(raw: unknown): DesktopBrowserOnlineDeviceProjection {
  const projection = parseDesktopBrowserRecord<DesktopBrowserOnlineDeviceProjection>(
    onlineDeviceProjectionAdditiveParser,
    "desktop browser online device projection",
    raw,
  );
  assertCanonicalUtcMillisecondInstant(projection.lastSeenAt, "lastSeenAt");
  return {
    publicDeviceFingerprint: projection.publicDeviceFingerprint,
    browserInstanceId: projection.browserInstanceId,
    operatingSystem: projection.operatingSystem,
    status: projection.status,
    browserRuntimeStatus: projection.browserRuntimeStatus,
    lastSeenAt: projection.lastSeenAt,
  };
}

export function parseDesktopBrowserRelayConnectionProjection(raw: unknown): DesktopBrowserRelayConnectionProjection {
  const projection = parseDesktopBrowserRecord<DesktopBrowserRelayConnectionProjection>(
    relayConnectionProjectionParser,
    "desktop browser relay connection projection",
    raw,
  );
  if (!isDesktopBrowserProtocolCompatible(projection.protocolVersion, DESKTOP_BROWSER_PROTOCOL_VERSION)) {
    throw new Error(
      `relay connection protocol major ${protocolMajor(projection.protocolVersion)} is incompatible with supported major ${protocolMajor(DESKTOP_BROWSER_PROTOCOL_VERSION)}`,
    );
  }
  if (!isDesktopBrowserProtocolCompatible(projection.policyGrammarVersion, DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION)) {
    throw new Error(
      `relay connection policy grammar major ${protocolMajor(projection.policyGrammarVersion)} is incompatible with supported major ${protocolMajor(DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION)}`,
    );
  }
  assertCanonicalProtocolVersion(projection.protocolVersion, "protocolVersion");
  assertCanonicalProtocolVersion(projection.policyGrammarVersion, "policyGrammarVersion");
  assertCanonicalUtcMillisecondInstant(projection.lastSeenAt, "lastSeenAt");
  return canonicalizeDesktopBrowserRelayConnectionProjection(projection);
}

export function parseDesktopBrowserRelayConnectionPublishRequest(
  raw: unknown,
): DesktopBrowserRelayConnectionPublishRequest {
  const request = parseDesktopBrowserRecord<DesktopBrowserRelayConnectionPublishRequest>(
    relayConnectionPublishRequestParser,
    "desktop browser relay connection publish request",
    raw,
  );
  return {
    projection: parseDesktopBrowserRelayConnectionProjection(request.projection),
  };
}

export function parseDesktopBrowserCapabilitySet(
  raw: unknown,
  expectedProtocolVersion: string = DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  expectedPolicyGrammarVersion: string = DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION,
): DesktopBrowserCapabilitySet {
  const capabilitySet = parseDesktopBrowserRecord<DesktopBrowserCapabilitySet>(
    capabilitySetParser,
    "desktop browser capability set",
    raw,
  );
  assertCanonicalProtocolVersion(expectedProtocolVersion, "expectedProtocolVersion");
  assertCanonicalProtocolVersion(expectedPolicyGrammarVersion, "expectedPolicyGrammarVersion");
  if (capabilitySet.protocolVersion !== expectedProtocolVersion) {
    throw new Error(
      `capability protocol version ${capabilitySet.protocolVersion} does not equal expected version ${expectedProtocolVersion}`,
    );
  }
  if (capabilitySet.policyGrammarVersion !== expectedPolicyGrammarVersion) {
    throw new Error(
      `capability policy grammar version ${capabilitySet.policyGrammarVersion} does not equal expected version ${expectedPolicyGrammarVersion}`,
    );
  }
  assertCanonicalProtocolVersion(capabilitySet.protocolVersion, "protocolVersion");
  assertCanonicalProtocolVersion(capabilitySet.policyGrammarVersion, "policyGrammarVersion");
  return {
    protocolVersion: capabilitySet.protocolVersion,
    policyGrammarVersion: capabilitySet.policyGrammarVersion,
    bskVersion: capabilitySet.bskVersion,
    extensionVersion: capabilitySet.extensionVersion,
    cliShapeHash: capabilitySet.cliShapeHash,
  };
}

export function buildDesktopBrowserSessionStartArgv(browserInstanceId: string): DesktopBrowserSessionStartArgv {
  if (!new RegExp(CANONICAL_LEXICAL_STRING_PATTERN).test(browserInstanceId)) {
    throw new Error("browserInstanceId must be a canonical lexical string");
  }
  return ["--json", "session", "start", "--browser", browserInstanceId];
}

export function validateDesktopBrowserSessionStartArgv(
  raw: unknown,
  browserInstanceId: string,
): DesktopBrowserSessionStartArgv {
  const expected = buildDesktopBrowserSessionStartArgv(browserInstanceId);
  if (!Array.isArray(raw) || raw.length !== expected.length || raw.some((value, index) => value !== expected[index])) {
    throw new Error(`argv must equal canonical session-start argv ${JSON.stringify(expected)}`);
  }
  return [...expected];
}

export function buildDesktopBrowserNavigateArgv(url: string, sessionId: string): DesktopBrowserNavigateArgv {
  if (!new RegExp(CANONICAL_LEXICAL_STRING_PATTERN).test(url)) {
    throw new Error("url must be a canonical lexical string");
  }
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new Error("url must be one absolute HTTPS URL");
  }
  const hostname = target.hostname.toLowerCase().replace(/\.$/, "");
  const isIpLiteral = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname) || (hostname.startsWith("[") && hostname.endsWith("]"));
  const isLocalHostname =
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    hostname.endsWith(".internal");
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password ||
    hostname.length === 0 ||
    isIpLiteral ||
    isLocalHostname
  ) {
    throw new Error("url must be one credential-free absolute HTTPS URL with a public DNS hostname");
  }
  if (!new RegExp(CANONICAL_LEXICAL_STRING_PATTERN).test(sessionId)) {
    throw new Error("sessionId must be a canonical lexical string");
  }
  return ["--json", "navigate", url, "--session", sessionId];
}

export function validateDesktopBrowserNavigateArgv(raw: unknown, sessionId: string): DesktopBrowserNavigateArgv {
  if (!Array.isArray(raw) || raw.length !== 5 || typeof raw[2] !== "string") {
    throw new Error("argv must equal canonical navigate argv");
  }
  const expected = buildDesktopBrowserNavigateArgv(raw[2], sessionId);
  if (raw.some((value, index) => value !== expected[index])) {
    throw new Error(`argv must equal canonical navigate argv ${JSON.stringify(expected)}`);
  }
  return [...expected];
}

export function buildDesktopBrowserObserveArgv(sessionId: string): DesktopBrowserObserveArgv {
  if (!new RegExp(CANONICAL_LEXICAL_STRING_PATTERN).test(sessionId)) {
    throw new Error("sessionId must be a canonical lexical string");
  }
  return ["--json", "observe", "--session", sessionId];
}

export function validateDesktopBrowserObserveArgv(raw: unknown, sessionId: string): DesktopBrowserObserveArgv {
  const expected = buildDesktopBrowserObserveArgv(sessionId);
  if (!Array.isArray(raw) || raw.length !== expected.length || raw.some((value, index) => value !== expected[index])) {
    throw new Error(`argv must equal canonical observe argv ${JSON.stringify(expected)}`);
  }
  return [...expected];
}

export function buildDesktopBrowserSessionStopArgv(sessionId: string): DesktopBrowserSessionStopArgv {
  if (!new RegExp(CANONICAL_LEXICAL_STRING_PATTERN).test(sessionId)) {
    throw new Error("sessionId must be a canonical lexical string");
  }
  return ["--json", "session", "stop", sessionId];
}

export function validateDesktopBrowserSessionStopArgv(raw: unknown, sessionId: string): DesktopBrowserSessionStopArgv {
  const expected = buildDesktopBrowserSessionStopArgv(sessionId);
  if (!Array.isArray(raw) || raw.length !== expected.length || raw.some((value, index) => value !== expected[index])) {
    throw new Error(`argv must equal canonical session-stop argv ${JSON.stringify(expected)}`);
  }
  return [...expected];
}

export function validateDesktopBrowserPhaseFArgv(
  raw: unknown,
  bindings: DesktopBrowserPhaseFArgvBindings,
): DesktopBrowserPhaseFArgv {
  if (!Array.isArray(raw) || raw[0] !== "--json") {
    throw new Error("browser_cli_policy_missing: argv does not match a Phase F command");
  }
  if (raw[1] === "session" && raw[2] === "start") {
    return validateDesktopBrowserSessionStartArgv(raw, bindings.browserInstanceId);
  }
  if (bindings.sessionId === undefined) {
    throw new Error("browser_cli_policy_missing: Task-owned session is required");
  }
  if (raw[1] === "navigate") return validateDesktopBrowserNavigateArgv(raw, bindings.sessionId);
  if (raw[1] === "observe") return validateDesktopBrowserObserveArgv(raw, bindings.sessionId);
  if (raw[1] === "session" && raw[2] === "stop") {
    return validateDesktopBrowserSessionStopArgv(raw, bindings.sessionId);
  }
  throw new Error("browser_cli_policy_missing: argv does not match a Phase F command");
}

function phaseFSessionId(argv: readonly string[]): string | undefined {
  if (argv[1] === "navigate") return argv[4];
  if (argv[1] === "observe") return argv[3];
  if (argv[1] === "session" && argv[2] === "stop") return argv[3];
  return undefined;
}

function phaseFEffectClass(argv: DesktopBrowserPhaseFArgv): DesktopBrowserEffectClass {
  if (argv[1] === "navigate") return "browser_effect";
  if (argv[1] === "observe") return "observation";
  if (argv[1] === "session" && argv[2] === "stop") return "cleanup";
  return "local_effect";
}

export function parseDesktopBrowserOperationAuthorityEnvelope(
  raw: unknown,
  expectedProtocolVersion: string = DESKTOP_BROWSER_TICKET_06_PROTOCOL_VERSION,
  expectedPolicyGrammarVersion: string = DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION,
): DesktopBrowserOperationAuthorityEnvelope {
  const authority = parseDesktopBrowserRecord<DesktopBrowserOperationAuthorityEnvelope>(
    operationAuthorityEnvelopeParser,
    "desktop browser operation authority envelope",
    raw,
  );
  if (!isDesktopBrowserProtocolCompatible(authority.authorityVersion, DESKTOP_BROWSER_AUTHORITY_VERSION)) {
    throw new Error(
      `authority protocol major ${protocolMajor(authority.authorityVersion)} is incompatible with supported major ${protocolMajor(DESKTOP_BROWSER_AUTHORITY_VERSION)}`,
    );
  }
  assertCanonicalProtocolVersion(authority.authorityVersion, "authorityVersion");
  assertCanonicalUtcMillisecondInstant(authority.issuedAt, "issuedAt");
  assertCanonicalUtcMillisecondInstant(authority.leaseExpiresAt, "leaseExpiresAt");
  if (
    Date.parse(authority.leaseExpiresAt) - Date.parse(authority.issuedAt) !==
    DESKTOP_BROWSER_TASK_LEASE_DURATION_MS
  ) {
    throw new Error("desktop browser operation authority lease must expire exactly 60 seconds after issuedAt");
  }
  const capabilitySet = parseDesktopBrowserCapabilitySet(
    authority.capabilitySet,
    expectedProtocolVersion,
    expectedPolicyGrammarVersion,
  );
  const argv = validateDesktopBrowserPhaseFArgv(authority.argv, {
    browserInstanceId: authority.browserInstanceId,
    sessionId: phaseFSessionId(authority.argv),
  });
  const effectClass = phaseFEffectClass(argv);
  if (authority.effectClass !== effectClass) {
    throw new Error(`desktop browser operation authority effect class does not match ${argv[1]}`);
  }
  if (authority.brokerOptions.forceSharedRuntime) {
    throw new Error("desktop browser operation authority forceSharedRuntime must be false for Phase F");
  }
  return {
    ...authority,
    capabilitySet,
    argv,
    brokerOptions: { forceSharedRuntime: false },
    effectClass,
  };
}

export function parseDesktopBrowserSessionStartAuthorityEnvelope(
  raw: unknown,
  expectedProtocolVersion: string = DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  expectedPolicyGrammarVersion: string = DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION,
): DesktopBrowserSessionStartAuthorityEnvelope {
  const authority = parseDesktopBrowserRecord<DesktopBrowserSessionStartAuthorityEnvelope>(
    sessionStartAuthorityEnvelopeParser,
    "desktop browser session-start authority envelope",
    raw,
  );
  if (!isDesktopBrowserProtocolCompatible(authority.authorityVersion, DESKTOP_BROWSER_AUTHORITY_VERSION)) {
    throw new Error(
      `authority protocol major ${protocolMajor(authority.authorityVersion)} is incompatible with supported major ${protocolMajor(DESKTOP_BROWSER_AUTHORITY_VERSION)}`,
    );
  }
  assertCanonicalProtocolVersion(authority.authorityVersion, "authorityVersion");
  assertCanonicalUtcMillisecondInstant(authority.issuedAt, "issuedAt");
  assertCanonicalUtcMillisecondInstant(authority.leaseExpiresAt, "leaseExpiresAt");
  if (
    Date.parse(authority.leaseExpiresAt) - Date.parse(authority.issuedAt) !==
    DESKTOP_BROWSER_TASK_LEASE_DURATION_MS
  ) {
    throw new Error("desktop browser session-start authority lease must expire exactly 60 seconds after issuedAt");
  }
  const parsedCapabilitySet = parseDesktopBrowserCapabilitySet(
    authority.capabilitySet,
    expectedProtocolVersion,
    expectedPolicyGrammarVersion,
  );
  const argv = validateDesktopBrowserSessionStartArgv(authority.argv, authority.browserInstanceId);
  if (authority.brokerOptions.forceSharedRuntime) {
    throw new Error("desktop browser session-start authority forceSharedRuntime must be false for Ticket 05");
  }
  return {
    authorityVersion: authority.authorityVersion,
    audience: authority.audience,
    deploymentCanonicalId: authority.deploymentCanonicalId,
    actorId: authority.actorId,
    actorSnapshotHash: authority.actorSnapshotHash,
    projectId: authority.projectId,
    projectSnapshotHash: authority.projectSnapshotHash,
    membershipEpoch: authority.membershipEpoch,
    taskId: authority.taskId,
    attemptId: authority.attemptId,
    deviceId: authority.deviceId,
    browserInstanceId: authority.browserInstanceId,
    leaseId: authority.leaseId,
    leaseVersion: authority.leaseVersion,
    leaseExpiresAt: authority.leaseExpiresAt,
    operationId: authority.operationId,
    operationSequence: authority.operationSequence,
    capabilitySet: parsedCapabilitySet,
    argv,
    brokerOptions: { forceSharedRuntime: authority.brokerOptions.forceSharedRuntime },
    effectClass: authority.effectClass,
    nonce: authority.nonce,
    issuedAt: authority.issuedAt,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "number" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("desktop browser canonical request contains a non-JSON value");
}

export function computeDesktopBrowserRequestHash(
  raw: unknown,
  expectedProtocolVersion: string = DESKTOP_BROWSER_TICKET_05_PROTOCOL_VERSION,
  expectedPolicyGrammarVersion: string = DESKTOP_BROWSER_POLICY_GRAMMAR_VERSION,
): string {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("desktop browser request hash input must be an object");
  }
  const input = raw as Record<string, unknown>;
  const capabilitySet = parseDesktopBrowserCapabilitySet(
    input.capabilitySet,
    expectedProtocolVersion,
    expectedPolicyGrammarVersion,
  );
  const argv = input.argv;
  if (!Array.isArray(argv) || argv.length === 0 || argv.some((value) => typeof value !== "string")) {
    throw new Error("desktop browser request hash argv must be a non-empty string array");
  }
  const brokerOptions = parseDesktopBrowserRecord<DesktopBrowserBrokerOptions>(
    brokerOptionsParser,
    "desktop browser broker options",
    input.brokerOptions,
  );
  const requiredString = (key: string): string => {
    const value = input[key];
    if (typeof value !== "string" || !new RegExp(CANONICAL_LEXICAL_STRING_PATTERN).test(value)) {
      throw new Error(`${key} must be a canonical lexical string`);
    }
    return value;
  };
  if (!Number.isSafeInteger(input.operationSequence) || (input.operationSequence as number) < 1) {
    throw new Error("operationSequence must be a positive safe integer");
  }
  const canonicalRequest = {
    attemptId: requiredString("attemptId"),
    argv: [...argv],
    brokerOptions: { forceSharedRuntime: brokerOptions.forceSharedRuntime },
    browserInstanceId: requiredString("browserInstanceId"),
    capabilitySet,
    deploymentCanonicalId: requiredString("deploymentCanonicalId"),
    deviceId: requiredString("deviceId"),
    effectClass: requiredString("effectClass"),
    operationId: requiredString("operationId"),
    operationSequence: input.operationSequence,
    policyGrammarVersion: capabilitySet.policyGrammarVersion,
    requestSchemaVersion: requiredString("authorityVersion"),
    taskId: requiredString("taskId"),
  };
  return `sha256:${createHash("sha256").update(canonicalJson(canonicalRequest)).digest("hex")}`;
}

function canonicalizeDesktopBrowserRegistrationReservationTuple(
  tuple: DesktopBrowserRegistrationReservationTuple,
): DesktopBrowserRegistrationReservationTuple {
  return {
    registrationProtocolVersion: tuple.registrationProtocolVersion,
    deploymentCanonicalId: tuple.deploymentCanonicalId,
    registrationId: tuple.registrationId,
    actorId: tuple.actorId,
    originatingProjectId: tuple.originatingProjectId,
    membershipEpoch: tuple.membershipEpoch,
    devicePublicKey: tuple.devicePublicKey,
    brokerInstanceId: tuple.brokerInstanceId,
    browserInstanceId: tuple.browserInstanceId,
    connectionEpoch: tuple.connectionEpoch,
    expiresAt: tuple.expiresAt,
  };
}

function canonicalizeDesktopBrowserPublicIdentity(
  identity: DesktopBrowserPublicIdentity,
): DesktopBrowserPublicIdentity {
  return {
    publicIdentityVersion: identity.publicIdentityVersion,
    deploymentCanonicalId: identity.deploymentCanonicalId,
    devicePublicKey: identity.devicePublicKey,
    brokerInstanceId: identity.brokerInstanceId,
    browserInstanceId: identity.browserInstanceId,
  };
}

function canonicalizeDesktopBrowserRelayConnectionProjection(
  projection: DesktopBrowserRelayConnectionProjection,
): DesktopBrowserRelayConnectionProjection {
  return {
    connectionId: projection.connectionId,
    publicDeviceFingerprint: projection.publicDeviceFingerprint,
    brokerInstanceId: projection.brokerInstanceId,
    browserInstanceId: projection.browserInstanceId,
    connectionEpoch: projection.connectionEpoch,
    registrationState: projection.registrationState,
    protocolVersion: projection.protocolVersion,
    policyGrammarVersion: projection.policyGrammarVersion,
    brokerVersion: projection.brokerVersion,
    bskVersion: projection.bskVersion,
    extensionVersion: projection.extensionVersion,
    cliShapeHash: projection.cliShapeHash,
    lastSeenAt: projection.lastSeenAt,
  };
}

export function encodeDesktopBrowserRegistrationReservationTupleBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  const tuple = parseDesktopBrowserRegistrationReservationTuple(raw);
  return Buffer.from(JSON.stringify(canonicalizeDesktopBrowserRegistrationReservationTuple(tuple)));
}

export function encodeDesktopBrowserRegistrationConfirmationSigningBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  return encodeDesktopBrowserRegistrationReservationTupleBytes(raw);
}

export function encodeDesktopBrowserRegistrationConfirmationVerificationBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  return encodeDesktopBrowserRegistrationConfirmationSigningBytes(raw);
}

export function encodeDesktopBrowserPublicIdentityBytes(raw: unknown): Uint8Array<ArrayBuffer> {
  const identity = parseDesktopBrowserPublicIdentity(raw);
  return Buffer.from(JSON.stringify(canonicalizeDesktopBrowserPublicIdentity(identity)));
}

export function computeDesktopBrowserRegistrationConfirmationFingerprint(
  raw: DesktopBrowserRegistrationReservationTuple,
): string {
  const canonicalBytes = encodeDesktopBrowserRegistrationConfirmationSigningBytes(raw);
  return createHash("sha256").update(canonicalBytes).digest("hex").slice(0, 16);
}

export function computeDesktopBrowserPublicDeviceFingerprint(raw: DesktopBrowserPublicIdentity): string {
  const canonicalBytes = encodeDesktopBrowserPublicIdentityBytes(raw);
  return createHash("sha256").update(canonicalBytes).digest("hex").slice(0, 16);
}

export function encodeHostChallengeResponseSigningBytes(message: {
  protocolVersion: HostChallengeResponseMessage["protocolVersion"];
  payload: Pick<
    HostChallengeResponseMessage["payload"],
    | "relayInstanceId"
    | "deploymentCanonicalId"
    | "devicePublicKey"
    | "brokerInstanceId"
    | "browserInstanceId"
    | "connectionEpoch"
    | "challengeNonce"
  >;
}): Uint8Array<ArrayBuffer> {
  return Buffer.from(
    JSON.stringify({
      protocolVersion: message.protocolVersion,
      relayInstanceId: message.payload.relayInstanceId,
      deploymentCanonicalId: message.payload.deploymentCanonicalId,
      devicePublicKey: message.payload.devicePublicKey,
      brokerInstanceId: message.payload.brokerInstanceId,
      browserInstanceId: message.payload.browserInstanceId,
      connectionEpoch: message.payload.connectionEpoch,
      challengeNonce: message.payload.challengeNonce,
    }),
  );
}

function decodeHostChallengeResponsePublicKey(devicePublicKey: string) {
  if (!devicePublicKey.startsWith("ed25519:")) {
    throw new Error("devicePublicKey must use ed25519:<base64-spki-der>");
  }
  return createPublicKey({
    key: Buffer.from(devicePublicKey.slice("ed25519:".length), "base64"),
    format: "der",
    type: "spki",
  });
}

export function verifyHostChallengeResponseMessage(message: HostChallengeResponseMessage): boolean {
  try {
    const parsed = decodeDesktopBrowserMessage(JSON.stringify(message), message.protocolVersion);
    if (parsed.kind !== "host.challenge-response") return false;
    return verify(
      null,
      Buffer.from(encodeHostChallengeResponseSigningBytes(parsed)),
      decodeHostChallengeResponsePublicKey(parsed.payload.devicePublicKey),
      Buffer.from(parsed.payload.signature, "base64url"),
    );
  } catch {
    return false;
  }
}

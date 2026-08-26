import { createHash } from "node:crypto";
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
  };
}

export interface HostChallengeResponseMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.challenge-response";
  payload: {
    devicePublicKey: string;
    brokerInstanceId: string;
    challengeNonce: string;
    signatureAlgorithm: "ed25519";
    signature: string;
  };
}

export interface RelayInvocationMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.invoke";
  payload: {
    dispatchId: string;
    operationId: string;
    requestHash: string;
    argv: string[];
  };
}

export interface HostResultMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.result";
  payload: {
    operationId: string;
    outcome: "completed" | "failed" | "unknown";
    resultHash: string;
  };
}

export interface CompanionStatusMessage {
  protocolVersion: `${number}.${number}`;
  kind: "companion.status";
  payload: {
    brokerStatus: "ready" | "paused" | "disconnected";
    browserSkillStatus: "ready" | "offline";
    currentTaskPresent: boolean;
  };
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

export type DesktopBrowserMessage =
  | CoreAuthorityMessage
  | HostHelloMessage
  | RelayChallengeMessage
  | HostChallengeResponseMessage
  | RelayInvocationMessage
  | HostResultMessage
  | CompanionStatusMessage;

type DesktopBrowserMessageKind = DesktopBrowserMessage["kind"];

export const DESKTOP_BROWSER_PROTOCOL_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION = "1.0" as const;
export const DESKTOP_BROWSER_PUBLIC_IDENTITY_VERSION = "1.0" as const;

const PROTOCOL_VERSION_PATTERN = "^([0-9]{1,9})\\.[0-9]{1,9}$";
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
  objectSchema(["protocolVersion", "kind", "payload"], {
    protocolVersion: { type: "string", pattern: PROTOCOL_VERSION_PATTERN },
    kind: { const: kind },
    payload,
  }, true);

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
    objectSchema(["requestId", "audience"], {
      requestId: nonEmptyStringSchema,
      audience: nonEmptyStringSchema,
    }, true),
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
      ["relayInstanceId", "challengeNonce"],
      {
        relayInstanceId: nonEmptyStringSchema,
        challengeNonce: nonEmptyStringSchema,
      },
      true,
    ),
  ),
  "host.challenge-response": messageSchema(
    "host.challenge-response",
    objectSchema(
      ["devicePublicKey", "brokerInstanceId", "challengeNonce", "signatureAlgorithm", "signature"],
      {
        devicePublicKey: nonEmptyStringSchema,
        brokerInstanceId: nonEmptyStringSchema,
        challengeNonce: nonEmptyStringSchema,
        signatureAlgorithm: { const: "ed25519" },
        signature: nonEmptyStringSchema,
      },
      true,
    ),
  ),
  "relay.invoke": messageSchema(
    "relay.invoke",
    objectSchema(["dispatchId", "operationId", "requestHash", "argv"], {
      dispatchId: nonEmptyStringSchema,
      operationId: nonEmptyStringSchema,
      requestHash: nonEmptyStringSchema,
      argv: { type: "array", minItems: 1, items: { type: "string" } },
    }, true),
  ),
  "host.result": messageSchema(
    "host.result",
    objectSchema(["operationId", "outcome", "resultHash"], {
      operationId: nonEmptyStringSchema,
      outcome: { enum: ["completed", "failed", "unknown"] },
      resultHash: nonEmptyStringSchema,
    }, true),
  ),
  "companion.status": messageSchema(
    "companion.status",
    objectSchema(["brokerStatus", "browserSkillStatus", "currentTaskPresent"], {
      brokerStatus: { enum: ["ready", "paused", "disconnected"] },
      browserSkillStatus: { enum: ["ready", "offline"] },
      currentTaskPresent: { type: "boolean" },
    }, true),
  ),
} as const;

const messageParsers = Object.fromEntries(
  Object.entries(desktopBrowserMessageSchemas).map(([kind, schema]) => [
    kind,
    fromJSONSchema(schema as unknown as Parameters<typeof fromJSONSchema>[0]),
  ]),
) as Record<DesktopBrowserMessageKind, ReturnType<typeof fromJSONSchema>>;

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

export function encodeDesktopBrowserMessage(message: DesktopBrowserMessage): string {
  return JSON.stringify(message);
}

function protocolMajor(version: string): string {
  const match = protocolVersionPattern.exec(version);
  if (!match) throw new Error(`invalid desktop browser protocol version ${JSON.stringify(version)}`);
  return match[1]!.replace(/^0+(?=[0-9])/, "");
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
  if (typeof version !== "string" || version === supportedVersion) return false;
  try {
    return isDesktopBrowserProtocolCompatible(version, supportedVersion);
  } catch {
    return false;
  }
}

export function isDesktopBrowserProtocolCompatible(remoteVersion: string, supportedVersion: string): boolean {
  return protocolMajor(remoteVersion) === protocolMajor(supportedVersion);
}

export function decodeDesktopBrowserMessage(
  encoded: string,
  supportedVersion: string = DESKTOP_BROWSER_PROTOCOL_VERSION,
): DesktopBrowserMessage {
  const raw: unknown = JSON.parse(encoded);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("desktop browser message must be a JSON object");
  }
  const kind = (raw as Record<string, unknown>)["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(messageParsers, kind)) {
    throw new Error(`unsupported desktop browser message kind ${JSON.stringify(kind)}`);
  }
  const parsed = messageParsers[kind as DesktopBrowserMessageKind].safeParse(raw);
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
  return message;
}

function parseDesktopBrowserRecord<T>(
  parser: ReturnType<typeof fromJSONSchema>,
  label: string,
  raw: unknown,
): T {
  const parsed = parser.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `${label} does not match its schema: ${parsed.error.issues.map((issue) => issue.message).join("; ")}`,
    );
  }
  return parsed.data as T;
}

function pickRegistrationTupleParser(raw: unknown): ReturnType<typeof fromJSONSchema> {
  const version = raw && typeof raw === "object" ? (raw as Record<string, unknown>).registrationProtocolVersion : undefined;
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
  const registrationTuple = raw && typeof raw === "object"
    ? (raw as Record<string, unknown>).registrationTuple
    : undefined;
  const version = registrationTuple && typeof registrationTuple === "object"
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
  if (!isDesktopBrowserProtocolCompatible(tuple.registrationProtocolVersion, DESKTOP_BROWSER_REGISTRATION_PROTOCOL_VERSION)) {
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

export function projectDesktopBrowserPublicIdentity(
  raw: unknown,
): DesktopBrowserPublicIdentity {
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
  if (JSON.stringify(canonicalizeDesktopBrowserPublicIdentity(publicIdentity)) !== JSON.stringify(projectedPublicIdentity)) {
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

export function encodeDesktopBrowserRegistrationReservationTupleBytes(
  raw: unknown,
): Uint8Array<ArrayBuffer> {
  const tuple = parseDesktopBrowserRegistrationReservationTuple(raw);
  return Buffer.from(JSON.stringify(canonicalizeDesktopBrowserRegistrationReservationTuple(tuple)));
}

export function encodeDesktopBrowserRegistrationConfirmationSigningBytes(
  raw: unknown,
): Uint8Array<ArrayBuffer> {
  return encodeDesktopBrowserRegistrationReservationTupleBytes(raw);
}

export function encodeDesktopBrowserRegistrationConfirmationVerificationBytes(
  raw: unknown,
): Uint8Array<ArrayBuffer> {
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

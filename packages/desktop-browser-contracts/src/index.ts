import { fromJSONSchema } from "zod";

interface CoreAuthorityMessage {
  protocolVersion: `${number}.${number}`;
  kind: "core.authority";
  payload: {
    requestId: string;
    audience: string;
  };
}

interface RelayInvocationMessage {
  protocolVersion: `${number}.${number}`;
  kind: "relay.invoke";
  payload: {
    dispatchId: string;
    operationId: string;
    requestHash: string;
    argv: string[];
  };
}

interface HostResultMessage {
  protocolVersion: `${number}.${number}`;
  kind: "host.result";
  payload: {
    operationId: string;
    outcome: "completed" | "failed" | "unknown";
    resultHash: string;
  };
}

interface CompanionStatusMessage {
  protocolVersion: `${number}.${number}`;
  kind: "companion.status";
  payload: {
    brokerStatus: "ready" | "paused" | "disconnected";
    browserSkillStatus: "ready" | "offline";
    currentTaskPresent: boolean;
  };
}

export type DesktopBrowserMessage =
  CoreAuthorityMessage | RelayInvocationMessage | HostResultMessage | CompanionStatusMessage;

type DesktopBrowserMessageKind = DesktopBrowserMessage["kind"];

export const DESKTOP_BROWSER_PROTOCOL_VERSION = "1.0" as const;

const PROTOCOL_VERSION_PATTERN = "^([0-9]{1,9})\\.[0-9]{1,9}$";
const protocolVersionPattern = new RegExp(PROTOCOL_VERSION_PATTERN);

const objectSchema = <const Required extends readonly string[], const Properties extends Record<string, unknown>>(
  required: Required,
  properties: Properties,
) => ({
  type: "object" as const,
  additionalProperties: true,
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
  });

const nonEmptyStringSchema = { type: "string", minLength: 1 } as const;

export const desktopBrowserMessageSchemas = {
  "core.authority": messageSchema(
    "core.authority",
    objectSchema(["requestId", "audience"], {
      requestId: nonEmptyStringSchema,
      audience: nonEmptyStringSchema,
    }),
  ),
  "relay.invoke": messageSchema(
    "relay.invoke",
    objectSchema(["dispatchId", "operationId", "requestHash", "argv"], {
      dispatchId: nonEmptyStringSchema,
      operationId: nonEmptyStringSchema,
      requestHash: nonEmptyStringSchema,
      argv: { type: "array", minItems: 1, items: { type: "string" } },
    }),
  ),
  "host.result": messageSchema(
    "host.result",
    objectSchema(["operationId", "outcome", "resultHash"], {
      operationId: nonEmptyStringSchema,
      outcome: { enum: ["completed", "failed", "unknown"] },
      resultHash: nonEmptyStringSchema,
    }),
  ),
  "companion.status": messageSchema(
    "companion.status",
    objectSchema(["brokerStatus", "browserSkillStatus", "currentTaskPresent"], {
      brokerStatus: { enum: ["ready", "paused", "disconnected"] },
      browserSkillStatus: { enum: ["ready", "offline"] },
      currentTaskPresent: { type: "boolean" },
    }),
  ),
} as const;

const messageParsers = Object.fromEntries(
  Object.entries(desktopBrowserMessageSchemas).map(([kind, schema]) => [
    kind,
    fromJSONSchema(schema as unknown as Parameters<typeof fromJSONSchema>[0]),
  ]),
) as Record<DesktopBrowserMessageKind, ReturnType<typeof fromJSONSchema>>;

export function encodeDesktopBrowserMessage(message: DesktopBrowserMessage): string {
  return JSON.stringify(message);
}

function protocolMajor(version: string): string {
  const match = protocolVersionPattern.exec(version);
  if (!match) throw new Error(`invalid desktop browser protocol version ${JSON.stringify(version)}`);
  return match[1]!.replace(/^0+(?=[0-9])/, "");
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

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

export const desktopBrowserMessageSchemas = {
  "core.authority": {
    type: "object",
    additionalProperties: true,
    required: ["protocolVersion", "kind", "payload"],
    properties: {
      protocolVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
      kind: { const: "core.authority" },
      payload: {
        type: "object",
        additionalProperties: true,
        required: ["requestId", "audience"],
        properties: {
          requestId: { type: "string", minLength: 1 },
          audience: { type: "string", minLength: 1 },
        },
      },
    },
  },
  "relay.invoke": {
    type: "object",
    additionalProperties: true,
    required: ["protocolVersion", "kind", "payload"],
    properties: {
      protocolVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
      kind: { const: "relay.invoke" },
      payload: {
        type: "object",
        additionalProperties: true,
        required: ["dispatchId", "operationId", "requestHash", "argv"],
        properties: {
          dispatchId: { type: "string", minLength: 1 },
          operationId: { type: "string", minLength: 1 },
          requestHash: { type: "string", minLength: 1 },
          argv: { type: "array", minItems: 1, items: { type: "string" } },
        },
      },
    },
  },
  "host.result": {
    type: "object",
    additionalProperties: true,
    required: ["protocolVersion", "kind", "payload"],
    properties: {
      protocolVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
      kind: { const: "host.result" },
      payload: {
        type: "object",
        additionalProperties: true,
        required: ["operationId", "outcome", "resultHash"],
        properties: {
          operationId: { type: "string", minLength: 1 },
          outcome: { enum: ["completed", "failed", "unknown"] },
          resultHash: { type: "string", minLength: 1 },
        },
      },
    },
  },
  "companion.status": {
    type: "object",
    additionalProperties: true,
    required: ["protocolVersion", "kind", "payload"],
    properties: {
      protocolVersion: { type: "string", pattern: "^[0-9]+\\.[0-9]+$" },
      kind: { const: "companion.status" },
      payload: {
        type: "object",
        additionalProperties: true,
        required: ["brokerStatus", "browserSkillStatus", "currentTaskPresent"],
        properties: {
          brokerStatus: { enum: ["ready", "paused", "disconnected"] },
          browserSkillStatus: { enum: ["ready", "offline"] },
          currentTaskPresent: { type: "boolean" },
        },
      },
    },
  },
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

function protocolMajor(version: string): number {
  const match = /^([0-9]+)\.[0-9]+$/.exec(version);
  if (!match) throw new Error(`invalid desktop browser protocol version ${JSON.stringify(version)}`);
  return Number(match[1]);
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

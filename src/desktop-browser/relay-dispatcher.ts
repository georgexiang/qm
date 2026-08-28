import { randomUUID } from "node:crypto";
import { decodeDesktopBrowserMessage } from "qm-desktop-browser-contracts";
import { signedRequestHeaders } from "../auth/source-auth-sign.ts";
import type { DesktopBrowserRelayDispatcher, DesktopBrowserRelayDispatchResult } from "./operation-coordinator.ts";

export interface DesktopBrowserRelayControl extends DesktopBrowserRelayDispatcher {
  revoke(input: {
    publicDeviceFingerprint: string;
    browserInstanceId: string;
    taskId: string;
    attemptId: string;
    leaseId: string;
    leaseVersion: number;
  }): Promise<void>;
}

async function readBoundedResponse(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new Error("Desktop Browser Relay response exceeded the maximum size");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

export function createHttpDesktopBrowserRelayDispatcher(options: {
  baseUrl: string;
  authSecret: string;
  fetch?: typeof fetch;
}): DesktopBrowserRelayControl {
  const baseUrl = options.baseUrl.replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const parsedBase = new URL(baseUrl);
  if (
    parsedBase.protocol !== "https:" &&
    !(parsedBase.protocol === "http:" && ["127.0.0.1", "localhost", "::1"].includes(parsedBase.hostname))
  ) {
    throw new Error("Desktop Browser Relay URL must use HTTPS or loopback HTTP");
  }
  if (
    parsedBase.username ||
    parsedBase.password ||
    (parsedBase.pathname !== "/" && parsedBase.pathname !== "") ||
    parsedBase.search ||
    parsedBase.hash
  ) {
    throw new Error("Desktop Browser Relay URL must be an origin without credentials, path, query, or fragment");
  }
  if (options.authSecret.length < 32)
    throw new Error("Desktop Browser Relay auth secret must be at least 32 characters");
  return {
    async revoke(input) {
      const body = JSON.stringify(input);
      const path = `/v1/revocations?_sourceAuthNonce=${encodeURIComponent(randomUUID())}`;
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(options.authSecret, "POST", path, body, {
          "content-type": "application/json",
        }),
        body,
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      });
      if (response.status !== 204) {
        throw new Error(`Desktop Browser Relay revocation failed with status ${response.status}`);
      }
    },
    async dispatch(input) {
      const body = JSON.stringify(input);
      const path = `/v1/invocations?_sourceAuthNonce=${encodeURIComponent(randomUUID())}`;
      const response = await fetchImpl(`${baseUrl}${path}`, {
        method: "POST",
        headers: signedRequestHeaders(options.authSecret, "POST", path, body, {
          "content-type": "application/json",
        }),
        body,
        signal: AbortSignal.timeout(20_000),
        redirect: "manual",
      });
      if (!response.ok) throw new Error(`Desktop Browser Relay dispatch failed with status ${response.status}`);
      const responseBody = await readBoundedResponse(response, 128 * 1024);
      const raw: unknown = JSON.parse(responseBody);
      if (!raw || typeof raw !== "object" || Array.isArray(raw))
        throw new Error("Desktop Browser Relay returned invalid JSON");
      const record = raw as Record<string, unknown>;
      const protocolVersion = input.invocation.protocolVersion;
      const policyGrammarVersion = input.invocation.payload.authority.capabilitySet.policyGrammarVersion;
      const expectedDispatchId = input.invocation.payload.dispatchId;
      const expectedOperationId = input.invocation.payload.authority.operationId;
      const expectedRequestHash = input.invocation.payload.requestHash;
      if (record.kind === "host.result") {
        const accepted = decodeDesktopBrowserMessage(
          JSON.stringify(record.accepted),
          protocolVersion,
          policyGrammarVersion,
        );
        const result = decodeDesktopBrowserMessage(
          JSON.stringify(record.result),
          protocolVersion,
          policyGrammarVersion,
        );
        if (accepted.kind !== "host.accepted" || result.kind !== "host.result") {
          throw new Error("Desktop Browser Relay returned invalid Host messages");
        }
        if (
          accepted.payload.dispatchId !== expectedDispatchId ||
          accepted.payload.operationId !== expectedOperationId ||
          accepted.payload.requestHash !== expectedRequestHash ||
          result.payload.dispatchId !== expectedDispatchId ||
          result.payload.operationId !== expectedOperationId
        ) {
          throw new Error("Desktop Browser Relay response does not match the submitted operation");
        }
        return { kind: "host.result", accepted, result };
      }
      if (record.kind === "accepted_unknown") {
        const accepted = decodeDesktopBrowserMessage(
          JSON.stringify(record.accepted),
          protocolVersion,
          policyGrammarVersion,
        );
        if (accepted.kind !== "host.accepted" || !record.error || typeof record.error !== "object") {
          throw new Error("Desktop Browser Relay returned invalid accepted-unknown state");
        }
        const error = record.error as Record<string, unknown>;
        if (typeof error.code !== "string" || typeof error.message !== "string") {
          throw new Error("Desktop Browser Relay returned invalid accepted-unknown error");
        }
        if (
          accepted.payload.dispatchId !== expectedDispatchId ||
          accepted.payload.operationId !== expectedOperationId ||
          accepted.payload.requestHash !== expectedRequestHash
        ) {
          throw new Error("Desktop Browser Relay response does not match the submitted operation");
        }
        let result;
        if (record.result !== undefined) {
          const decodedResult = decodeDesktopBrowserMessage(
            JSON.stringify(record.result),
            protocolVersion,
            policyGrammarVersion,
          );
          if (
            decodedResult.kind !== "host.result" ||
            decodedResult.payload.dispatchId !== expectedDispatchId ||
            decodedResult.payload.operationId !== expectedOperationId ||
            decodedResult.payload.outcome !== "unknown"
          ) {
            throw new Error("Desktop Browser Relay response does not match the submitted operation");
          }
          result = decodedResult;
        }
        return {
          kind: "accepted_unknown",
          accepted,
          ...(result ? { result } : {}),
          error: { code: error.code, message: error.message },
        };
      }
      if (record.kind === "not_accepted_or_unknown") {
        const dispatchId = record.dispatchId;
        const operationId = record.operationId;
        const requestHash = record.requestHash;
        if (typeof dispatchId !== "string" || typeof operationId !== "string" || typeof requestHash !== "string") {
          throw new Error("Desktop Browser Relay returned invalid dispatch state");
        }
        if (!record.error || typeof record.error !== "object") {
          throw new Error("Desktop Browser Relay returned invalid dispatch error");
        }
        const error = record.error as Record<string, unknown>;
        if (typeof error.code !== "string" || typeof error.message !== "string") {
          throw new Error("Desktop Browser Relay returned invalid dispatch error");
        }
        if (
          dispatchId !== expectedDispatchId ||
          operationId !== expectedOperationId ||
          requestHash !== expectedRequestHash
        ) {
          throw new Error("Desktop Browser Relay response does not match the submitted operation");
        }
        return {
          kind: "not_accepted_or_unknown",
          dispatchId,
          operationId,
          requestHash,
          error: { code: error.code, message: error.message },
        } satisfies DesktopBrowserRelayDispatchResult;
      }
      throw new Error("Desktop Browser Relay returned an unsupported dispatch result");
    },
  };
}

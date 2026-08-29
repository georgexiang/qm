import { headerValue, sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type BaseCtx, type Route } from "./route.ts";
import {
  parseDesktopBrowserRelayConnectionPublishRequest,
  decodeDesktopBrowserMessage,
  type DesktopBrowserRegistrationConfirmationEnvelope,
  type DesktopBrowserRelayConnectionProjection,
  type HostAcceptedMessage,
  type DesktopBrowserArtifactIntent,
  type HostLocalStopReceiptMessage,
  type HostResultMessage,
} from "qm-desktop-browser-contracts";

async function taskAction(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (ctx.capability && requested !== ctx.capability.actorId) {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  const principalId = ctx.capability?.actorId ?? requested;
  const authorityId = typeof body.authorityId === "string" ? body.authorityId : "";
  const action = body.action;
  if (!principalId || (action !== "cancel" && action !== "continue" && action !== "recover" && action !== "stop")) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId and cancel, continue, recover, or stop action required",
    });
  }
  const result = await ctx.app.desktopBrowserTaskAction(ctx.params.id!, principalId, authorityId, action);
  if (result.status === "refused") {
    return sendJson(ctx.res, 409, {
      error: "not_accepted",
      message: result.reason,
      ...(result.newSubmission ? { newSubmission: result.newSubmission } : {}),
    });
  }
  return sendJson(ctx.res, 200, result);
}

async function reserveRegistration(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const authorityId = typeof body.authorityId === "string" ? body.authorityId : "";
  const devicePublicKey = typeof body.devicePublicKey === "string" ? body.devicePublicKey : "";
  const brokerInstanceId = typeof body.brokerInstanceId === "string" ? body.brokerInstanceId : "";
  const browserInstanceId = typeof body.browserInstanceId === "string" ? body.browserInstanceId : "";
  const connectionEpoch = typeof body.connectionEpoch === "number" ? body.connectionEpoch : NaN;
  const operatingSystem = typeof body.operatingSystem === "string" ? body.operatingSystem : "";
  if (
    !authorityId ||
    !devicePublicKey ||
    !brokerInstanceId ||
    !browserInstanceId ||
    !Number.isInteger(connectionEpoch) ||
    connectionEpoch < 1 ||
    !operatingSystem
  ) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message:
        "authorityId, devicePublicKey, brokerInstanceId, browserInstanceId, connectionEpoch, and operatingSystem required",
    });
  }
  const result = await ctx.app.desktopBrowserReserveRegistration(ctx.params.id!, authorityId, {
    devicePublicKey,
    brokerInstanceId,
    browserInstanceId,
    connectionEpoch,
    operatingSystem,
  });
  if (result.status === "refused") return sendJson(ctx.res, 409, { error: "conflict", message: result.reason });
  return sendJson(ctx.res, 200, result);
}

async function confirmRegistration(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (ctx.capability && requested !== ctx.capability.actorId) {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  const principalId = ctx.capability?.actorId ?? requested;
  const authorityId = typeof body.authorityId === "string" ? body.authorityId : "";
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const confirmationFingerprint = typeof body.confirmationFingerprint === "string" ? body.confirmationFingerprint : "";
  if (!principalId || !authorityId || !taskId || !confirmationFingerprint) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId, authorityId, taskId, and confirmationFingerprint required",
    });
  }
  const result = await ctx.app.desktopBrowserConfirmRegistration(ctx.params.id!, principalId, authorityId, {
    taskId,
    confirmationFingerprint,
  });
  if (result.status === "refused") return sendJson(ctx.res, 409, { error: "conflict", message: result.reason });
  return sendJson(ctx.res, 200, result);
}

async function stageRegistrationConfirmation(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  let browserRuntimeStatus: "ready" | "offline" | "" = "";
  if (body.browserRuntimeStatus === "ready") browserRuntimeStatus = "ready";
  else if (body.browserRuntimeStatus === "offline") browserRuntimeStatus = "offline";
  const envelope = isObj(body.envelope) ? body.envelope : null;
  if (!browserRuntimeStatus || !envelope) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "browserRuntimeStatus and envelope required",
    });
  }
  const result = await ctx.app.desktopBrowserStageRegistrationConfirmation(ctx.params.id!, {
    browserRuntimeStatus,
    envelope: envelope as unknown as DesktopBrowserRegistrationConfirmationEnvelope,
  });
  if (result.status === "refused") return sendJson(ctx.res, 409, { error: "conflict", message: result.reason });
  return sendJson(ctx.res, 200, result);
}

async function markRegistrationOffline(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const brokerInstanceId = typeof body.brokerInstanceId === "string" ? body.brokerInstanceId : "";
  const browserInstanceId = typeof body.browserInstanceId === "string" ? body.browserInstanceId : "";
  const connectionEpoch = typeof body.connectionEpoch === "number" ? body.connectionEpoch : NaN;
  if (!brokerInstanceId || !browserInstanceId || !Number.isInteger(connectionEpoch) || connectionEpoch < 1) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "brokerInstanceId, browserInstanceId, and connectionEpoch required",
    });
  }
  const result = await ctx.app.desktopBrowserMarkRegistrationOffline(ctx.params.id!, {
    brokerInstanceId,
    browserInstanceId,
    connectionEpoch,
  });
  if (result.status === "refused") return sendJson(ctx.res, 409, { error: "conflict", message: result.reason });
  return sendJson(ctx.res, 200, result);
}

async function resolveRelayBinding(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const devicePublicKey = typeof body.devicePublicKey === "string" ? body.devicePublicKey : "";
  const brokerInstanceId = typeof body.brokerInstanceId === "string" ? body.brokerInstanceId : "";
  if (!devicePublicKey || !brokerInstanceId) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "devicePublicKey and brokerInstanceId required",
    });
  }
  const result = await ctx.app.desktopBrowserResolveRelayBinding({ devicePublicKey, brokerInstanceId });
  if (result.status === "refused") return sendJson(ctx.res, 404, { error: "not_found", message: result.reason });
  return sendJson(ctx.res, 200, { binding: result.binding });
}

async function relayReady(ctx: ApiCtx): Promise<void> {
  return sendJson(ctx.res, 200, { ok: true });
}

function parseRelayProjection(body: unknown): DesktopBrowserRelayConnectionProjection | null {
  try {
    return parseDesktopBrowserRelayConnectionPublishRequest(body).projection;
  } catch {
    return null;
  }
}

async function publishRelayConnection(ctx: ApiCtx): Promise<void> {
  const projection = parseRelayProjection(ctx.body);
  if (!projection || projection.connectionId !== ctx.params.id) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "projection with matching connectionId required",
    });
  }
  await ctx.app.desktopBrowserPublishRelayConnection(projection);
  ctx.res.statusCode = 204;
  ctx.res.end();
}

async function clearRelayConnection(ctx: ApiCtx): Promise<void> {
  await ctx.app.desktopBrowserClearRelayConnection(ctx.params.id!);
  ctx.res.statusCode = 204;
  ctx.res.end();
}

async function reconcileRelayDevice(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  if (
    typeof body.reconciliationId !== "string" ||
    typeof body.devicePublicKey !== "string" ||
    typeof body.browserInstanceId !== "string" ||
    !Number.isSafeInteger(body.confirmedAt)
  ) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "valid Device reconciliation required" });
  }
  await ctx.app.desktopBrowserReconcileDevice({
    reconciliationId: body.reconciliationId,
    devicePublicKey: body.devicePublicKey,
    browserInstanceId: body.browserInstanceId,
    confirmedAt: body.confirmedAt as number,
  });
  ctx.res.statusCode = 204;
  ctx.res.end();
}

async function consumeRelayTerminalCallback(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const taskId = typeof body.taskId === "string" ? body.taskId : "";
  const accepted = isObj(body.accepted) ? body.accepted : null;
  const result = isObj(body.result) ? body.result : null;
  if (!taskId || !accepted || !result) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "taskId, accepted, and result required" });
  }
  const callbackResult = await ctx.app.desktopBrowserConsumeRelayTerminalCallback(
    taskId,
    accepted as unknown as HostAcceptedMessage,
    result as unknown as HostResultMessage,
  );
  if (callbackResult.status === "refused") {
    return sendJson(ctx.res, 409, { error: "conflict", message: callbackResult.reason });
  }
  ctx.res.statusCode = 204;
  ctx.res.end();
}

async function consumeLocalStopCallback(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  if (!isObj(body.receipt)) {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "receipt required" });
  }
  let receipt: HostLocalStopReceiptMessage;
  try {
    const decoded = decodeDesktopBrowserMessage(JSON.stringify(body.receipt), String(body.receipt.protocolVersion));
    if (decoded.kind !== "host.local-stop-receipt") throw new Error("unexpected receipt kind");
    receipt = decoded;
  } catch {
    return sendJson(ctx.res, 400, { error: "bad_request", message: "valid receipt required" });
  }
  const result = await ctx.app.desktopBrowserConsumeLocalStopReceipt(receipt);
  if (result.status === "refused") return sendJson(ctx.res, 409, { error: "conflict", message: result.reason });
  ctx.res.statusCode = 204;
  ctx.res.end();
}

async function issueArtifactGrant(ctx: ApiCtx): Promise<void> {
  if (!ctx.deps.desktopBrowserArtifacts) {
    return sendJson(ctx.res, 501, { error: "not_configured" });
  }
  const body = isObj(ctx.body) ? ctx.body : {};
  let intent: DesktopBrowserArtifactIntent | null = null;
  if (isObj(body.intent)) {
    try {
      const decoded = decodeDesktopBrowserMessage(
        JSON.stringify({ protocolVersion: "1.3", kind: "host.artifact-intent", payload: body.intent }),
        "1.3",
        "1.0",
      );
      if (decoded.kind === "host.artifact-intent") intent = decoded.payload;
    } catch {
      intent = null;
    }
  }
  const baseUrl = ctx.deps.publicUrl ?? ctx.deps.apiBaseUrl;
  if (!intent || !baseUrl) return sendJson(ctx.res, 400, { error: "bad_request", message: "intent required" });
  const issued = await ctx.deps.desktopBrowserArtifacts.issue(
    intent,
    new URL("/v1/desktop-browser/artifacts", baseUrl).toString(),
  );
  if (issued.status === "refused") {
    return sendJson(ctx.res, 409, { error: "not_accepted", message: issued.reason });
  }
  return sendJson(ctx.res, 200, { grant: issued.grant });
}

async function redeemArtifactGrant(ctx: BaseCtx): Promise<void> {
  if (!ctx.deps.desktopBrowserArtifacts) {
    ctx.req.resume();
    return sendJson(ctx.res, 501, { error: "not_configured" });
  }
  const authorization = headerValue(ctx.req, "authorization") ?? "";
  const bearerToken = authorization.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
  const deviceId = headerValue(ctx.req, "x-desktop-browser-device-id") ?? "";
  const contentType = headerValue(ctx.req, "content-type") ?? "";
  if (!bearerToken || !deviceId || !contentType) {
    ctx.req.resume();
    return sendJson(ctx.res, 401, { error: "unauthorized" });
  }
  const redeemed = await ctx.deps.desktopBrowserArtifacts.redeem({
    bearerToken,
    deviceId,
    contentType,
    data: ctx.req,
  });
  if (redeemed.status === "refused") {
    return sendJson(ctx.res, 409, { error: "not_accepted", message: redeemed.reason });
  }
  return sendJson(ctx.res, 200, { artifact: redeemed.reference });
}

export const desktopBrowserRawRoutes: ReadonlyArray<Route<BaseCtx>> = [
  { method: "POST", path: "/v1/desktop-browser/artifacts", auth: "public", handle: redeemArtifactGrant },
];

export const desktopBrowserRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/desktop-browser/relay/artifact-grants", auth: "source", handle: issueArtifactGrant },
  { method: "GET", path: "/v1/desktop-browser/relay/ready", auth: "source", handle: relayReady },
  {
    method: "POST",
    path: "/v1/desktop-browser/relay/callbacks/terminal",
    auth: "source",
    handle: consumeRelayTerminalCallback,
  },
  {
    method: "POST",
    path: "/v1/desktop-browser/relay/callbacks/local-stop",
    auth: "source",
    handle: consumeLocalStopCallback,
  },
  {
    method: "POST",
    path: "/v1/desktop-browser/relay/device-reconciliations",
    auth: "source",
    handle: reconcileRelayDevice,
  },
  { method: "POST", path: "/v1/desktop-browser/tasks/:id/actions", auth: "source", handle: taskAction },
  {
    method: "POST",
    path: "/v1/desktop-browser/tasks/:id/registration-reservations",
    auth: "source",
    handle: reserveRegistration,
  },
  {
    method: "POST",
    path: "/v1/desktop-browser/registrations/:id/confirmation-envelope",
    auth: "source",
    handle: stageRegistrationConfirmation,
  },
  {
    method: "POST",
    path: "/v1/desktop-browser/registrations/:id/confirm",
    auth: "source",
    handle: confirmRegistration,
  },
  {
    method: "POST",
    path: "/v1/desktop-browser/registrations/:id/offline",
    auth: "source",
    handle: markRegistrationOffline,
  },
  {
    method: "POST",
    path: "/v1/desktop-browser/relay/bindings/resolve",
    auth: "source",
    handle: resolveRelayBinding,
  },
  {
    method: "PUT",
    path: "/v1/desktop-browser/relay/connections/:id",
    auth: "source",
    handle: publishRelayConnection,
  },
  {
    method: "DELETE",
    path: "/v1/desktop-browser/relay/connections/:id",
    auth: "source",
    handle: clearRelayConnection,
  },
];

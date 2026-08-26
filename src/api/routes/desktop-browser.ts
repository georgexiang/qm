import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";
import type { DesktopBrowserRegistrationConfirmationEnvelope } from "qm-desktop-browser-contracts";

async function taskAction(ctx: ApiCtx): Promise<void> {
  const body = isObj(ctx.body) ? ctx.body : {};
  const requested = typeof body.principalId === "string" ? body.principalId.trim() : "";
  if (ctx.capability && requested !== ctx.capability.actorId) {
    return sendJson(ctx.res, 404, { error: "not_found" });
  }
  const principalId = ctx.capability?.actorId ?? requested;
  const authorityId = typeof body.authorityId === "string" ? body.authorityId : "";
  const action = body.action;
  if (!principalId || !authorityId || action !== "cancel") {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "principalId, authorityId, and cancel action required",
    });
  }
  const result = await ctx.app.desktopBrowserTaskAction(ctx.params.id!, principalId, authorityId, action);
  if (result.status === "refused") return sendJson(ctx.res, 404, { error: "not_found", message: result.reason });
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
      message: "authorityId, devicePublicKey, brokerInstanceId, browserInstanceId, connectionEpoch, and operatingSystem required",
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
  const authorityId = typeof body.authorityId === "string" ? body.authorityId : "";
  let browserRuntimeStatus: "ready" | "offline" | "" = "";
  if (body.browserRuntimeStatus === "ready") browserRuntimeStatus = "ready";
  else if (body.browserRuntimeStatus === "offline") browserRuntimeStatus = "offline";
  const envelope = isObj(body.envelope) ? body.envelope : null;
  if (!authorityId || !browserRuntimeStatus || !envelope) {
    return sendJson(ctx.res, 400, {
      error: "bad_request",
      message: "authorityId, browserRuntimeStatus, and envelope required",
    });
  }
  const result = await ctx.app.desktopBrowserConfirmRegistration(ctx.params.id!, authorityId, {
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

export const desktopBrowserRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/desktop-browser/tasks/:id/actions", auth: "source", handle: taskAction },
  {
    method: "POST",
    path: "/v1/desktop-browser/tasks/:id/registration-reservations",
    auth: "source",
    handle: reserveRegistration,
  },
  { method: "POST", path: "/v1/desktop-browser/registrations/:id/confirm", auth: "source", handle: confirmRegistration },
  {
    method: "POST",
    path: "/v1/desktop-browser/registrations/:id/offline",
    auth: "source",
    handle: markRegistrationOffline,
  },
];

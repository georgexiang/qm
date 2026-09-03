import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import type { ApiCtx, Route } from "./route.ts";

function response(ctx: ApiCtx, result: Awaited<ReturnType<ApiCtx["app"]["setAzureOpsBinding"]>>): void {
  if (result.status === "ok") return sendJson(ctx.res, 200, result.binding);
  if (result.status === "invalid_scope" || result.status === "invalid_allowlist") {
    return sendJson(ctx.res, 400, { error: result.status });
  }
  if (result.status === "invalid_credential" || result.status === "sharing_confirmation_required") {
    return sendJson(ctx.res, 409, { error: result.status });
  }
  return sendJson(ctx.res, result.status === "forbidden" ? 403 : 404, { error: result.status });
}

function createConnectionInput(body: unknown) {
  if (!isObj(body)) return null;
  return {
    credentialId: typeof body.credentialId === "string" ? body.credentialId.trim() : "",
    accountLabel: typeof body.accountLabel === "string" ? body.accountLabel : undefined,
  };
}

function updateConnectionInput(body: unknown) {
  if (!isObj(body)) return null;
  return {
    accountLabel: typeof body.accountLabel === "string" ? body.accountLabel : undefined,
  };
}

function connectionResponse(
  ctx: ApiCtx,
  result: Awaited<ReturnType<ApiCtx["app"]["saveAzureAccountConnection"]>>,
): void {
  if (result.status === "ok") return sendJson(ctx.res, result.created ? 201 : 200, result.connection);
  if (result.status === "conflict") {
    return sendJson(ctx.res, 409, { error: "connection_in_use", bindingScopes: result.bindingScopes });
  }
  if (result.status === "verification_required") return sendJson(ctx.res, 409, { error: result.status });
  if (result.status === "invalid_profile") return sendJson(ctx.res, 400, { error: result.status });
  if (result.status === "invalid_metadata") return sendJson(ctx.res, 400, { error: result.status });
  return sendJson(ctx.res, result.status === "invalid_credential" ? 409 : 404, { error: result.status });
}

function deviceCodeResponse(
  ctx: ApiCtx,
  result: Awaited<ReturnType<ApiCtx["app"]["startAzureDeviceCodeFlow"]>>,
  created = false,
): void {
  if (result.status === "ok") return sendJson(ctx.res, created ? 201 : 200, result);
  if (result.status === "forbidden") return sendJson(ctx.res, 403, { error: result.status });
  if (result.status === "expired") return sendJson(ctx.res, 410, { error: result.status });
  if (result.status === "conflict" || result.status === "not_ready") {
    return sendJson(ctx.res, 409, { error: result.status });
  }
  if (result.status === "unavailable") return sendJson(ctx.res, 503, { error: result.status });
  return sendJson(ctx.res, result.status === "not_found" ? 404 : 502, { error: result.status });
}

async function listCredentials(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  return sendJson(ctx.res, 200, { credentials: await ctx.app.listAzureCapturedCredentials(actorId) });
}

async function listConnections(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  return sendJson(ctx.res, 200, { connections: await ctx.app.listAzureAccountConnections(actorId) });
}

async function startDeviceCode(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : undefined;
  return deviceCodeResponse(
    ctx,
    await ctx.app.startAzureDeviceCodeFlow({ actorId, ...(connectionId ? { connectionId } : {}) }),
    true,
  );
}

async function pollDeviceCode(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const flowId = ctx.params.flowId;
  if (!flowId) return sendJson(ctx.res, 400, { error: "bad_request" });
  return deviceCodeResponse(ctx, await ctx.app.pollAzureDeviceCodeFlow(flowId, actorId));
}

async function completeDeviceCode(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const flowId = ctx.params.flowId;
  if (!flowId) return sendJson(ctx.res, 400, { error: "bad_request" });
  return deviceCodeResponse(ctx, await ctx.app.completeAzureDeviceCodeFlow(flowId, actorId));
}

async function createConnection(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const input = createConnectionInput(ctx.body);
  if (!input || !input.credentialId) return sendJson(ctx.res, 400, { error: "bad_request" });
  return connectionResponse(ctx, await ctx.app.saveAzureAccountConnection({ ...input, actorId }));
}

async function updateConnection(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const input = updateConnectionInput(ctx.body);
  if (!input) return sendJson(ctx.res, 400, { error: "bad_request" });
  return connectionResponse(
    ctx,
    await ctx.app.saveAzureAccountConnection({ ...input, connectionId: ctx.params.connectionId, actorId }),
  );
}

async function deleteConnection(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const connectionId = ctx.params.connectionId;
  if (!connectionId) return sendJson(ctx.res, 400, { error: "bad_request" });
  return connectionResponse(ctx, await ctx.app.deleteAzureAccountConnection(connectionId, actorId));
}

async function getBinding(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const scopeId = (ctx.url.searchParams.get("scopeId") ?? "").trim();
  if (!scopeId) return sendJson(ctx.res, 400, { error: "bad_request", message: "scopeId required" });
  return response(ctx, await ctx.app.getAzureOpsBinding(scopeId, actorId));
}

async function putBinding(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const body = isObj(ctx.body) ? ctx.body : {};
  const scopeId = typeof body.scopeId === "string" ? body.scopeId.trim() : "";
  const connectionId = typeof body.connectionId === "string" ? body.connectionId.trim() : "";
  const rawDefault = isObj(body.defaultTarget) ? body.defaultTarget : {};
  const defaultTarget = {
    tenantId: typeof rawDefault.tenantId === "string" ? rawDefault.tenantId : "",
    subscriptionId: typeof rawDefault.subscriptionId === "string" ? rawDefault.subscriptionId : "",
  };
  const targetAllowlist = Array.isArray(body.targetAllowlist)
    ? body.targetAllowlist.filter(isObj).map((target) => ({
        tenantId: typeof target.tenantId === "string" ? target.tenantId : "",
        subscriptionIds: Array.isArray(target.subscriptionIds)
          ? target.subscriptionIds.filter((id): id is string => typeof id === "string")
          : [],
      }))
    : [];
  const confirmProjectSharing = body.confirmProjectSharing === true;
  if (!scopeId || !connectionId) return sendJson(ctx.res, 400, { error: "bad_request" });
  return response(
    ctx,
    await ctx.app.setAzureOpsBinding({
      scopeId,
      connectionId,
      defaultTarget,
      targetAllowlist,
      confirmProjectSharing,
      actorId,
    }),
  );
}

async function deleteBinding(ctx: ApiCtx): Promise<void> {
  const actorId = ctx.actor?.p;
  if (!actorId) return sendJson(ctx.res, 401, { error: "unauthorized" });
  const scopeId = (ctx.url.searchParams.get("scopeId") ?? "").trim();
  if (!scopeId) return sendJson(ctx.res, 400, { error: "bad_request", message: "scopeId required" });
  return response(ctx, await ctx.app.deleteAzureOpsBinding(scopeId, actorId));
}

export const azureOpsRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/azure/credentials", auth: "source", handle: listCredentials },
  { method: "POST", path: "/v1/azure/connections/device-code/start", auth: "source", handle: startDeviceCode },
  { method: "GET", path: "/v1/azure/connections/device-code/:flowId", auth: "source", handle: pollDeviceCode },
  {
    method: "POST",
    path: "/v1/azure/connections/device-code/:flowId/complete",
    auth: "source",
    handle: completeDeviceCode,
  },
  { method: "GET", path: "/v1/azure/connections", auth: "source", handle: listConnections },
  { method: "POST", path: "/v1/azure/connections", auth: "source", handle: createConnection },
  { method: "PUT", path: "/v1/azure/connections/:connectionId", auth: "source", handle: updateConnection },
  { method: "DELETE", path: "/v1/azure/connections/:connectionId", auth: "source", handle: deleteConnection },
  { method: "GET", path: "/v1/azure/default", auth: "source", handle: getBinding },
  { method: "PUT", path: "/v1/azure/default", auth: "source", handle: putBinding },
  { method: "DELETE", path: "/v1/azure/default", auth: "source", handle: deleteBinding },
];

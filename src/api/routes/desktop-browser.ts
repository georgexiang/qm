import { sendJson } from "../http.ts";
import { isObj } from "./shared.ts";
import { type ApiCtx, type Route } from "./route.ts";

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

export const desktopBrowserRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "POST", path: "/v1/desktop-browser/tasks/:id/actions", auth: "source", handle: taskAction },
];

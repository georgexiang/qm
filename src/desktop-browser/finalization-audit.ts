import type { AuditLog } from "../audit/audit-log.ts";
import { projectScopeId } from "../projects/project-store.ts";
import type { DesktopBrowserTask, DesktopBrowserTaskStore } from "./browser-task-store.ts";

export async function persistDesktopBrowserFinalizationAudit(
  tasks: DesktopBrowserTaskStore,
  auditLog: AuditLog,
  task: DesktopBrowserTask,
): Promise<void> {
  if (!task.outcome || !task.finalizationAudit)
    throw new Error("Desktop Browser Task finalization audit is unavailable");
  if (!auditLog.recordOnce) throw new Error("durable idempotent audit storage is unavailable");
  await auditLog.recordOnce(task.finalizationAudit.idempotencyKey, {
    at: task.outcome.finalizedAt,
    principalId: task.actorId,
    action: "desktop_browser.task.finalized",
    resource: task.id,
    scopeLabel: projectScopeId(task.projectId),
    status: task.status,
  });
  const marked = await tasks.markFinalizationAudited(task.id, task.finalizationAudit.idempotencyKey);
  if (marked.status === "refused") throw new Error(marked.reason);
}

export async function reconcileDesktopBrowserFinalizationAudits(
  tasks: DesktopBrowserTaskStore,
  auditLog: AuditLog,
): Promise<void> {
  for (const task of await tasks.listPendingFinalizationAudits()) {
    await persistDesktopBrowserFinalizationAudit(tasks, auditLog, task);
  }
}

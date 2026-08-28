import type { AuditLog } from "../audit/audit-log.ts";
import { projectScopeId } from "../projects/project-store.ts";
import type { DesktopBrowserTask, DesktopBrowserTaskStore } from "./browser-task-store.ts";

export type DesktopBrowserRevoke = (input: {
  publicDeviceFingerprint: string;
  browserInstanceId: string;
  taskId: string;
  attemptId: string;
  leaseId: string;
  leaseVersion: number;
}) => Promise<void>;

export async function deliverDesktopBrowserStop(
  tasks: DesktopBrowserTaskStore,
  auditLog: AuditLog,
  revoke: DesktopBrowserRevoke,
  task: DesktopBrowserTask,
): Promise<void> {
  if (!task.stopIntent || !task.leaseRevocation)
    throw new Error("Desktop Browser Task Stop intent is unavailable");
  if (task.stopIntent.auditStatus !== "recorded") {
    try {
      if (!auditLog.recordOnce) throw new Error("durable idempotent audit storage is unavailable");
      await auditLog.recordOnce(`desktop-browser-stop:${task.id}`, {
        at: task.stopIntent.requestedAt,
        principalId: task.stopIntent.requestedBy,
        action: "desktop_browser.task.stopped",
        resource: task.id,
        scopeLabel: projectScopeId(task.projectId),
        status: task.status,
      });
      await tasks.markStopAudited(task.id);
    } catch (error) {
      void error;
    }
  }
  if (task.stopIntent.revocationStatus === "delivered") return;
  const authority = task.operations?.at(-1)?.operation.authority ?? task.execution?.operation.authority;
  if (!authority) throw new Error("Desktop Browser Task Lease authority is unavailable");
  await revoke({
    publicDeviceFingerprint: authority.deviceId,
    browserInstanceId: authority.browserInstanceId,
    taskId: task.id,
    attemptId: authority.attemptId,
    leaseId: authority.leaseId,
    leaseVersion: task.leaseRevocation.leaseVersion,
  });
  await tasks.markStopRevocationDelivered(task.id);
}

export async function reconcileDesktopBrowserStops(
  tasks: DesktopBrowserTaskStore,
  auditLog: AuditLog,
  revoke: DesktopBrowserRevoke,
): Promise<void> {
  const failures: unknown[] = [];
  for (const task of await tasks.listPendingStops()) {
    try {
      await deliverDesktopBrowserStop(tasks, auditLog, revoke, task);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Desktop Browser Stop reconciliation failed");
}

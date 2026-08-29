import type { App } from "../api/app-types.ts";
import type { DesktopBrowserTaskStore } from "./browser-task-store.ts";
import type { DesktopBrowserRelayControl } from "./relay-dispatcher.ts";

export async function reconcileDesktopBrowserAttempts(
  tasks: DesktopBrowserTaskStore,
  relay: Pick<DesktopBrowserRelayControl, "attemptStatus">,
  app: Pick<
    App,
    | "desktopBrowserConsumeSessionStartAccepted"
    | "desktopBrowserConsumeOperationAccepted"
    | "desktopBrowserConsumeRelayTerminalCallback"
  >,
): Promise<void> {
  const failures: unknown[] = [];
  for (const task of await tasks.list()) {
    if (!task.execution) continue;
    const currentOperation = task.operations?.at(-1);
    if (currentOperation?.hostResult || (!currentOperation && task.execution.hostResult)) continue;
    try {
      const status = await relay.attemptStatus(task.execution.attemptId);
      if (!status) continue;
      if (!status.accepted) {
        if (status.checkpoint.deliveryState !== "started") continue;
        const operationId = status.checkpoint.operationId;
        const current = task.operations?.find(
          (operation) => operation.operation.authority.operationId === operationId,
        );
        const marked = current
          ? await tasks.markOperationDeliveryUnknown(task.id, operationId)
          : await tasks.markSessionStartDeliveryUnknown(task.id, operationId);
        if (marked.status === "refused") throw new Error(marked.reason);
        continue;
      }
      if (status.result) {
        const consumed = await app.desktopBrowserConsumeRelayTerminalCallback(task.id, status.accepted, status.result);
        if (consumed.status === "refused") throw new Error(consumed.reason);
      } else {
        const consumed =
          status.checkpoint.operationId === task.execution.operation.authority.operationId
            ? await app.desktopBrowserConsumeSessionStartAccepted(task.id, status.accepted)
            : await app.desktopBrowserConsumeOperationAccepted(task.id, status.accepted);
        if (consumed.status === "refused") throw new Error(consumed.reason);
      }
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "Desktop Browser Attempt reconciliation failed");
}

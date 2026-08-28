import type { DesktopBrowserTask } from "./browser-task-store.ts";
import type { DesktopBrowserTaskRegistrationProjection } from "./device-registry.ts";

export interface DesktopBrowserActivityProjection {
  taskId: string;
  status:
    | "waiting_for_broker"
    | "waiting_for_local_confirmation"
    | "registration_confirmed"
    | "running"
    | "completed"
    | "failed"
    | "canceled"
    | "canceled_with_unknown_effects";
  connectCommand?: string;
  actionAuthority: string;
  actions: Array<"confirm" | "continue" | "cancel" | "stop">;
  registration?: {
    registrationId: string;
    confirmationFingerprint: string;
    expiresAt: string;
    confirmReady: boolean;
  };
  result?: {
    outcome: "completed" | "failed";
    summary: string;
    actorId: string;
    projectId: string;
    browserSkillSessionId?: string;
    browserInstanceId?: string;
    agentWindowId?: number;
    observation?: DesktopBrowserTask["latestObservation"];
  };
}

export function projectDesktopBrowserTaskActivity(
  task: Pick<
    DesktopBrowserTask,
    | "id"
    | "status"
    | "authorityId"
    | "actorId"
    | "projectId"
    | "outcome"
    | "browserSkillSessionId"
    | "browserSkillSessionStoppedAt"
    | "browserInstanceId"
    | "agentWindowId"
    | "continuationRunId"
    | "latestObservation"
  >,
  publicWebUrl: string | undefined,
  registration: DesktopBrowserTaskRegistrationProjection | null,
): DesktopBrowserActivityProjection {
  if ((task.status === "completed" || task.status === "failed") && task.outcome) {
    return {
      taskId: task.id,
      status: task.status,
      actionAuthority: task.authorityId,
      actions: [],
      result: {
        outcome: task.outcome.outcome,
        summary: task.outcome.summary,
        actorId: task.actorId,
        projectId: task.projectId,
        ...(task.browserSkillSessionId ? { browserSkillSessionId: task.browserSkillSessionId } : {}),
        ...(task.browserInstanceId ? { browserInstanceId: task.browserInstanceId } : {}),
        ...(task.agentWindowId === undefined ? {} : { agentWindowId: task.agentWindowId }),
        ...(task.latestObservation ? { observation: structuredClone(task.latestObservation) } : {}),
      },
    };
  }
  if (
    task.status === "waiting_for_broker" &&
    task.browserSkillSessionId &&
    !task.browserSkillSessionStoppedAt &&
    task.continuationRunId
  ) {
    return {
      taskId: task.id,
      status: "running",
      actionAuthority: task.authorityId,
      actions: ["stop"],
    };
  }
  if (task.status === "canceled" || task.status === "canceled_with_unknown_effects") {
    return {
      taskId: task.id,
      status: task.status,
      connectCommand: `qm-host-broker connect ${publicWebUrl}`,
      actionAuthority: task.authorityId,
      actions: [],
    };
  }
  if (!registration) {
    return {
      taskId: task.id,
      status: "waiting_for_broker",
      connectCommand: `qm-host-broker connect ${publicWebUrl}`,
      actionAuthority: task.authorityId,
      actions: ["cancel"],
    };
  }
  return {
    taskId: task.id,
    status: registration.status === "confirmed" ? "registration_confirmed" : "waiting_for_local_confirmation",
    connectCommand: `qm-host-broker connect ${publicWebUrl}`,
    actionAuthority: task.authorityId,
    actions: registration.status === "confirmed" ? ["continue", "cancel"] : ["confirm", "cancel"],
    registration: {
      registrationId: registration.registrationId,
      confirmationFingerprint: registration.confirmationFingerprint,
      expiresAt: registration.expiresAt,
      confirmReady: registration.status === "ready_to_confirm",
    },
  };
}

export function projectDesktopBrowserActivityReply(activity: DesktopBrowserActivityProjection): string {
  if (activity.status === "completed" || activity.status === "failed") {
    return activity.result?.summary ?? `Desktop Browser Task ${activity.status}.`;
  }
  if (activity.status === "running") return "Desktop Browser Task is running.";
  if (activity.status === "canceled_with_unknown_effects") {
    return "Desktop Browser Task canceled with unknown browser effects.";
  }
  if (activity.status === "canceled") return "Desktop Browser Task canceled.";
  if (activity.status === "waiting_for_broker") {
    return `No Host Broker is connected. Start it on the customer desktop:\n\n${activity.connectCommand}`;
  }
  if (activity.status === "registration_confirmed") {
    return "Desktop Browser registration confirmed. Continue when you are ready to run the original goal.";
  }
  return activity.registration?.confirmReady
    ? "Desktop Browser registration is ready to confirm. Match the fingerprint with the Host Broker preview, then confirm it here."
    : "Desktop Browser registration is waiting for local confirmation. Match the fingerprint with the Host Broker preview, then confirm it here once the Host envelope arrives.";
}

import { randomUUID } from "node:crypto";
import type { DurableMap } from "../persistence/durable-map.ts";

type DesktopBrowserTaskStatus = "waiting_for_broker" | "canceled";

export interface DesktopBrowserTask {
  id: string;
  status: DesktopBrowserTaskStatus;
  goal: string;
  actorId: string;
  actorSnapshot: { id: string; displayName?: string };
  projectId: string;
  projectSnapshot: { id: string; name: string };
  projectMembershipVersion: string;
  authorityId: string;
  authorityExpiresAt: number;
  sessionId: string;
  threadRef: string;
  createdAt: number;
  updatedAt: number;
}

interface CreateDesktopBrowserTaskInput {
  goal: string;
  actorId: string;
  actorDisplayName?: string;
  projectId: string;
  projectName: string;
  projectMembershipVersion: string;
  authorityId: string;
  authorityExpiresAt: number;
  sessionId: string;
  threadRef: string;
}

export interface DesktopBrowserTaskStore {
  createWaiting(input: CreateDesktopBrowserTaskInput): Promise<DesktopBrowserTask>;
  get(id: string): Promise<DesktopBrowserTask | null>;
  list(): Promise<DesktopBrowserTask[]>;
  listForSession(sessionId: string): Promise<DesktopBrowserTask[]>;
  cancelWaiting(id: string): Promise<DesktopBrowserTask | null>;
}

export function createDesktopBrowserTaskStore(
  backing: DurableMap<DesktopBrowserTask>,
  options: { id?: () => string; now?: () => number } = {},
): DesktopBrowserTaskStore {
  const id = options.id ?? randomUUID;
  const now = options.now ?? Date.now;
  const copy = (task: DesktopBrowserTask): DesktopBrowserTask => ({
    ...task,
    actorSnapshot: { ...task.actorSnapshot },
    projectSnapshot: { ...task.projectSnapshot },
  });
  return {
    async createWaiting(input) {
      const taskId = id();
      const at = now();
      const task: DesktopBrowserTask = {
        id: taskId,
        status: "waiting_for_broker",
        goal: input.goal,
        actorId: input.actorId,
        actorSnapshot: {
          id: input.actorId,
          ...(input.actorDisplayName ? { displayName: input.actorDisplayName } : {}),
        },
        projectId: input.projectId,
        projectSnapshot: { id: input.projectId, name: input.projectName },
        projectMembershipVersion: input.projectMembershipVersion,
        authorityId: input.authorityId,
        authorityExpiresAt: input.authorityExpiresAt,
        sessionId: input.sessionId,
        threadRef: input.threadRef,
        createdAt: at,
        updatedAt: at,
      };
      if (backing.insertIfAbsent) {
        if (!(await backing.insertIfAbsent(taskId, task)))
          throw new Error(`desktop browser task ${taskId} already exists`);
      } else {
        const stored = await backing.putIfAbsent(taskId, task);
        if (stored.id !== taskId) throw new Error(`desktop browser task ${taskId} already exists`);
      }
      return copy(task);
    },
    async get(id) {
      const task = await backing.get(id);
      return task ? copy(task) : null;
    },
    async list() {
      return (await backing.all())
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(copy);
    },
    async listForSession(sessionId) {
      return (await backing.all())
        .filter((task) => task.sessionId === sessionId)
        .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
        .map(copy);
    },
    async cancelWaiting(taskId) {
      let canceled = false;
      const task = await backing.update?.(taskId, (current) => {
        if (current.status !== "waiting_for_broker") return current;
        canceled = true;
        return { ...current, status: "canceled", updatedAt: now() };
      });
      return canceled && task ? copy(task) : null;
    },
  };
}

import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  desktopBrowserActivityEntry,
  entriesToMessages,
  type AssistantWork,
  type DesktopBrowserActivity,
} from "../src/core-bridge.ts";

const model = { id: "m", api: "anthropic", provider: "anthropic" } as unknown as Model<Api>;

test("a direct Desktop Browser Turn result becomes one updateable WorkBlock activity", () => {
  const activity: DesktopBrowserActivity = {
    taskId: "task-1",
    status: "waiting_for_broker",
    connectCommand: "qm-host-broker connect https://qm.example.com",
    actionAuthority: "turn-authority",
    actions: ["continue", "cancel"],
  };

  assert.deepEqual(desktopBrowserActivityEntry(activity, 123), {
    seq: 0,
    parentSeq: null,
    type: "desktop_browser_task",
    payload: activity,
    createdAt: 123,
  });
});

test("a persisted Desktop Browser assistant entry restores the activity after reload", () => {
  const activity: DesktopBrowserActivity = {
    taskId: "task-1",
    status: "waiting_for_broker",
    connectCommand: "qm-host-broker connect https://qm.example.com",
    actionAuthority: "turn-authority",
    actions: ["continue", "cancel"],
  };
  const messages = entriesToMessages(
    [
      {
        type: "user",
        payload: { text: "/desktop-browser open the dashboard" },
        createdAt: 100,
      },
      {
        type: "assistant",
        payload: { text: "Waiting", desktopBrowserActivity: activity },
        createdAt: 101,
      },
    ],
    model,
  );

  const assistant = messages.at(-1) as AssistantWork;
  assert.equal(assistant.role, "assistant");
  assert.deepEqual(assistant.work?.activity, [desktopBrowserActivityEntry(activity, 101)]);
});

test("replay keeps only the latest state for one Desktop Browser Task", () => {
  const waiting: DesktopBrowserActivity = {
    taskId: "task-1",
    status: "waiting_for_broker",
    connectCommand: "qm-host-broker connect https://qm.example.com",
    actionAuthority: "turn-authority",
    actions: ["continue", "cancel"],
  };
  const canceled: DesktopBrowserActivity = { ...waiting, status: "canceled", actions: [] };
  const messages = entriesToMessages(
    [
      {
        type: "user",
        payload: { text: "/desktop-browser open the dashboard" },
        createdAt: 100,
      },
      {
        type: "assistant",
        payload: { text: "Waiting", desktopBrowserActivity: waiting },
        createdAt: 101,
      },
      {
        type: "assistant",
        payload: { text: "Canceled", desktopBrowserActivity: canceled },
        createdAt: 102,
      },
    ],
    model,
  );

  const activities = messages.flatMap((message) =>
    message.role === "assistant" ? ((message as AssistantWork).work?.activity ?? []) : [],
  );
  assert.deepEqual(activities, [desktopBrowserActivityEntry(canceled, 102)]);
});

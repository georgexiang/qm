import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
  confirmDesktopBrowserRegistration,
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
    actions: ["cancel"],
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
    status: "waiting_for_local_confirmation",
    connectCommand: "qm-host-broker connect https://qm.example.com",
    actionAuthority: "turn-authority",
    actions: ["confirm", "cancel"],
    registration: {
      registrationId: "reg-1",
      confirmationFingerprint: "4f8c52de91a3b10c",
      expiresAt: "2026-08-26T12:00:00.000Z",
      confirmReady: false,
    },
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
    status: "waiting_for_local_confirmation",
    connectCommand: "qm-host-broker connect https://qm.example.com",
    actionAuthority: "turn-authority",
    actions: ["confirm", "cancel"],
    registration: {
      registrationId: "reg-1",
      confirmationFingerprint: "4f8c52de91a3b10c",
      expiresAt: "2026-08-26T12:00:00.000Z",
      confirmReady: true,
    },
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

test("registration confirmation calls the dedicated WebUI route", async () => {
  const originalFetch = globalThis.fetch;
  let call: { url: string; body: Record<string, unknown> } | null = null;
  globalThis.fetch = (async (input, init) => {
    call = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    };
    return new Response(JSON.stringify({ status: "ok" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  try {
    await confirmDesktopBrowserRegistration("reg-1", "task-1", "turn-authority", "4f8c52de91a3b10c");
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.deepEqual(call, {
    url: "/api/desktop-browser/registrations/reg-1/confirm",
    body: {
      taskId: "task-1",
      authorityId: "turn-authority",
      confirmationFingerprint: "4f8c52de91a3b10c",
    },
  });
});

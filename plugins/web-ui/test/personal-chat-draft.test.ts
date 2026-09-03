import { beforeEach, test } from "node:test";
import assert from "node:assert/strict";
import { clearAllDrafts, newChatDraftKey, storedDraft } from "../src/drafts.ts";
import { openPersonalChatDraftWithSeams } from "../src/personal-chat-draft.ts";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

beforeEach(() => {
  clearAllDrafts();
  store.clear();
});

test("openPersonalChatDraft helper saves the exact Device Code command for a signed-in user and opens a new chat draft", () => {
  let newChatCalls = 0;
  openPersonalChatDraftWithSeams("/azure-ops connect my Azure account using Device Code", "alice", () => {
    newChatCalls += 1;
  });

  assert.equal(newChatCalls, 1);
  assert.equal(storedDraft(newChatDraftKey("alice")), "/azure-ops connect my Azure account using Device Code");
  assert.equal(storedDraft(newChatDraftKey("bob")), "");
  assert.equal(storedDraft("web:alice:existing"), "");
});

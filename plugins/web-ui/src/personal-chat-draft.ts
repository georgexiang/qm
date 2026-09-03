import { newChatDraftKey, saveDraft } from "./drafts.ts";

export function openPersonalChatDraftWithSeams(
  text: string,
  user: string | null | undefined,
  openNewChat: () => void,
): void {
  saveDraft(newChatDraftKey(user), text);
  openNewChat();
}

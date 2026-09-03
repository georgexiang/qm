import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../src/contexts.ts", import.meta.url), "utf8");

test("contexts pane redraws preserve focus instead of raw-replacing the DOM", () => {
  assert.match(
    source,
    /render\(selected \? detailTpl\(selected\) : gridTpl\(\), host\);\s+replacePanePreservingFocus\(host\);/,
  );
  assert.doesNotMatch(source, /appState\.mainEl\.replaceChildren/);
});

test("contexts pane text inputs carry focus keys", () => {
  assert.match(source, /data-focus-key="project-member-search"/);
  assert.match(source, /data-focus-key="contexts-search"/);
  assert.match(source, /data-focus-key="project-name"/);
  assert.match(
    readFileSync(new URL("../src/ambient-policy.ts", import.meta.url), "utf8"),
    /data-focus-key="ambient-orders"/,
  );
});

test("member search commits the typed query to state on input", () => {
  const input = source.match(/<input\s+id="project-member-search"[^]*?\/>/)?.[0] ?? "";
  assert.match(
    input,
    /@input=\$\{[^]*?contextsState\.memberQuery = \(event\.currentTarget as HTMLInputElement\)\.value/,
  );
  assert.match(input, /\.value=\$\{contextsState\.memberQuery\}/);
});

test("member search runs debounced as you type", () => {
  const input = source.match(/<input\s+id="project-member-search"[^]*?\/>/)?.[0] ?? "";
  assert.match(input, /@input=\$\{[^]*?scheduleMemberSearch\(/);
  assert.match(source, /function scheduleMemberSearch\(/);
  assert.match(source, /clearTimeout\(memberSearchTimer\)/);
  assert.match(source, /memberSearchTimer = (?:window\.)?setTimeout\([^]*?MEMBER_SEARCH_DEBOUNCE_MS/);
});

test("submit and debounce share runMemberSearch", () => {
  assert.match(source, /async function runMemberSearch\(/);
  const submit = source.match(/async function searchProjectMembers\([^]*?\n\}/)?.[0] ?? "";
  assert.match(submit, /runMemberSearch\(/);
});

test("no-match searches render visible feedback", () => {
  assert.match(source, /memberSearchedQuery/);
  assert.match(source, /No matches for/);
  assert.match(source, /already in this project/);
});

test("dismissing the picker cancels a pending debounced search", () => {
  for (const fn of ["closeMemberPicker", "toggleMemberPicker", "selectContext", "addProjectMember"]) {
    const body = source.match(new RegExp(`function ${fn}\\([^]*?\\n\\}`))?.[0] ?? "";
    assert.match(body, /cancelMemberSearchTimer\(\)/, `${fn} must cancel the debounce timer`);
  }
});

test("typing supersedes an in-flight search", () => {
  const sched = source.match(/function scheduleMemberSearch\([^]*?\n\}/)?.[0] ?? "";
  assert.match(sched, /memberSearchSeq\+\+/);
  assert.match(sched, /memberSearching = false/);
});

test("result cap applies after the member filter", () => {
  assert.match(source, /\.filter\(\(match\) => !members\.has\(match\.principalId\)\)\.slice\(0, 8\)/);
});

test("every project member can invite while only the owner can remove people", () => {
  const detail = source.match(/function detailTpl\([^]*?\n\}/)?.[0] ?? "";
  const members = source.match(/function projectMembersSection\([^]*?\n\}/)?.[0] ?? "";
  assert.match(detail, /\$\{\s*c\.project\s*\? html`<button class="btn context-add-member"/);
  assert.doesNotMatch(detail, /c\.project && isProjectOwner\(c\)/);
  assert.match(members, /isProjectOwner\(context\) && principalId !== project\.ownerId/);
});

test("project settings includes Azure access section with owner edit and member read-only states", () => {
  assert.match(source, /projectAzureSection\(c\)/);
  const azureSection = source.match(/function projectAzureSection\([^]*?\n\}/)?.[0] ?? "";
  assert.match(azureSection, /Azure access/);
  assert.match(azureSection, /Only the Project Owner can change Azure access settings\./);
  assert.match(azureSection, /This Project will use Azure as the selected account\./);
  assert.match(azureSection, /Every active Project\s+member who can run \/azure-ops/);
  assert.match(azureSection, /may indirectly use that account(?:'|\\')s Azure\s+permissions\./);
  assert.match(azureSection, /I understand this Project-sharing impact and want to continue\./);
  assert.match(azureSection, /saveProjectAzureBinding\(context\)/);
  assert.match(azureSection, /disconnectProjectAzureBinding\(context\)/);
  assert.match(azureSection, /azureAllowlist/);
});

test("project Azure access loads and saves via dedicated API routes", () => {
  assert.match(source, /\/api\/azure\/default\?scopeId=/);
  assert.match(source, /api<\{ connections\?: AzureConnection\[\] \}>\("\/api\/azure\/connections"\)/);
  assert.match(source, /api\("\/api\/azure\/default", \{/);
  assert.match(
    source,
    /confirmProjectSharing: needsSharingConfirmation \? contextsState\.azureProjectSharingConfirmed : false/,
  );
});

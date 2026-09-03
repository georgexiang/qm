import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const shell = readFileSync(new URL("../src/shell.ts", import.meta.url), "utf8");

test("sidebar identity prefers displayName while retaining the stable principal in the title", () => {
  assert.match(shell, /title=\$\{appState\.me\?\.user \?\? ""\}/);
  assert.match(shell, /initials\(appState\.me\?\.displayName \|\| appState\.me\?\.user \|\| "\?"\)/);
  assert.match(shell, /user-name">\$\{appState\.me\?\.displayName \|\| appState\.me\?\.user \|\| ""\}/);
});

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

function slice(from: string, to: string): string {
  const start = html.indexOf(from);
  const end = html.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `could not extract ${from}`);
  return html.slice(start, end);
}

function resolveView(pathname: string, search: string): string {
  const src = [
    slice("const SECTIONS = [", "const DISABLED_VIEWS"),
    slice("const DEFAULT_VIEW = ", ";") + ";",
    slice("function urlToState() {", "let transcriptObserver"),
    "urlToState().view;",
  ].join("\n");
  const context = vm.createContext({
    URLSearchParams,
    API_BASE: "/admin",
    scope: "org",
    location: { pathname, search },
  });
  return vm.runInContext(src, context);
}

interface FakeElement {
  textContent: string;
  className: string;
  value: string;
  placeholder: string;
  disabled: boolean;
  href: string;
  options: Array<{ value?: string; textContent?: string }>;
  appendChild(option: { value?: string; textContent?: string }): void;
}

async function runLoadOnboarding(modelProviders: unknown): Promise<Record<string, FakeElement>> {
  const src = slice("let onboardingModels = {};", '$("onboarding-model-provider").onchange') + "\nloadOnboarding();";
  const elements: Record<string, FakeElement> = {};
  const fixtures: Record<string, unknown> = {
    "/api/model-providers": modelProviders,
    "/api/slack-installation": { configured: false },
    "/api/connector-catalog": { catalog: [] },
    "/api/scopes/org%3Adefault-org": { baseModel: "claude-opus-5" },
  };
  const context = vm.createContext({
    $: (id: string) =>
      (elements[id] ??= {
        textContent: "",
        className: "",
        value: "",
        placeholder: "",
        disabled: false,
        href: "",
        options: [],
        appendChild(option) {
          this.options.push(option);
        },
      }),
    api: async (_method: string, path: string) => ({ ok: true, data: fixtures[path] ?? {} }),
    orgScope: () => "org:default-org",
    encodeURIComponent,
    setStatus: () => {},
    connectorName: (id: string) => id,
    viewLoadedAt: {},
    Date,
    document: { createElement: () => ({}) },
  });
  await vm.runInContext(src, context);
  return elements;
}

async function runLoadOnboardingView(
  results: { onboarding?: boolean | Error; customProviders?: boolean | Error } = {},
  calls = { onboarding: 0, customProviders: 0, loadedAt: 0 },
): Promise<{ onboarding: number; customProviders: number; loadedAt: number }> {
  const src = slice("let onboardingLoad;", "async function loadOnboarding()") + "\nloadOnboardingView();";
  const context = vm.createContext({
    loadOnboarding: async () => {
      calls.onboarding += 1;
      if (results.onboarding instanceof Error) throw results.onboarding;
      return results.onboarding ?? true;
    },
    loadCustomProviders: async () => {
      calls.customProviders += 1;
      if (results.customProviders instanceof Error) throw results.customProviders;
      return results.customProviders ?? true;
    },
    viewLoadedAt: new Proxy(
      {},
      {
        set(_target, property, value) {
          if (property === "onboarding") calls.loadedAt = value as number;
          return true;
        },
      },
    ),
    Date,
  });
  await vm.runInContext(src, context);
  return calls;
}

const UNCONFIGURED_PROVIDERS = [
  { provider: "anthropic", configured: false, source: "absent" },
  { provider: "openai", configured: false, source: "absent" },
  { provider: "openrouter", configured: false, source: "absent" },
];
const ANTHROPIC_MODELS = [{ id: "claude-opus-5", name: "Claude Opus 5", provider: "anthropic" }];

test("harness-carried auth shows the model step as ready without a stored key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
    harnessAuth: { harnessId: "claude", provider: "anthropic" },
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge ok");
  assert.equal(
    elements["onboarding-model-summary"]!.textContent,
    "claude-opus-5 · authenticated by the claude harness — no API key needed.",
  );
});

test("without harness auth an unconfigured provider still needs a key", async () => {
  const elements = await runLoadOnboarding({
    providers: UNCONFIGURED_PROVIDERS,
    models: ANTHROPIC_MODELS,
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Needs a key");
  assert.equal(elements["onboarding-model-badge"]!.className, "badge warn");
  assert.match(elements["onboarding-model-summary"]!.textContent, /cannot run until its Anthropic key is configured/);
});

test("a stored key keeps its summary even when the harness also carries auth", async () => {
  const elements = await runLoadOnboarding({
    providers: [
      { provider: "anthropic", configured: true, source: "admin" },
      { provider: "openai", configured: false, source: "absent" },
      { provider: "openrouter", configured: false, source: "absent" },
    ],
    models: ANTHROPIC_MODELS,
    harnessAuth: { harnessId: "claude", provider: "anthropic" },
  });
  assert.equal(elements["onboarding-model-badge"]!.textContent, "Ready");
  assert.equal(elements["onboarding-model-summary"]!.textContent, "claude-opus-5 · admin-managed key");
});

test("onboarding is a navigable view", () => {
  assert.match(html, /\{ label: "Admin", views: \["onboarding",/);
});

test("/admin/onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/onboarding", ""), "onboarding");
});

test("the onboarding view loads setup and saved custom providers", async () => {
  const calls = await runLoadOnboardingView();
  assert.equal(calls.onboarding, 1);
  assert.equal(calls.customProviders, 1);
  assert.ok(calls.loadedAt > 0);
});

test("saved custom providers still load when setup loading fails", async () => {
  for (const onboarding of [false, new Error("unavailable")]) {
    const calls = await runLoadOnboardingView({ onboarding });
    assert.equal(calls.onboarding, 1);
    assert.equal(calls.customProviders, 1);
    assert.equal(calls.loadedAt, 0);
  }
});

test("failed custom-provider loads do not mark onboarding fresh", async () => {
  for (const customProviders of [false, new Error("unavailable")]) {
    const calls = await runLoadOnboardingView({ customProviders });
    assert.equal(calls.onboarding, 1);
    assert.equal(calls.customProviders, 1);
    assert.equal(calls.loadedAt, 0);
  }
});

test("overlapping onboarding refreshes share one load", async () => {
  const src =
    slice("let onboardingLoad;", "async function loadOnboarding()") +
    "\nawait Promise.all([loadOnboardingView(), loadOnboardingView()]);";
  const calls = { onboarding: 0, customProviders: 0, loadedAt: 0 };
  const context = vm.createContext({
    loadOnboarding: async () => {
      calls.onboarding += 1;
      return true;
    },
    loadCustomProviders: async () => {
      calls.customProviders += 1;
      return true;
    },
    viewLoadedAt: new Proxy({}, { set: () => true }),
    Promise,
  });
  await vm.runInContext(`(async () => { ${src} })()`, context);
  assert.equal(calls.onboarding, 1);
  assert.equal(calls.customProviders, 1);
});

test("mutation refresh waits for an in-flight read and loads again", async () => {
  const src =
    slice("let onboardingLoad;", "async function loadOnboarding()") +
    "\nconst first = loadOnboardingView(); await firstStarted; const forced = loadOnboardingView(true); await Promise.resolve(); assertForcedPending(); releaseFirst(); await first; await secondStarted; assertSecondStarted(); await forced;";
  const calls = { onboarding: 0, customProviders: 0 };
  let releaseFirst = () => {};
  let resolveFirstStarted = () => {};
  let resolveSecondStarted = () => {};
  const firstLoad = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const firstStarted = new Promise<void>((resolve) => {
    resolveFirstStarted = resolve;
  });
  const secondStarted = new Promise<void>((resolve) => {
    resolveSecondStarted = resolve;
  });
  function recordStart() {
    const total = calls.onboarding + calls.customProviders;
    if (total === 2) resolveFirstStarted();
    if (total === 4) resolveSecondStarted();
  }
  const context = vm.createContext({
    loadOnboarding: async () => {
      calls.onboarding += 1;
      recordStart();
      if (calls.onboarding === 1) await firstLoad;
      return true;
    },
    loadCustomProviders: async () => {
      calls.customProviders += 1;
      recordStart();
      if (calls.customProviders === 1) await firstLoad;
      return true;
    },
    assertForcedPending: () => {
      assert.deepEqual(calls, { onboarding: 1, customProviders: 1 });
    },
    assertSecondStarted: () => {
      assert.deepEqual(calls, { onboarding: 2, customProviders: 2 });
    },
    firstStarted,
    secondStarted,
    releaseFirst,
    viewLoadedAt: new Proxy({}, { set: () => true }),
    Promise,
    Date,
  });
  await vm.runInContext(`(async () => { ${src} })()`, context);
  assert.equal(calls.onboarding, 2);
  assert.equal(calls.customProviders, 2);
});

test("initial and focus onboarding refreshes use the complete view loader", () => {
  assert.match(html, /if \(view === "onboarding"\) return void loadOnboardingView\(\);/);
  assert.match(html, /if \(view === "onboarding"\) \{\s+loadOnboardingView\(\);\s+return;/);
});

test("?view=onboarding resolves to the onboarding view", () => {
  assert.equal(resolveView("/admin/", "?view=onboarding"), "onboarding");
});

test("unknown views still fall back to the default view", () => {
  assert.equal(resolveView("/admin/no-such-view", ""), "history");
});

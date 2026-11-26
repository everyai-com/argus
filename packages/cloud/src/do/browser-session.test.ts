// @vitest-environment happy-dom
/**
 * The session-action path end to end, without a browser: the real
 * BrowserSession DO, its real in-page code, and a stand-in for the Playwright
 * page that drives happy-dom's DOM. What is faked is only the transport to
 * Chromium (locators, navigation, layout) — every response below is produced
 * by the code that ships.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { ActBatchResultSchema, ActResultSchema, FlowDraftSchema, FlowSchema, type ActResult, type FlowDraft } from "@argus/shared";
import { BrowserSession } from "./browser-session";

const SECRET = "hunter2-secret";

/** A two-screen app: a sign-in form, then a task board. */
function mountApp(): void {
  document.title = "Sign in";
  document.body.innerHTML = `
    <h1>Sign in</h1>
    <label for="email">Email</label><input id="email" name="email" />
    <input type="password" name="password" data-testid="login-password" placeholder="Password" />
    <button data-testid="sign-in">Sign in</button>`;
  (document.querySelector('[data-testid="sign-in"]') as any).addEventListener("click", () => {
    (window as any).happyDOM.setURL("http://app.test/board");
    document.title = "Task Board";
    document.body.innerHTML = `
      <h1>Task Board</h1>
      <p data-testid="task-count">0 task(s)</p>
      <input placeholder="New task title" />
      <button>Add</button>
      <ul></ul>
      <button class="del">Delete</button><button class="del">Delete</button>`;
    const input = document.querySelector("input") as any;
    (document.querySelector("button") as any).addEventListener("click", () => {
      const li = document.createElement("li");
      li.textContent = input.value;
      document.querySelector("ul")!.appendChild(li);
      input.value = "";
      const count = document.querySelectorAll("li").length;
      (document.querySelector('[data-testid="task-count"]') as any).textContent = `${count} task(s)`;
    });
  });
}

/** The slice of Playwright's Page the session uses, over the live happy-dom document. */
function fakePage(): unknown {
  const all = (css: string): any[] => Array.from(document.querySelectorAll(css));
  const text = (el: any) => String(el.textContent ?? "").replace(/\s+/g, " ").trim();
  const implicitRole = (el: any): string | undefined => {
    const tag = String(el.tagName).toLowerCase();
    if (el.getAttribute("role")) return el.getAttribute("role");
    if (tag === "button") return "button";
    if (tag === "a") return "link";
    if (tag === "input" && el.type !== "password") return "textbox";
    return undefined;
  };
  const accName = (el: any) =>
    el.getAttribute("aria-label") || text(el.labels?.[0] ?? {}) || text(el) || el.getAttribute("placeholder") || "";
  const locator = (find: () => any[]): any => ({
    count: async () => find().length,
    first: () => locator(() => find().slice(0, 1)),
    nth: (i: number) => locator(() => find().slice(i, i + 1)),
    click: async () => find()[0].click(),
    hover: async () => {},
    press: async () => {},
    fill: async (value: string) => {
      const el = find()[0];
      if (el.disabled) throw new Error(`locator.fill: Timeout 5000ms exceeded.\n  - fill("${value}")`);
      el.value = value;
    },
    selectOption: async (value: string) => {
      find()[0].value = value;
    },
    evaluate: async (fn: (el: any, arg?: unknown) => unknown, arg?: unknown) => fn(find()[0], arg),
    evaluateAll: async (fn: (els: any[], arg?: unknown) => unknown, arg?: unknown) => fn(find(), arg),
    getAttribute: async (name: string) => find()[0].getAttribute(name),
  });
  return {
    url: () => String(window.location.href),
    title: async () => String(document.title),
    goto: async (url: string) => {
      (window as any).happyDOM.setURL(url);
      mountApp();
    },
    evaluate: async (fn: (arg?: unknown) => unknown, arg?: unknown) => fn(arg),
    waitForLoadState: async () => {},
    waitForTimeout: async () => {},
    locator: (css: string) => locator(() => all(css)),
    getByTestId: (id: string) => locator(() => all(`[data-testid="${id}"]`)),
    getByText: (t: string) => locator(() => all("body *").filter((el) => el.children.length === 0 && text(el).includes(t))),
    getByRole: (role: string, opts: { name?: string } = {}) =>
      locator(() =>
        all("body *").filter(
          (el) =>
            implicitRole(el) === role &&
            (!opts.name || accName(el).toLowerCase().includes(opts.name.toLowerCase()))
        )
      ),
    keyboard: { press: async () => {} },
    mouse: { wheel: async () => {} },
  };
}

function session() {
  const store = new Map<string, unknown>();
  const ctx = {
    storage: {
      get: async (key: string) => structuredClone(store.get(key)),
      put: async (key: string, value: unknown) => void store.set(key, structuredClone(value)),
      delete: async (key: string) => store.delete(key),
      setAlarm: async () => {},
      deleteAlarm: async () => {},
    },
  };
  const do_ = new BrowserSession(ctx as never, {} as never);
  Object.assign(do_ as unknown as Record<string, unknown>, {
    page: fakePage(),
    browser: { isConnected: () => true },
  });
  const call = async <T>(command: string, body: unknown = {}): Promise<T> => {
    const res = await do_.fetch(new Request(`https://do/${command}`, { method: "POST", body: JSON.stringify(body) }));
    return (await res.json()) as T;
  };
  return { call, do_ };
}

async function leased() {
  const s = session();
  await s.call("init", {
    sessionId: "s1",
    tenantId: "t1",
    url: "http://app.test/",
    viewport: "desktop",
    colorScheme: "light",
    ttlSeconds: 300,
    label: "sign in & add",
  });
  return s;
}

beforeEach(() => {
  (window as any).Element.prototype.getBoundingClientRect = function () {
    const shown = !this.closest("[hidden]");
    return { x: 0, y: 0, width: shown ? 10 : 0, height: shown ? 10 : 0 };
  };
  delete (window as any).__argusDoc;
  delete (window as any).__argusRefCounter;
});

describe("session actions answer with the step and the screen diff", () => {
  it("keeps every existing field and adds step + diff", async () => {
    const { call } = await leased();
    const result = await call<ActResult>("act", { action: "fill", anchor: { css: "#email" }, value: "a@b.co" });
    expect(ActResultSchema.safeParse(result).success).toBe(true);
    // Before this change the response was exactly these three fields.
    expect(result.ok).toBe(true);
    expect(result.resolution).toEqual({ via: "css", matched: 1 });
    expect(result.effects).toEqual({
      urlBefore: "http://app.test/",
      urlAfter: "http://app.test/",
      navigated: false,
      domNodeDelta: 0,
      newConsoleErrors: 0,
      newNetworkFailures: 0,
    });
    // Added.
    expect(result.step).toEqual({
      action: { action: "fill", value: "a@b.co" },
      anchor: { css: "#email" },
      expect: [],
    });
    expect(result.diff).toEqual({
      added: [],
      removed: [],
      changed: ['input[name="Email"]: value "" → "a@b.co"'],
    });
  });

  it("resolves a ref to a verified semantic anchor, and reports navigation in the diff", async () => {
    const { call } = await leased();
    const { elements } = await call<{ elements: Array<{ ref: string; testid?: string; text?: string }> }>("query", {
      interactive: true,
    });
    const signIn = elements.find((e) => e.testid === "sign-in")!;
    const result = await call<ActResult>("act", { action: "click", ref: signIn.ref });
    expect(result.step).toEqual({ action: { action: "click" }, anchor: { testid: "sign-in" }, expect: [] });
    expect(result.stepNote).toBeUndefined();
    expect(result.diff!.url).toEqual({ from: "http://app.test/", to: "http://app.test/board" });
    expect(result.diff!.title).toEqual({ from: "Sign in", to: "Task Board" });
    expect(result.diff!.added).toContain('p[testid=task-count] "0 task(s)"');
    expect(result.diff!.removed).toContain('button[testid=sign-in] "Sign in"');

    // No testid: the ladder falls to role + name, and only because it resolves to this one element.
    const board = await call<{ elements: Array<{ ref: string; text?: string }> }>("query", { interactive: true });
    const add = board.elements.find((e) => e.text === "Add")!;
    const added = await call<ActResult>("act", { action: "click", ref: add.ref });
    expect(added.step!.anchor).toEqual({ role: "button", name: "Add" });

    // Two identical buttons: no anchor is unique, and the response says so instead of guessing.
    const del = board.elements.find((e) => e.text === "Delete")!;
    const ambiguous = await call<ActResult>("act", { action: "click", ref: del.ref });
    expect(ambiguous.ok).toBe(true);
    expect(ambiguous.stepNote).toContain("matched 2 elements");
  });

  it("never returns a password field's value — step, diff, query, error, recording or draft", async () => {
    const { call } = await leased();
    await call("record-start", { name: "login" });
    const seen: unknown[] = [];

    const fill = await call<ActResult>("act", {
      action: "fill",
      anchor: { testid: "login-password" },
      value: SECRET,
    });
    seen.push(fill);
    expect(fill.step!.action).toEqual({ action: "fill", value: "${LOGIN_PASSWORD}" });
    expect(fill.stepNote).toContain("LOGIN_PASSWORD");
    expect(fill.diff!.changed).toEqual([
      'input[type=password testid=login-password name="Password"]: value "" → [redacted]',
    ]);

    const query = await call<{ elements: Array<{ testid?: string; text?: string }> }>("query", { interactive: true });
    seen.push(query);
    expect(query.elements.find((e) => e.testid === "login-password")!.text).toBeUndefined();

    // A failing fill: Playwright's error quotes the typed text.
    (document.querySelector('[data-testid="login-password"]') as any).disabled = true;
    const failed = await call<ActResult>("act", { action: "fill", anchor: { testid: "login-password" }, value: SECRET });
    seen.push(failed);
    expect(failed.ok).toBe(false);
    expect(failed.error).toContain('fill("[redacted]")');
    expect(failed.step).toBeUndefined();

    seen.push(await call("record-stop"));
    seen.push(await call("flow-draft"));
    seen.push(
      await call("act-batch", {
        steps: [{ action: "fill", anchor: { css: "#email" }, value: "a@b.co" }],
      })
    );
    expect(JSON.stringify(seen)).not.toContain(SECRET);
  });

  it("returns the accumulated steps as a flow that saves as it stands", async () => {
    const { call } = await leased();
    const batch = await call<{ results: ActResult[]; completed: number }>("act-batch", {
      steps: [
        { action: "fill", anchor: { css: "#email" }, value: "a@b.co" },
        { action: "fill", anchor: { testid: "login-password" }, value: SECRET },
        { action: "click", anchor: { testid: "sign-in" } },
        { action: "click", anchor: { testid: "nope" } }, // fails: not accumulated
      ],
    });
    expect(ActBatchResultSchema.safeParse(batch).success).toBe(true);
    expect(batch.completed).toBe(3);
    expect(batch.results.map((r) => Boolean(r.step))).toEqual([true, true, true, false]);
    expect(batch.results[2]!.diff!.url).toBeDefined();

    const draft = await call<FlowDraft>("flow-draft", { name: "sign-in" });
    expect(FlowDraftSchema.safeParse(draft).success).toBe(true);
    expect(draft.ready).toBe(true);
    expect(draft.flow).toEqual({
      name: "sign-in",
      startUrl: "http://app.test/",
      viewport: "desktop",
      steps: [
        { action: { action: "fill", value: "a@b.co" }, anchor: { css: "#email" }, expect: [] },
        { action: { action: "fill", value: "${LOGIN_PASSWORD}" }, anchor: { testid: "login-password" }, expect: [] },
        { action: { action: "click" }, anchor: { testid: "sign-in" }, expect: [] },
      ],
      success: [
        { kind: "route", includes: "/board" },
        { kind: "console-clean", since: 0, cumulative: false, includeThirdParty: false },
      ],
    });
    expect(draft.placeholders).toEqual(["LOGIN_PASSWORD"]);
    // Exactly what argus_flow_save builds from these arguments.
    expect(FlowSchema.safeParse({ version: 1, ...draft.flow }).success).toBe(true);

    // The default name comes from the lease label; reset starts over from the current page.
    const reset = await call<FlowDraft>("flow-draft", { reset: true });
    expect(reset.flow.name).toBe("sign-in-add");
    expect(reset.flow.steps).toHaveLength(3);
    const after = await call<FlowDraft>("flow-draft");
    expect(after.flow.steps).toEqual([]);
    expect(after.flow.startUrl).toBe("http://app.test/board");
    expect(after.ready).toBe(false);
  });
});

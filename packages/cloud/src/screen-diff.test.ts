// @vitest-environment happy-dom
/**
 * The snapshot collector runs in a real DOM here (happy-dom), so the code that
 * ships into the page is the code under test. happy-dom has no layout, so the
 * one thing stubbed is the bounding box: an element is "laid out" unless it or
 * an ancestor carries `hidden`.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { SCREEN_DIFF_LIMITS } from "@argus/shared";
import { collectSnapshot, diffSnapshots, type Snapshot, type SnapshotElement } from "./screen-diff";

const LIMITS: { maxEls: number; maxText: number } = {
  maxEls: SCREEN_DIFF_LIMITS.snapshotElements,
  maxText: SCREEN_DIFF_LIMITS.text,
};
const snap = (opts = LIMITS) => collectSnapshot(opts);

beforeEach(() => {
  (window as any).Element.prototype.getBoundingClientRect = function () {
    const shown = !this.closest("[hidden]");
    return { x: 0, y: 0, width: shown ? 10 : 0, height: shown ? 10 : 0 };
  };
  delete (window as any).__argusDoc;
  document.title = "Task Board";
  document.body.innerHTML = `
    <main>
      <h1>Task Board</h1>
      <p data-testid="task-count">2 task(s)</p>
      <input data-testid="new-task" placeholder="New task title" />
      <button data-testid="add-task"><span>Add</span></button>
      <ul data-testid="task-list"><li>Ship Argus</li><li>Test everything</li></ul>
      <div hidden><p>never shown</p></div>
      <script>var ignored = 1;</script>
    </main>`;
});

describe("collectSnapshot", () => {
  it("lists visible, meaningful elements with their identity and content", () => {
    const s = snap();
    const lines = s.els.map((e) => [e.tag, e.testid, e.text, e.value]);
    expect(lines).toEqual([
      ["h1", undefined, "Task Board", undefined],
      ["p", "task-count", "2 task(s)", undefined],
      ["input", "new-task", undefined, ""],
      ["button", "add-task", "Add", undefined], // its <span> is not listed again
      ["ul", "task-list", undefined, undefined],
      ["li", undefined, "Ship Argus", undefined],
      ["li", undefined, "Test everything", undefined],
    ]);
    expect(s.els[2]!.name).toBe("New task title");
    expect(s.title).toBe("Task Board");
    expect(s.partial).toBe(false);
  });

  it("never reads what a password field holds, even after a show-password toggle", () => {
    document.body.innerHTML = `<input type="password" name="pw" /><input autocomplete="current-password" name="pw2" />`;
    const [pw, pw2] = Array.from(document.querySelectorAll("input")) as any[];
    expect(snap().els.map((e) => e.value)).toEqual(["", ""]);
    pw.value = "hunter2-secret";
    pw2.value = "hunter2-secret";
    expect(JSON.stringify(snap())).not.toContain("hunter2");
    expect(snap().els.map((e) => e.value)).toEqual(["[redacted]", "[redacted]"]);
    pw.setAttribute("type", "text"); // "show password"
    expect(JSON.stringify(snap())).not.toContain("hunter2");
  });

  it("caps the snapshot and says so", () => {
    document.body.innerHTML = Array.from({ length: 30 }, (_, i) => `<p>row ${i}</p>`).join("");
    const s = snap({ maxEls: 10, maxText: 80 });
    expect(s.els).toHaveLength(10);
    expect(s.partial).toBe(true);
  });
});

describe("diffSnapshots", () => {
  it("reports an in-place change as changed, and new nodes as added", () => {
    const before = snap();
    (document.querySelector('[data-testid="task-count"]') as any).textContent = "3 task(s)";
    const li = document.createElement("li");
    li.textContent = "Buy milk";
    document.querySelector("ul")!.appendChild(li);
    const diff = diffSnapshots(before, snap());
    expect(diff).toEqual({
      added: ['li "Buy milk"'],
      removed: [],
      changed: ['p[testid=task-count]: text "2 task(s)" → "3 task(s)"'],
    });
  });

  it("reports value and state changes on the same node", () => {
    const before = snap();
    (document.querySelector('[data-testid="new-task"]') as any).value = "Buy milk";
    (document.querySelector('[data-testid="add-task"]') as any).disabled = true;
    expect(diffSnapshots(before, snap()).changed).toEqual([
      'input[testid=new-task name="New task title"]: value "" → "Buy milk"',
      'button[testid=add-task] "Add": state +disabled',
    ]);
  });

  it("is empty when nothing changed, even after a full re-render", () => {
    const before = snap();
    document.body.innerHTML = document.body.innerHTML; // every node is new
    expect(diffSnapshots(before, snap())).toEqual({ added: [], removed: [], changed: [] });
  });

  it("pairs a re-rendered element by testid instead of reporting a swap", () => {
    const before = snap();
    document.body.innerHTML = document.body.innerHTML.replace("2 task(s)", "5 task(s)");
    expect(diffSnapshots(before, snap())).toEqual({
      added: [],
      removed: [],
      changed: ['p[testid=task-count]: text "2 task(s)" → "5 task(s)"'],
    });
  });

  it("reports URL and title changes, and removed elements", () => {
    const before = snap();
    document.title = "Done";
    document.querySelector("ul")!.remove();
    const after = { ...snap(), url: "https://app.test/done" };
    const diff = diffSnapshots({ ...before, url: "https://app.test/" }, after);
    expect(diff.url).toEqual({ from: "https://app.test/", to: "https://app.test/done" });
    expect(diff.title).toEqual({ from: "Task Board", to: "Done" });
    expect(diff.removed).toEqual(["ul[testid=task-list]", 'li "Ship Argus"', 'li "Test everything"']);
  });

  it("holds every list to its limit, counts what it left out, and keeps dialogs first", () => {
    const el = (id: number, over: Partial<SnapshotElement> = {}): SnapshotElement => ({
      id,
      tag: "p",
      text: `row ${id} ${"x".repeat(400)}`,
      ...over,
    });
    const base: Snapshot = { doc: "d", url: "u", title: "t", nodes: 0, els: [], partial: false };
    const next = {
      ...base,
      els: [...Array.from({ length: 40 }, (_, i) => el(i)), el(99, { tag: "div", role: "dialog", text: "Sure?" })],
    };
    const diff = diffSnapshots(base, next);
    expect(diff.added).toHaveLength(SCREEN_DIFF_LIMITS.perList);
    expect(diff.added[0]).toBe('div[role=dialog] "Sure?"');
    expect(diff.omitted).toEqual({ added: 41 - SCREEN_DIFF_LIMITS.perList, removed: 0, changed: 0 });
    for (const line of diff.added) expect(line.length).toBeLessThanOrEqual(SCREEN_DIFF_LIMITS.line);
    // The worst case of a single action's diff stays a few kilobytes.
    const worst = diffSnapshots({ ...base, els: next.els.map((e) => ({ ...e, id: e.id + 1000, text: "y" + e.text })) }, next);
    expect(JSON.stringify(worst).length).toBeLessThan(6_000);
    expect(diffSnapshots(base, next, SCREEN_DIFF_LIMITS.perListBatch).added).toHaveLength(SCREEN_DIFF_LIMITS.perListBatch);
  });
});

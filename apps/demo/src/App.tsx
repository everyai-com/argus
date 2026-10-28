/**
 * Argus demo — a small task board with an injectable-bug switchboard.
 *
 * Add ?bug=<name> to the URL to inject a bug class Argus must catch:
 *   silent500    — "Add" POST returns 500 but the UI optimistically renders anyway
 *   deadbutton   — "Add" button does nothing (no handler)
 *   consoleerror — an error is thrown on load
 *   overflow     — a fixed 1600px-wide banner breaks responsive layouts
 *   slowreq      — the tasks fetch takes 8 seconds
 *   wrongstate   — the counter shows a hardcoded number, not the real count
 *   nofeedback   — Add shows nothing while the save is in flight (no disabled/busy state)
 *   nopersist    — tasks are never written to storage, so a reload loses them
 */
import React, { useEffect, useRef, useState } from "react";
import { registerStore, signal } from "@argus/sdk";

const bug = new URLSearchParams(window.location.search).get("bug");

if (bug === "consoleerror") {
  setTimeout(() => {
    throw new Error("Injected: something exploded during load");
  }, 100);
}

// Fake API on top of fetch-to-self so network events are observable.
async function apiAddTask(title: string): Promise<{ ok: boolean; status: number }> {
  const path = bug === "silent500" ? "/api/tasks?fail=1" : "/api/tasks";
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title }),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

const STORAGE_KEY = "argus-demo:tasks";
const SEED_TASKS = ["Ship Argus", "Test everything"];
const MAX_TITLE = 200;

// Tasks live in this browser: each visitor (and each fresh Argus lease) gets
// its own board, and an added task survives a reload. Storage can throw
// (private mode, blocked site data) — then the board is per-tab, never broken.
function loadTasks(): string[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : undefined;
    if (Array.isArray(parsed) && parsed.every((t) => typeof t === "string")) return parsed;
  } catch {}
  return SEED_TASKS;
}

function saveTasks(tasks: string[]): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks));
  } catch {}
}

export function App(): React.ReactElement {
  const [tasks, setTasks] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A ref, not state: both clicks of a double-click run before React
  // re-renders, so a `saving` state check would let the second one through.
  const inFlight = useRef(false);
  // True from a successful save until the user types again: an Enter on the
  // field the save just cleared is a repeated press, not an empty submit.
  const justAdded = useRef(false);

  useEffect(() => {
    const delay = bug === "slowreq" ? 8000 : 300;
    // Simulated initial load; the timer stands in for a slow backend.
    fetch("/api/tasks").catch(() => {});
    const t = setTimeout(() => {
      setTasks(loadTasks());
      setLoading(false);
    }, delay);
    return () => clearTimeout(t);
  }, []);

  useEffect(() => {
    if (!loading && bug !== "nopersist") saveTasks(tasks);
  }, [tasks, loading]);

  const addTask = async (via: "click" | "enter") => {
    if (inFlight.current) return;
    const clean = title.trim();
    if (!clean) {
      if (via === "enter" && justAdded.current) return;
      setError("Type a task title first.");
      return;
    }
    if (bug === "deadbutton") return; // injected: handler does nothing
    inFlight.current = true;
    setSaving(true);
    setError(null);
    const res = await apiAddTask(clean);
    if (bug === "silent500") {
      // Injected: optimistic render even though the POST failed — looks done, isn't.
      setTasks((t) => [...t, clean]);
      setTitle("");
    } else if (res.ok) {
      setTasks((t) => [...t, clean]);
      signal("task:added", { title: clean });
      setTitle("");
      justAdded.current = true;
    } else {
      // Keep what they typed: losing input on a failed save is the worst outcome.
      setError(
        res.status === 0
          ? "Couldn't save your task. Check your connection and try again."
          : `Couldn't save your task (error ${res.status}). Try again.`
      );
    }
    inFlight.current = false;
    setSaving(false);
  };

  // Tier-1 observability: expose real state, and declare real events.
  registerStore("tasks", () => tasks);
  registerStore("draft", () => title);

  const count = bug === "wrongstate" ? 42 : tasks.length;
  const busy = saving && bug !== "nofeedback";

  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", maxWidth: 640, margin: "0 auto", padding: 24 }}>
      {bug === "overflow" && (
        <div style={{ width: 1600, background: "#ffe9a8", padding: 8 }} data-testid="banner">
          This banner is 1600px wide and breaks mobile layouts.
        </div>
      )}
      <h1>Task Board</h1>
      <p data-testid="task-count">
        {loading ? "Loading…" : `${count} ${count === 1 ? "task" : "tasks"}`}
      </p>
      <label htmlFor="new-task" style={{ display: "block", fontWeight: 600, marginBottom: 4 }}>
        Task title
      </label>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          id="new-task"
          data-testid="new-task"
          placeholder="For example: Buy milk"
          value={title}
          maxLength={MAX_TITLE}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? "task-hint task-error" : "task-hint"}
          onChange={(e) => {
            setTitle(e.target.value);
            justAdded.current = false;
            if (error) setError(null);
          }}
          onKeyDown={(e) => e.key === "Enter" && addTask("enter")}
          style={{ flex: 1, minHeight: 44, padding: "8px 12px", fontSize: 16 }}
        />
        <button
          data-testid="add-task"
          onClick={() => addTask("click")}
          disabled={busy}
          aria-busy={busy || undefined}
          style={{ minHeight: 44, minWidth: 64, padding: "8px 16px", fontSize: 16 }}
        >
          {busy ? "Adding…" : "Add"}
        </button>
      </div>
      <p id="task-hint" style={{ color: "#535b6b", fontSize: 14, margin: "4px 0 0" }}>
        {title.length >= MAX_TITLE
          ? `You have reached the ${MAX_TITLE}-character limit.`
          : `Up to ${MAX_TITLE} characters.`}
      </p>
      {error && (
        <p id="task-error" role="alert" style={{ color: "#b42318", margin: "8px 0 0" }}>
          {error}
        </p>
      )}
      <ul data-testid="task-list">
        {tasks.map((t, i) => (
          <li key={i} style={{ padding: "6px 0", overflowWrap: "anywhere" }}>
            {t}
          </li>
        ))}
      </ul>
      <footer style={{ marginTop: 40, color: "#535b6b" }}>
        <small>
          Argus demo app · The first two tasks are examples. Your tasks are kept in this browser; each new task
          is also sent to the demo server, which does not store it.
          {bug && ` · Injected bug: ${bug}`}
        </small>
      </footer>
    </main>
  );
}

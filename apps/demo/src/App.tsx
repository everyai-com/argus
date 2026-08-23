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
 */
import React, { useEffect, useState } from "react";
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

export function App(): React.ReactElement {
  const [tasks, setTasks] = useState<string[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const delay = bug === "slowreq" ? 8000 : 300;
    // Simulated initial load; the timer stands in for a slow backend.
    fetch("/api/tasks").catch(() => {});
    const t = setTimeout(() => {
      setTasks(["Ship Argus", "Test everything"]);
      setLoading(false);
    }, delay);
    return () => clearTimeout(t);
  }, []);

  const addTask = async () => {
    if (!title.trim()) return;
    if (bug === "deadbutton") return; // injected: handler does nothing
    const res = await apiAddTask(title.trim());
    if (bug === "silent500") {
      // Injected: optimistic render even though the POST failed — looks done, isn't.
      setTasks((t) => [...t, title.trim()]);
    } else if (res.ok) {
      setTasks((t) => [...t, title.trim()]);
      signal("task:added", { title: title.trim() });
    }
    setTitle("");
  };

  // Tier-1 observability: expose real state, and declare real events.
  registerStore("tasks", () => tasks);

  const count = bug === "wrongstate" ? 42 : tasks.length;

  return (
    <main style={{ fontFamily: "ui-sans-serif, system-ui", maxWidth: 640, margin: "0 auto", padding: 24 }}>
      {bug === "overflow" && (
        <div style={{ width: 1600, background: "#ffe9a8", padding: 8 }} data-testid="banner">
          This banner is 1600px wide and breaks mobile layouts.
        </div>
      )}
      <h1>Task Board</h1>
      <p data-testid="task-count">
        {loading ? "Loading…" : `${count} task(s)`}
      </p>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          data-testid="new-task"
          placeholder="New task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addTask()}
          style={{ flex: 1, padding: 8 }}
        />
        <button data-testid="add-task" onClick={addTask} style={{ padding: "8px 16px" }}>
          Add
        </button>
      </div>
      <ul data-testid="task-list">
        {tasks.map((t, i) => (
          <li key={i} style={{ padding: "6px 0" }}>
            {t}
          </li>
        ))}
      </ul>
      <footer style={{ marginTop: 40, color: "#535b6b" }}>
        <small>Argus demo app · bug={bug ?? "none"}</small>
      </footer>
    </main>
  );
}

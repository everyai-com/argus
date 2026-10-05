/**
 * Argus console — rail navigation, the live horizon strip, and view routing.
 * The strip is the product's pulse: fleet headroom, live sessions, the newest
 * verdict, and how fresh this screen is.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { AccountView } from "./Account";
import { GitHubView } from "./Platform";
import { CapacityView, SessionsView } from "./Ops";
import { FleetView, RunDetail, RunsView } from "./Runs";
import { apiGet, useCapacity, useToken, type ProjectRow, type RunRow, type SessionRow } from "./api";
import { Empty, Mark, Meter, Skeleton, Sparkbars, timeAgo, until, useNow, Verdict } from "./ui";

type Tab = "fleet" | "runs" | "sessions" | "capacity" | "github" | "account";

const TABS: Array<{ id: Tab; label: string; group: string; blurb: string }> = [
  { id: "fleet", label: "Fleet", group: "Observe", blurb: "Latest verdict per project — the board you scan first." },
  { id: "runs", label: "Runs", group: "Observe", blurb: "Every verification run this tenant has produced, newest first." },
  { id: "sessions", label: "Sessions", group: "Observe", blurb: "Live cloud browsers, their lease clocks, and how to free a slot." },
  { id: "capacity", label: "Capacity", group: "Operate", blurb: "Saturation, launch queue, and per-tenant reserved floors." },
  { id: "github", label: "GitHub", group: "Operate", blurb: "Verification posted onto pull requests." },
  { id: "account", label: "Account", group: "Account", blurb: "Create an account, mint the token your agent connects with." },
];

interface ApiError {
  status?: number;
  message: string;
}

/** "Error: 401 {"error":"unauthorized"}" → { status: 401, message: '{"error":"unauthorized"}' } */
function readApiError(reason: unknown): ApiError {
  const text = String(reason instanceof Error ? reason.message : reason).replace(/^Error:\s*/, "");
  const match = /^(\d{3})\s*([\s\S]*)$/.exec(text);
  return match ? { status: Number(match[1]), message: (match[2] ?? "").trim() || text } : { message: text };
}

const params = () => new URLSearchParams(location.search);
const tabFromUrl = (): Tab | undefined => {
  const t = params().get("tab");
  return TABS.some((x) => x.id === t) ? (t as Tab) : undefined;
};
const runFromUrl = (): string | undefined => params().get("run") ?? undefined;

export function App(): React.ReactElement {
  const [token, setToken] = useToken();
  const [tab, setTab] = useState<Tab>(
    () => tabFromUrl() ?? (localStorage.getItem("argus-token") ? "fleet" : "account")
  );
  const [selected, setSelected] = useState<string | undefined>(runFromUrl);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [fleet, setFleet] = useState<ProjectRow[]>([]);
  const [error, setError] = useState<ApiError>();
  const [loaded, setLoaded] = useState(false);
  const [live, setLive] = useState(true);
  const [updatedAt, setUpdatedAt] = useState<number>();

  const now = useNow(1000);
  const { cap, rates, error: capError, reload: reloadCapacity } = useCapacity(token, live && Boolean(token));

  const refresh = useCallback(() => {
    if (!token) return;
    Promise.allSettled([
      apiGet<{ runs: RunRow[] }>(token, "/v1/runs"),
      apiGet<{ sessions: SessionRow[] }>(token, "/v1/sessions"),
      apiGet<{ projects: ProjectRow[] }>(token, "/v1/fleet"),
    ]).then(([r, s, f]) => {
      if (r.status === "fulfilled") {
        setRuns(r.value.runs);
        setError(undefined);
      } else {
        setError(readApiError(r.reason));
      }
      if (s.status === "fulfilled") setSessions(s.value.sessions);
      if (f.status === "fulfilled") setFleet(f.value.projects);
      setLoaded(true);
      setUpdatedAt(Date.now());
    });
  }, [token]);

  useEffect(() => {
    refresh();
    if (!live) return;
    const t = setInterval(refresh, 8000);
    return () => clearInterval(t);
  }, [refresh, live]);

  useEffect(() => {
    const query = new URLSearchParams();
    if (tab !== "fleet") query.set("tab", tab);
    if (selected) query.set("run", selected);
    const q = query.toString();
    history.replaceState(null, "", q ? `?${q}` : location.pathname);
  }, [tab, selected]);

  useEffect(() => {
    const onPop = () => {
      setTab(tabFromUrl() ?? "fleet");
      setSelected(runFromUrl());
    };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  const open = (next: Tab, run?: string) => {
    setTab(next);
    setSelected(run);
  };

  const groups = useMemo(() => {
    const out: Array<{ name: string; items: typeof TABS }> = [];
    for (const entry of TABS) {
      const group = out.find((g) => g.name === entry.group);
      if (group) group.items.push(entry);
      else out.push({ name: entry.group, items: [entry] });
    }
    return out;
  }, []);

  const counts: Partial<Record<Tab, number>> = {
    fleet: fleet.length,
    runs: runs.length,
    sessions: sessions.length,
  };

  const newest = useMemo(
    () =>
      [...fleet]
        .filter((p) => p.latest?.at)
        .sort((a, b) => Date.parse(b.latest.at!) - Date.parse(a.latest.at!))[0],
    [fleet]
  );
  const sessionsDue = useMemo(
    () => sessions.map((s) => s.expiresAt).sort((a, b) => Date.parse(a) - Date.parse(b))[0],
    [sessions]
  );
  const { buckets, labels, runsToday } = useMemo(() => {
    const slots = 24;
    const nowMs = Date.now();
    const hour = 60 * 60 * 1000;
    const values = new Array(slots).fill(0) as number[];
    const labelList: string[] = [];
    for (let i = slots; i > 0; i--) {
      const start = new Date(nowMs - i * hour);
      labelList.push(start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }
    for (const r of runs) {
      if (!r.at) continue;
      const age = nowMs - Date.parse(r.at);
      if (age < 0 || age >= slots * hour) continue;
      values[slots - 1 - Math.floor(age / hour)] = (values[slots - 1 - Math.floor(age / hour)] ?? 0) + 1;
    }
    return { buckets: values, labels: labelList, runsToday: runs.length ? values.reduce((a, b) => a + b, 0) : 0 };
  }, [runs]);

  const active = TABS.find((t) => t.id === tab)!;
  const needsToken = tab !== "account" && tab !== "github";

  const body = useMemo(() => {
    if (tab === "account") return <AccountView onToken={setToken} />;
    if (tab === "github") return <GitHubView />;
    if (!token)
      return (
        <Empty title="Connect with an API token">
          The console reads your tenant's runs, sessions and flows.
          <div className="hint">
            <button className="btn primary" onClick={() => open("account")}>
              Open Account
            </button>
            <span className="dim">or paste a token from the rail</span>
          </div>
        </Empty>
      );
    if (selected) return <RunDetail token={token} runId={selected} onBack={() => setSelected(undefined)} />;
    if (!loaded) return <Skeleton rows={4} />;
    if (tab === "capacity")
      return <CapacityView cap={cap} rates={rates} error={capError} live={live} onRetry={reloadCapacity} />;
    if (tab === "sessions")
      return <SessionsView token={token} sessions={sessions} onChanged={refresh} now={now} />;
    if (tab === "fleet") return <FleetView projects={fleet} onOpen={(runId) => setSelected(runId)} now={now} />;
    return <RunsView runs={runs} onOpen={(runId) => setSelected(runId)} now={now} />;
  }, [tab, token, selected, loaded, cap, rates, capError, live, reloadCapacity, sessions, refresh, now, fleet, runs]);

  return (
    <>
      <a className="skip" href="#content">
        Skip to content
      </a>
      <div className="shell">
        <aside className="rail">
          <div className="brand">
            <Mark size={20} />
            <span>
              <span className="name">Argus</span>
              <span className="sub">browser verification</span>
            </span>
          </div>

          <nav className="rail-nav" aria-label="Sections">
            {groups.map((group) => (
              <div className="navgroup" key={group.name}>
                <span className="navgroup-label micro">{group.name}</span>
                {group.items.map((item) => (
                  <button
                    key={item.id}
                    className="navbtn"
                    aria-current={tab === item.id && !selected ? "true" : "false"}
                    onClick={() => open(item.id)}
                  >
                    {item.label}
                    {token && counts[item.id] ? <span className="count num">{counts[item.id]}</span> : null}
                  </button>
                ))}
              </div>
            ))}
          </nav>

          <div className="rail-foot">
            <div className="field">
              <label className="micro" htmlFor="argus-token">
                API token
              </label>
              <input
                id="argus-token"
                className="input"
                type="password"
                value={token}
                autoComplete="off"
                spellCheck={false}
                placeholder="argus_…"
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            {token ? (
              <button className="btn quiet sm" onClick={() => setToken("")}>
                Clear token
              </button>
            ) : (
              <button className="btn quiet sm" onClick={() => open("account")}>
                Create a token
              </button>
            )}
            <span className="faint" style={{ fontSize: "var(--fs-micro)" }}>
              {updatedAt ? `updated ${timeAgo(new Date(updatedAt).toISOString(), now)}` : "not connected"}
            </span>
          </div>
        </aside>

        <main className="main" id="content">
          <div className="main-inner">
            <div className="strip">
              <div className="tile">
                <span className="micro">Fleet</span>
                <span className="val num">
                  {cap ? (
                    <>
                      {cap.active}
                      <span className="faint" style={{ fontSize: "var(--fs-lg)" }}>/{cap.cap}</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                <Meter
                  pct={cap && cap.cap ? (cap.active / cap.cap) * 100 : 0}
                  hot={Boolean(cap && cap.active >= cap.cap)}
                  label="Fleet saturation"
                />
                <span className="sub">
                  {cap
                    ? cap.active >= cap.cap
                      ? "saturated — leases will 429"
                      : `${cap.cap - cap.active} browser slots free`
                    : needsToken && !token
                      ? "waiting for a token"
                      : "no capacity data"}
                </span>
              </div>

              <div className="tile">
                <span className="micro">Live sessions</span>
                <span className="val num">{token ? sessions.length : "—"}</span>
                <span className="sub">
                  {sessions.length && sessionsDue ? `next lease ends in ${until(sessionsDue, now)}` : "none leased right now"}
                </span>
              </div>

              <div className="tile">
                <span className="micro">Newest verdict</span>
                <span className="val sm">
                  {newest ? <Verdict status={newest.latest.status} /> : <span className="faint">none yet</span>}
                </span>
                <span className="sub truncate">
                  {newest ? `${newest.project} · ${timeAgo(newest.latest.at, now)}` : "tag a run with a project to see it here"}
                </span>
              </div>

              <div className="tile">
                <span className="micro">Activity · 24h</span>
                <span className="val num">
                  {token ? runsToday : "—"}
                  <span className="sub" style={{ marginLeft: 6, fontWeight: 400 }}>
                    runs
                  </span>
                </span>
                {token ? (
                  <Sparkbars values={buckets} labels={labels} />
                ) : (
                  <span className="sub">connect to see activity</span>
                )}
                <div className="rail-note">
                  <span className={"dot" + (live && token ? " live" : "")} aria-hidden="true" />
                  <span className="sub">{live ? "live" : "paused"}</span>
                  <span style={{ flex: 1 }} />
                  <button
                    className="btn quiet sm"
                    aria-pressed={live}
                    onClick={() => setLive((v) => !v)}
                    title={live ? "Pause auto-refresh" : "Resume auto-refresh"}
                  >
                    {live ? "Pause" : "Resume"}
                  </button>
                </div>
              </div>
            </div>

            <div className="bar">
              <h1>{selected ? "Run" : active.label}</h1>
              <span className="dim">
                {selected ? "findings, flow results, and the artifacts behind them" : active.blurb}
              </span>
            </div>

            {error && tab !== "account" && tab !== "github" ? (
              <div className="err" role="alert">
                <div className="micro">
                  {error.status === 401
                    ? "Token rejected"
                    : error.status === 429
                      ? "Fleet saturated"
                      : "Could not read the fleet"}
                </div>
                <div className="msg mono">{error.status ? `${error.status} ${error.message}` : error.message}</div>
                <div
                  className="dim"
                  style={{ marginTop: 6, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}
                >
                  {error.status === 401
                    ? "Paste a valid token in the rail, or mint a new one."
                    : error.status === 429
                      ? "Every browser slot is busy — retry in a moment."
                      : "Check that the worker is reachable."}
                  {error.status === 401 ? (
                    <button className="btn sm" onClick={() => open("account")}>
                      Open Account
                    </button>
                  ) : (
                    <button className="btn sm ghost" onClick={refresh}>
                      Retry
                    </button>
                  )}
                </div>
              </div>
            ) : null}

            {body}
          </div>
        </main>
      </div>
    </>
  );
}

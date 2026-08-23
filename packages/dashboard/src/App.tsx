/**
 * Argus dashboard — run history, findings inbox with copy-as-prompt,
 * screenshots, visual diffs, and the live session fleet. Served by the same
 * worker that runs the tests; auto-refreshes so runs appear as they land.
 */
import React, { useCallback, useEffect, useMemo, useState } from "react";

// ---------------------------------------------------------------------------
// API helpers — the token is kept in localStorage and sent as a header;
// artifact images are fetched with the header and shown via blob URLs.
// ---------------------------------------------------------------------------

function useToken(): [string, (t: string) => void] {
  const [token, setToken] = useState(() => localStorage.getItem("argus-token") ?? "");
  return [
    token,
    (t: string) => {
      localStorage.setItem("argus-token", t);
      setToken(t);
    },
  ];
}

async function apiGet(token: string, path: string): Promise<any> {
  const res = await fetch(path, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
  return res.json();
}

function ArtifactImg({ token, src, alt }: { token: string; src: string; alt: string }) {
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    let revoke: string | undefined;
    let cancelled = false;
    fetch(src, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (cancelled) return;
        revoke = URL.createObjectURL(b);
        setUrl(revoke);
      })
      .catch(() => setErr(true));
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [src, token]);
  if (err) return <div className="label">⚠ could not load</div>;
  if (!url) return <div className="label">loading…</div>;
  return <img src={url} alt={alt} />;
}

function GitHubView(): React.ReactElement {
  const [status, setStatus] = useState<{ configured: boolean; installUrl?: string; checkName: string }>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    fetch("/platform/github/status")
      .then(async (response) => {
        if (!response.ok) throw new Error(`GitHub platform status: ${response.status}`);
        return response.json();
      })
      .then(setStatus)
      .catch((reason) => setError(String(reason)));
  }, []);
  if (error) return <div className="empty">{error}</div>;
  if (!status) return <div className="empty">checking GitHub App…</div>;
  return (
    <div>
      <div className="card platform-hero">
        <span className={`badge ${status.configured ? "pass" : "major"}`}>
          {status.configured ? "ready" : "setup required"}
        </span>
        <h2>Automatic verification for every pull request</h2>
        <p className="muted">
          Install Argus on selected repositories. Each PR receives one rich GitHub Check with cloud-browser
          smoke tests, accessibility and performance audits, visual diffs, and committed flow replays.
        </p>
        {status.installUrl ? (
          <a className="primary" href={status.installUrl}>
            Connect GitHub
          </a>
        ) : (
          <p className="muted small">Set the GitHub App slug to enable repository installation.</p>
        )}
      </div>
      <div className="card">
        <strong>Repository configuration</strong>
        <p className="muted small">
          Commit <code className="k">.argus/platform.json</code>. Credentials never belong in this file.
        </p>
        <pre className="config-example">{`{
  "deployment": { "environments": ["Preview"] },
  "checks": ["smoke", "audit", "flows"],
  "viewports": ["mobile", "desktop"],
  "flowConcurrency": 3
}`}</pre>
        <p className="muted small">
          Argus starts when GitHub receives a successful HTTPS preview deployment. For a stable staging site,
          replace <code className="k">deployment</code> with <code className="k">targetUrl</code>.
        </p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

interface RunRow {
  runId: string;
  kind: string;
  at: string;
  artifacts: number;
}

interface Finding {
  id: string;
  severity: string;
  category: string;
  summary: string;
  detail?: string;
  evidence?: { screenshotKey?: string; viewport?: string };
  decision?: { whatChanged: string; whereInSource?: string; nextAction: string };
}

function findingToPrompt(f: Finding, url?: string): string {
  return [
    `Fix this issue found by Argus verification${url ? ` on ${url}` : ""}:`,
    `- Problem: ${f.summary}`,
    f.detail ? `- Detail: ${f.detail}` : undefined,
    f.decision ? `- What changed: ${f.decision.whatChanged}` : undefined,
    f.decision?.whereInSource ? `- Where: ${f.decision.whereInSource}` : undefined,
    f.decision ? `- Suggested next action: ${f.decision.nextAction}` : undefined,
    `After fixing, re-run the Argus check to verify the fix (argus_flow_verify or argus audit).`,
  ]
    .filter(Boolean)
    .join("\n");
}

function FindingCard({ f, url }: { f: Finding; url?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`finding ${f.severity}`}>
      <div className="row">
        <span className={`badge ${f.severity}`}>{f.severity}</span>
        <span className="badge kind">{f.category}</span>
        <span>{f.summary}</span>
        <span style={{ flex: 1 }} />
        <button
          className="mini"
          onClick={() => {
            navigator.clipboard.writeText(findingToPrompt(f, url)).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? "copied ✓" : "copy fix prompt"}
        </button>
      </div>
      {f.decision && <div className="next">→ {f.decision.nextAction}</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Capacity — live fleet telemetry: browsers vs cap, warm pool, launch queue,
// per-tenant used/reserved/burst, and throughput rates derived from successive
// polls of the cumulative counters.
// ---------------------------------------------------------------------------

interface Capacity {
  active: number;
  cap: number;
  warm: number;
  warmCap: number;
  launchQueueMs: number;
  reservedTotal: number;
  cumulative: { acquires: number; rejects: number; launches: number; releases: number };
  since: string;
  tenants: Array<{ id: string; name: string; active: number; reserved: number; maxBurst: number; disabled?: boolean }>;
}

function Gauge({
  label,
  used,
  total,
  hint,
  tone = "load",
}: {
  label: string;
  used: number;
  total: number;
  hint?: string;
  /** "load" escalates blue→amber→red as it fills (near cap = attention); "pool"
   *  stays blue because a FULL warm pool is healthy, not a warning. */
  tone?: "load" | "pool";
}) {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const cls = tone === "pool" ? "fill" : pct >= 90 ? "fill hot" : pct >= 60 ? "fill warm" : "fill";
  return (
    <div className="gauge">
      <div className="glabel">
        <span>{label}</span>
        <span className="muted">
          {used}/{total}
          {hint ? ` · ${hint}` : ""}
        </span>
      </div>
      <div className="track">
        <div className={cls} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function CapacityView({ token }: { token: string }) {
  const [cap, setCap] = useState<Capacity>();
  const [error, setError] = useState<string>();
  const prev = React.useRef<{ c: Capacity["cumulative"]; t: number }>();
  const [rates, setRates] = useState<{ acquires: number; rejects: number }>({ acquires: 0, rejects: 0 });

  useEffect(() => {
    let live = true;
    const tick = () => {
      apiGet(token, "/v1/capacity")
        .then((d: Capacity) => {
          if (!live) return;
          const now = Date.now();
          if (prev.current) {
            const dt = (now - prev.current.t) / 1000;
            if (dt > 0)
              setRates({
                acquires: Math.max(0, (d.cumulative.acquires - prev.current.c.acquires) / dt),
                rejects: Math.max(0, (d.cumulative.rejects - prev.current.c.rejects) / dt),
              });
          }
          prev.current = { c: d.cumulative, t: now };
          setCap(d);
          setError(undefined);
        })
        .catch((e) => live && setError(String(e)));
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      live = false;
      clearInterval(iv);
    };
  }, [token]);

  if (error) return <div className="empty">{error}</div>;
  if (!cap) return <div className="empty">loading capacity…</div>;

  return (
    <div>
      <div className="card">
        <div className="row">
          <strong>Fleet</strong>
          <span className="muted small">
            {cap.active} of {cap.cap} browsers in use · {cap.reservedTotal} reserved across tenants
          </span>
          <span style={{ flex: 1 }} />
          <span className={`badge ${cap.active >= cap.cap ? "fail" : "pass"}`}>
            {cap.active >= cap.cap ? "saturated" : "headroom"}
          </span>
        </div>
        <Gauge label="Concurrent browsers" used={cap.active} total={cap.cap} />
        <Gauge label="Warm pool (reconnect-ready)" used={cap.warm} total={cap.warmCap} tone="pool" />
        <div className="statgrid">
          <div className="stat">
            <div className="n">{cap.launchQueueMs}ms</div>
            <div className="k">launch queue</div>
          </div>
          <div className="stat">
            <div className="n rate">{rates.acquires.toFixed(1)}/s</div>
            <div className="k">acquire rate</div>
          </div>
          <div className="stat">
            <div className="n rate">{rates.rejects.toFixed(1)}/s</div>
            <div className="k">429 rate</div>
          </div>
          <div className="stat">
            <div className="n">{cap.cumulative.launches}</div>
            <div className="k">cold launches</div>
          </div>
          <div className="stat">
            <div className="n">{cap.cumulative.acquires}</div>
            <div className="k">total acquires</div>
          </div>
          <div className="stat">
            <div className="n">{cap.cumulative.releases}</div>
            <div className="k">total releases</div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="row">
          <strong>Tenants</strong>
          <span className="muted small">used / burst ceiling · dashed line = reserved floor</span>
        </div>
        {cap.tenants.length === 0 ? (
          <p className="muted small">
            no tenants yet — the admin token holds all leases. Create one with{" "}
            <code className="k">argus tenants create &lt;id&gt; --reserved 5</code>
          </p>
        ) : (
          cap.tenants.map((t) => {
            const pct = t.maxBurst > 0 ? Math.min(100, (t.active / t.maxBurst) * 100) : 0;
            const resPct = t.maxBurst > 0 ? Math.min(100, (t.reserved / t.maxBurst) * 100) : 0;
            const cls = pct >= 90 ? "fill hot" : pct >= 60 ? "fill warm" : "fill";
            return (
              <div className="tenantrow" key={t.id}>
                <div className="tname">
                  <span>
                    <code className="k">{t.id}</code>{" "}
                    <span className="muted">{t.name}</span>
                    {t.disabled ? <span className="badge fail" style={{ marginLeft: 6 }}>disabled</span> : null}
                  </span>
                  <span className="muted">
                    {t.active}/{t.maxBurst} · reserved {t.reserved}
                  </span>
                </div>
                <div className="track">
                  <div className={cls} style={{ width: `${pct}%` }} />
                  {t.reserved > 0 && <div className="reserved" style={{ left: `${resPct}%` }} />}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------

function RunDetail({ token, runId, onBack }: { token: string; runId: string; onBack: () => void }) {
  const [data, setData] = useState<any>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    apiGet(token, `/v1/run/${runId}`).then(setData).catch((e) => setError(String(e)));
  }, [runId, token]);

  if (error) return <div className="empty">{error}</div>;
  if (!data) return <div className="empty">loading run…</div>;

  const report = data.audit_report ?? data.report;
  const flows = data.flows_verdict;

  return (
    <div>
      <p>
        <a className="back" onClick={onBack}>
          ← runs
        </a>
      </p>
      {report && (
        <div className="card">
          <div className="row">
            <span className={`badge ${report.status}`}>{report.status}</span>
            <strong>{report.url}</strong>
            <span className="muted small">
              {report.startedAt} · {(report.durationMs / 1000).toFixed(1)}s
            </span>
          </div>
          {report.perf?.length > 0 && (
            <p className="small muted">
              {report.perf
                .map(
                  (p: any) =>
                    `${p.viewport}: FCP ${p.fcpMs ?? "?"}ms · LCP ${p.lcpMs ?? "?"}ms · CLS ${p.cls ?? "?"}`
                )
                .join("  ·  ")}
            </p>
          )}
          {report.findings?.length > 0 ? (
            <>
              <h3>Findings ({report.findings.length})</h3>
              {report.findings.map((f: Finding) => (
                <FindingCard key={f.id} f={f} url={report.url} />
              ))}
            </>
          ) : (
            <p className="muted">No findings — clean run. ✓</p>
          )}
          {report.visual?.some((v: any) => v.status === "diff") && (
            <>
              <h3>Visual diffs</h3>
              {report.visual
                .filter((v: any) => v.status === "diff")
                .map((v: any) => (
                  <div key={v.currentKey}>
                    <p className="small muted">
                      {v.viewport}/{v.colorScheme} — {(v.diffRatio * 100).toFixed(1)}% changed
                      (baseline · current · diff)
                    </p>
                    <div className="difftriplet">
                      <div className="shot">
                        <ArtifactImg token={token} src={`/v1/artifact/${v.baselineKey}`} alt="baseline" />
                      </div>
                      <div className="shot">
                        <ArtifactImg token={token} src={`/v1/artifact/${v.currentKey}`} alt="current" />
                      </div>
                      <div className="shot">
                        <ArtifactImg token={token} src={`/v1/artifact/${v.diffKey}`} alt="diff" />
                      </div>
                    </div>
                  </div>
                ))}
            </>
          )}
          {report.screenshots?.length > 0 && (
            <>
              <h3>Screenshots</h3>
              <div className="grid">
                {report.screenshots.map((s: any) => (
                  <div className="shot" key={s.key}>
                    <ArtifactImg token={token} src={`/v1/artifact/${s.key}`} alt={s.viewport} />
                    <div className="label">
                      {s.viewport} / {s.colorScheme}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
      {flows && (
        <div className="card">
          <div className="row">
            <span className={`badge ${flows.status}`}>{flows.status}</span>
            <strong>flow suite</strong>
            <span className="muted">{flows.summary}</span>
          </div>
          {flows.results?.map((r: any) => (
            <div key={r.flow} className={`finding ${r.status === "ok" ? "info" : "critical"}`}>
              <div className="row">
                <span className={`badge ${r.status === "ok" ? "pass" : r.status}`}>{r.status}</span>
                <code className="k">{r.flow}</code>
                <span className="muted small">
                  {r.stepsRun} steps · {(r.durationMs / 1000).toFixed(1)}s
                  {r.evidenceTier ? ` · evidence: ${r.evidenceTier}` : ""}
                </span>
              </div>
              {r.decision && (
                <div className="next">
                  {r.decision.whatChanged} → {r.decision.nextAction}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {!report && !flows && <div className="empty">no report artifacts in this run</div>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function App(): React.ReactElement {
  const [token, setToken] = useToken();
  const [tab, setTab] = useState<"fleet" | "runs" | "sessions" | "capacity" | "github">("fleet");
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [sessions, setSessions] = useState<any[]>([]);
  const [fleet, setFleet] = useState<any[]>([]);
  const [selected, setSelected] = useState<string | undefined>(
    () => new URLSearchParams(location.search).get("run") ?? undefined
  );
  const [error, setError] = useState<string>();

  const refresh = useCallback(() => {
    if (!token) return;
    apiGet(token, "/v1/runs")
      .then((d) => {
        setRuns(d.runs);
        setError(undefined);
      })
      .catch((e) => setError(String(e)));
    apiGet(token, "/v1/sessions")
      .then((d) => setSessions(d.sessions))
      .catch(() => {});
    apiGet(token, "/v1/fleet")
      .then((d) => setFleet(d.projects))
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 8000); // live-ish: runs appear as they land
    return () => clearInterval(t);
  }, [refresh]);

  const body = useMemo(() => {
    if (tab === "github") return <GitHubView />;
    if (!token)
      return (
        <div className="empty">
          Paste your Argus API token above to connect. <br />
          <span className="small">(it's in .argus/config.json in your project)</span>
        </div>
      );
    if (selected) return <RunDetail token={token} runId={selected} onBack={() => setSelected(undefined)} />;
    if (tab === "capacity") return <CapacityView token={token} />;
    if (tab === "fleet")
      return fleet.length === 0 ? (
        <div className="empty">
          no tagged runs yet — run <code className="k">argus test</code> or{" "}
          <code className="k">argus audit</code> inside a project
        </div>
      ) : (
        fleet.map((p) => (
          <div
            className="card clickable"
            key={p.project}
            role="button"
            tabIndex={0}
            onClick={() => setSelected(p.latest.runId)}
            onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(p.latest.runId)}
          >
            <div className="row">
              <span className={`badge ${p.latest.status}`}>{p.latest.status}</span>
              <strong>{p.project}</strong>
              <span className="badge kind">{p.latest.kind}</span>
              <span className="muted small">{p.latest.url}</span>
              <span style={{ flex: 1 }} />
              <span className="muted small">
                {p.failing > 0 ? `${p.failing}/${p.runs} runs failing` : `${p.runs} runs, all green`}
              </span>
              <span className="muted small">
                {p.latest.at ? new Date(p.latest.at).toLocaleString() : ""}
              </span>
            </div>
          </div>
        ))
      );
    if (tab === "sessions")
      return sessions.length === 0 ? (
        <div className="empty">no active browser sessions</div>
      ) : (
        sessions.map((s) => (
          <div className="card" key={s.sessionId}>
            <div className="row">
              <code className="k">{s.sessionId}</code>
              <span>{s.url}</span>
              <span className="badge kind">{s.label ?? "unlabeled"}</span>
              <span className="muted small">expires {new Date(s.expiresAt).toLocaleTimeString()}</span>
            </div>
          </div>
        ))
      );
    return runs.length === 0 ? (
      <div className="empty">
        no runs yet — try <code className="k">argus test &lt;url&gt;</code>
      </div>
    ) : (
      runs.map((r) => (
        <div
          className="card clickable"
          key={r.runId}
          role="button"
          tabIndex={0}
          aria-label={`open run ${r.runId}`}
          onClick={() => setSelected(r.runId)}
          onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && setSelected(r.runId)}
        >
          <div className="row">
            <code className="k">{r.runId}</code>
            <span className="badge kind">{r.kind}</span>
            <span className="muted small">{r.at ? new Date(r.at).toLocaleString() : ""}</span>
            <span style={{ flex: 1 }} />
            <span className="muted small">{r.artifacts} artifacts</span>
          </div>
        </div>
      ))
    );
  }, [token, selected, tab, runs, sessions, fleet]);

  return (
    <div className="app">
      <header className="top">
        <h1>👁 Argus</h1>
        <nav className="tabs">
          <button
            className={tab === "fleet" && !selected ? "active" : ""}
            onClick={() => {
              setTab("fleet");
              setSelected(undefined);
            }}
          >
            Fleet {fleet.length > 0 ? `(${fleet.length})` : ""}
          </button>
          <button className={tab === "runs" && !selected ? "active" : ""} onClick={() => { setTab("runs"); setSelected(undefined); }}>
            Runs
          </button>
          <button className={tab === "sessions" ? "active" : ""} onClick={() => { setTab("sessions"); setSelected(undefined); }}>
            Sessions {sessions.length > 0 ? `(${sessions.length})` : ""}
          </button>
          <button className={tab === "capacity" && !selected ? "active" : ""} onClick={() => { setTab("capacity"); setSelected(undefined); }}>
            Capacity
          </button>
          <button className={tab === "github" && !selected ? "active" : ""} onClick={() => { setTab("github"); setSelected(undefined); }}>
            GitHub
          </button>
        </nav>
        <span className="spacer" />
        <input
          className="token"
          type="password"
          placeholder="API token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </header>
      {error && <div className="card" style={{ borderColor: "#f87171" }}>{error}</div>}
      {body}
    </div>
  );
}

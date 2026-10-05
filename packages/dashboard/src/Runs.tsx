/**
 * Run surfaces — the verdict wall (latest status per project), the run list,
 * and a run's detail: findings on the left, proof on the right.
 */
import React, { useEffect, useId, useMemo, useState } from "react";
import { apiGet, artifactUrl, type Finding, type ProjectRow, type RunRow } from "./api";
import {
  Badge,
  Empty,
  ErrBox,
  Skeleton,
  Tier,
  timeAgo,
  toneOf,
  useArtifact,
  useCopied,
  useFilter,
  Verdict,
} from "./ui";

const SEVERITY_ORDER = ["critical", "major", "minor", "info"];

interface Report {
  status: string;
  url: string;
  startedAt: string;
  durationMs: number;
  perf?: Array<{ viewport: string; fcpMs?: number; lcpMs?: number; cls?: number }>;
  findings?: Finding[];
  visual?: Array<{
    status: string;
    viewport: string;
    colorScheme: string;
    diffRatio: number;
    baselineKey?: string;
    currentKey: string;
    diffKey?: string;
  }>;
  screenshots?: Array<{ key: string; viewport: string; colorScheme: string }>;
}

interface FlowResult {
  flow: string;
  status: string;
  stepsRun: number;
  durationMs: number;
  evidenceTier?: string;
  decision?: { whatChanged: string; nextAction: string };
}

interface RunData {
  runId: string;
  files: string[];
  report?: Report;
  audit_report?: Report;
  flows_verdict?: { status: string; summary: string; results?: FlowResult[] };
}

const absolute = (iso?: string): string | undefined => (iso ? new Date(iso).toLocaleString() : undefined);

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

function Artifact({ token, src, alt }: { token: string; src: string; alt: string }): React.ReactElement {
  const { url, err } = useArtifact(token, src);
  if (err) return <div className="label">image unavailable</div>;
  if (!url) return <div className="label">loading image…</div>;
  return <img src={url} alt={alt} />;
}

function ArtifactImg({ token, src, alt }: { token: string; src: string; alt: string }): React.ReactElement {
  const { url, err } = useArtifact(token, src);
  if (err) return <div className="label">image unavailable</div>;
  if (!url) return <div className="label">loading image…</div>;
  return (
    <a href={url} target="_blank" rel="noreferrer" title="Open full size" aria-label={`Open ${alt} full size`}>
      <img src={url} alt={alt} />
    </a>
  );
}

/** Baseline under, current revealed from the left as the divider moves. */
function Compare({
  token,
  baseline,
  current,
  caption,
}: {
  token: string;
  baseline: string;
  current: string;
  caption: string;
}): React.ReactElement {
  const [pos, setPos] = useState(50);
  const id = useId();
  return (
    <div className="compare">
      <div className="frame">
        <Artifact token={token} src={baseline} alt={`${caption} baseline`} />
        <div className="over" style={{ clipPath: `inset(0 ${100 - pos}% 0 0)` }}>
          <Artifact token={token} src={current} alt={`${caption} current`} />
        </div>
        <span className="handle" style={{ left: `${pos}%` }} aria-hidden="true" />
      </div>
      <div className="scrub">
        <label className="sr-only" htmlFor={id}>
          Reveal current over baseline
        </label>
        <input id={id} type="range" min={0} max={100} value={pos} onChange={(e) => setPos(Number(e.target.value))} />
        <span className="faint small">
          <span className="chip">baseline</span> → <span className="chip">current</span>
        </span>
      </div>
    </div>
  );
}

export function FleetView({
  projects,
  onOpen,
  now,
}: {
  projects: ProjectRow[];
  onOpen: (runId: string) => void;
  now: number;
}): React.ReactElement {
  const { query, setQuery, filtered, ref } = useFilter(
    projects,
    (p, q) =>
      p.project.toLowerCase().includes(q) ||
      (p.latest.url ?? "").toLowerCase().includes(q) ||
      p.latest.status.toLowerCase().includes(q)
  );

  const roll = useMemo(() => {
    const out = { pass: 0, warn: 0, fail: 0 };
    for (const p of projects) {
      const tone = toneOf(p.latest.status);
      if (tone === "pass") out.pass++;
      else if (tone === "fail") out.fail++;
      else if (tone === "warn") out.warn++;
    }
    return out;
  }, [projects]);

  if (projects.length === 0)
    return (
      <Empty title="No tagged runs yet">
        A run is tagged with the folder you launched it from. Run Argus from your project directory:
        <div className="hint">
          <code className="k">cd my-app &amp;&amp; argus test &lt;url&gt;</code>
        </div>
      </Empty>
    );

  return (
    <>
      <div className="panel rise">
        <div className="panel-head">
          <h2>Verdicts</h2>
          <span className="dim grow">one tile per project, colored by its latest status</span>
          {roll.fail > 0 ? <Badge tone="fail">{roll.fail} failing</Badge> : null}
          {roll.warn > 0 ? <Badge tone="warn">{roll.warn} drifting</Badge> : null}
          {roll.pass > 0 ? <Badge tone="pass">{roll.pass} green</Badge> : null}
        </div>
        <div className="wall">
          {projects.map((p) => (
            <a
              className={`cell tone-${toneOf(p.latest.status)}`}
              key={p.project}
              href={`?run=${p.latest.runId}`}
              title={`${p.project} — open latest run`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(p.latest.runId);
              }}
            >
              <span className="cell-top">
                <Verdict status={p.latest.status} />
                <span className="faint small">{p.latest.kind}</span>
              </span>
              <span className="cell-name truncate">{p.project}</span>
              <span className="faint small num">
                {p.failing > 0 ? `${p.failing} of ${p.runs} failing` : `${p.runs} runs, all green`} ·{" "}
                <span title={absolute(p.latest.at)}>{timeAgo(p.latest.at, now)}</span>
              </span>
            </a>
          ))}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Projects</h2>
          <span className="grow" />
          <input
            ref={ref}
            className="input filter"
            type="search"
            placeholder="filter projects…"
            aria-label="Filter projects"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <span className="faint small num">
            {filtered.length === projects.length ? projects.length : `${filtered.length} of ${projects.length}`}
          </span>
        </div>
        <div className="cols fleet head-row micro">
          <span>Verdict</span>
          <span>Project</span>
          <span className="hide-md">Runs</span>
          <span>Latest</span>
        </div>
        {filtered.length === 0 ? (
          <div className="panel-body dim">Nothing matches “{query}”.</div>
        ) : (
          filtered.map((p) => (
            <a
              className="row-link cols fleet"
              key={p.project}
              href={`?run=${p.latest.runId}`}
              onClick={(e) => {
                e.preventDefault();
                onOpen(p.latest.runId);
              }}
            >
              <Verdict status={p.latest.status} />
              <span className="truncate">
                <span style={{ fontWeight: 600 }}>{p.project}</span>
                <span className="dim"> · </span>
                <span className="faint truncate">{p.latest.url ?? "—"}</span>
              </span>
              <span className="num dim hide-md">
                {p.runs} runs{p.failing > 0 ? <span className="dim"> · </span> : null}
                {p.failing > 0 ? <span style={{ color: "var(--fail)" }}>{p.failing} failing</span> : null}
              </span>
              <span className="faint" title={absolute(p.latest.at)}>
                {timeAgo(p.latest.at, now)}
              </span>
            </a>
          ))
        )}
      </div>
    </>
  );
}

export function RunsView({
  runs,
  onOpen,
  now,
}: {
  runs: RunRow[];
  onOpen: (runId: string) => void;
  now: number;
}): React.ReactElement {
  const { query, setQuery, filtered, ref } = useFilter(
    runs,
    (r, q) => r.runId.toLowerCase().includes(q) || r.kind.toLowerCase().includes(q)
  );

  if (runs.length === 0)
    return (
      <Empty title="No runs yet">
        Point Argus at a URL and it will land here:
        <div className="hint">
          <code className="k">argus test &lt;url&gt;</code>
          <code className="k">argus smoke &lt;url&gt;</code>
        </div>
      </Empty>
    );

  return (
    <div className="panel rise">
      <div className="panel-head">
        <h2>Runs</h2>
        <span className="dim grow">newest first · press / to filter</span>
        <input
          ref={ref}
          className="input filter"
          type="search"
          placeholder="filter runs…"
          aria-label="Filter runs"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <span className="faint small num">
          {filtered.length === runs.length ? runs.length : `${filtered.length} of ${runs.length}`}
        </span>
      </div>
      <div className="cols runs head-row micro">
        <span>Kind</span>
        <span>Run</span>
        <span className="hide-md">Artifacts</span>
        <span>When</span>
      </div>
      {filtered.length === 0 ? (
        <div className="panel-body dim">Nothing matches “{query}”.</div>
      ) : (
        filtered.map((r) => (
          <a
            className="row-link cols runs"
            key={r.runId}
            href={`?run=${r.runId}`}
            onClick={(e) => {
              e.preventDefault();
              onOpen(r.runId);
            }}
          >
            <Badge plain>{r.kind}</Badge>
            <code className="mono truncate">{r.runId}</code>
            <span className="num dim hide-md">{r.artifacts}</span>
            <span className="faint" title={absolute(r.at)}>
              {timeAgo(r.at, now)}
            </span>
          </a>
        ))
      )}
    </div>
  );
}

export function RunDetail({
  token,
  runId,
  onBack,
}: {
  token: string;
  runId: string;
  onBack: () => void;
}): React.ReactElement {
  const [data, setData] = useState<RunData>();
  const [error, setError] = useState<string>();
  const [copied, copy] = useCopied();

  const load = () =>
    apiGet<RunData>(token, `/v1/run/${runId}`)
      .then(setData)
      .catch((e) => setError(String(e)));

  useEffect(() => {
    setData(undefined);
    setError(undefined);
    apiGet<RunData>(token, `/v1/run/${runId}`)
      .then(setData)
      .catch((e) => setError(String(e)));
  }, [runId, token]);

  const report = data?.audit_report ?? data?.report;
  const flows = data?.flows_verdict;

  const findings = useMemo(() => {
    const list = report?.findings ?? [];
    return [...list].sort(
      (a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity)
    );
  }, [report]);

  const counts = useMemo(() => {
    const out: Record<string, number> = {};
    for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
    return out;
  }, [findings]);

  const diffs = (report?.visual ?? []).filter((v) => v.status === "diff");

  return (
    <div>
      <div className="bar">
        <button className="btn ghost" onClick={onBack}>
          ← Runs
        </button>
        <code className="mono dim truncate">{runId}</code>
        <button className="btn sm quiet" onClick={() => copy("id", runId)}>
          {copied === "id" ? "copied ✓" : "copy id"}
        </button>
        <span className="grow" />
        {report ? (
          <a className="link" href={report.url} target="_blank" rel="noreferrer">
            open target
          </a>
        ) : null}
      </div>

      {error ? <ErrBox message={error} onRetry={() => void load()} /> : null}
      {!data && !error ? <Skeleton rows={3} /> : null}
      {data && !report && !flows ? <Empty title="No report artifacts in this run" /> : null}

      {report ? (
        <>
          <div className="panel rise">
            <div className="panel-head">
              <Verdict status={report.status} />
              <strong className="truncate">{report.url}</strong>
              <span className="grow" />
              <span className="faint num">
                {new Date(report.startedAt).toLocaleString()} · {(report.durationMs / 1000).toFixed(1)}s
              </span>
            </div>
            {report.perf?.length ? (
              <div className="panel-body" style={{ paddingTop: 10, paddingBottom: 10 }}>
                <span className="micro">Performance</span>{" "}
                <span className="dim num">
                  {report.perf
                    .map((p) => `${p.viewport} FCP ${p.fcpMs ?? "?"}ms · LCP ${p.lcpMs ?? "?"}ms · CLS ${p.cls ?? "?"}`)
                    .join("   ")}
                </span>
              </div>
            ) : null}
          </div>

          <div className="detail">
            <div>
              <div className="panel">
                <div className="panel-head">
                  <h2>Findings</h2>
                  <span className="grow" />
                  {SEVERITY_ORDER.filter((s) => counts[s]).map((s) => (
                    <Badge key={s} tone={toneOf(s)}>
                      {counts[s]} {s}
                    </Badge>
                  ))}
                  {findings.length > 1 ? (
                    <button
                      className="btn sm ghost"
                      onClick={() => copy("all", findings.map((f) => findingToPrompt(f, report.url)).join("\n\n"))}
                    >
                      {copied === "all" ? "copied ✓" : "copy all as prompt"}
                    </button>
                  ) : null}
                </div>
                <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
                  {findings.length === 0 ? (
                    <div className="dim" style={{ padding: "10px 0" }}>
                      No findings — the run came back clean.
                    </div>
                  ) : (
                    findings.map((f) => (
                      <div className={`finding ${f.severity}`} key={f.id}>
                        <div className="head">
                          <Badge tone={toneOf(f.severity)}>{f.severity}</Badge>
                          <Badge plain>{f.category}</Badge>
                          <span className="grow" />
                          <button className="btn sm quiet" onClick={() => copy(f.id, findingToPrompt(f, report.url))}>
                            {copied === f.id ? "copied ✓" : "copy fix prompt"}
                          </button>
                        </div>
                        <div className="summary">{f.summary}</div>
                        {f.detail ? <div className="detail">{f.detail}</div> : null}
                        {f.decision ? (
                          <div className="decision">
                            {f.decision.whatChanged} → <b>{f.decision.nextAction}</b>
                            {f.decision.whereInSource ? (
                              <>
                                {" "}
                                <code className="k">{f.decision.whereInSource}</code>
                              </>
                            ) : null}
                          </div>
                        ) : null}
                      </div>
                    ))
                  )}
                </div>
              </div>

              {flows ? (
                <div className="panel">
                  <div className="panel-head">
                    <Verdict status={flows.status} />
                    <h2>Flow suite</h2>
                    <span className="dim grow">{flows.summary}</span>
                  </div>
                  <div className="panel-body" style={{ paddingTop: 4, paddingBottom: 4 }}>
                    {(flows.results ?? []).map((r) => (
                      <div className={`finding ${r.status === "ok" ? "info" : "critical"}`} key={r.flow}>
                        <div className="head">
                          <Verdict status={r.status} />
                          <code className="mono">{r.flow}</code>
                          <Tier tier={r.evidenceTier} />
                          <span className="grow" />
                          <span className="faint num">
                            {r.stepsRun} steps · {(r.durationMs / 1000).toFixed(1)}s
                          </span>
                        </div>
                        {r.decision ? (
                          <div className="decision">
                            {r.decision.whatChanged} → <b>{r.decision.nextAction}</b>
                          </div>
                        ) : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>

            <div>
              {diffs.length ? (
                <div className="panel evidence">
                  <div className="panel-head">
                    <h2>Visual diffs</h2>
                    <span className="dim grow">drag the divider to compare</span>
                  </div>
                  <div className="panel-body">
                    {diffs.map((v) => {
                      const caption = `${v.viewport} / ${v.colorScheme}`;
                      return (
                        <div key={v.currentKey} style={{ marginBottom: 14 }}>
                          <div className="micro">
                            {caption} · {(v.diffRatio * 100).toFixed(1)}% changed
                          </div>
                          <div className="diffrow" style={{ marginTop: 6 }}>
                            {v.baselineKey ? (
                              <Compare
                                token={token}
                                baseline={artifactUrl(v.baselineKey)}
                                current={artifactUrl(v.currentKey)}
                                caption={caption}
                              />
                            ) : (
                              <div className="shot">
                                <ArtifactImg token={token} src={artifactUrl(v.currentKey)} alt={caption} />
                              </div>
                            )}
                            {v.diffKey ? (
                              <div className="shot">
                                <ArtifactImg token={token} src={artifactUrl(v.diffKey)} alt={`diff ${caption}`} />
                                <div className="label">diff</div>
                              </div>
                            ) : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              {report.screenshots?.length ? (
                <div className="panel evidence">
                  <div className="panel-head">
                    <h2>Screenshots</h2>
                    <span className="dim grow">click to open full size</span>
                  </div>
                  <div className="panel-body">
                    <div className="shots">
                      {report.screenshots.map((s) => (
                        <div className="shot" key={s.key}>
                          <ArtifactImg
                            token={token}
                            src={artifactUrl(s.key)}
                            alt={`${s.viewport} ${s.colorScheme}`}
                          />
                          <div className="label">
                            <span>
                              {s.viewport} / {s.colorScheme}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * Launch QA — five first-time users per run (`argus personas`): who reached
 * first success, and every place they got stuck, ranked by how many of them
 * hit it. Overview on top; a ranked "needs attention" list beside the issue
 * it opens (what they saw, expected and tried, with the screenshots).
 */
import React, { useEffect, useMemo, useState } from "react";
import type { PersonaIssue, PersonaRun, PersonaRunSummary } from "@argus/shared";
import { apiGet, artifactUrl } from "./api";
import { Badge, Empty, ErrBox, Skeleton, Tier, timeAgo, useArtifact } from "./ui";

const PERSONA_LABEL: Record<string, string> = {
  impatient: "Impatient",
  skeptic: "Skeptic",
  mobile: "Phone · slow 3G",
  literal: "Literal reader",
  breaker: "Breaker",
};
const SEVERITY_TONE: Record<string, "fail" | "warn" | "info"> = { blocker: "fail", major: "warn", minor: "info" };
const clip = (text: string, n = 48) => (text.length > n ? text.slice(0, n - 1) + "…" : text);
const human = (slug: string) => slug.charAt(0).toUpperCase() + slug.slice(1).replace(/-/g, " ");

function Thumb({ token, shot }: { token: string; shot?: string }): React.ReactElement {
  const { url } = useArtifact(token, shot ? artifactUrl(shot) : "");
  return shot && url ? <img className="qa-thumb" src={url} alt="" /> : <span className="qa-thumb empty" aria-hidden="true" />;
}

function Shot({ token, shot }: { token: string; shot: string }): React.ReactElement {
  const { url, err } = useArtifact(token, artifactUrl(shot));
  const name = shot.split("/").pop() ?? shot;
  return (
    <figure className="shot">
      {err ? (
        <div className="label">image unavailable</div>
      ) : url ? (
        <a href={url} target="_blank" rel="noreferrer" aria-label={`Open ${name} full size`}>
          <img src={url} alt={name} />
        </a>
      ) : (
        <div className="label">loading image…</div>
      )}
      <figcaption className="label">
        <span className="truncate">{name}</span>
      </figcaption>
    </figure>
  );
}

/** "skeptic: the task vanished" → the persona as a chip, the words as prose. */
function Voices({ title, lines }: { title: string; lines: string[] }): React.ReactElement | null {
  if (lines.length === 0) return null;
  return (
    <section className="qa-section">
      <h3 className="micro">{title}</h3>
      {lines.map((line, i) => {
        const at = line.indexOf(": ");
        const who = at > 0 ? line.slice(0, at) : undefined;
        return (
          <p key={i} className="qa-voice">
            {who ? <span className="chip">{PERSONA_LABEL[who] ?? who}</span> : null} {at > 0 ? line.slice(at + 2) : line}
          </p>
        );
      })}
    </section>
  );
}

function IssueDetail({ token, issue }: { token: string; issue: PersonaIssue }): React.ReactElement {
  return (
    <article className="panel qa-detail" aria-label={human(issue.symptom)}>
      <div className="panel-head">
        <h2 className="qa-title grow">{human(issue.symptom)}</h2>
        <Badge tone={SEVERITY_TONE[issue.severity] ?? "info"}>{issue.severity}</Badge>
      </div>
      <div className="panel-body">
        <div className="qa-meta dim">
          <span className="k" title={issue.element}>
            {clip(issue.element)}
          </span>{" "}
          on <span className="k">{issue.where}</span> · hit by {issue.personas.length} of 5
          · <Tier tier={issue.tier} />
        </div>
        <Voices title="What they saw" lines={issue.saw} />
        <Voices title="What they expected" lines={issue.expected ?? []} />
        <Voices title="What they tried" lines={issue.tried ?? []} />
        {issue.screenshots.length ? (
          <section className="qa-section">
            <h3 className="micro">Evidence</h3>
            <div className="shots">
              {issue.screenshots.slice(0, 6).map((s) => (
                <Shot key={s} token={token} shot={s} />
              ))}
            </div>
          </section>
        ) : null}
      </div>
    </article>
  );
}

export function LaunchQAView({ token, now }: { token: string; now: number }): React.ReactElement {
  const [runs, setRuns] = useState<PersonaRunSummary[]>();
  const [runId, setRunId] = useState<string>();
  const [run, setRun] = useState<PersonaRun>();
  const [open, setOpen] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    apiGet<{ runs: PersonaRunSummary[] }>(token, "/v1/personas")
      .then((r) => {
        setRuns(r.runs);
        setRunId((cur) => cur ?? r.runs[0]?.id);
      })
      .catch((e) => setError(String(e)));
  }, [token]);

  useEffect(() => {
    if (!runId) return;
    setRun(undefined);
    apiGet<PersonaRun>(token, `/v1/personas/${runId}`)
      .then((r) => {
        setRun(r);
        setOpen(r.issues[0]?.key);
      })
      .catch((e) => setError(String(e)));
  }, [token, runId]);

  const issue = useMemo(() => run?.issues.find((i) => i.key === open), [run, open]);

  if (error) return <ErrBox message={error} />;
  if (!runs) return <Skeleton rows={4} />;
  if (runs.length === 0)
    return (
      <Empty title="No launch QA runs yet">
        Run five first-time users against your app and the ranked results land here.
        <div className="hint">
          <code className="k">argus personas https://your.app --goal "create my first project"</code>
        </div>
      </Empty>
    );
  if (!run) return <Skeleton rows={4} />;

  const reached = run.reports.filter((r) => r.reachedSuccess).length;
  const top = run.issues[0];
  return (
    <div className="rise">
      <div className="panel">
        <div className="panel-head">
          <div className="grow">
            <div className="qa-goal">“{run.goal}”</div>
            <div className="dim truncate">
              {run.url} · {timeAgo(run.createdAt, now)}
            </div>
          </div>
          {runs.length > 1 ? (
            <label className="dim">
              <span className="sr-only">Run</span>
              <select className="input" value={runId} onChange={(e) => setRunId(e.target.value)}>
                {runs.map((r) => (
                  <option key={r.id} value={r.id}>
                    {new Date(r.createdAt).toLocaleString()} · {r.reached}/{r.personas} reached · {r.issues} issues
                  </option>
                ))}
              </select>
            </label>
          ) : null}
        </div>
        <div className="wall qa-wall" role="list" aria-label="The five users">
          {run.reports.map((r) => (
            <div key={r.persona} role="listitem" className={`cell tone-${r.reachedSuccess ? "pass" : "fail"}`}>
              <div className="cell-top">
                <span className="cell-name">{PERSONA_LABEL[r.persona] ?? r.persona}</span>
              </div>
              <div className={r.reachedSuccess ? "dim" : ""}>{r.reachedSuccess ? "Reached first success" : "Did not reach success"}</div>
              <div className="dim">
                {r.moments.length === 0 ? "No friction" : `${r.moments.length} moment${r.moments.length === 1 ? "" : "s"} of friction`}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="statgrid qa-stats">
        <div className="stat">
          <div className="n">
            {reached}/{run.reports.length}
          </div>
          <div className="k">reached first success</div>
        </div>
        <div className="stat">
          <div className="n">{run.issues.length}</div>
          <div className="k">issues</div>
        </div>
        <div className="stat">
          <div className="n">{run.issues.filter((i) => i.severity === "blocker").length}</div>
          <div className="k">blockers</div>
        </div>
        <div className="stat">
          <div className="n">{top ? top.personas.length : 0}</div>
          <div className="k">users on the top issue</div>
        </div>
      </div>

      {run.issues.length === 0 ? (
        <Empty title="Nobody got stuck">All five users reached first success without a moment of friction.</Empty>
      ) : (
        <div className="qa-split">
          <section className="panel" aria-label="Needs attention">
            <div className="panel-head">
              <span className="grow">Needs attention</span>
              <span className="dim">ranked by users hit</span>
            </div>
            {run.issues.map((i) => (
              <button
                key={i.key}
                type="button"
                className="row-link qa-row"
                aria-current={i.key === open ? "true" : "false"}
                onClick={() => setOpen(i.key)}
              >
                <Thumb token={token} shot={i.screenshots[0]} />
                <span className="qa-row-main">
                  <span className="qa-row-title">{human(i.symptom)}</span>
                  <span className="dim truncate">
                    {clip(i.element, 32)} · {i.personas.map((p) => PERSONA_LABEL[p] ?? p).join(", ")}
                  </span>
                </span>
                <span className="qa-row-side">
                  <Badge tone={SEVERITY_TONE[i.severity] ?? "info"}>{i.severity}</Badge>
                  <span className="dim num">×{i.personas.length}</span>
                </span>
              </button>
            ))}
          </section>
          {issue ? <IssueDetail token={token} issue={issue} /> : null}
        </div>
      )}
    </div>
  );
}

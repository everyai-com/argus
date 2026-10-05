/**
 * Operate surfaces — leased browsers with their lease clocks, and fleet
 * capacity (saturation, queue, per-tenant reserved floors).
 */
import React, { useState } from "react";
import { apiSend, type Capacity, type SessionRow } from "./api";
import { Badge, Empty, ErrBox, Gauge, Meter, until } from "./ui";

const DEFAULT_LEASE_MS = 300_000;

export function SessionsView({
  token,
  sessions,
  onChanged,
  now,
}: {
  token: string;
  sessions: SessionRow[];
  onChanged: () => void;
  now: number;
}): React.ReactElement {
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  const release = (sessionId: string) => {
    setBusy(sessionId);
    setError(undefined);
    apiSend(token, "DELETE", `/v1/session/${sessionId}`)
      .then(onChanged)
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(undefined));
  };

  if (sessions.length === 0)
    return (
      <Empty title="No browsers leased right now">
        Every agent session holds one isolated cloud Chromium. Leases appear here the moment they start:
        <div className="hint">
          <code className="k">argus_lease</code>
          <span className="dim">via your MCP client</span>
        </div>
      </Empty>
    );

  return (
    <div className="panel rise">
      <div className="panel-head">
        <h2>Leased browsers</h2>
        <span className="dim grow">releasing one frees its slot immediately</span>
        <span className="dim num">{sessions.length}</span>
      </div>
      {error ? (
        <div className="panel-body">
          <ErrBox message={error} />
        </div>
      ) : null}
      <div className="cols sessions head-row micro">
        <span>Session</span>
        <span className="hide-md">Page</span>
        <span>Lease</span>
        <span />
      </div>
      {sessions.map((s) => {
        const start = s.createdAt ? Date.parse(s.createdAt) : Date.parse(s.expiresAt) - DEFAULT_LEASE_MS;
        const end = Date.parse(s.expiresAt);
        const left = end - now;
        const pct = end > start ? (left / (end - start)) * 100 : 0;
        const soon = left < 60_000;
        return (
          <div className="cols sessions row-plain" key={s.sessionId}>
            <span className="truncate">
              <code className="mono">{s.sessionId}</code>
              {s.label ? (
                <>
                  {" "}
                  <span className="chip">{s.label}</span>
                </>
              ) : null}
            </span>
            <span className="dim truncate hide-md" title={s.url}>
              {s.url}
            </span>
            <span>
              <Meter
                pct={pct}
                hot={soon}
                label={`Lease ${s.sessionId} expires in ${until(s.expiresAt, now)}`}
              />
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                ends in {until(s.expiresAt, now)}
              </span>
            </span>
            <button
              className="btn sm ghost"
              disabled={busy === s.sessionId}
              onClick={() => release(s.sessionId)}
            >
              {busy === s.sessionId ? "releasing…" : "Release"}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function CapacityView({
  cap,
  rates,
  error,
  live,
  onRetry,
}: {
  cap?: Capacity;
  rates: { acquires: number; rejects: number };
  error?: string;
  live: boolean;
  onRetry: () => void;
}): React.ReactElement {
  if (error) return <ErrBox message={error} onRetry={onRetry} />;
  if (!cap) return <Empty title="Waiting for capacity telemetry">The coordinator reports every two seconds.</Empty>;

  return (
    <div className="rise">
      <div className="panel">
        <div className="panel-head">
          <h2>Fleet</h2>
          <span className="dim grow">
            {cap.active} of {cap.cap} browsers in use · {cap.reservedTotal} reserved across tenants
          </span>
          <Badge tone={cap.active >= cap.cap ? "fail" : "pass"}>
            {cap.active >= cap.cap ? "saturated" : "headroom"}
          </Badge>
          {!live ? <Badge tone="info">paused</Badge> : null}
        </div>
        <div className="panel-body">
          <Gauge label="Concurrent browsers" used={cap.active} total={cap.cap} />
          <Gauge label="Warm pool (reconnect-ready)" used={cap.warm} total={cap.warmCap} tone="pool" />
        </div>
      </div>

      <div className="statgrid" style={{ marginTop: 12 }}>
        <div className="stat">
          <div className="n num">{cap.launchQueueMs}ms</div>
          <div className="k">launch queue</div>
        </div>
        <div className="stat">
          <div className="n num">{rates.acquires.toFixed(1)}/s</div>
          <div className="k">acquire rate</div>
        </div>
        <div className="stat">
          <div className="n num">{rates.rejects.toFixed(1)}/s</div>
          <div className="k">429 rate</div>
        </div>
        <div className="stat">
          <div className="n num">{cap.cumulative.launches}</div>
          <div className="k">cold launches</div>
        </div>
        <div className="stat">
          <div className="n num">{cap.cumulative.acquires}</div>
          <div className="k">total acquires</div>
        </div>
        <div className="stat">
          <div className="n num">{cap.cumulative.releases}</div>
          <div className="k">total releases</div>
        </div>
      </div>

      <div className="panel" style={{ marginTop: 12 }}>
        <div className="panel-head">
          <h2>Tenants</h2>
          <span className="dim grow">used against burst ceiling · dashed line is the reserved floor</span>
        </div>
        <div className="panel-body">
          {cap.tenants.length === 0 ? (
            <div className="dim">
              No tenants yet — the admin token holds every lease. Create one with{" "}
              <code className="k">argus tenants create &lt;id&gt; --reserved 5</code>
            </div>
          ) : (
            cap.tenants.map((t) => {
              const pct = t.maxBurst > 0 ? Math.min(100, (t.active / t.maxBurst) * 100) : 0;
              const resPct = t.maxBurst > 0 ? Math.min(100, (t.reserved / t.maxBurst) * 100) : 0;
              const cls = pct >= 90 ? "hot" : pct >= 60 ? "warm" : "";
              return (
                <div key={t.id} style={{ marginBottom: 12 }}>
                  <div className="glabel" style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
                    <span>
                      <code className="k">{t.id}</code> <span className="dim">{t.name}</span>
                      {t.disabled ? (
                        <>
                          {" "}
                          <Badge tone="fail">disabled</Badge>
                        </>
                      ) : null}
                    </span>
                    <span className="dim num">
                      {t.active}/{t.maxBurst} · reserved {t.reserved}
                    </span>
                  </div>
                  <div className="track">
                    <div className={`fill ${cls}`} style={{ width: `${pct}%` }} />
                    {t.reserved > 0 ? <div className="reserved" style={{ left: `${resPct}%` }} /> : null}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      <div className="faint" style={{ marginTop: 10, fontSize: "var(--fs-xs)" }}>
        counters since {new Date(cap.since).toLocaleString()}
      </div>
    </div>
  );
}

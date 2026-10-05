/**
 * Console primitives: the mark, verdict badges, meters, state blocks, and the
 * relative-time helpers the live tiles tick on.
 */
import React, { useEffect, useMemo, useRef, useState } from "react";

export function Mark({ size = 18 }: { size?: number }): React.ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="8.4" />
      <circle cx="12" cy="12" r="1.5" fill="currentColor" stroke="none" />
      <path d="M12 1.2v4.4M12 18.4v4.4M1.2 12h4.4M18.4 12h4.4" strokeLinecap="round" />
    </svg>
  );
}

const PASS = new Set(["pass", "ok", "green"]);
const FAIL = new Set(["fail", "error", "critical"]);

export function toneOf(status?: string): "pass" | "fail" | "warn" | "info" {
  const s = (status ?? "").toLowerCase();
  if (PASS.has(s)) return "pass";
  if (FAIL.has(s)) return "fail";
  if (s === "warn" || s === "major" || s === "drift") return "warn";
  return "info";
}

export function Badge({
  children,
  tone,
  plain,
  title,
}: {
  children: React.ReactNode;
  tone?: "pass" | "fail" | "warn" | "info";
  plain?: boolean;
  title?: string;
}): React.ReactElement {
  return (
    <span className={`badge ${tone ?? "info"}${plain ? " plain" : ""}`} title={title}>
      {children}
    </span>
  );
}

export function Verdict({ status }: { status?: string }): React.ReactElement {
  return <Badge tone={toneOf(status)}>{status ?? "unknown"}</Badge>;
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function timeAgo(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function until(iso: string | undefined, now: number): string {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.max(0, Math.round((t - now) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.round(s / 60)}m`;
}

export function Gauge({
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
  tone?: "load" | "pool";
}): React.ReactElement {
  const pct = total > 0 ? Math.min(100, (used / total) * 100) : 0;
  const cls = tone === "pool" ? "pool" : pct >= 90 ? "hot" : pct >= 60 ? "warm" : "";
  return (
    <div className="gauge">
      <div className="glabel">
        <span>{label}</span>
        <span className="num">
          {used}/{total}
          {hint ? ` · ${hint}` : ""}
        </span>
      </div>
      <div className="track" role="img" aria-label={`${label}: ${used} of ${total}`}>
        <div className={`fill ${cls}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export function Meter({
  pct,
  hot,
  label,
}: {
  pct: number;
  hot?: boolean;
  label: string;
}): React.ReactElement {
  return (
    <div className="track ttl" role="img" aria-label={label}>
      <div className={`fill${hot ? " hot" : ""}`} style={{ width: `${Math.max(0, Math.min(100, pct))}%` }} />
    </div>
  );
}

export function Empty({
  title,
  children,
}: {
  title: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="empty rise">
      <div className="title">{title}</div>
      <div className="dim">{children}</div>
    </div>
  );
}

export function Skeleton({ rows = 4 }: { rows?: number }): React.ReactElement {
  return (
    <div className="panel" aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div className="skeleton" key={i}>
          <div className="sk" style={{ width: `${40 + ((i * 17) % 40)}%` }} />
          <div className="sk" style={{ width: `${20 + ((i * 11) % 25)}%` }} />
        </div>
      ))}
    </div>
  );
}

export function ErrBox({
  message,
  onRetry,
  children,
}: {
  message: string;
  onRetry?: () => void;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="err" role="alert">
      <div className="micro">Request failed</div>
      <div className="msg mono">{message}</div>
      <div className="dim" style={{ marginTop: 6 }}>
        {children}
        {onRetry ? (
          <button className="btn sm ghost" onClick={onRetry} style={{ marginLeft: children ? 10 : 0 }}>
            Retry
          </button>
        ) : null}
      </div>
    </div>
  );
}

export function useCopied(): [string | undefined, (key: string, text: string) => void] {
  const [copied, setCopied] = useState<string>();
  const copy = (key: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(key);
      setTimeout(() => setCopied(undefined), 1500);
    });
  };
  return [copied, copy];
}

/** Load an artifact (auth header) as a blob URL; revokes on unmount. */
export function useArtifact(token: string, src: string): { url?: string; err: boolean } {
  const [url, setUrl] = useState<string>();
  const [err, setErr] = useState(false);
  useEffect(() => {
    let revoke: string | undefined;
    let cancelled = false;
    setUrl(undefined);
    setErr(false);
    fetch(src, { headers: token ? { authorization: `Bearer ${token}` } : {} })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (cancelled) return;
        revoke = URL.createObjectURL(b);
        setUrl(revoke);
      })
      .catch(() => !cancelled && setErr(true));
    return () => {
      cancelled = true;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [src, token]);
  return { url, err };
}

/** Row filter with a `/` hotkey and Escape to clear. */
export function useFilter<T>(
  rows: T[],
  match: (row: T, query: string) => boolean
): {
  query: string;
  setQuery: (q: string) => void;
  filtered: T[];
  ref: React.RefObject<HTMLInputElement | null>;
} {
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing =
        e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "/" && !typing) {
        e.preventDefault();
        ref.current?.focus();
      }
      if (e.key === "Escape" && document.activeElement === ref.current) {
        setQuery("");
        ref.current?.blur();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);
  const filtered = useMemo(
    () => (query ? rows.filter((r) => match(r, query.trim().toLowerCase())) : rows),
    [rows, query, match]
  );
  return { query, setQuery, filtered, ref };
}

/**
 * The evidence ladder is the product's core model (strongest first). The tier
 * chip teaches it wherever a verdict rests on one.
 */
const TIERS: Array<{ id: string; glyph: string; note: string }> = [
  { id: "signal", glyph: "◆", note: "an app-emitted signal (needs the SDK)" },
  { id: "consequence", glyph: "●", note: "network, route or state truth" },
  { id: "dom", glyph: "◇", note: "DOM or text presence" },
  { id: "visual", glyph: "▪", note: "screenshot evidence only" },
];

export function Tier({ tier }: { tier?: string }): React.ReactElement | null {
  const found = TIERS.find((t) => t.id === tier);
  if (!found) return null;
  return (
    <span
      className="chip tier"
      title={"evidence tier: " + found.id + " — " + found.note + " (verdicts report the weakest tier they rest on)"}
    >
      <span aria-hidden="true">{found.glyph}</span> {found.id}
    </span>
  );
}

/** Monochrome 24-hour activity histogram — trends, not evidence, so no hue. */
export function Sparkbars({
  values,
  labels,
}: {
  values: number[];
  labels: string[];
}): React.ReactElement {
  const max = Math.max(1, ...values);
  const total = values.reduce((a, b) => a + b, 0);
  return (
    <div className="spark" role="img" aria-label={`${total} runs in the last 24 hours`}>
      {values.map((v, i) => (
        <span
          key={i}
          className={"bar" + (v === 0 ? " zero" : "")}
          style={{ height: `${Math.max(6, (v / max) * 100)}%` }}
          title={`${v} run${v === 1 ? "" : "s"} · ${labels[i]}`}
        />
      ))}
    </div>
  );
}

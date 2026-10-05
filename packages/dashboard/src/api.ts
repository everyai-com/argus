/**
 * Dashboard data layer — token storage, the worker's /v1 calls, and the
 * capacity poll every surface reads from.
 */
import { useCallback, useEffect, useRef, useState } from "react";

export interface RunRow {
  runId: string;
  kind: string;
  at: string;
  artifacts: number;
}

export interface SessionRow {
  sessionId: string;
  url: string;
  label?: string;
  createdAt?: string;
  expiresAt: string;
}

export interface ProjectRow {
  project: string;
  runs: number;
  failing: number;
  latest: { runId: string; kind: string; status: string; url?: string; at?: string };
}

export interface Finding {
  id: string;
  severity: string;
  category: string;
  summary: string;
  detail?: string;
  evidence?: { screenshotKey?: string; viewport?: string };
  decision?: { whatChanged: string; whereInSource?: string; nextAction: string };
}

export interface Capacity {
  active: number;
  cap: number;
  warm: number;
  warmCap: number;
  launchQueueMs: number;
  reservedTotal: number;
  cumulative: { acquires: number; rejects: number; launches: number; releases: number };
  since: string;
  tenants: Array<{
    id: string;
    name: string;
    active: number;
    reserved: number;
    maxBurst: number;
    disabled?: boolean;
  }>;
}

export function useToken(): [string, (token: string) => void] {
  const [token, setToken] = useState(() => localStorage.getItem("argus-token") ?? "");
  return [
    token,
    (t: string) => {
      localStorage.setItem("argus-token", t);
      setToken(t);
    },
  ];
}

function authHeaders(token: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {};
}

export async function apiGet<T = any>(token: string, path: string): Promise<T> {
  const res = await fetch(path, { headers: authHeaders(token) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
  return res.json();
}

export async function apiSend(token: string, method: string, path: string): Promise<void> {
  const res = await fetch(path, { method, headers: authHeaders(token) });
  if (!res.ok) throw new Error(`${res.status} ${await res.text().catch(() => "")}`.slice(0, 200));
}

export function artifactUrl(key: string): string {
  return `/v1/artifact/${key}`;
}

export function useCapacity(
  token: string,
  live: boolean
): { cap?: Capacity; rates: { acquires: number; rejects: number }; error?: string; reload: () => void } {
  const [cap, setCap] = useState<Capacity>();
  const [error, setError] = useState<string>();
  const [rates, setRates] = useState({ acquires: 0, rejects: 0 });
  const prev = useRef<{ c: Capacity["cumulative"]; t: number }>();
  const [nonce, setNonce] = useState(0);
  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    if (!token || !live) return;
    let alive = true;
    const tick = () => {
      apiGet<Capacity>(token, "/v1/capacity")
        .then((d) => {
          if (!alive) return;
          const now = Date.now();
          if (prev.current) {
            const dt = (now - prev.current.t) / 1000;
            if (dt > 0) {
              setRates({
                acquires: Math.max(0, (d.cumulative.acquires - prev.current.c.acquires) / dt),
                rejects: Math.max(0, (d.cumulative.rejects - prev.current.c.rejects) / dt),
              });
            }
          }
          prev.current = { c: d.cumulative, t: now };
          setCap(d);
          setError(undefined);
        })
        .catch((e) => alive && setError(String(e)));
    };
    tick();
    const iv = setInterval(tick, 2000);
    return () => {
      alive = false;
      clearInterval(iv);
    };
  }, [token, live, nonce]);

  return { cap, rates, error, reload };
}

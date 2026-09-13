/**
 * Account — self-serve signup with better-auth, then one button to mint an MCP
 * token. This is the whole onboarding: create an account, copy the block, paste
 * it into your agent.
 */
import React, { useEffect, useState } from "react";

interface Session {
  user: { id: string; email: string; name?: string };
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
}

export function AccountView({ onToken }: { onToken: (token: string) => void }): React.ReactElement {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [minted, setMinted] = useState<{
    token: string;
    mcpUrl: string;
    config: { json: unknown; codex: string };
  }>();
  const [copied, setCopied] = useState<string>();

  const loadSession = () =>
    fetch("/api/auth/get-session", { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then((s) => setSession(s && s.user ? (s as Session) : null))
      .catch(() => setSession(null))
      .finally(() => setChecked(true));

  useEffect(() => {
    void loadSession();
  }, []);

  const auth = async (mode: "up" | "in") => {
    setBusy(true);
    setError(undefined);
    try {
      const body =
        mode === "up" ? { email, password, name: email.split("@")[0] } : { email, password };
      const res = await post(mode === "up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email", body);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text.slice(0, 300) || String(res.status));
      }
      await loadSession();
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const mint = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const res = await fetch("/api/mcp-token", { method: "POST", credentials: "same-origin" });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.detail ?? data?.error ?? String(res.status));
      setMinted(data);
      onToken(data.token); // let the rest of the dashboard use it immediately
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  const copy = (label: string, text: string) => {
    void navigator.clipboard.writeText(text).then(() => {
      setCopied(label);
      setTimeout(() => setCopied(undefined), 1500);
    });
  };

  if (!checked) return <div className="empty">checking session…</div>;

  if (!session)
    return (
      <div className="card" style={{ maxWidth: 460 }}>
        <h2 style={{ marginTop: 0 }}>Create your Argus account</h2>
        <p className="muted small">
          An account gives you a tenant token for the MCP server. Nothing else to install.
        </p>
        <input
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          style={{ width: "100%", padding: 8, marginBottom: 8 }}
        />
        <input
          type="password"
          placeholder="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{ width: "100%", padding: 8, marginBottom: 12 }}
        />
        <div style={{ display: "flex", gap: 8 }}>
          <button disabled={busy || !email || password.length < 8} onClick={() => auth("up")}>
            Sign up
          </button>
          <button disabled={busy || !email || !password} onClick={() => auth("in")}>
            Sign in
          </button>
        </div>
        {error && <div className="small" style={{ color: "#f87171", marginTop: 10 }}>{error}</div>}
      </div>
    );

  const jsonBlock = minted ? JSON.stringify(minted.config.json, null, 2) : "";

  return (
    <div style={{ display: "grid", gap: 12, maxWidth: 720 }}>
      <div className="card">
        <div className="row">
          <strong>{session.user.email}</strong>
          <span style={{ flex: 1 }} />
          <button
            onClick={() =>
              post("/api/auth/sign-out", {}).then(() => {
                setSession(null);
                setMinted(undefined);
              })
            }
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="card">
        <h2 style={{ marginTop: 0 }}>Give this to your AI</h2>
        {!minted ? (
          <>
            <p className="muted small">
              Mints a token for this account&apos;s tenant and shows it <strong>once</strong>. Regenerate
              any time — the old token stops working.
            </p>
            <button disabled={busy} onClick={mint}>
              {busy ? "creating…" : "Create MCP token"}
            </button>
          </>
        ) : (
          <>
            <p className="small">
              <strong>Copy this now — it is not shown again.</strong>
            </p>
            <div className="row" style={{ gap: 8, marginBottom: 8 }}>
              <code className="k" style={{ wordBreak: "break-all" }}>{minted.token}</code>
              <button onClick={() => copy("token", minted.token)}>
                {copied === "token" ? "copied" : "copy"}
              </button>
            </div>
            <p className="muted small">Paste this into Claude Code, Cursor, VS Code, or Codex:</p>
            <div className="row" style={{ gap: 8 }}>
              <button onClick={() => copy("json", jsonBlock)}>
                {copied === "json" ? "copied" : "copy mcpServers JSON"}
              </button>
              <button onClick={() => copy("codex", minted.config.codex)}>
                {copied === "codex" ? "copied" : "copy Codex command"}
              </button>
            </div>
            <pre className="small" style={{ overflowX: "auto" }}>{jsonBlock}</pre>
            <p className="muted small">
              Or tell your agent: “Read https://raw.githubusercontent.com/everyai-com/argus/main/START.md
              and use MCP URL {minted.mcpUrl} with this token.”
            </p>
            <button disabled={busy} onClick={mint}>
              {busy ? "rotating…" : "Rotate token"}
            </button>
          </>
        )}
        {error && <div className="small" style={{ color: "#f87171", marginTop: 10 }}>{error}</div>}
      </div>
    </div>
  );
}

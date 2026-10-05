/**
 * Account — the whole onboarding: create an account, mint a tenant token, copy
 * the config block into an agent.
 */
import React, { useEffect, useState } from "react";
import { Badge, ErrBox, Skeleton, useCopied } from "./ui";

interface Session {
  user: { id: string; email: string; name?: string };
}

interface Minted {
  token: string;
  mcpUrl: string;
  config: { json: unknown; codex: string };
}

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify(body),
  });
}

function notConfigured(message: string): boolean {
  return message.includes("auth_not_configured") || message.includes("auth_unavailable");
}

export function AccountView({ onToken }: { onToken: (token: string) => void }): React.ReactElement {
  const [session, setSession] = useState<Session | null>(null);
  const [checked, setChecked] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [minted, setMinted] = useState<Minted>();
  const [copied, copy] = useCopied();

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
      const body = mode === "up" ? { email, password, name: email.split("@")[0] } : { email, password };
      const res = await post(
        mode === "up" ? "/api/auth/sign-up/email" : "/api/auth/sign-in/email",
        body
      );
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
      onToken(data.token);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
    } finally {
      setBusy(false);
    }
  };

  if (!checked)
    return (
      <>
        <Skeleton rows={2} />
        <span className="sr-only">Checking session</span>
      </>
    );

  if (!session)
    return (
      <div className="rise" style={{ maxWidth: 420 }}>
        {error && notConfigured(error) ? (
          <ErrBox message={error}>
            Accounts are not switched on for this deployment. Set{" "}
            <code className="k">BETTER_AUTH_SECRET</code> on the Worker, or paste an existing token in the rail.
          </ErrBox>
        ) : null}
        <form
          className="panel"
          onSubmit={(e) => {
            e.preventDefault();
            void auth("up");
          }}
        >
          <div className="panel-head">
            <h2>Create your Argus account</h2>
          </div>
          <div className="panel-body" style={{ display: "grid", gap: 12 }}>
            <p className="dim" style={{ margin: 0 }}>
              An account gives you a tenant token for the MCP server. Nothing to install.
            </p>
            <div className="field">
              <label className="micro" htmlFor="acct-email">
                Email
              </label>
              <input
                id="acct-email"
                className="input"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="field">
              <label className="micro" htmlFor="acct-pass">
                Password
              </label>
              <input
                id="acct-pass"
                className="input"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <span className="faint" style={{ fontSize: "var(--fs-xs)" }}>
                at least 8 characters
              </span>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button className="btn primary" type="submit" disabled={busy || !email || password.length < 8}>
                {busy ? "Creating…" : "Create account"}
              </button>
              <button
                className="btn"
                type="button"
                disabled={busy || !email || !password}
                onClick={() => void auth("in")}
              >
                Sign in instead
              </button>
            </div>
            {error && !notConfigured(error) ? <ErrBox message={error} /> : null}
          </div>
        </form>
      </div>
    );

  const jsonBlock = minted ? JSON.stringify(minted.config.json, null, 2) : "";

  return (
    <div className="rise" style={{ display: "grid", gap: 12, maxWidth: 720 }}>
      <div className="panel">
        <div className="panel-head">
          <Badge tone="pass">signed in</Badge>
          <strong className="truncate">{session.user.email}</strong>
          <span className="grow" />
          <button
            className="btn ghost sm"
            onClick={() =>
              void post("/api/auth/sign-out", {}).then(() => {
                setSession(null);
                setMinted(undefined);
              })
            }
          >
            Sign out
          </button>
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Token for your agent</h2>
          <span className="dim grow">one token per account · rotating retires the old one</span>
        </div>
        <div className="panel-body" style={{ display: "grid", gap: 12 }}>
          {!minted ? (
            <>
              <p className="dim" style={{ margin: 0 }}>
                Mints a tenant token and shows it <strong>once</strong>.
              </p>
              <div>
                <button className="btn primary" disabled={busy} onClick={() => void mint()}>
                  {busy ? "Creating…" : "Create MCP token"}
                </button>
              </div>
            </>
          ) : (
            <>
              <p style={{ margin: 0 }}>
                <strong>Copy it now — it is not shown again.</strong>
              </p>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <code className="k mono" style={{ wordBreak: "break-all", flex: 1, minWidth: 220 }}>
                  {minted.token}
                </code>
                <button className="btn" onClick={() => copy("token", minted.token)}>
                  {copied === "token" ? "Copied ✓" : "Copy token"}
                </button>
              </div>
              <p className="dim" style={{ margin: 0 }}>
                Paste this into Claude Code, Cursor, VS Code, or Codex:
              </p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => copy("json", jsonBlock)}>
                  {copied === "json" ? "Copied ✓" : "Copy mcpServers JSON"}
                </button>
                <button className="btn" onClick={() => copy("codex", minted.config.codex)}>
                  {copied === "codex" ? "Copied ✓" : "Copy Codex command"}
                </button>
              </div>
              <pre className="config-example">{jsonBlock}</pre>
              <p className="dim" style={{ margin: 0, maxWidth: "70ch" }}>
                Or tell your agent: “Read https://raw.githubusercontent.com/everyai-com/argus/main/START.md and
                use MCP URL {minted.mcpUrl} with this token.”
              </p>
              <div>
                <button className="btn ghost" disabled={busy} onClick={() => void mint()}>
                  {busy ? "Rotating…" : "Rotate token"}
                </button>
              </div>
            </>
          )}
          {error ? <ErrBox message={error} /> : null}
        </div>
      </div>
    </div>
  );
}

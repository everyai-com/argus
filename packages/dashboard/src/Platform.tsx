/**
 * Platform — the GitHub App surface: install it, point it at a repo's checks.
 */
import React, { useEffect, useState } from "react";
import { Badge, ErrBox, Skeleton } from "./ui";

interface GitHubStatus {
  configured: boolean;
  installUrl?: string;
  checkName: string;
}

export function GitHubView(): React.ReactElement {
  const [status, setStatus] = useState<GitHubStatus>();
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

  if (error) return <ErrBox message={error} />;
  if (!status) return <Skeleton rows={2} />;

  return (
    <div className="rise">
      <div className="panel">
        <div className="panel-body" style={{ padding: 20 }}>
          <Badge tone={status.configured ? "pass" : "warn"}>
            {status.configured ? "ready" : "setup required"}
          </Badge>
          <h2 style={{ marginTop: 10 }}>Automatic verification for every pull request</h2>
          <p className="dim" style={{ maxWidth: "62ch" }}>
            Install Argus on selected repositories. Each pull request gets one {status.checkName} check with
            cloud-browser smoke tests, accessibility and performance audits, visual diffs, and committed flow
            replays.
          </p>
          {status.installUrl ? (
            <a className="btn primary" href={status.installUrl} style={{ marginTop: 6 }}>
              Connect GitHub
            </a>
          ) : (
            <p className="faint">Set the GitHub App slug on the Worker to enable repository installation.</p>
          )}
        </div>
      </div>

      <div className="panel">
        <div className="panel-head">
          <h2>Repository configuration</h2>
          <span className="dim grow">committed, never contains credentials</span>
        </div>
        <div className="panel-body">
          <code className="k">.argus/platform.json</code>
          <pre className="config-example">{`{
  "deployment": { "environments": ["Preview"] },
  "checks": ["smoke", "audit", "flows"],
  "viewports": ["mobile", "desktop"],
  "flowConcurrency": 3
}`}</pre>
          <p className="dim" style={{ marginBottom: 0, maxWidth: "70ch" }}>
            Argus starts when GitHub reports a successful HTTPS preview deployment. For a stable staging site,
            replace <code className="k">deployment</code> with <code className="k">targetUrl</code>.
          </p>
        </div>
      </div>
    </div>
  );
}

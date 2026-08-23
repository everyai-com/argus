import type { Env } from "./env";

const MAX_LINK_LIFETIME_SECONDS = 7 * 24 * 60 * 60;
const DEFAULT_LINK_LIFETIME_SECONDS = 24 * 60 * 60;

function hex(bytes: ArrayBuffer): string {
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < Math.max(a.length, b.length); index++) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

async function evidenceSignature(secret: string, resource: string, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return hex(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`argus-evidence-v1\n${expires}\n${resource}`)
    )
  );
}

export async function signedEvidenceUrl(
  secret: string,
  publicUrl: string,
  tenantId: string,
  runId: string,
  now = Date.now()
): Promise<string> {
  const expires = Math.floor(now / 1000) + DEFAULT_LINK_LIFETIME_SECONDS;
  const resource = `run:${tenantId}:${runId}`;
  const signature = await evidenceSignature(secret, resource, expires);
  return `${publicUrl}/platform/evidence/${encodeURIComponent(tenantId)}/${encodeURIComponent(runId)}?expires=${expires}&sig=${signature}`;
}

export async function verifyEvidenceSignature(
  secret: string,
  resource: string,
  expiresValue: string | undefined,
  signature: string | undefined,
  now = Date.now()
): Promise<boolean> {
  if (!expiresValue || !signature || !/^[a-f0-9]{64}$/.test(signature)) return false;
  const expires = Number(expiresValue);
  const nowSeconds = Math.floor(now / 1000);
  if (!Number.isInteger(expires) || expires < nowSeconds || expires > nowSeconds + MAX_LINK_LIFETIME_SECONDS) {
    return false;
  }
  return constantTimeEqual(await evidenceSignature(secret, resource, expires), signature);
}

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function artifactUrl(secret: string, origin: string, key: string, expires: number): Promise<string> {
  const signature = await evidenceSignature(secret, `artifact:${key}`, expires);
  return `${origin}/platform/evidence-artifact/${key.split("/").map(encodeURIComponent).join("/")}?expires=${expires}&sig=${signature}`;
}

async function firstJson(env: Env, keys: string[]): Promise<Record<string, any> | undefined> {
  for (const key of keys) {
    const object = await env.ARTIFACTS.get(key);
    if (object) return (await object.json()) as Record<string, any>;
  }
  return undefined;
}

export async function renderEvidencePage(
  env: Env,
  secret: string,
  origin: string,
  tenantId: string,
  runId: string,
  expires: number
): Promise<Response> {
  const prefix = `tenants/${tenantId}/runs/${runId}/`;
  const report = await firstJson(env, [
    `${prefix}audit-report.json`,
    `${prefix}report.json`,
    `${prefix}flows-verdict.json`,
  ]);
  if (!report) return new Response("Evidence not found", { status: 404 });

  const findings = Array.isArray(report.findings) ? report.findings : [];
  const results = Array.isArray(report.results) ? report.results : [];
  const screenshots = Array.isArray(report.screenshots) ? report.screenshots : [];
  const images = await Promise.all(
    screenshots.slice(0, 12).map(async (shot: Record<string, any>) => {
      if (typeof shot.key !== "string" || !shot.key.startsWith(prefix)) return "";
      const src = await artifactUrl(secret, origin, shot.key, expires);
      return `<figure><img src="${escapeHtml(src)}" alt="${escapeHtml(shot.viewport ?? "Argus screenshot")}"><figcaption>${escapeHtml(shot.viewport ?? "viewport")} · ${escapeHtml(shot.colorScheme ?? "")}</figcaption></figure>`;
    })
  );

  const status = report.status ?? (Number(report.failed ?? 0) > 0 ? "fail" : "pass");
  const target = report.url ?? report.baseUrl ?? "";
  const findingMarkup = findings.length
    ? findings
        .slice(0, 50)
        .map(
          (finding: Record<string, any>) =>
            `<article class="finding"><div><span class="severity ${escapeHtml(finding.severity)}">${escapeHtml(finding.severity)}</span> <strong>${escapeHtml(finding.summary)}</strong></div>${
              finding.decision?.nextAction
                ? `<p>Next: ${escapeHtml(finding.decision.nextAction)}</p>`
                : ""
            }</article>`
        )
        .join("")
    : "<p class=clean>No findings — this run is clean.</p>";
  const flowMarkup = results
    .slice(0, 50)
    .map(
      (result: Record<string, any>) =>
        `<article class="finding"><div><span class="severity ${escapeHtml(result.status)}">${escapeHtml(result.status)}</span> <strong>${escapeHtml(result.flow)}</strong></div><p>${escapeHtml(result.stepsRun ?? 0)} steps · ${escapeHtml(result.durationMs ?? 0)}ms</p></article>`
    )
    .join("");

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>Argus evidence ${escapeHtml(runId)}</title><style>
:root{color-scheme:dark;--bg:#0b0e14;--panel:#131824;--line:#263147;--text:#e6e8ee;--muted:#99a4b8;--green:#4ade80;--red:#f87171;--amber:#fbbf24}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 ui-sans-serif,system-ui,sans-serif}.wrap{max-width:1080px;margin:auto;padding:28px 18px}header,.finding,figure{background:var(--panel);border:1px solid var(--line);border-radius:12px}header{padding:22px;margin-bottom:18px}h1{margin:7px 0 2px;font-size:26px}.meta{color:var(--muted);overflow-wrap:anywhere}.status,.severity{display:inline-block;border-radius:999px;padding:2px 9px;text-transform:uppercase;font-size:11px;font-weight:800}.status.pass,.severity.pass,.severity.ok{color:var(--green);background:#123321}.status.fail,.status.error,.severity.fail,.severity.error,.severity.critical{color:var(--red);background:#3a171d}.severity.major,.severity.minor{color:var(--amber);background:#382c12}.finding{padding:12px 14px;margin:9px 0}.finding p{margin:5px 0 0;color:var(--muted)}.clean{color:var(--green)}.shots{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px}figure{margin:0;overflow:hidden}figure img{display:block;width:100%;height:auto}figcaption{padding:8px 10px;color:var(--muted)}footer{margin-top:24px;color:var(--muted);font-size:12px}@media(max-width:520px){.wrap{padding:14px 10px}header{padding:16px}}
</style></head><body><main class="wrap"><header><span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span><h1>Argus verification evidence</h1><div class="meta">Run ${escapeHtml(runId)}${target ? ` · ${escapeHtml(target)}` : ""}</div></header><h2>${results.length ? "Flow results" : `Findings (${findings.length})`}</h2>${results.length ? flowMarkup : findingMarkup}${images.some(Boolean) ? `<h2>Screenshots</h2><section class="shots">${images.join("")}</section>` : ""}<footer>This private evidence link expires automatically. Generated by Argus cloud browsers.</footer></main></body></html>`;
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

export async function serveEvidenceArtifact(env: Env, key: string): Promise<Response> {
  const object = await env.ARTIFACTS.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "content-type": object.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, no-store",
      "content-security-policy": "default-src 'none'",
      "x-content-type-options": "nosniff",
    },
  });
}

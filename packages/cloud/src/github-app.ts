import {
  FlowSchema,
  GitHubPlatformConfigSchema,
  type AuditReport,
  type Flow,
  type GitHubPlatformConfig,
  type SmokeReport,
} from "@argus/shared";
import type { Env } from "./env";
import { runAudit } from "./audit";
import { verifyFlows } from "./flows";
import { writeRunMeta } from "./runs";
import { runSmoke } from "./smoke";
import { signedEvidenceUrl } from "./evidence";

const GITHUB_API = "https://api.github.com";
const CHECK_NAME = "Argus Verification";
const HANDLED_PULL_REQUEST_ACTIONS = new Set([
  "opened",
  "reopened",
  "synchronize",
  "ready_for_review",
]);

export interface GitHubRepositoryRef {
  owner: string;
  repo: string;
  sha: string;
  installationId: number;
  account: string;
}

interface GitHubFile {
  type: "file";
  path: string;
  content?: string;
  encoding?: string;
}

interface GitHubDirectoryEntry {
  type: "file" | "dir";
  path: string;
  name: string;
}

interface CheckRun {
  id: number;
}

interface SuiteResult {
  name: string;
  status: "pass" | "fail" | "error" | "skipped";
  runId?: string;
  summary: string;
  findings?: Array<{
    severity: string;
    category: string;
    summary: string;
    decision?: { nextAction?: string };
  }>;
}

export interface PlatformRunResult {
  conclusion: "success" | "failure" | "action_required";
  title: string;
  summary: string;
  detailsUrl: string;
}

interface VerificationOptions {
  targetUrl?: string;
  force?: boolean;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function textToBase64Url(value: unknown): string {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value.replace(/\s/g, ""));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function derLength(length: number): Uint8Array {
  if (length < 128) return Uint8Array.of(length);
  const bytes: number[] = [];
  for (let value = length; value > 0; value >>= 8) bytes.unshift(value & 0xff);
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}

function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((total, part) => total + part.length, 0);
  const prefix = Uint8Array.of(tag, ...derLength(length));
  const output = new Uint8Array(prefix.length + length);
  output.set(prefix);
  let offset = prefix.length;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** WebCrypto accepts PKCS#8; GitHub currently downloads PKCS#1 RSA PEM files. */
function privateKeyPkcs8(pemOrBase64: string): Uint8Array {
  const normalized = pemOrBase64.includes("BEGIN")
    ? pemOrBase64.replace(/\\n/g, "\n")
    : new TextDecoder().decode(decodeBase64(pemOrBase64));
  const body = normalized.replace(/-----BEGIN [^-]+-----|-----END [^-]+-----|\s/g, "");
  const key = decodeBase64(body);
  if (normalized.includes("BEGIN PRIVATE KEY")) return key;
  if (!normalized.includes("BEGIN RSA PRIVATE KEY")) {
    throw new Error("ARGUS_GITHUB_PRIVATE_KEY must be a PKCS#1 or PKCS#8 PEM key");
  }
  const version = Uint8Array.of(0x02, 0x01, 0x00);
  const rsaAlgorithm = Uint8Array.of(
    0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01,
    0x01, 0x05, 0x00
  );
  return der(0x30, version, rsaAlgorithm, der(0x04, key));
}

export async function createGitHubAppJwt(appId: string, privateKey: string, now = Date.now()): Promise<string> {
  const issuedAt = Math.floor(now / 1000) - 60;
  const unsigned = `${textToBase64Url({ alg: "RS256", typ: "JWT" })}.${textToBase64Url({
    iat: issuedAt,
    exp: issuedAt + 540,
    iss: appId,
  })}`;
  const key = await crypto.subtle.importKey(
    "pkcs8",
    privateKeyPkcs8(privateKey),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    new TextEncoder().encode(unsigned)
  );
  return `${unsigned}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let mismatch = a.length ^ b.length;
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index++) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

export async function verifyGitHubWebhook(rawBody: string, secret: string, signature: string): Promise<boolean> {
  if (!signature.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = `sha256=${[...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}`;
  return constantTimeEqual(expected, signature.toLowerCase());
}

async function githubRequest<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path.startsWith("http") ? path : `${GITHUB_API}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "user-agent": "argus-cloud",
      "x-github-api-version": "2026-03-10",
      ...init.headers,
    },
  });
  if (!response.ok) {
    const detail = (await response.text().catch(() => "")).slice(0, 500);
    throw new Error(`GitHub API ${response.status}: ${detail}`);
  }
  return (await response.json()) as T;
}

async function installationToken(env: Env, installationId: number): Promise<string> {
  if (!env.ARGUS_GITHUB_APP_ID || !env.ARGUS_GITHUB_PRIVATE_KEY) {
    throw new Error("GitHub App credentials are not configured");
  }
  const jwt = await createGitHubAppJwt(env.ARGUS_GITHUB_APP_ID, env.ARGUS_GITHUB_PRIVATE_KEY);
  const result = await githubRequest<{ token: string }>(
    jwt,
    `/app/installations/${installationId}/access_tokens`,
    { method: "POST", body: "{}" }
  );
  return result.token;
}

function repoPath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

async function repositoryJson<T>(
  token: string,
  ref: GitHubRepositoryRef,
  path: string
): Promise<T | null> {
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/${repoPath(path)}?ref=${encodeURIComponent(ref.sha)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "argus-cloud",
        "x-github-api-version": "2026-03-10",
      },
    }
  );
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub contents API ${response.status}`);
  const file = (await response.json()) as GitHubFile;
  if (file.type !== "file" || file.encoding !== "base64" || !file.content) return null;
  return JSON.parse(new TextDecoder().decode(decodeBase64(file.content))) as T;
}

export async function loadGitHubPlatformConfig(
  token: string,
  ref: GitHubRepositoryRef
): Promise<GitHubPlatformConfig | null> {
  const raw = await repositoryJson<unknown>(token, ref, ".argus/platform.json");
  if (raw === null) return null;
  return GitHubPlatformConfigSchema.parse(raw);
}

async function loadGitHubFlows(token: string, ref: GitHubRepositoryRef): Promise<Flow[]> {
  const response = await fetch(
    `${GITHUB_API}/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/contents/.argus/flows?ref=${encodeURIComponent(ref.sha)}`,
    {
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${token}`,
        "user-agent": "argus-cloud",
        "x-github-api-version": "2026-03-10",
      },
    }
  );
  if (response.status === 404) return [];
  if (!response.ok) throw new Error(`GitHub flow listing failed (${response.status})`);
  const entries = (await response.json()) as GitHubDirectoryEntry[];
  const flows: Flow[] = [];
  for (const entry of entries.filter((item) => item.type === "file" && item.name.endsWith(".json")).slice(0, 50)) {
    const raw = await repositoryJson<unknown>(token, ref, entry.path);
    if (raw === null) continue;
    flows.push(FlowSchema.parse(raw));
  }
  return flows;
}

function targetKey(ref: GitHubRepositoryRef): string {
  return `platform/github/targets/${ref.installationId}/${ref.owner}/${ref.repo}/${ref.sha}.json`;
}

async function saveDeploymentTarget(
  env: Env,
  ref: GitHubRepositoryRef,
  targetUrl: string,
  environment?: string
): Promise<void> {
  await env.ARTIFACTS.put(
    targetKey(ref),
    JSON.stringify({ targetUrl, environment, savedAt: new Date().toISOString() }),
    { httpMetadata: { contentType: "application/json" } }
  );
}

async function loadDeploymentTarget(env: Env, ref: GitHubRepositoryRef): Promise<string | undefined> {
  const object = await env.ARTIFACTS.get(targetKey(ref));
  if (!object) return undefined;
  const value = (await object.json()) as { targetUrl?: string };
  return value.targetUrl;
}

async function runKey(ref: GitHubRepositoryRef, targetUrl: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(targetUrl));
  const targetHash = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return `platform/github/runs/${ref.installationId}/${ref.owner}/${ref.repo}/${ref.sha}/${targetHash}.json`;
}

async function claimPlatformRun(env: Env, key: string, force = false): Promise<boolean> {
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  const response = await coordinator.fetch("https://do/platform-run-claim", {
    method: "POST",
    body: JSON.stringify({ key, force }),
  });
  if (!response.ok) throw new Error(`platform run claim failed (${response.status})`);
  return (await response.json<{ claimed: boolean }>()).claimed;
}

async function completePlatformRun(env: Env, key: string, conclusion: string): Promise<void> {
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  await coordinator.fetch("https://do/platform-run-complete", {
    method: "POST",
    body: JSON.stringify({ key, conclusion }),
  });
}

async function ensurePlatformTenant(env: Env, ref: GitHubRepositoryRef): Promise<string> {
  const tenantId = `gh-${ref.installationId}`.slice(0, 40);
  // The registry still expects a token hash, but GitHub installations are
  // authenticated by signed webhooks and short-lived installation tokens.
  // Salt the unreachable placeholder with a Worker secret so an installation
  // id can never be turned into a valid Argus bearer token.
  const tokenHash = await crypto.subtle
    .digest(
      "SHA-256",
      new TextEncoder().encode(
        `github-installation:${ref.installationId}:${env.ARGUS_GITHUB_WEBHOOK_SECRET ?? crypto.randomUUID()}`
      )
    )
    .then((buffer) => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join(""));
  const coordinator = env.COORDINATOR.get(env.COORDINATOR.idFromName("main"));
  await coordinator
    .fetch("https://do/tenant-create", {
      method: "POST",
      body: JSON.stringify({
        id: tenantId,
        name: `GitHub: ${ref.account}`.slice(0, 80),
        reserved: 0,
        maxBurst: 8,
        tokenHash,
      }),
    })
    .catch(() => undefined);
  return tenantId;
}

async function runFlowSuite(
  env: Env,
  flows: Flow[],
  config: GitHubPlatformConfig,
  tenantId: string,
  project: string
): Promise<SuiteResult> {
  if (flows.length === 0) {
    return { name: "Flows", status: "skipped", summary: "No committed .argus/flows/*.json files" };
  }
  const targetUrl = config.targetUrl;
  if (!targetUrl) throw new Error("flow suite target URL was not resolved");
  const verdict = await verifyFlows(env, flows, config.flowConcurrency, targetUrl, tenantId);
  const runId = crypto.randomUUID().slice(0, 8);
  const at = new Date().toISOString();
  await env.ARTIFACTS.put(
    `tenants/${tenantId}/runs/${runId}/flows-verdict.json`,
    JSON.stringify({ runId, at, project, baseUrl: targetUrl, ...verdict }),
    { httpMetadata: { contentType: "application/json" } }
  );
  await writeRunMeta(env, {
    runId,
    kind: "flows",
    project,
    tenantId,
    url: targetUrl,
    status: verdict.status,
    at,
    passed: verdict.passed,
    failed: verdict.failed,
  });
  return {
    name: "Flows",
    status: verdict.status === "pass" ? "pass" : "fail",
    runId,
    summary: verdict.summary,
  };
}

function reportResult(name: string, report: SmokeReport | AuditReport): SuiteResult {
  return {
    name,
    status: report.status === "pass" ? "pass" : report.status === "fail" ? "fail" : "error",
    runId: report.runId,
    summary: `${report.findings.length} finding${report.findings.length === 1 ? "" : "s"}`,
    findings: report.findings,
  };
}

function markdownSummary(targetUrl: string, suites: SuiteResult[]): string {
  const icon = (status: SuiteResult["status"]) =>
    status === "pass" ? "✅" : status === "skipped" ? "➖" : status === "fail" ? "❌" : "⚠️";
  const lines = [
    `Target: ${targetUrl}`,
    "",
    "| Suite | Verdict | Result |",
    "|---|---:|---|",
    ...suites.map((suite) => `| ${suite.name} | ${icon(suite.status)} ${suite.status} | ${suite.summary} |`),
  ];
  const findings = suites.flatMap((suite) => suite.findings ?? []).slice(0, 12);
  if (findings.length > 0) {
    lines.push("", "### Highest-priority findings");
    for (const finding of findings) {
      lines.push(
        `- **${finding.severity} · ${finding.category}:** ${finding.summary}${
          finding.decision?.nextAction ? ` — ${finding.decision.nextAction}` : ""
        }`
      );
    }
  }
  lines.push("", "Generated by Argus cloud browsers. Open the run for screenshots and complete evidence.");
  return lines.join("\n").slice(0, 65_000);
}

async function createCheck(token: string, ref: GitHubRepositoryRef, publicUrl: string): Promise<CheckRun> {
  return githubRequest<CheckRun>(token, `/repos/${ref.owner}/${ref.repo}/check-runs`, {
    method: "POST",
    body: JSON.stringify({
      name: CHECK_NAME,
      head_sha: ref.sha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      details_url: publicUrl,
      output: {
        title: "Argus is testing this change",
        summary: "Starting cloud browser verification…",
      },
    }),
  });
}

async function updateCheck(
  token: string,
  ref: GitHubRepositoryRef,
  checkId: number,
  result: PlatformRunResult
): Promise<void> {
  await githubRequest(token, `/repos/${ref.owner}/${ref.repo}/check-runs/${checkId}`, {
    method: "PATCH",
    body: JSON.stringify({
      status: "completed",
      conclusion: result.conclusion,
      completed_at: new Date().toISOString(),
      details_url: result.detailsUrl,
      output: { title: result.title, summary: result.summary },
      actions: [
        {
          label: "Rerun",
          description: "Run Argus verification again",
          identifier: "rerun",
        },
      ],
    }),
  });
}

export async function runGitHubVerification(
  env: Env,
  ref: GitHubRepositoryRef,
  publicUrl: string,
  options: VerificationOptions = {}
): Promise<PlatformRunResult> {
  const token = await installationToken(env, ref.installationId);
  let check: CheckRun | undefined;
  let claimedKey: string | undefined;
  try {
    const config = await loadGitHubPlatformConfig(token, ref);
    if (!config) {
      check = await createCheck(token, ref, publicUrl);
      const result: PlatformRunResult = {
        conclusion: "action_required",
        title: "Argus needs a project target",
        summary:
          "Commit `.argus/platform.json` with either a static `targetUrl` or a `deployment.environments` preview configuration, then rerun this check.",
        detailsUrl: publicUrl,
      };
      await updateCheck(token, ref, check.id, result);
      return result;
    }

    const targetUrl = options.targetUrl ?? config.targetUrl;
    if (!targetUrl) {
      throw new Error("waiting for a successful preview deployment with an environment URL");
    }
    const idempotencyKey = await runKey(ref, targetUrl);
    if (!(await claimPlatformRun(env, idempotencyKey, options.force))) {
      return {
        conclusion: "success",
        title: "Argus already verified this deployment",
        summary: `A completed Argus run already exists for ${targetUrl}.`,
        detailsUrl: publicUrl,
      };
    }
    claimedKey = idempotencyKey;
    check = await createCheck(token, ref, publicUrl);
    const resolvedConfig: GitHubPlatformConfig = { ...config, targetUrl, deployment: undefined };

    const tenantId = await ensurePlatformTenant(env, ref);
    const project = config.project ?? `${ref.owner}/${ref.repo}`;
    const suites: SuiteResult[] = [];
    if (config.checks.includes("smoke")) {
      suites.push(
        reportResult(
          "Smoke",
          await runSmoke(
            env,
            {
              url: targetUrl,
              project,
              viewports: resolvedConfig.viewports,
              colorSchemes: resolvedConfig.colorSchemes,
            },
            tenantId
          )
        )
      );
    }
    if (config.checks.includes("audit")) {
      suites.push(
        reportResult(
          "Audit",
          await runAudit(
            env,
            {
              url: targetUrl,
              project,
              viewports: resolvedConfig.viewports,
              colorSchemes: resolvedConfig.colorSchemes,
              checks: ["a11y", "perf", "links", "visual"],
              updateBaseline: false,
              authProfile: resolvedConfig.authProfile,
            },
            tenantId
          )
        )
      );
    }
    if (config.checks.includes("flows")) {
      suites.push(
        await runFlowSuite(env, await loadGitHubFlows(token, ref), resolvedConfig, tenantId, project)
      );
    }

    const failed = suites.some((suite) => suite.status === "fail" || suite.status === "error");
    // Prefer the audit report because it contains the richest review evidence
    // (findings plus screenshots), then fall back to smoke or flow output.
    const primaryRun =
      suites.find((suite) => suite.name === "Audit" && suite.runId)?.runId ??
      suites.find((suite) => suite.name === "Smoke" && suite.runId)?.runId ??
      suites.find((suite) => suite.runId)?.runId;
    const detailsUrl =
      primaryRun && env.ARGUS_GITHUB_WEBHOOK_SECRET
        ? await signedEvidenceUrl(
            env.ARGUS_GITHUB_WEBHOOK_SECRET,
            publicUrl,
            tenantId,
            primaryRun
          )
        : publicUrl;
    const result: PlatformRunResult = {
      conclusion: failed ? "failure" : "success",
      title: failed ? "Argus found issues" : "Argus verification passed",
      summary: markdownSummary(targetUrl, suites),
      detailsUrl,
    };
    await updateCheck(token, ref, check.id, result);
    await env.ARTIFACTS.put(
      idempotencyKey,
      JSON.stringify({
        at: new Date().toISOString(),
        targetUrl,
        conclusion: result.conclusion,
        detailsUrl,
      }),
      { httpMetadata: { contentType: "application/json" } }
    );
    await completePlatformRun(env, idempotencyKey, result.conclusion);
    return result;
  } catch (error) {
    const result: PlatformRunResult = {
      conclusion: "failure",
      title: "Argus verification could not complete",
      summary: `The platform run failed safely: ${String(error).slice(0, 1_000)}`,
      detailsUrl: publicUrl,
    };
    if (check) await updateCheck(token, ref, check.id, result).catch(() => undefined);
    if (claimedKey) await completePlatformRun(env, claimedKey, "failure").catch(() => undefined);
    return result;
  }
}

function repositoryRef(payload: Record<string, any>): GitHubRepositoryRef | null {
  const installationId = payload.installation?.id;
  const owner = payload.repository?.owner?.login;
  const repo = payload.repository?.name;
  const sha = payload.pull_request?.head?.sha ?? payload.check_run?.head_sha ?? payload.deployment?.sha;
  const account = payload.installation?.account?.login ?? owner;
  if (!Number.isInteger(installationId) || !owner || !repo || !sha || !account) return null;
  return { installationId, owner, repo, sha, account };
}

export async function handleGitHubEvent(
  env: Env,
  event: string,
  payload: Record<string, any>,
  publicUrl: string
): Promise<void> {
  if (event === "pull_request") {
    if (!HANDLED_PULL_REQUEST_ACTIONS.has(payload.action) || payload.pull_request?.draft === true) return;
    const ref = repositoryRef(payload);
    if (!ref) return;
    const token = await installationToken(env, ref.installationId);
    const config = await loadGitHubPlatformConfig(token, ref);
    // Deployment-driven projects start when their preview provider publishes a
    // successful environment URL. Static targets continue to run immediately.
    if (!config?.deployment) await runGitHubVerification(env, ref, publicUrl);
    return;
  }
  if (event === "deployment_status") {
    const ref = repositoryRef(payload);
    const state = payload.deployment_status?.state;
    const targetUrl = payload.deployment_status?.environment_url;
    const environment = payload.deployment_status?.environment ?? payload.deployment?.environment;
    if (!ref || state !== "success" || typeof targetUrl !== "string") return;
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      return;
    }
    if (parsedUrl.protocol !== "https:") return;
    const token = await installationToken(env, ref.installationId);
    const config = await loadGitHubPlatformConfig(token, ref);
    if (!config?.deployment) return;
    if (
      config.deployment.environments.length > 0 &&
      !config.deployment.environments.includes(String(environment ?? ""))
    ) {
      return;
    }
    await saveDeploymentTarget(env, ref, parsedUrl.toString(), String(environment ?? ""));
    await runGitHubVerification(env, ref, publicUrl, { targetUrl: parsedUrl.toString() });
    return;
  }
  if (
    event === "check_run" &&
    payload.action === "requested_action" &&
    payload.requested_action?.identifier === "rerun"
  ) {
    const ref = repositoryRef(payload);
    if (!ref) return;
    const token = await installationToken(env, ref.installationId);
    const config = await loadGitHubPlatformConfig(token, ref);
    const targetUrl = config?.deployment ? await loadDeploymentTarget(env, ref) : undefined;
    await runGitHubVerification(env, ref, publicUrl, { targetUrl, force: true });
  }
}

/**
 * argus CLI — "just apply it" from any project.
 *
 *   argus test <url>          run the cloud smoke suite against a URL
 *   argus sessions            list active cloud browser sessions
 *   argus config              show resolved config
 *
 * Config resolution: env ARGUS_API / ARGUS_TOKEN, else .argus/config.json
 * (walking up from cwd), else defaults.
 */
import { exitCodeFor, exitCodeForApiStatus } from "./exit";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import process from "node:process";
import readline from "node:readline";
import type { Flow, SmokeReport } from "@argus/shared";
import { buildCfSaasFlows, probeApp, type ProbeResult } from "./preset";
import { wireHarnesses, mcpServerPath, parseInitArgs, splitCredentials, DEFAULT_API } from "./harness";
import { parseTarget, scanLocalPorts } from "./target";
import { runFixLoop, type FixDeps, type FixOutcome, type Suite } from "./fix";
import { patrolTick, type PatrolState } from "./patrol";
import { PERSONAS, extractReport, mergeReports, personaPrompt, renderReport } from "./personas";
import { compareVersions, npmLatest, validateFlowFile } from "./doctor";

// --- tiny ANSI helpers (no deps) -------------------------------------------
const isTTY = process.stdout.isTTY;
const paint = (code: number) => (s: string) => (isTTY ? `[${code}m${s}[0m` : s);
const red = paint(31);
const green = paint(32);
const yellow = paint(33);
const dim = paint(2);
const bold = paint(1);

interface Config {
  api: string;
  token?: string;
}

function loadConfig(): Config {
  let api = process.env.ARGUS_API;
  let token = process.env.ARGUS_TOKEN;
  let dir = process.cwd();
  while (!api) {
    const candidate = join(dir, ".argus", "config.json");
    if (existsSync(candidate)) {
      try {
        const file = JSON.parse(readFileSync(candidate, "utf8"));
        api = api ?? file.api;
        token = token ?? file.token;
      } catch {
        /* unreadable config — keep walking */
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { api: (api ?? DEFAULT_API).replace(/\/$/, ""), token };
}

async function api<T>(cfg: Config, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(cfg.api + path, {
    method,
    headers: {
      "content-type": "application/json",
      ...(cfg.token ? { authorization: `Bearer ${cfg.token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = data as { error?: string; detail?: string; retryable?: boolean; remediation?: string };
    const retry = err.retryable ? " · retryable" : "";
    const fix = err.remediation ? ` · fix: ${err.remediation}` : "";
    throw new ApiCallError(
      `${err.error ?? res.status}${err.detail ? ` — ${err.detail}` : ""}${retry}${fix}`,
      res.status
    );
  }
  return data as T;
}

/** An API refusal. 429/5xx mean Argus could not test (exit 4), not that the app regressed. */
class ApiCallError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function statusBadge(status: string): string {
  switch (status) {
    case "pass":
      return green(bold(" PASS "));
    case "flaky":
      return yellow(bold(" FLAKY "));
    case "untested":
    case "error":
      return yellow(bold(" COULD NOT TEST "));
    default:
      return red(bold(` ${status.toUpperCase()} `));
  }
}

/** "3 new · 1 regression · 2 dismissed" — what triage memory says about this run. */
function triageLine(r: { newFindings?: number; regressions?: number; suppressed?: unknown[] }): string | undefined {
  const parts: string[] = [];
  if (r.newFindings) parts.push(`${r.newFindings} new`);
  if (r.regressions) parts.push(red(`${r.regressions} regression${r.regressions === 1 ? "" : "s"}`));
  if (r.suppressed?.length) parts.push(dim(`${r.suppressed.length} dismissed (suppressed)`));
  return parts.length ? parts.join(" · ") : undefined;
}

function findingTag(f: { triage?: { state: string } }): string {
  if (f.triage?.state === "new") return yellow("[new] ");
  if (f.triage?.state === "regression") return red(bold("[regression] "));
  return "";
}

/** Run attribution — override with ARGUS_ACTOR (e.g. `ci:verify`). */
const actor = (): string => process.env.ARGUS_ACTOR ?? "cli";

function promptLine(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (answer) => {
    rl.close();
    resolve(answer);
  }));
}

/**
 * Token resolution for init/onboard: explicit flag/positional → ARGUS_TOKEN →
 * saved config (re-init friendly) → interactive prompt. Exits with guidance
 * when stdin isn't a TTY and nothing was provided.
 */
async function ensureToken(explicit: string | undefined, cfg: Config): Promise<string> {
  const token = explicit ?? process.env.ARGUS_TOKEN ?? cfg.token;
  if (token) return token;
  if (process.stdin.isTTY) {
    const pasted = (await promptLine("Argus API token (sign up on the dashboard, then paste it here): ")).trim();
    if (pasted) return pasted;
  }
  console.error("no API token — pass --token <t>, set ARGUS_TOKEN, or run interactively and paste it when asked");
  process.exit(2);
}

function printSmokeReport(cfg: Config, report: SmokeReport): void {
  const badge = statusBadge(report.status);
  console.log();
  console.log(`${badge} ${bold(report.url)} ${dim(`(run ${report.runId}, ${(report.durationMs / 1000).toFixed(1)}s)`)}`);
  console.log();
  const c = report.checks;
  const mark = (ok: boolean) => (ok ? green("✔") : red("✘"));
  console.log(`  ${mark(c.loaded)} page loads`);
  console.log(`  ${mark(c.consoleErrors === 0)} console clean ${c.consoleErrors ? red(`(${c.consoleErrors} error(s))`) : ""}`);
  console.log(`  ${mark(c.failedRequests === 0)} network clean ${c.failedRequests ? red(`(${c.failedRequests} failed request(s))`) : ""}`);
  console.log(
    `  ${mark(c.responsiveOverflow.length === 0)} responsive ${
      c.responsiveOverflow.length ? red(`(overflow at ${c.responsiveOverflow.join(", ")})`) : ""
    }`
  );
  console.log();
  const tl = triageLine(report);
  if (tl) console.log(`  triage: ${tl}\n`);
  if (report.findings.length > 0) {
    console.log(bold(`  Findings (${report.findings.length}):`));
    for (const f of report.findings) {
      const sev =
        f.severity === "critical" ? red(bold(f.severity)) : f.severity === "major" ? yellow(f.severity) : dim(f.severity);
      console.log(`  • ${findingTag(f)}[${sev}] ${f.summary}`);
      if (f.decision) console.log(`      ${dim("→ " + f.decision.nextAction)}`);
    }
    console.log();
  }
  console.log(bold("  Screenshots:"));
  for (const s of report.screenshots) {
    console.log(`  • ${s.viewport}/${s.colorScheme}  ${dim(cfg.api + s.url)}`);
  }
  console.log();
}

/**
 * Quick tunnel: expose a local port to the cloud browser via cloudflared's
 * free trycloudflare.com tunnels (no account setup needed). Resolves with the
 * public URL and the child process to kill when done.
 */
async function startTunnel(port: number): Promise<{ url: string; child: ChildProcess }> {
  const child = spawn("cloudflared", ["tunnel", "--url", `http://localhost:${port}`], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("cloudflared did not report a tunnel URL within 30s"));
    }, 30_000);
    const scan = (chunk: Buffer) => {
      const match = chunk.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match) {
        clearTimeout(timer);
        resolve({ url: match[0], child });
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `could not start cloudflared (${err.message}) — install it with: brew install cloudflared`
        )
      );
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cloudflared exited early (code ${code})`));
    });
  });
}

/**
 * Resolve `${VAR}` placeholders (test logins) from the environment, here on
 * the developer's machine — secrets never live in the flow files themselves.
 * A missing variable fails loudly naming what to supply.
 */
function resolveEnvPlaceholders<T>(value: T): T {
  const missing = new Set<string>();
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") {
      return v.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
        const found = process.env[name];
        if (found === undefined) {
          missing.add(name);
          return "";
        }
        return found;
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === "object")
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  const out = walk(value) as T;
  if (missing.size > 0) {
    throw new Error(
      `missing environment values: ${[...missing].join(", ")} — export them (seeded test user) and re-run`
    );
  }
  return out;
}

/** Load + placeholder-resolve every flow file in a directory ([] when absent). */
function loadFlowFiles(flowsPath: string): unknown[] {
  if (!existsSync(flowsPath)) return [];
  return readdirSync(flowsPath)
    .filter((file) => file.endsWith(".json"))
    .map((file) => resolveEnvPlaceholders(JSON.parse(readFileSync(join(flowsPath, file), "utf8"))));
}

/** `${VAR}` names in a value that have no environment value right now. */
function missingEnvVars(value: unknown): string[] {
  const missing = new Set<string>();
  const walk = (v: unknown): void => {
    if (typeof v === "string") {
      for (const m of v.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) {
        if (process.env[m[1]!] === undefined) missing.add(m[1]!);
      }
    } else if (Array.isArray(v)) {
      v.forEach(walk);
    } else if (v && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(value);
  return [...missing];
}

/**
 * Lenient flow loading for auto-generated suites: run what resolves now, skip
 * files whose test-user env is missing (reported, never a crash).
 */
function loadFlowFilesLenient(dir: string): { flows: unknown[]; skipped: Array<{ file: string; vars: string[] }> } {
  if (!existsSync(dir)) return { flows: [], skipped: [] };
  const flows: unknown[] = [];
  const skipped: Array<{ file: string; vars: string[] }> = [];
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const raw = JSON.parse(readFileSync(join(dir, file), "utf8"));
    const vars = missingEnvVars(raw);
    if (vars.length) skipped.push({ file, vars });
    else flows.push(resolveEnvPlaceholders(raw));
  }
  return { flows, skipped };
}

interface PresetGen {
  flows: Flow[];
  skipped: string[];
  probe: ProbeResult;
}

/**
 * Probe the app in a real cloud browser and write the baseline flow suite to
 * .argus/flows/. Shared by `preset` (explicit) and the auto-generate paths
 * (`verify`/`onboard` on projects with no saved flows yet).
 */
async function generatePresetSuite(
  cfg: Config,
  url: string,
  opts: { authProfile: string; emailVar: string; passwordVar: string },
  log: (msg: string) => void = console.log
): Promise<PresetGen> {
  log(dim(`probing ${url} in a real browser (SPA-safe) ...`));
  const root = url.replace(/\/$/, "");
  const lease = await api<{ sessionId: string }>(cfg, "POST", "/v1/lease", {
    url: root + "/",
    label: "preset-probe",
    ttlSeconds: 300,
  });
  const sid = lease.sessionId;
  let probe: ProbeResult;
  try {
    probe = await probeApp(url, async (path: string) => {
      await api(cfg, "POST", `/v1/session/${sid}/act`, {
        action: "goto",
        url: root + path,
      });
      await api(cfg, "POST", `/v1/session/${sid}/act`, { action: "wait", ms: 900 });
      const q = await api<{
        elements: Array<{ text?: string; name?: string }>;
        pageUrl: string;
        pageTitle: string;
      }>(cfg, "POST", `/v1/session/${sid}/query`, { interactive: true, limit: 25 });
      return {
        url: q.pageUrl,
        title: q.pageTitle,
        texts: q.elements.map((e) => (e.text ?? e.name ?? "").trim()).filter(Boolean),
      };
    });
  } finally {
    await api(cfg, "DELETE", `/v1/session/${sid}`).catch(() => {});
  }

  log(`  signin: ${probe.signin ?? dim("not found")}   signup: ${probe.signup ?? dim("not found")}`);
  log(`  protected: ${probe.protectedPath ?? dim("not found")}   api health: ${probe.apiHealth ?? dim("not found")}`);
  if (probe.notFoundMarker) log(`  not-found fingerprint: ${dim(`"${probe.notFoundMarker}"`)}`);

  const { flows, skipped } = buildCfSaasFlows({
    base: url,
    probe,
    authProfile: opts.authProfile,
    emailVar: opts.emailVar,
    passwordVar: opts.passwordVar,
  });
  const dir = join(process.cwd(), ".argus", "flows");
  mkdirSync(dir, { recursive: true });
  for (const flow of flows) {
    writeFileSync(join(dir, `${flow.name}.json`), JSON.stringify(flow, null, 2) + "\n");
  }
  return { flows, skipped, probe };
}

interface LiveCheck {
  name: string;
  status: string;
  detail: string;
  runId?: string;
  /** Full API payload — `--json` re-emits it for machine consumers. */
  report?: unknown;
}

/** Smoke + audit + flows against one URL — the live core of verify + doctor. */
async function runLiveChecks(
  cfg: Config,
  url: string,
  flows: unknown[],
  project: string
): Promise<LiveCheck[]> {
  const [smoke, audit, suite] = await Promise.all([
    api<{ status: string; findings: unknown[]; runId: string }>(cfg, "POST", "/v1/smoke", {
      url,
      project,
    }),
    api<{ status: string; findings: unknown[]; runId: string }>(cfg, "POST", "/v1/audit", {
      url,
      project,
    }),
    flows.length
      ? api<{ status: string; passed: number; failed: number; flaky?: number; untested?: number; runId: string }>(
          cfg,
          "POST",
          "/v1/flows/verify",
          { flows, baseUrl: url, project, concurrency: 4, actor: actor() }
        )
      : Promise.resolve(undefined),
  ]);
  return [
    { name: "smoke", status: smoke.status, detail: `${smoke.findings.length} finding(s)`, runId: smoke.runId, report: smoke },
    { name: "audit", status: audit.status, detail: `${audit.findings.length} finding(s)`, runId: audit.runId, report: audit },
    ...(suite
      ? [
          {
            name: "flows",
            status: suite.status,
            detail: [
              `${suite.passed} passed`,
              `${suite.failed} failed`,
              ...(suite.flaky ? [`${suite.flaky} flaky`] : []),
              ...(suite.untested ? [`${suite.untested} untested`] : []),
            ].join(", "),
            runId: suite.runId,
            report: suite,
          },
        ]
      : [{ name: "flows", status: "skipped", detail: "no .argus/flows (or --no-flows)" }]),
  ];
}

type Tunnel = { url: string; child: ChildProcess };

/** Run a shell command with optional stdin; never throws (spawn errors become exit 1). */
function runShell(
  cmd: string,
  o: { cwd: string; input?: string; timeoutMs?: number }
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: o.cwd, shell: true, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    child.stdout?.on("data", (d) => (out += d));
    child.stderr?.on("data", (d) => (out += d));
    const timer = o.timeoutMs ? setTimeout(() => child.kill("SIGTERM"), o.timeoutMs) : undefined;
    child.on("error", (e) => resolve({ code: 1, out: String(e) }));
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? 1, out });
    });
    child.stdin?.end(o.input ?? "");
  });
}

/** The fix loop's real dependencies: the suite in the cloud, a shell, and gh for human decisions. */
function fixDeps(cfg: Config, flows: unknown[]): FixDeps {
  return {
    verify: (baseUrl) =>
      api<Suite>(cfg, "POST", "/v1/flows/verify", {
        flows,
        baseUrl,
        project: basename(process.cwd()),
        concurrency: 4,
        actor: actor(),
      }),
    sh: runShell,
    log: console.log,
    declined: async (flow) => {
      const r = spawnSync(
        "gh",
        ["pr", "list", "--state", "closed", "--search", `"fix: ${flow} (argus)" in:title`, "--json", "mergedAt"],
        { encoding: "utf8" }
      );
      if (r.status !== 0) return false; // no gh / no remote: nothing a person has declined
      try {
        return (JSON.parse(r.stdout) as Array<{ mergedAt: string | null }>).some((p) => !p.mergedAt);
      } catch {
        return false;
      }
    },
  };
}

function printFixOutcomes(outcomes: FixOutcome[]): void {
  for (const o of outcomes) {
    const mark = o.result === "pr" || o.result === "verified" ? green("✔") : o.result === "unverified" ? yellow("●") : red("✘");
    const tail = o.result === "pr" ? o.url : "why" in o ? o.why : `proven — push ${o.branch} and open a PR (or re-run with --pr)`;
    console.log(`  ${mark} ${o.flow}: ${o.result} ${dim(`(${o.branch})`)} ${tail}`);
  }
}

/** Shared by fix and patrol: flag parsing, flows, repo root. Exits 2 on a usage problem. */
function fixSetup(args: string[], cmd: string) {
  const valued = new Set(["--agent", "--preview", "--max", "--every", "--branch"]);
  const flag = (name: string) => {
    const i = args.indexOf(name);
    return i === -1 ? undefined : args[i + 1];
  };
  const raw = args.find((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
  const flows = loadFlowFiles(join(process.cwd(), ".argus", "flows"));
  if (flows.length === 0) {
    console.error(`argus ${cmd} works from saved flows — run \`argus verify\` first to build a suite`);
    process.exit(2);
  }
  const top = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (top.status !== 0) {
    console.error(`argus ${cmd} needs a git repository (each fix gets its own worktree and branch)`);
    process.exit(2);
  }
  return {
    raw,
    flows,
    flag,
    repo: top.stdout.trim(),
    agent: flag("--agent") ?? "claude -p --permission-mode acceptEdits",
    preview: flag("--preview"),
    openPr: args.includes("--pr"),
    max: Number(flag("--max") ?? 3),
  };
}

/** Open a tunnel and wait until the edge actually serves it. */
async function openTunnel(port: number, log: (msg: string) => void = console.log): Promise<Tunnel> {
  log(dim(`starting tunnel to localhost:${port} ...`));
  const tunnel = await startTunnel(port);
  log(dim(`tunnel up: ${tunnel.url}`));
  // A fresh trycloudflare hostname takes a few seconds to propagate at the
  // edge — poll until it actually serves before testing it.
  let reachable = false;
  for (let i = 0; i < 15; i++) {
    try {
      const res = await fetch(tunnel.url, { redirect: "manual" });
      if (res.status < 500 && res.status !== 404) {
        reachable = true;
        break;
      }
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  if (!reachable) log(dim("warning: tunnel still not answering after 30s — testing anyway"));
  return tunnel;
}

/**
 * Resolve a testing command's target: an explicit URL as-is, a bare port via
 * a tunnel, nothing via localhost auto-detect (a lone hit wins; zero or
 * several is a usage error naming the options). Returns an open tunnel the
 * caller must kill BEFORE process.exit (finally does not run on exit).
 */
async function resolveTarget(
  raw: string | undefined,
  cmd: string,
  log: (msg: string) => void = console.log
): Promise<{ url: string; tunnel?: Tunnel }> {
  const parsed = parseTarget(raw);
  if (parsed.kind === "url") return { url: parsed.url };
  if (parsed.kind === "port") {
    const tunnel = await openTunnel(parsed.port, log);
    return { url: tunnel.url, tunnel };
  }
  log(dim("no target given — looking for a local app ..."));
  const hits = await scanLocalPorts();
  if (hits.length === 1) {
    log(dim(`found localhost:${hits[0]} — tunnelling ...`));
    const tunnel = await openTunnel(hits[0]!, log);
    return { url: tunnel.url, tunnel };
  }
  if (hits.length === 0) {
    console.error(
      `point me at the app: argus ${cmd} <url>  |  argus ${cmd} <port>  |  start your dev server, then re-run`
    );
  } else {
    console.error(
      `several local apps answer (${hits.map((p) => `localhost:${p}`).join(", ")}) — pick one: argus ${cmd} <port>`
    );
  }
  process.exit(2);
}

/**
 * One-command onboarding for the testing commands: when no token resolves
 * anywhere, take one inline (prompt on TTY, guidance otherwise) and persist
 * it, so `argus verify <url>` works from absolute nothing.
 */
async function ensureConfigured(cfg: Config): Promise<Config> {
  if (cfg.token) return cfg;
  const token = await ensureToken(undefined, cfg);
  const out = { api: cfg.api, token };
  mkdirSync(join(process.cwd(), ".argus"), { recursive: true });
  writeFileSync(join(process.cwd(), ".argus", "config.json"), JSON.stringify(out, null, 2) + "\n");
  console.log(`${green("✔")} credentials saved to .argus/config.json`);
  return out;
}

/** Smoke + audit + flows against one URL. Returns the process exit code. */
async function runVerifyCommand(
  cfg: Config,
  url: string,
  opts: { json: boolean; noFlows: boolean; strict?: boolean }
): Promise<number> {
  const { json, noFlows } = opts;
  const project = basename(process.cwd());
  const flowsDir = join(process.cwd(), ".argus", "flows");
  let flows: unknown[] = [];
  if (!noFlows) {
    flows = loadFlowFiles(flowsDir);
    if (flows.length === 0) {
      // Dead-easy path: no suite yet → probe the app, save a baseline
      // suite, and verify it in the same run. Flows needing test-user
      // env are skipped with a hint, never a crash.
      const log = json ? console.error : console.log;
      log(dim(`no saved flows — generating a baseline suite for ${url} ...`));
      const gen = await generatePresetSuite(
        cfg,
        url,
        { authProfile: "default", emailVar: "ARGUS_TEST_EMAIL", passwordVar: "ARGUS_TEST_PASSWORD" },
        log
      );
      const lenient = loadFlowFilesLenient(flowsDir);
      flows = lenient.flows;
      log(`${green("✔")} wrote ${gen.flows.length} flows to .argus/flows/`);
      if (lenient.skipped.length) {
        const vars = [...new Set(lenient.skipped.flatMap((s) => s.vars))];
        log(
          yellow(
            `  ${lenient.skipped.length} flow(s) need ${vars.join(", ")} — export them and re-run for the full suite`
          )
        );
      }
    }
  }
  if (!json) {
    console.log(
      dim(
        `argus → ${cfg.api} · full verification of ${url} ` +
          `(smoke + audit${flows.length ? ` + ${flows.length} flows` : ""}) ...`
      )
    );
  }
  const checks = await runLiveChecks(cfg, url, flows, project);
  const code = exitCodeFor(
    checks.map((c) => c.status),
    opts.strict
  );
  const overall = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "error" || c.status === "untested")
      ? "untested"
      : checks.some((c) => c.status === "flaky")
        ? "flaky"
        : "pass";
  if (json) {
    // Machine-readable full report: every check's run id + full payload,
    // plus the executable recovery actions the failures carry.
    const suite = checks.find((c) => c.name === "flows")?.report as
      | { results?: Array<{ flow: string; decision?: { verdict?: string; action?: unknown } }> }
      | undefined;
    const actions: Array<{ flow: string; verdict: string; action: unknown }> = [];
    for (const r of suite?.results ?? []) {
      if (r.decision?.action) {
        actions.push({ flow: r.flow, verdict: r.decision.verdict ?? "error", action: r.decision.action });
      }
    }
    console.log(JSON.stringify({ url, project, status: overall, exitCode: code, checks, actions }, null, 2));
    return code;
  }
  console.log(`\n${statusBadge(overall)} ${bold("verify")} ${bold(url)}\n`);
  for (const check of checks) {
    const mark =
      check.status === "pass"
        ? green("✔")
        : check.status === "skipped" || check.status === "flaky"
          ? yellow("●")
          : check.status === "error" || check.status === "untested"
            ? yellow("?")
            : red("✘");
    console.log(`  ${mark} ${check.name}: ${check.status} ${dim(`(${check.detail})`)}`);
  }
  if (overall === "flaky") {
    console.log(
      yellow(
        `\n  ! some flows failed once and passed (or failed differently) on the re-run — an intermittent bug or a timing race.` +
          `\n    They don't fail this run${opts.strict ? " (but --strict does)" : " (use --strict to make them)"}; look at the confirmation detail.`
      )
    );
  }
  if (overall === "untested") console.log(yellow(`\n  ! Argus could not test everything — exit 4 means "not tested", not "regressed".`));
  console.log();
  return code;
}

/**
 * Guided first run: credentials → harness wiring → target → full verify.
 * Exactly one paste (the token) and one answer (the URL, blank to detect).
 */
async function quickstart(startCfg: Config): Promise<void> {
  console.log(`${bold("argus")} — from zero to a verdict in about a minute\n`);
  const cfg = await ensureConfigured(startCfg);
  mkdirSync(join(process.cwd(), ".argus", "flows"), { recursive: true });
  const wired = wireHarnesses(process.cwd(), { command: "node", args: [mcpServerPath()] }, {});
  console.log(`${green("✔")} project wired (${wired.written.length} new, ${wired.unchanged.length} already set)`);
  for (const note of wired.notes) console.log(`\n${yellow("!")} ${note}`);
  const answer = (await promptLine("App URL to verify (blank = detect local dev server): ")).trim();
  const { url, tunnel } = await resolveTarget(answer || undefined, "verify");
  try {
    const code = await runVerifyCommand(cfg, url, { json: false, noFlows: false });
    tunnel?.child.kill();
    process.exit(code);
  } finally {
    tunnel?.child.kill();
  }
}

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const cfg = loadConfig();

  // Bare `argus` on a TTY is the guided quickstart. Piped/non-TTY keeps
  // printing help so scripts never hang on a prompt.
  if (!command && process.stdin.isTTY) {
    await quickstart(cfg);
    return;
  }

  switch (command) {
    case "verify": {
      const json = args.includes("--json");
      const raw = args.find((a) => !a.startsWith("-"));
      const live = await ensureConfigured(cfg);
      const log = json ? console.error : console.log;
      const { url, tunnel } = await resolveTarget(raw, "verify", log);
      try {
        const code = await runVerifyCommand(live, url, {
          json,
          noFlows: args.includes("--no-flows"),
          strict: args.includes("--strict"),
        });
        tunnel?.child.kill();
        process.exit(code);
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "doctor": {
      // argus doctor [--target <url> | --local <port>] [--offline]
      // One command that checks every possibility: config, API health, auth,
      // fleet headroom, recent run history, flow files, the app itself, repo
      // gates, and Cloudflare dependency drift. Exit 1 on any failure.
      const offline = args.includes("--offline");
      const targetFlag = args.indexOf("--target");
      const localFlag = args.indexOf("--local");
      const target = targetFlag === -1 ? undefined : args[targetFlag + 1];
      const localPort = localFlag === -1 ? undefined : Number(args[localFlag + 1]);
      if (
        (targetFlag !== -1 && (!target || target.startsWith("-"))) ||
        (localFlag !== -1 && !Number.isInteger(localPort)) ||
        (target && localFlag !== -1)
      ) {
        console.error("usage: argus doctor [--target <url> | --local <port>] [--offline]");
        process.exit(2);
      }
      if (offline && (target || localFlag !== -1)) {
        console.error("argus doctor: --offline cannot verify a live target");
        process.exit(2);
      }
      type Row = { name: string; state: "pass" | "warn" | "fail" | "skip"; detail: string };
      const rows: Row[] = [];
      const mark = (s: Row["state"]): string =>
        s === "pass" ? green("✔") : s === "fail" ? red("✘") : s === "warn" ? yellow("●") : dim("○");
      const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e)).slice(0, 160);

      console.log(bold("argus doctor") + dim(`  ${cfg.api}${offline ? " · offline" : ""}`));

      // 1. config — the token itself is never printed
      rows.push(
        cfg.token
          ? { name: "config", state: "pass", detail: `api ${cfg.api} · token •••set•••` }
          : { name: "config", state: "fail", detail: "no token — set ARGUS_TOKEN or .argus/config.json" }
      );

      // 2-5. live API checks (no browsers consumed)
      if (offline) {
        for (const name of ["api health", "auth", "fleet", "recent runs"]) {
          rows.push({ name, state: "skip", detail: "offline" });
        }
      } else {
        try {
          const health = await api<{ ok: boolean; service: string }>(cfg, "GET", "/health");
          rows.push({
            name: "api health",
            state: health.ok ? "pass" : "fail",
            detail: health.service || "answered",
          });
        } catch (e) {
          rows.push({ name: "api health", state: "fail", detail: errText(e) });
        }
        try {
          const sessions = await api<{ sessions: unknown[] }>(cfg, "GET", "/v1/sessions");
          rows.push({
            name: "auth",
            state: "pass",
            detail: `token accepted · ${sessions.sessions.length} active session(s)`,
          });
        } catch (e) {
          rows.push({ name: "auth", state: "fail", detail: errText(e) });
        }
        try {
          const fleet = await api<{ active: number; cap: number; warm: number; warmCap: number }>(
            cfg,
            "GET",
            "/v1/capacity"
          );
          rows.push(
            fleet.active >= fleet.cap
              ? { name: "fleet", state: "warn", detail: `saturated ${fleet.active}/${fleet.cap}` }
              : {
                  name: "fleet",
                  state: "pass",
                  detail: `${fleet.active}/${fleet.cap} browsers · warm ${fleet.warm}/${fleet.warmCap}`,
                }
          );
        } catch (e) {
          rows.push({ name: "fleet", state: "fail", detail: errText(e) });
        }
        try {
          const runs = await api<{ runs: Array<{ runId: string; kind: string; status: string }> }>(
            cfg,
            "GET",
            "/v1/runs"
          );
          const recent = runs.runs.slice(0, 5);
          const bad = recent.filter((r) => r.status === "fail" || r.status === "error");
          rows.push(
            recent.length === 0
              ? { name: "recent runs", state: "warn", detail: "no runs recorded yet" }
              : bad.length > 0
                ? {
                    name: "recent runs",
                    state: "fail",
                    detail: bad.map((r) => `${r.runId} ${r.kind} ${r.status.toUpperCase()}`).join(", "),
                  }
                : { name: "recent runs", state: "pass", detail: `last ${recent.length} all pass` }
          );
        } catch (e) {
          rows.push({ name: "recent runs", state: "fail", detail: errText(e) });
        }
      }

      // 6. flow files, statically (safe offline)
      const flowsPath = join(process.cwd(), ".argus", "flows");
      if (!existsSync(flowsPath)) {
        rows.push({ name: "flows", state: "skip", detail: "no .argus/flows" });
      } else {
        const files = readdirSync(flowsPath).filter((file) => file.endsWith(".json"));
        const problems: string[] = [];
        for (const file of files) {
          try {
            const raw: unknown = JSON.parse(readFileSync(join(flowsPath, file), "utf8"));
            for (const issue of validateFlowFile(file, raw)) {
              problems.push(`${issue.file}: ${issue.issue}`);
            }
          } catch {
            problems.push(`${file}: invalid JSON`);
          }
        }
        rows.push(
          problems.length > 0
            ? { name: "flows", state: "fail", detail: problems.slice(0, 3).join("; ") }
            : { name: "flows", state: "pass", detail: `${files.length} valid` }
        );
      }

      // 7. the app itself, live through the cloud browsers
      let tunnel: { url: string; child: ChildProcess } | undefined;
      try {
        if (!target && localFlag === -1) {
          rows.push({ name: "app", state: "skip", detail: "pass --target <url> or --local <port>" });
        } else {
          let url = target as string;
          if (localFlag !== -1) {
            console.log(dim(`starting tunnel to localhost:${localPort} ...`));
            tunnel = await startTunnel(localPort as number);
            console.log(dim(`tunnel up: ${tunnel.url}`));
            url = tunnel.url;
          }
          const flows = loadFlowFiles(flowsPath);
          const checks = await runLiveChecks(cfg, url, flows, basename(process.cwd()));
          for (const check of checks) {
            rows.push({
              name: `app ${check.name}`,
              state:
                check.status === "pass"
                  ? "pass"
                  : check.status === "skipped"
                    ? "skip"
                    : check.status === "flaky" || check.status === "untested" || check.status === "error"
                      ? "warn"
                      : "fail",
              detail: `${url} (${check.detail})`,
            });
          }
        }
      } finally {
        tunnel?.child.kill();
      }

      // 8-9. repo-only checks (local gates + Cloudflare drift)
      const isRepo =
        existsSync(join(process.cwd(), "pnpm-workspace.yaml")) &&
        (() => {
          try {
            return (
              (JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { name?: string })
                .name === "argus"
            );
          } catch {
            return false;
          }
        })();
      const cloudPkgPath = join(process.cwd(), "packages", "cloud", "package.json");
      if (!isRepo) {
        rows.push({ name: "repo gates", state: "skip", detail: "not the argus monorepo" });
        rows.push({ name: "cf versions", state: "skip", detail: "not the argus monorepo" });
      } else if (offline) {
        rows.push({ name: "repo gates", state: "skip", detail: "offline" });
        rows.push({ name: "cf versions", state: "skip", detail: "offline" });
      } else {
        const gates = spawnSync("pnpm", ["check"], { encoding: "utf8", timeout: 300_000 });
        rows.push(
          gates.status === 0
            ? { name: "repo gates", state: "pass", detail: "pnpm check (typecheck + test + build)" }
            : {
                name: "repo gates",
                state: "fail",
                detail: `pnpm check exited ${gates.status ?? "timeout"} — run it for details`,
              }
        );
        try {
          const cloudPkg = JSON.parse(readFileSync(cloudPkgPath, "utf8")) as {
            dependencies?: Record<string, string>;
            devDependencies?: Record<string, string>;
          };
          const pins = [
            ["wrangler", cloudPkg.devDependencies?.["wrangler"]],
            ["@cloudflare/workers-types", cloudPkg.devDependencies?.["@cloudflare/workers-types"]],
            ["@cloudflare/playwright", cloudPkg.dependencies?.["@cloudflare/playwright"]],
          ].filter((entry): entry is [string, string] => typeof entry[1] === "string");
          const drift = (
            await Promise.all(
              pins.map(async ([name, pinned]) => ({ name, pinned, latest: await npmLatest(name) }))
            )
          ).filter((r) => r.latest !== undefined && compareVersions(r.pinned, r.latest) === "behind");
          rows.push(
            drift.length > 0
              ? {
                  name: "cf versions",
                  state: "warn",
                  detail: drift.map((d) => `${d.name} ${d.pinned} → ${d.latest}`).join(", "),
                }
              : { name: "cf versions", state: "pass", detail: "wrangler, workers-types, playwright current" }
          );
        } catch {
          rows.push({ name: "cf versions", state: "skip", detail: "could not read cloud package.json" });
        }
      }

      for (const row of rows) {
        console.log(`  ${mark(row.state)} ${row.name}: ${row.detail}`);
      }
      const fails = rows.filter((row) => row.state === "fail").length;
      console.log(
        `\n${fails ? red(bold(" DOCTOR FAIL ")) : green(bold(" DOCTOR PASS "))} ${
          fails ? `${fails} check(s) failing` : "everything checks out"
        }\n`
      );
      process.exit(fails ? 1 : 0);
      break;
    }
    case "test": {
      const live = await ensureConfigured(cfg);
      const localFlag = args.indexOf("--local");
      const portArg = localFlag === -1 ? undefined : args[localFlag + 1];
      if (localFlag !== -1 && !Number.isInteger(Number(portArg))) {
        console.error("usage: argus test --local <port>");
        process.exit(2);
      }
      const raw = localFlag !== -1 ? portArg : args.find((a) => !a.startsWith("-"));
      const { url, tunnel } = await resolveTarget(raw, "test");
      console.log(dim(`argus → ${live.api} · testing ${url} ...`));
      try {
        const report = await api<SmokeReport>(live, "POST", "/v1/smoke", {
          url,
          project: basename(process.cwd()),
        });
        printSmokeReport(live, report);
        tunnel?.child.kill();
        process.exit(exitCodeFor([report.status]));
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "audit": {
      const live = await ensureConfigured(cfg);
      const localFlag = args.indexOf("--local");
      const portArg = localFlag === -1 ? undefined : args[localFlag + 1];
      if (localFlag !== -1 && !Number.isInteger(Number(portArg))) {
        console.error("usage: argus audit --local <port>");
        process.exit(2);
      }
      const raw = localFlag !== -1 ? portArg : args.find((a) => !a.startsWith("-"));
      const { url, tunnel } = await resolveTarget(raw, "audit");
      const update = args.includes("--update-baseline");
      console.log(dim(`argus → ${live.api} · auditing ${url} ...`));
      try {
        const r = await api<{
          status: string;
          durationMs: number;
          perf: Array<{ viewport: string; fcpMs?: number; lcpMs?: number; cls?: number; loadMs?: number }>;
          visual: Array<{ viewport: string; colorScheme: string; status: string; diffRatio?: number; maskedPct?: number }>;
          newFindings?: number;
          regressions?: number;
          suppressed?: unknown[];
          a11yViolations: number;
          linksChecked: number;
          brokenLinks: number;
          findings: Array<{ severity: string; summary: string; decision?: { nextAction: string }; triage?: { state: string } }>;
          screenshots: Array<{ viewport: string; colorScheme: string; url: string }>;
        }>(live, "POST", "/v1/audit", {
          url,
          updateBaseline: update,
          project: basename(process.cwd()),
        });
        console.log(`\n${statusBadge(r.status)} ${bold(url)} ${dim(`(${(r.durationMs / 1000).toFixed(1)}s)`)}\n`);
        for (const p of r.perf) {
          console.log(
            `  perf ${p.viewport}: FCP ${p.fcpMs ?? "?"}ms · LCP ${p.lcpMs ?? "?"}ms · CLS ${p.cls ?? "?"} · load ${p.loadMs ?? "?"}ms`
          );
        }
        for (const v of r.visual) {
          const mark =
            v.status === "match" ? green("✔") : v.status === "baseline-created" || v.status === "unstable" ? yellow("●") : red("✘");
          console.log(
            `  visual ${v.viewport}/${v.colorScheme}: ${mark} ${v.status}${v.diffRatio ? ` (${(v.diffRatio * 100).toFixed(1)}%)` : ""}${
              v.maskedPct ? dim(` · ${(v.maskedPct * 100).toFixed(0)}% masked`) : ""
            }`
          );
        }
        console.log(`  a11y violations: ${r.a11yViolations === 0 ? green("0") : red(String(r.a11yViolations))}`);
        console.log(`  links: ${r.linksChecked} checked, ${r.brokenLinks === 0 ? green("0 broken") : red(`${r.brokenLinks} broken`)}\n`);
        const tl = triageLine(r);
        if (tl) console.log(`  triage: ${tl}\n`);
        if (r.findings.length) {
          console.log(bold(`  Findings (${r.findings.length}):`));
          for (const f of r.findings.slice(0, 15)) {
            const sev = f.severity === "critical" ? red(bold(f.severity)) : f.severity === "major" ? yellow(f.severity) : dim(f.severity);
            console.log(`  • ${findingTag(f)}[${sev}] ${f.summary}`);
            if (f.decision) console.log(`      ${dim("→ " + f.decision.nextAction)}`);
          }
          if (r.findings.length > 15) console.log(dim(`  … and ${r.findings.length - 15} more`));
          console.log();
        }
        tunnel?.child.kill();
        process.exit(exitCodeFor([r.status]));
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "crawl": {
      // argus crawl [url|port] [--max N] [--concurrency N] [--mobile] [--include /path]
      const live = await ensureConfigured(cfg);
      const flag = (name: string) => {
        const i = args.indexOf(name);
        return i === -1 ? undefined : args[i + 1];
      };
      const valued = new Set(["--max", "--concurrency", "--include"]);
      const raw = args.find((a, i) => !a.startsWith("-") && !valued.has(args[i - 1] ?? ""));
      const { url, tunnel } = await resolveTarget(raw, "crawl");
      const max = flag("--max");
      const conc = flag("--concurrency");
      console.log(dim(`argus → ${live.api} · crawling ${url} in parallel cloud browsers ...`));
      try {
        const r = await api<{
          status: string;
          durationMs: number;
          truncated: boolean;
          pages: Array<{ url: string; title?: string; notFound: boolean; findings: number; loadMs?: number; error?: string; skipped?: string }>;
          findings: Array<{ severity: string; summary: string; decision?: { nextAction: string }; triage?: { state: string } }>;
          newFindings?: number;
          regressions?: number;
          suppressed?: unknown[];
        }>(live, "POST", "/v1/crawl", {
          url,
          project: basename(process.cwd()),
          ...(max ? { maxPages: Number(max) } : {}),
          ...(conc ? { concurrency: Number(conc) } : {}),
          ...(args.includes("--mobile") ? { viewport: "mobile" } : {}),
          ...(flag("--include") ? { include: flag("--include") } : {}),
        });
        console.log(
          `\n${statusBadge(r.status)} ${bold(url)} ${dim(`(${r.pages.length} page(s)${r.truncated ? ", more found — raise --max" : ""}, ${(r.durationMs / 1000).toFixed(1)}s)`)}\n`
        );
        for (const p of r.pages) {
          const mark = p.error ? red("✘") : p.skipped ? dim("–") : p.notFound ? red("404") : p.findings ? yellow("●") : green("✔");
          const u = new URL(p.url);
          const path = (u.pathname + u.search).slice(0, 48);
          const note = p.error ? p.error.slice(0, 60) : p.skipped ? `skipped: ${p.skipped}` : `${p.findings} finding(s) · ${p.loadMs ?? "?"}ms`;
          console.log(`  ${mark} ${path.padEnd(48)} ${dim(note)}`);
        }
        const tl = triageLine(r);
        if (tl) console.log(`\n  triage: ${tl}`);
        if (r.findings.length) {
          console.log(bold(`\n  Findings (${r.findings.length}):`));
          for (const f of r.findings.slice(0, 20)) {
            const sev = f.severity === "critical" ? red(bold(f.severity)) : f.severity === "major" ? yellow(f.severity) : dim(f.severity);
            console.log(`  • ${findingTag(f)}[${sev}] ${f.summary}`);
            if (f.decision) console.log(`      ${dim("→ " + f.decision.nextAction)}`);
          }
          if (r.findings.length > 20) console.log(dim(`  … and ${r.findings.length - 20} more`));
        }
        console.log();
        tunnel?.child.kill();
        process.exit(exitCodeFor([r.status]));
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "tunnel": {
      const port = Number(args[0]);
      if (!Number.isInteger(port)) {
        console.error("usage: argus tunnel <port>");
        process.exit(2);
      }
      const tunnel = await startTunnel(port);
      console.log(`${bold(tunnel.url)}  ${dim(`→ localhost:${port} (ctrl-c to stop)`)}`);
      await new Promise(() => {}); // hold until interrupted
      break;
    }
    case "init": {
      // argus init [api-url] [token] [--api U] [--token T] [--harness ...] [--write-global]
      // Bare `argus init` just works: hosted API default, token from env/config/prompt.
      const parsed = parseInitArgs(args);
      if (!parsed.ok) {
        console.error(parsed.error);
        process.exit(2);
      }
      const { apiUrl, token: explicitToken, harnesses: harnessSel, writeGlobal } = parsed.args;
      const token = await ensureToken(explicitToken, cfg);
      mkdirSync(join(process.cwd(), ".argus", "flows"), { recursive: true });
      writeFileSync(
        join(process.cwd(), ".argus", "config.json"),
        JSON.stringify({ api: apiUrl.replace(/\/$/, ""), token }, null, 2) + "\n"
      );
      console.log(`${green("✔")} .argus/config.json written`);
      console.log(`${green("✔")} .argus/flows/ ready (commit this directory)`);

      // Register the MCP server (and standing instructions) in each harness.
      // Defaults to Claude Code + AGENTS.md, plus Cursor/VS Code when detected;
      // --harness all adds the global Codex config snippet.
      const result = wireHarnesses(
        process.cwd(),
        { command: "node", args: [mcpServerPath()] },
        { harnesses: harnessSel, writeGlobal }
      );
      const rel = (p: string) => relative(process.cwd(), p) || p;
      for (const file of result.written) console.log(`${green("✔")} ${rel(file)}`);
      for (const label of result.unchanged) console.log(`${dim("•")} ${label} already wired`);
      for (const note of result.notes) console.log(`\n${yellow("!")} ${note}`);
      if (result.harnesses.length) {
        console.log(dim(`harnesses: ${result.harnesses.join(", ")}`));
      }

      console.log(`\ntry:  ${bold("argus verify <your-app-url>")}   or   ${bold("argus test --local <port>")}`);
      break;
    }
    case "onboard": {
      // argus onboard [--url U | --local PORT] [--api A] [--token T] [--harness all]
      // One command from nothing to a verdict: write config, wire every harness,
      // tunnel a local app if needed, generate a baseline suite when none exists,
      // run smoke + every flow, and report.
      const take = (flag: string): string | undefined => {
        const i = args.indexOf(flag);
        if (i === -1) return undefined;
        const v = args[i + 1];
        return v && !v.startsWith("-") ? v : undefined;
      };
      const skip = new Set<number>();
      for (const flag of ["--harness", "--url", "--local", "--api", "--token"]) {
        const i = args.indexOf(flag);
        if (i !== -1) {
          skip.add(i);
          skip.add(i + 1);
        }
      }
      const positional = args.filter((a, i) => !a.startsWith("-") && !skip.has(i));
      const creds = splitCredentials(positional, { api: take("--api"), token: take("--token") });
      if (!creds.ok) {
        console.error(
          "usage: argus onboard [--url <app-url> | --local <port>] [--api <url>] [--token <token>] [--harness all]"
        );
        process.exit(2);
      }
      const token = await ensureToken(creds.token, cfg);
      const oc = { api: creds.apiUrl.replace(/\/$/, ""), token };
      const harnessFlag = take("--harness");
      const urlFlag = take("--url");
      const localFlag = take("--local");

      mkdirSync(join(process.cwd(), ".argus", "flows"), { recursive: true });
      writeFileSync(
        join(process.cwd(), ".argus", "config.json"),
        JSON.stringify(oc, null, 2) + "\n"
      );
      const wired = wireHarnesses(
        process.cwd(),
        { command: "node", args: [mcpServerPath()] },
        { harnesses: harnessFlag }
      );
      console.log(
        `${green("✔")} wired ${wired.written.length} file(s)` +
          (wired.unchanged.length ? dim(` · ${wired.unchanged.length} already set`) : "")
      );

      let target = urlFlag;
      let tunnel: { url: string; child: ChildProcess } | undefined;
      if (!target && localFlag !== undefined) {
        const port = Number(localFlag);
        if (!Number.isInteger(port)) {
          console.error("usage: argus onboard ... --local <port>");
          process.exit(2);
        }
        console.log(dim(`tunnelling localhost:${port} ...`));
        tunnel = await startTunnel(port);
        target = tunnel.url;
        // A fresh trycloudflare hostname needs a moment at the edge.
        for (let i = 0; i < 15; i++) {
          try {
            const res = await fetch(target, { redirect: "manual" });
            if (res.status < 500 && res.status !== 404) break;
          } catch {
            /* not yet */
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      if (!target) {
        tunnel?.child.kill();
        console.error("point me at the app: --url https://your-app  or  --local 5173");
        process.exit(2);
      }
      console.log(dim(`argus → ${oc.api} · ${target}`));

      try {
        const report = await api<SmokeReport>(oc, "POST", "/v1/smoke", {
          url: target,
          project: basename(process.cwd()),
        });
        printSmokeReport(oc, report);

        const flowsPath = join(process.cwd(), ".argus", "flows");
        let flows: unknown[] = loadFlowFiles(flowsPath);
        if (flows.length === 0) {
          console.log(dim("no flows yet — generating a baseline suite ..."));
          await generatePresetSuite(
            oc,
            target,
            { authProfile: "default", emailVar: "ARGUS_TEST_EMAIL", passwordVar: "ARGUS_TEST_PASSWORD" }
          );
          const lenient = loadFlowFilesLenient(flowsPath);
          flows = lenient.flows;
          if (lenient.skipped.length) {
            console.log(
              dim(
                `  (${lenient.skipped.length} flow(s) need test-user env — export ARGUS_TEST_EMAIL/ARGUS_TEST_PASSWORD and re-run)`
              )
            );
          }
        }
        let flowsOk = true;
        if (flows.length === 0) {
          console.log(dim("no runnable flows — add some under .argus/flows/ and re-run\n"));
        } else {
          const verdict = await api<{
            status: string;
            passed: number;
            failed: number;
            results: Array<{
              flow: string;
              status: string;
              decision?: { whatChanged: string; nextAction: string };
            }>;
          }>(oc, "POST", "/v1/flows/verify", {
            flows,
            baseUrl: target,
            project: basename(process.cwd()),
            concurrency: 4,
            actor: actor(),
          });
          flowsOk = verdict.status === "pass";
          console.log(
            `\n${flowsOk ? green(bold(" FLOWS PASS ")) : red(bold(" FLOWS FAIL "))} ${verdict.passed}/${flows.length}`
          );
          for (const r of verdict.results) {
            if (r.status === "ok") continue;
            console.log(`  ${red("✘")} ${r.flow}`);
            if (r.decision) console.log(`      ${dim("→ " + r.decision.nextAction)}`);
          }
        }

        const ok = report.status === "pass" && flowsOk;
        console.log(
          `\n${
            ok
              ? green(bold(" READY ")) + " — nothing to fix"
              : red(bold(" NOT YET ")) + " — fix the findings above, then run it again"
          }\n`
        );
        process.exit(ok ? 0 : 1);
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "gate": {
      // argus gate [--url <url>] [--upload] — verify a build BEFORE it takes traffic.
      const live = await ensureConfigured(cfg);
      const urlFlagIndex = args.indexOf("--url");
      let target = urlFlagIndex !== -1 ? args[urlFlagIndex + 1] : undefined;
      let versionId: string | undefined;

      if (!target && args.includes("--upload")) {
        // `wrangler versions upload` publishes a version WITHOUT routing traffic
        // to it, and prints a preview URL — exactly the artifact a gate needs.
        console.log(dim("uploading a new Worker version (no traffic yet) ..."));
        const out = spawnSync("npx", ["wrangler", "versions", "upload"], {
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        const combined = `${out.stdout ?? ""}${out.stderr ?? ""}`;
        target = combined.match(/https:\/\/[a-z0-9-]+\.[a-z0-9-]+\.workers\.dev/i)?.[0];
        versionId = combined.match(/Version ID:\s*([0-9a-f-]{36})/i)?.[1];
        if (!target) {
          console.error(red("could not find a preview URL in wrangler output:"));
          console.error(dim(combined.slice(-600)));
          process.exit(1);
        }
        console.log(`${green("✔")} preview: ${bold(target)}${versionId ? dim(` (version ${versionId})`) : ""}`);
      }

      if (!target) {
        console.error("usage: argus gate --url <url>   |   argus gate --upload");
        process.exit(2);
      }

      // Flow files keep their recorded origin; baseUrl re-homes the whole suite.
      // Missing suite → generate one on the spot (CI-friendly, non-interactive).
      const flowsPath = join(process.cwd(), ".argus", "flows");
      let flows = loadFlowFiles(flowsPath);
      if (flows.length === 0) {
        console.log(dim("no saved flows — generating a baseline suite ..."));
        await generatePresetSuite(
          live,
          target,
          { authProfile: "default", emailVar: "ARGUS_TEST_EMAIL", passwordVar: "ARGUS_TEST_PASSWORD" }
        );
        flows = loadFlowFilesLenient(flowsPath).flows;
        if (flows.length === 0) {
          console.error(red("no runnable flows — seed test-user env or add flows under .argus/flows/"));
          process.exit(2);
        }
      }

      console.log(dim(`gating ${flows.length} flows against ${target} ...`));
      const verdict = await api<{
        status: string;
        summary: string;
        results: Array<{ flow: string; status: string; durationMs: number; decision?: { whatChanged: string; nextAction: string } }>;
      }>(live, "POST", "/v1/flows/verify", {
        flows,
        baseUrl: target,
        project: basename(process.cwd()),
        concurrency: 4,
        actor: actor(),
      });

      const ok = verdict.status === "pass";
      console.log(`\n${ok ? green(bold(" GATE PASS ")) : red(bold(" GATE FAIL "))} ${verdict.summary}\n`);
      for (const r of verdict.results) {
        console.log(`  ${r.status === "ok" ? green("✔") : red("✘")} ${r.flow} ${dim(`${(r.durationMs / 1000).toFixed(1)}s`)}`);
        if (r.decision) console.log(`      ${dim(r.decision.whatChanged.slice(0, 120))}`);
      }
      if (ok && versionId) {
        console.log(`\n${dim("promote with:")} ${bold(`npx wrangler versions deploy ${versionId} -y`)}`);
      } else if (!ok) {
        console.log(`\n${red("not promoted")} — fix the failures above and re-gate.`);
      }
      process.exit(ok ? 0 : 1);
      break;
    }
    case "preset": {
      // argus preset cf-saas <url> [--profile default] [--email-var X] [--password-var Y]
      const [presetName, url] = args.filter((a) => !a.startsWith("-"));
      if (presetName !== "cf-saas" || !url) {
        console.error("usage: argus preset cf-saas <url> [--profile <name>]");
        process.exit(2);
      }
      const flag = (name: string, fallback: string) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 && args[i + 1] ? args[i + 1]! : fallback;
      };
      const live = await ensureConfigured(cfg);
      const authProfile = flag("profile", "default");
      const emailVar = flag("email-var", "ARGUS_TEST_EMAIL");
      const passwordVar = flag("password-var", "ARGUS_TEST_PASSWORD");

      // Route discovery renders each candidate in a real cloud browser — an
      // SPA returns 200 for every path, so HTTP status alone would invent
      // flows for routes that don't exist.
      const { flows, skipped } = await generatePresetSuite(live, url, {
        authProfile,
        emailVar,
        passwordVar,
      });
      console.log(`\n${green("✔")} wrote ${flows.length} flows to .argus/flows/`);
      for (const f of flows) {
        const tag = f.saveAuthAs
          ? yellow(" (mints auth profile)")
          : f.auth
            ? dim(" (runs signed in)")
            : "";
        console.log(`  • ${f.name}${tag}`);
      }
      if (skipped.length) {
        console.log(`\n${yellow("skipped")} (route not found — add manually if it exists):`);
        for (const s of skipped) console.log(`  • ${dim(s)}`);
      }
      console.log(
        `\nnext: export ${bold(emailVar)} and ${bold(passwordVar)} for a seeded test user, then run the suite.`
      );
      break;
    }
    case "ci": {
      // argus ci [url] [--url U] [--force] — write .github/workflows/argus.yml.
      // Worker projects (wrangler config present) get a gate --upload job that
      // verifies the preview BEFORE it takes traffic; everything else verifies
      // the given URL (or a placeholder to fill in).
      const force = args.includes("--force");
      const urlFlag = args.indexOf("--url");
      const appUrl =
        urlFlag === -1 ? args.find((a) => !a.startsWith("-")) : args[urlFlag + 1];
      const out = join(process.cwd(), ".github", "workflows", "argus.yml");
      if (existsSync(out) && !force) {
        console.error(".github/workflows/argus.yml already exists — re-run with --force to overwrite");
        process.exit(2);
      }
      const isWorker =
        existsSync(join(process.cwd(), "wrangler.toml")) ||
        existsSync(join(process.cwd(), "wrangler.json")) ||
        existsSync(join(process.cwd(), "wrangler.jsonc"));
      const verifyStep = isWorker
        ? `      - name: Verify preview (gate before traffic)
        env:
          ARGUS_TOKEN: \${{ secrets.ARGUS_TOKEN }}
          CLOUDFLARE_API_TOKEN: \${{ secrets.CLOUDFLARE_API_TOKEN }}
        run: node /tmp/argus/packages/cli/dist/index.js gate --upload`
        : `      - name: Verify app
        env:
          ARGUS_TOKEN: \${{ secrets.ARGUS_TOKEN }}
        run: node /tmp/argus/packages/cli/dist/index.js verify "${appUrl ?? "https://YOUR-APP-URL"}" --json`;
      mkdirSync(dirname(out), { recursive: true });
      writeFileSync(
        out,
        `name: argus
on: [push, pull_request]
jobs:
  verify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
        with:
          version: 10
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - name: Install argus
        run: |
          git clone --depth 1 https://github.com/everyai-com/argus /tmp/argus
          cd /tmp/argus && pnpm install --frozen-lockfile && pnpm --filter @argus/cli --filter @argus/mcp build
${verifyStep}
`
      );
      console.log(`${green("✔")} .github/workflows/argus.yml written (${isWorker ? "worker gate" : "url verify"})`);
      console.log(`next: add ${bold("ARGUS_TOKEN")} as a repo secret${isWorker ? " (plus CLOUDFLARE_API_TOKEN for the upload)" : ""}`);
      if (!isWorker && !appUrl) {
        console.log(dim("  then replace https://YOUR-APP-URL with your deployed or preview URL"));
      }
      break;
    }
    case "tenants": {
      // argus tenants list
      // argus tenants create <id> [--name N] [--reserved R] [--burst B]
      // argus tenants update <id> [--reserved R] [--burst B] [--disable|--enable]
      // argus tenants rm <id>
      const [sub, id] = args.filter((a) => !a.startsWith("-"));
      const num = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 && args[i + 1] ? Number(args[i + 1]) : undefined;
      };
      const str = (name: string) => {
        const i = args.indexOf(`--${name}`);
        return i !== -1 && args[i + 1] ? args[i + 1] : undefined;
      };
      if (sub === "list" || sub === undefined) {
        const { tenants } = await api<{ tenants: Array<{ id: string; name: string; active: number; reserved: number; maxBurst: number; disabled: boolean }> }>(cfg, "GET", "/v1/admin/tenants");
        if (tenants.length === 0) { console.log(dim("no tenants — create one with: argus tenants create <id> --reserved 5")); break; }
        for (const t of tenants) {
          const state = t.disabled ? red("disabled") : green("active");
          console.log(`${bold(t.id.padEnd(16))} ${dim(t.name.padEnd(22))} ${state}  ${t.active}/${t.maxBurst} in use · reserved ${t.reserved}`);
        }
      } else if (sub === "create") {
        if (!id) { console.error("usage: argus tenants create <id> [--name N] [--reserved R] [--burst B]"); process.exit(2); }
        const r = await api<{ tenant: { id: string; reserved: number; maxBurst: number }; token: string }>(cfg, "POST", "/v1/admin/tenants", {
          id, name: str("name"), reserved: num("reserved") ?? 0, maxBurst: num("burst") ?? 60,
        });
        console.log(`${green("✔")} tenant ${bold(r.tenant.id)} created · reserved ${r.tenant.reserved} · burst ${r.tenant.maxBurst}`);
        console.log(`\n  ${bold("token (shown once — save it now):")}`);
        console.log(`  ${yellow(r.token)}\n`);
        console.log(dim(`  wire a project to it:  argus init ${cfg.api} ${r.token}`));
      } else if (sub === "update") {
        if (!id) { console.error("usage: argus tenants update <id> [--reserved R] [--burst B] [--disable|--enable]"); process.exit(2); }
        const patch: Record<string, unknown> = {};
        if (num("reserved") !== undefined) patch.reserved = num("reserved");
        if (num("burst") !== undefined) patch.maxBurst = num("burst");
        if (args.includes("--disable")) patch.disabled = true;
        if (args.includes("--enable")) patch.disabled = false;
        if (str("name")) patch.name = str("name");
        const r = await api<{ tenant: unknown }>(cfg, "PATCH", `/v1/admin/tenant/${id}`, patch);
        console.log(`${green("✔")} updated`, JSON.stringify(r.tenant));
      } else if (sub === "rm") {
        if (!id) { console.error("usage: argus tenants rm <id>"); process.exit(2); }
        await api(cfg, "DELETE", `/v1/admin/tenant/${id}`);
        console.log(`${green("✔")} tenant ${bold(id)} removed (its token no longer authenticates)`);
      } else {
        console.error("usage: argus tenants <list|create|update|rm> ...");
        process.exit(2);
      }
      break;
    }
    case "capacity": {
      // argus capacity [--watch]
      const watch = args.includes("--watch");
      const render = async () => {
        const s = await api<{ active: number; cap: number; warm: number; warmCap: number; launchQueueMs: number; reservedTotal: number; cumulative: { acquires: number; rejects: number; launches: number; releases: number }; tenants: Array<{ id: string; name: string; active: number; reserved: number; maxBurst: number }> }>(cfg, "GET", "/v1/capacity");
        const bar = (used: number, total: number, width = 24) => {
          const n = total > 0 ? Math.round((used / total) * width) : 0;
          return `[${"█".repeat(n)}${dim("·".repeat(width - n))}]`;
        };
        if (watch) process.stdout.write("[2J[H");
        console.log(bold("Argus fleet capacity") + dim(`  ${cfg.api}`));
        console.log(`  browsers  ${bar(s.active, s.cap)} ${bold(`${s.active}/${s.cap}`)}   warm ${s.warm}/${s.warmCap}   launch-queue ${s.launchQueueMs}ms`);
        console.log(`  reserved  ${s.reservedTotal}/${s.cap} committed   ${dim(`acquires ${s.cumulative.acquires} · 429s ${s.cumulative.rejects} · launches ${s.cumulative.launches} · releases ${s.cumulative.releases}`)}`);
        if (s.tenants.length) {
          console.log(bold("\n  tenants"));
          for (const t of s.tenants) {
            console.log(`    ${t.id.padEnd(16)} ${bar(t.active, t.maxBurst, 16)} ${t.active}/${t.maxBurst} ${dim(`reserved ${t.reserved}`)}`);
          }
        }
        console.log();
      };
      if (watch) {
        for (;;) { await render(); await new Promise((r) => setTimeout(r, 2000)); }
      } else {
        await render();
      }
      break;
    }
    case "stress": {
      // argus stress [N] [--ttl S] — fire N concurrent leases, report admit/429/timing + capacity.
      const n = Number(args.find((a) => !a.startsWith("-"))) || 10;
      const ttlIdx = args.indexOf("--ttl");
      const ttl = ttlIdx !== -1 ? Number(args[ttlIdx + 1]) : 60;
      console.log(dim(`firing ${n} concurrent leases (ttl ${ttl}s) at ${cfg.api} ...`));
      const t0 = Date.now();
      const results = await Promise.all(
        Array.from({ length: n }, async () => {
          const s = Date.now();
          try {
            const r = await api<{ sessionId: string }>(cfg, "POST", "/v1/lease", { url: "https://example.com", ttlSeconds: ttl });
            return { ok: true as const, ms: Date.now() - s, sid: r.sessionId };
          } catch (e) {
            return { ok: false as const, ms: Date.now() - s, err: e instanceof Error ? e.message : String(e) };
          }
        })
      );
      const wall = Date.now() - t0;
      const ok = results.filter((r) => r.ok);
      const rejected = results.filter((r) => !r.ok);
      const per = ok.map((r) => r.ms).sort((a, b) => a - b);
      console.log(`\n  admitted ${green(String(ok.length))}/${n}   rejected ${rejected.length ? red(String(rejected.length)) : "0"}   wall ${(wall / 1000).toFixed(1)}s`);
      if (per.length) console.log(dim(`  per-lease ms: min ${per[0]} · median ${per[Math.floor(per.length / 2)]} · max ${per[per.length - 1]}`));
      const reasons = new Set(rejected.map((r) => ("err" in r ? r.err : "")));
      if (reasons.size) console.log(dim(`  reject reasons: ${[...reasons].join(" | ")}`));
      // release what we took so the fleet frees immediately
      await Promise.all(ok.map((r) => api(cfg, "DELETE", `/v1/session/${r.sid}`).catch(() => {})));
      console.log(dim(`  released ${ok.length} sessions`));
      break;
    }
    case "sessions": {
      const data = await api<{ sessions: Array<{ sessionId: string; url?: string; label?: string; expiresAt: string }> }>(
        cfg,
        "GET",
        "/v1/sessions"
      );
      if (data.sessions.length === 0) {
        console.log(dim("no active sessions"));
      } else {
        for (const s of data.sessions) {
          console.log(`${bold(s.sessionId)}  ${s.url ?? ""}  ${dim(s.label ?? "")}  expires ${s.expiresAt}`);
        }
      }
      break;
    }
    case "fix": {
      // argus fix [url|port] [--agent "<cmd>"] [--preview "<cmd>"] [--pr] [--max N]
      const setup = fixSetup(args, "fix");
      const live = await ensureConfigured(cfg);
      const { url, tunnel } = await resolveTarget(setup.raw, "fix");
      try {
        const outcomes = await runFixLoop(fixDeps(live, setup.flows), { ...setup, target: url });
        console.log();
        printFixOutcomes(outcomes);
        tunnel?.child.kill();
        // 0: nothing to fix, or every confirmed failure has a proven fix.
        process.exit(outcomes.every((o) => o.result === "pr" || o.result === "verified") ? 0 : 1);
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "patrol": {
      // argus patrol <url> [--every 30] [--branch main] [--fix [--preview "<cmd>"] [--pr]] [--once]
      // <url> is where the branch deploys (staging/preview): patrol re-verifies it on every new commit.
      const setup = fixSetup(args, "patrol");
      if (!setup.raw || /^\d+$/.test(setup.raw)) {
        console.error("argus patrol <url> — the URL your tracked branch deploys to (a patrol outlives any local tunnel)");
        process.exit(2);
      }
      const live = await ensureConfigured(cfg);
      const branch = setup.flag("--branch") ?? "main";
      const everyMin = Math.max(1, Number(setup.flag("--every") ?? 30));
      const statePath = join(process.cwd(), ".argus", "patrol.json");
      const deps = fixDeps(live, setup.flows);
      for (;;) {
        const tick = await patrolTick({
          headSha: async () => {
            const f = await runShell(`git fetch --quiet origin ${branch}`, { cwd: setup.repo, timeoutMs: 60_000 });
            if (f.code !== 0) return undefined;
            const h = spawnSync("git", ["rev-parse", `origin/${branch}`], { cwd: setup.repo, encoding: "utf8" });
            return h.status === 0 ? h.stdout.trim() : undefined;
          },
          verify: () => deps.verify(setup.raw!),
          ...(args.includes("--fix")
            ? { fix: (suite: Suite) => runFixLoop(deps, { ...setup, target: setup.raw!, suite }) }
            : {}),
          readState: () => {
            try {
              return JSON.parse(readFileSync(statePath, "utf8")) as PatrolState;
            } catch {
              return {};
            }
          },
          writeState: (st) => writeFileSync(statePath, JSON.stringify(st, null, 2) + "\n"),
          log: (m) => console.log(dim(`[${new Date().toISOString().slice(11, 19)}] `) + m),
        });
        if (tick.ran) {
          const badge = tick.status === "pass" ? green("PASS") : tick.status === "untested" ? yellow("UNTESTED") : red(tick.status?.toUpperCase() ?? "?");
          console.log(`  ${badge} ${tick.sha?.slice(0, 7)}${tick.failing?.length ? ` — failing: ${tick.failing.join(", ")}` : ""}`);
          if (tick.outcomes) printFixOutcomes(tick.outcomes);
        }
        if (args.includes("--once")) process.exit(tick.status === "fail" ? 1 : 0);
        await new Promise((r) => setTimeout(r, everyMin * 60_000));
      }
    }
    case "personas": {
      // argus personas <url> --goal "<first success>" [--agent "<cmd>"]
      const flag = (name: string) => {
        const i = args.indexOf(name);
        return i === -1 ? undefined : args[i + 1];
      };
      const url = args.find((a, i) => /^https?:\/\//.test(a) && !["--goal", "--agent"].includes(args[i - 1] ?? ""));
      const goal = flag("--goal");
      if (!url || !goal) {
        console.error('argus personas <url> --goal "add my first task" — the goal is the one sentence every user gets');
        process.exit(2);
      }
      await ensureConfigured(cfg);
      // The project's MCP config (argus init) gives the agent the argus tools.
      const agent = flag("--agent") ?? "claude -p --allowedTools mcp__argus";
      console.log(dim(`five first-time users → ${url} (goal: "${goal}") via \`${agent}\` ...`));
      const outputs = await Promise.all(
        PERSONAS.map(async (p) => {
          const r = await runShell(agent, { cwd: process.cwd(), input: personaPrompt(p, url, goal), timeoutMs: 20 * 60_000 });
          const report = extractReport(r.out);
          console.log(`  ${report ? green("✔") : yellow("?")} ${p.id}${report ? ` — ${report.moments.length} moment(s)` : ` — no report (exit ${r.code})`}`);
          return report;
        })
      );
      const reports = outputs.filter((r): r is NonNullable<typeof r> => r !== undefined);
      const issues = mergeReports(reports);
      const md = renderReport(url, reports, issues);
      const dir = join(process.cwd(), ".argus", "personas");
      mkdirSync(dir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      writeFileSync(join(dir, `${stamp}.md`), md + "\n");
      writeFileSync(join(dir, `${stamp}.json`), JSON.stringify({ url, goal, reports, issues }, null, 2) + "\n");
      console.log("\n" + md);
      console.log(dim(`saved .argus/personas/${stamp}.{md,json}`));
      // 4: a user never reported (not tested) · 1: a user failed or a blocker/major issue · 0: clean.
      const code =
        reports.length < PERSONAS.length
          ? 4
          : reports.some((r) => !r.reachedSuccess) || issues.some((i) => i.severity !== "minor")
            ? 1
            : 0;
      process.exit(code);
    }
    case "config": {
      console.log(JSON.stringify({ api: cfg.api, token: cfg.token ? "•••set•••" : undefined }, null, 2));
      break;
    }
    default:
      console.log(`${bold("argus")} — cloud verification platform

usage:
  argus                        guided quickstart: wire + detect + verify (interactive)
  argus verify [url|port]      smoke + audit + every saved flow (generates a suite
                               automatically when none exists yet; blank detects
                               a local dev server, a bare port tunnels localhost)
  argus verify --json          same, as machine-readable JSON (run ids + full reports)
  argus verify --strict        also fail on flaky flows (a failure the re-run didn't repeat)
  argus doctor [--target …]    one command: config, API, auth, fleet, runs, flows, gates
  argus fix [url|port]         confirmed failures → an agent fixes each in its own
                               worktree → the flow must pass on --preview "<cmd that
                               prints the fixed build's URL>" → --pr opens a draft PR
                               (--agent "<cmd>", default: claude -p; --max N, default 3)
  argus personas <url> --goal "<first success>"
                               five first-time users (impatient, skeptic, phone on
                               slow 3G, literal reader, breaker) via your agent CLI;
                               one list ranked by how many hit each issue
                               (--agent "<cmd>", default: claude -p)
  argus patrol <url>           re-verify <url> whenever origin/main gets a new commit
                               (--every 30 min, --branch main, --once; --fix runs
                               argus fix on confirmed failures; state in .argus/patrol.json)
  argus test [url|port]        smoke suite (bare port tunnels, blank detects)
  argus test --local <port>    tunnel a local app to the cloud and test it
  argus audit [url|port]       a11y, perf, links, visual regression (port/detect as above)
  argus preset cf-saas <url>   generate the baseline flow suite for a CF+React+better-auth app
  argus audit --update-baseline <url>   approve current look as the baseline
  argus crawl [url|port]       every reachable page in parallel cloud browsers, detectors on
                               each (--max N, --concurrency N, --mobile, --include /path)
  argus init                   wire this project to Argus — MCP server + verification
                               steps for Claude Code, Cursor, VS Code, Gemini CLI,
                               Codex, any AGENTS.md reader (--harness all, --write-global,
                               --token <t> / --api <url>; bare init uses the hosted
                               cloud and prompts for the token)
  argus onboard --url <u>      one command from nothing to a verdict: wire every
  argus onboard --local <port> harness, tunnel a local app, generate a suite when
                               none exists, run smoke + all flows
  argus ci [url]               write .github/workflows/argus.yml (PR verification;
                               Worker projects get a gate --upload job instead)
  argus tunnel <port>          hold a tunnel open (for agent-driven sessions)
  argus sessions               list active cloud browser sessions
  argus capacity [--watch]     live fleet capacity: browsers, warm pool, per-tenant usage
  argus tenants <cmd>          admin: list | create <id> | update <id> | rm <id>
  argus stress [N]             fire N concurrent leases to load-test the fleet
  argus config                 show resolved config

exit codes: 0 pass · 1 confirmed regression · 2 usage/config · 4 could not test
            (unreachable target, no browser slot) — only 1 means the app regressed

config: set ARGUS_TOKEN (API defaults to the hosted cloud), or .argus/config.json { "api": "...", "token": "..." } — testing commands take a token inline on first run`);
      process.exit(command && command !== "help" && command !== "--help" && command !== "-h" ? 2 : 0);
  }
}

main().catch((err) => {
  console.error(red(`argus: ${err instanceof Error ? err.message : String(err)}`));
  // A capacity refusal or server error means nothing was tested — not a regression.
  process.exit(err instanceof ApiCallError ? exitCodeForApiStatus(err.status) : 1);
});

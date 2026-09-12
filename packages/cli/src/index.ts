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
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename, relative } from "node:path";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import process from "node:process";
import type { SmokeReport } from "@argus/shared";
import { buildCfSaasFlows, probeApp } from "./preset";
import { wireHarnesses, mcpServerPath } from "./harness";

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
  return { api: (api ?? "http://localhost:8787").replace(/\/$/, ""), token };
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
    const err = data as { error?: string; detail?: string };
    throw new Error(`${err.error ?? res.status}${err.detail ? ` — ${err.detail}` : ""}`);
  }
  return data as T;
}

function printSmokeReport(cfg: Config, report: SmokeReport): void {
  const badge =
    report.status === "pass" ? green(bold(" PASS ")) : report.status === "fail" ? red(bold(" FAIL ")) : red(bold(" ERROR "));
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
  if (report.findings.length > 0) {
    console.log(bold(`  Findings (${report.findings.length}):`));
    for (const f of report.findings) {
      const sev =
        f.severity === "critical" ? red(bold(f.severity)) : f.severity === "major" ? yellow(f.severity) : dim(f.severity);
      console.log(`  • [${sev}] ${f.summary}`);
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

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;
  const cfg = loadConfig();

  switch (command) {
    case "verify": {
      const url = args.find((a) => !a.startsWith("-"));
      if (!url) {
        console.error("usage: argus verify <url> [--no-flows]");
        process.exit(2);
      }
      const project = basename(process.cwd());
      const flowsPath = join(process.cwd(), ".argus", "flows");
      const flows =
        !args.includes("--no-flows") && existsSync(flowsPath)
          ? readdirSync(flowsPath)
              .filter((file) => file.endsWith(".json"))
              .map((file) =>
                resolveEnvPlaceholders(JSON.parse(readFileSync(join(flowsPath, file), "utf8")))
              )
          : [];
      console.log(
        dim(
          `argus → ${cfg.api} · full verification of ${url} ` +
            `(smoke + audit${flows.length ? ` + ${flows.length} flows` : ""}) ...`
        )
      );
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
          ? api<{ status: string; passed: number; failed: number; runId: string }>(
              cfg,
              "POST",
              "/v1/flows/verify",
              { flows, baseUrl: url, project, concurrency: 4 }
            )
          : Promise.resolve(undefined),
      ]);
      const checks = [
        { name: "smoke", status: smoke.status, detail: `${smoke.findings.length} finding(s)` },
        { name: "audit", status: audit.status, detail: `${audit.findings.length} finding(s)` },
        ...(suite
          ? [{ name: "flows", status: suite.status, detail: `${suite.passed} passed, ${suite.failed} failed` }]
          : [{ name: "flows", status: "skipped", detail: "no .argus/flows (or --no-flows)" }]),
      ];
      const ok = checks.every((check) => check.status === "pass" || check.status === "skipped");
      console.log(`\n${ok ? green(bold(" VERIFY PASS ")) : red(bold(" VERIFY FAIL "))} ${bold(url)}\n`);
      for (const check of checks) {
        const mark = check.status === "pass" ? green("✔") : check.status === "skipped" ? yellow("●") : red("✘");
        console.log(`  ${mark} ${check.name}: ${check.status} ${dim(`(${check.detail})`)}`);
      }
      console.log();
      process.exit(ok ? 0 : 1);
      break;
    }
    case "test": {
      const localFlag = args.indexOf("--local");
      const portArg = localFlag === -1 ? undefined : args[localFlag + 1];
      let url = args.find((a) => !a.startsWith("-") && a !== portArg);
      let tunnel: { url: string; child: ChildProcess } | undefined;

      if (localFlag !== -1) {
        const port = Number(args[localFlag + 1]);
        if (!Number.isInteger(port)) {
          console.error("usage: argus test --local <port>");
          process.exit(2);
        }
        console.log(dim(`starting tunnel to localhost:${port} ...`));
        tunnel = await startTunnel(port);
        console.log(dim(`tunnel up: ${tunnel.url}`));
        // A fresh trycloudflare hostname takes a few seconds to propagate at
        // the edge — poll until it actually serves before testing it.
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
        if (!reachable) console.log(dim("warning: tunnel still not answering after 30s — testing anyway"));
        url = tunnel.url;
      }
      if (!url) {
        console.error("usage: argus test <url> | argus test --local <port>");
        process.exit(2);
      }
      console.log(dim(`argus → ${cfg.api} · testing ${url} ...`));
      try {
        const report = await api<SmokeReport>(cfg, "POST", "/v1/smoke", {
          url,
          project: basename(process.cwd()),
        });
        printSmokeReport(cfg, report);
        process.exit(report.status === "pass" ? 0 : 1);
      } finally {
        tunnel?.child.kill();
      }
      break;
    }
    case "audit": {
      const localFlag = args.indexOf("--local");
      const portArg = localFlag === -1 ? undefined : args[localFlag + 1];
      let url = args.find((a) => !a.startsWith("-") && a !== portArg);
      let tunnel: { url: string; child: ChildProcess } | undefined;
      if (localFlag !== -1) {
        const port = Number(args[localFlag + 1]);
        if (!Number.isInteger(port)) {
          console.error("usage: argus audit --local <port>");
          process.exit(2);
        }
        console.log(dim(`starting tunnel to localhost:${port} ...`));
        tunnel = await startTunnel(port);
        console.log(dim(`tunnel up: ${tunnel.url}`));
        await new Promise((r) => setTimeout(r, 5000));
        url = tunnel.url;
      }
      if (!url) {
        console.error("usage: argus audit <url> | argus audit --local <port>");
        process.exit(2);
      }
      const update = args.includes("--update-baseline");
      console.log(dim(`argus → ${cfg.api} · auditing ${url} ...`));
      try {
        const r = await api<{
          status: string;
          durationMs: number;
          perf: Array<{ viewport: string; fcpMs?: number; lcpMs?: number; cls?: number; loadMs?: number }>;
          visual: Array<{ viewport: string; colorScheme: string; status: string; diffRatio?: number }>;
          a11yViolations: number;
          linksChecked: number;
          brokenLinks: number;
          findings: Array<{ severity: string; summary: string; decision?: { nextAction: string } }>;
          screenshots: Array<{ viewport: string; colorScheme: string; url: string }>;
        }>(cfg, "POST", "/v1/audit", {
          url,
          updateBaseline: update,
          project: basename(process.cwd()),
        });
        const badge = r.status === "pass" ? green(bold(" PASS ")) : red(bold(` ${r.status.toUpperCase()} `));
        console.log(`\n${badge} ${bold(url)} ${dim(`(${(r.durationMs / 1000).toFixed(1)}s)`)}\n`);
        for (const p of r.perf) {
          console.log(
            `  perf ${p.viewport}: FCP ${p.fcpMs ?? "?"}ms · LCP ${p.lcpMs ?? "?"}ms · CLS ${p.cls ?? "?"} · load ${p.loadMs ?? "?"}ms`
          );
        }
        for (const v of r.visual) {
          const mark = v.status === "match" ? green("✔") : v.status === "baseline-created" ? yellow("●") : red("✘");
          console.log(`  visual ${v.viewport}/${v.colorScheme}: ${mark} ${v.status}${v.diffRatio ? ` (${(v.diffRatio * 100).toFixed(1)}%)` : ""}`);
        }
        console.log(`  a11y violations: ${r.a11yViolations === 0 ? green("0") : red(String(r.a11yViolations))}`);
        console.log(`  links: ${r.linksChecked} checked, ${r.brokenLinks === 0 ? green("0 broken") : red(`${r.brokenLinks} broken`)}\n`);
        if (r.findings.length) {
          console.log(bold(`  Findings (${r.findings.length}):`));
          for (const f of r.findings.slice(0, 15)) {
            const sev = f.severity === "critical" ? red(bold(f.severity)) : f.severity === "major" ? yellow(f.severity) : dim(f.severity);
            console.log(`  • [${sev}] ${f.summary}`);
            if (f.decision) console.log(`      ${dim("→ " + f.decision.nextAction)}`);
          }
          if (r.findings.length > 15) console.log(dim(`  … and ${r.findings.length - 15} more`));
          console.log();
        }
        process.exit(r.status === "pass" ? 0 : 1);
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
      // argus init <api-url> <token> [--harness all|csv] [--write-global]
      const harnessIdx = args.indexOf("--harness");
      const harnessSel = harnessIdx !== -1 ? args[harnessIdx + 1] : undefined;
      const writeGlobal = args.includes("--write-global");
      const positional = args.filter((a, i) => !a.startsWith("-") && i !== harnessIdx + 1);
      const [apiUrl, token] = positional;
      if (!apiUrl || !token) {
        console.error(
          "usage: argus init <api-url> <token> [--harness claude,cursor,vscode,agents,codex|all] [--write-global]"
        );
        process.exit(2);
      }
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

      console.log(`\ntry:  ${bold("argus test <your-app-url>")}   or   ${bold("argus test --local <port>")}`);
      break;
    }
    case "gate": {
      // argus gate [--url <url>] [--upload] — verify a build BEFORE it takes traffic.
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
      const flowsPath = join(process.cwd(), ".argus", "flows");
      if (!existsSync(flowsPath)) {
        console.error(red("no .argus/flows — run `argus preset cf-saas <url>` first"));
        process.exit(2);
      }
      const flows = readdirSync(flowsPath)
        .filter((f) => f.endsWith(".json"))
        .map((f) => resolveEnvPlaceholders(JSON.parse(readFileSync(join(flowsPath, f), "utf8"))));

      console.log(dim(`gating ${flows.length} flows against ${target} ...`));
      const verdict = await api<{
        status: string;
        summary: string;
        results: Array<{ flow: string; status: string; durationMs: number; decision?: { whatChanged: string; nextAction: string } }>;
      }>(cfg, "POST", "/v1/flows/verify", {
        flows,
        baseUrl: target,
        project: basename(process.cwd()),
        concurrency: 4,
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
      const authProfile = flag("profile", "default");
      const emailVar = flag("email-var", "ARGUS_TEST_EMAIL");
      const passwordVar = flag("password-var", "ARGUS_TEST_PASSWORD");

      // Route discovery renders each candidate in a real cloud browser — an
      // SPA returns 200 for every path, so HTTP status alone would invent
      // flows for routes that don't exist.
      console.log(dim(`probing ${url} in a real browser (SPA-safe) ...`));
      const root = url.replace(/\/$/, "");
      const lease = await api<{ sessionId: string }>(cfg, "POST", "/v1/lease", {
        url: root + "/",
        label: "preset-probe",
        ttlSeconds: 300,
      });
      const sid = lease.sessionId;
      let probe;
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

      console.log(
        `  signin: ${probe.signin ?? dim("not found")}   signup: ${probe.signup ?? dim("not found")}`
      );
      console.log(
        `  protected: ${probe.protectedPath ?? dim("not found")}   api health: ${probe.apiHealth ?? dim("not found")}`
      );
      if (probe.notFoundMarker)
        console.log(`  not-found fingerprint: ${dim(`"${probe.notFoundMarker}"`)}`);

      const { flows, skipped } = buildCfSaasFlows({
        base: url,
        probe,
        authProfile,
        emailVar,
        passwordVar,
      });
      const dir = join(process.cwd(), ".argus", "flows");
      mkdirSync(dir, { recursive: true });
      for (const flow of flows) {
        writeFileSync(join(dir, `${flow.name}.json`), JSON.stringify(flow, null, 2) + "\n");
      }
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
    case "config": {
      console.log(JSON.stringify({ api: cfg.api, token: cfg.token ? "•••set•••" : undefined }, null, 2));
      break;
    }
    default:
      console.log(`${bold("argus")} — cloud verification platform

usage:
  argus verify <url>           automatically run smoke + audit + every saved flow
  argus test <url>             run the smoke suite against a URL
  argus test --local <port>    tunnel a local app to the cloud and test it
  argus audit <url>            full audit: a11y, perf, links, visual regression
  argus preset cf-saas <url>   generate the baseline flow suite for a CF+React+better-auth app
  argus audit --update-baseline <url>   approve current look as the baseline
  argus init <api> <token>     wire this project to Argus — MCP server + verification
                               steps for Claude Code, Cursor, VS Code, Codex, any
                               AGENTS.md reader (--harness all, --write-global)
  argus tunnel <port>          hold a tunnel open (for agent-driven sessions)
  argus sessions               list active cloud browser sessions
  argus capacity [--watch]     live fleet capacity: browsers, warm pool, per-tenant usage
  argus tenants <cmd>          admin: list | create <id> | update <id> | rm <id>
  argus stress [N]             fire N concurrent leases to load-test the fleet
  argus config                 show resolved config

config: set ARGUS_API / ARGUS_TOKEN env vars, or .argus/config.json { "api": "...", "token": "..." }`);
      process.exit(command && command !== "help" && command !== "--help" && command !== "-h" ? 2 : 0);
  }
}

main().catch((err) => {
  console.error(red(`argus: ${err instanceof Error ? err.message : String(err)}`));
  process.exit(1);
});

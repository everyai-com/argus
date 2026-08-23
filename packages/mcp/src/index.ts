/**
 * argus-mcp — MCP server exposing the Argus cloud browser to coding agents.
 *
 * The agent (Claude Code, on the user's subscription) is the brain; these
 * tools are its hands and eyes on cloud Chromium. Parallelism falls out
 * naturally: N subagents each lease their own isolated session.
 *
 * Config: env ARGUS_API / ARGUS_TOKEN, else .argus/config.json walking up
 * from cwd.
 */
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import process from "node:process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ActionSchema,
  AnchorSchema,
  FlowSchema,
  PredicateSchema,
  ViewportNameSchema,
  type Flow,
} from "@argus/shared";

// --- config -----------------------------------------------------------------

function loadConfig(): { api: string; token?: string } {
  let api = process.env.ARGUS_API;
  let token = process.env.ARGUS_TOKEN;
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".argus", "config.json");
    if (existsSync(candidate)) {
      try {
        const file = JSON.parse(readFileSync(candidate, "utf8"));
        api = api ?? file.api;
        token = token ?? file.token;
      } catch {
        /* ignore unreadable config */
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { api: (api ?? "http://localhost:8787").replace(/\/$/, ""), token };
}

const cfg = loadConfig();

async function api(method: string, path: string, body?: unknown): Promise<unknown> {
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
    throw new Error(`argus API returned non-JSON (${res.status}): ${text.slice(0, 200)}`);
  }
  if (!res.ok) {
    const err = data as { error?: string; detail?: string };
    throw new Error(`${err.error ?? res.status}${err.detail ? ` — ${err.detail}` : ""}`);
  }
  return data;
}

const jsonResult = (data: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(data) }],
});

// --- server -----------------------------------------------------------------

const server = new McpServer({ name: "argus", version: "0.1.0" });

server.tool(
  "argus_lease",
  "Lease an isolated cloud browser session pointed at a URL. Returns a sessionId used by every other argus tool. Each parallel agent/flow should hold its own lease; release it when done.",
  {
    url: z.string().url(),
    viewport: ViewportNameSchema.optional(),
    colorScheme: z.enum(["light", "dark"]).optional(),
    label: z.string().max(80).optional().describe("what this session is for, e.g. the flow name"),
    authProfile: z
      .string()
      .optional()
      .describe("start already signed in using a saved auth profile (see argus_auth_list)"),
  },
  async (args) => jsonResult(await api("POST", "/v1/lease", args))
);

server.tool(
  "argus_auth_save",
  "Save this session's cookies/localStorage as a reusable auth profile — call it AFTER driving a real login. Every later flow/lease can then start signed in via authProfile, instead of re-driving the login form. Profiles are stored server-side, never in the repo.",
  { sessionId: z.string(), profile: z.string().describe("profile name, e.g. \"default\"") },
  async ({ sessionId, profile }) =>
    jsonResult(await api("POST", `/v1/session/${sessionId}/auth-save`, { profile }))
);

server.tool(
  "argus_auth_list",
  "List saved auth profiles with their age. A stale profile (expired session cookies) is the usual cause of an authenticated flow suddenly failing — re-run the login flow to refresh it.",
  {},
  async () => jsonResult(await api("GET", "/v1/auth/profiles"))
);

server.tool(
  "argus_auth_delete",
  "Delete a saved auth profile. Profiles are host-scoped, so pass the host it belongs to (see argus_auth_list).",
  { profile: z.string(), host: z.string() },
  async ({ profile, host }) =>
    jsonResult(await api("DELETE", `/v1/auth/profile/${profile}?host=${encodeURIComponent(host)}`))
);

server.tool(
  "argus_release",
  "Release a leased browser session, freeing its slot for other agents.",
  { sessionId: z.string() },
  async ({ sessionId }) => jsonResult(await api("DELETE", `/v1/session/${sessionId}`))
);

server.tool(
  "argus_sessions",
  "List active cloud browser sessions (the fleet view).",
  {},
  async () => jsonResult(await api("GET", "/v1/sessions"))
);

server.tool(
  "argus_query",
  "Find elements on the page. Pass an anchor (testid / role+name / text / css — resolved in that ladder order) to locate a specific target, or interactive:true to list the interactive surface. Returns stable refs usable in argus_act.",
  {
    sessionId: z.string(),
    anchor: AnchorSchema.optional(),
    interactive: z.boolean().optional(),
    limit: z.number().int().min(1).max(100).optional(),
  },
  async ({ sessionId, ...rest }) =>
    jsonResult(await api("POST", `/v1/session/${sessionId}/query`, rest))
);

server.tool(
  "argus_act",
  "Perform one action (goto/click/fill/select/press/hover/scroll/back/reload/wait) and get its OBSERVED effects: navigation, DOM delta, new console errors, new network failures. Target elements by ref (from argus_query) or semantic anchor.",
  { sessionId: z.string(), step: ActionSchema },
  async ({ sessionId, step }) =>
    jsonResult(await api("POST", `/v1/session/${sessionId}/act`, step))
);

server.tool(
  "argus_act_batch",
  "Perform up to 50 actions in one call (much faster than one-by-one). Executes in order; stops at the first failure unless stopOnError:false. Returns per-step effects.",
  {
    sessionId: z.string(),
    steps: z.array(ActionSchema).min(1).max(50),
    stopOnError: z.boolean().optional(),
  },
  async ({ sessionId, ...rest }) =>
    jsonResult(await api("POST", `/v1/session/${sessionId}/act-batch`, rest))
);

server.tool(
  "argus_observe",
  "Read what happened: network requests, console messages, current route — from the session's ring buffers. Pass the previous cursor to get only new events.",
  {
    sessionId: z.string(),
    since: z.number().int().optional(),
    what: z.array(z.enum(["network", "console", "route"])).optional(),
  },
  async ({ sessionId, ...rest }) =>
    jsonResult(await api("POST", `/v1/session/${sessionId}/observe`, rest))
);

server.tool(
  "argus_assert",
  "Assert evidence-tiered predicates over program truth: network (url/status/cardinality), console-clean, route, visible/hidden/text. The verdict reports the WEAKEST evidence tier it rests on — prefer network/route (consequence) over DOM presence.",
  { sessionId: z.string(), predicates: z.array(PredicateSchema).min(1).max(20) },
  async ({ sessionId, predicates }) =>
    jsonResult(await api("POST", `/v1/session/${sessionId}/assert`, { predicates }))
);

server.tool(
  "argus_screenshot",
  "Screenshot the session's page. Returns the image itself so you can SEE the current state, plus its artifact URL.",
  {
    sessionId: z.string(),
    fullPage: z.boolean().optional(),
    label: z.string().max(80).optional(),
  },
  async ({ sessionId, ...rest }) => {
    const shot = (await api("POST", `/v1/session/${sessionId}/screenshot`, rest)) as {
      key: string;
      url: string;
      width: number;
      height: number;
    };
    // Fetch the PNG and hand it back as image content — visual feedback in-loop.
    const res = await fetch(cfg.api + shot.url, {
      headers: cfg.token ? { authorization: `Bearer ${cfg.token}` } : {},
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      content: [
        { type: "image" as const, data: buf.toString("base64"), mimeType: "image/png" },
        { type: "text" as const, text: JSON.stringify(shot) },
      ],
    };
  }
);

server.tool(
  "argus_smoke",
  "Run the zero-config smoke suite against a URL: load check, console/network cleanliness, responsive overflow, screenshots at mobile/tablet/desktop. Returns the full report with findings and decision envelopes.",
  {
    url: z.string().url(),
    viewports: z.array(ViewportNameSchema).optional(),
    colorSchemes: z.array(z.enum(["light", "dark"])).optional(),
  },
  async (args) => jsonResult(await api("POST", "/v1/smoke", args))
);

server.tool(
  "argus_runs",
  "List recent verification runs (smoke/audit/flow-verify) with their run ids — the run history the dashboard shows.",
  {},
  async () => jsonResult(await api("GET", "/v1/runs"))
);

server.tool(
  "argus_findings",
  "Fetch a run's full report(s) — findings with severities, decision envelopes (whatChanged/nextAction), perf metrics, visual diffs, flow verdicts. This is the feedback loop: read the findings, fix the code, re-verify.",
  { runId: z.string() },
  async ({ runId }) => jsonResult(await api("GET", `/v1/run/${runId}`))
);

server.tool(
  "argus_audit",
  "Run the full UX/visual audit against a URL: axe-core accessibility (WCAG 2.1 A/AA), performance metrics (FCP/LCP/CLS), broken-link check, responsive overflow, and visual regression against stored baselines (pixel diff). Returns findings with decision envelopes. Set updateBaseline:true to approve the current look.",
  {
    url: z.string().url(),
    viewports: z.array(ViewportNameSchema).optional(),
    colorSchemes: z.array(z.enum(["light", "dark"])).optional(),
    checks: z.array(z.enum(["a11y", "perf", "links", "visual"])).optional(),
    updateBaseline: z.boolean().optional(),
    authProfile: z
      .string()
      .optional()
      .describe("audit behind the login wall using a saved auth profile"),
    project: z.string().optional(),
  },
  async (args) => jsonResult(await api("POST", "/v1/audit", args))
);

// --- email / magic links ----------------------------------------------------
// Signup verification, password reset and magic-link sign-in are untestable
// without reading the mail the app sent. Most apps on this stack queue
// outgoing mail into their own D1 table before delivery, which makes that
// table the honest source of truth — no inbox, no DNS, no third-party service.
// Configure in .argus/config.json:
//   "email": { "source": "d1", "database": "grandstage", "table": "delivery" }

interface EmailConfig {
  source: "d1";
  database: string;
  table?: string;
  toColumn?: string;
  bodyColumn?: string;
  createdColumn?: string;
  remote?: boolean;
}

function loadEmailConfig(): EmailConfig | undefined {
  let dir = process.cwd();
  for (;;) {
    const candidate = join(dir, ".argus", "config.json");
    if (existsSync(candidate)) {
      try {
        return JSON.parse(readFileSync(candidate, "utf8")).email as EmailConfig | undefined;
      } catch {
        return undefined;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

server.tool(
  "argus_email_link",
  "Read the newest link the app emailed to an address — the missing piece for signup-verification, password-reset and magic-link flows. Reads the app's own outbox table (configure .argus/config.json → email), so no real inbox is involved. Returns the link to drive with argus_act goto.",
  {
    address: z.string().email(),
    contains: z
      .string()
      .optional()
      .describe('only links containing this, e.g. "verify-email" or "reset-password"'),
  },
  async ({ address, contains }) => {
    const cfg = loadEmailConfig();
    if (!cfg)
      throw new Error(
        'no email source configured — add to .argus/config.json: {"email":{"source":"d1","database":"<d1-name>","table":"delivery"}}'
      );
    // The address reaches a shell + SQL, so accept only real address characters.
    if (!/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+$/.test(address)) {
      throw new Error("address contains characters that aren't valid in an email address");
    }
    const table = cfg.table ?? "delivery";
    const toCol = cfg.toColumn ?? "to_email";
    const bodyCol = cfg.bodyColumn ?? "body";
    const createdCol = cfg.createdColumn ?? "created_at";
    const sql = `SELECT ${bodyCol}, subject, ${createdCol} FROM ${table} WHERE ${toCol} = '${address}' ORDER BY ${createdCol} DESC LIMIT 5;`;

    const { execFileSync } = await import("node:child_process");
    const out = execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        cfg.database,
        cfg.remote === false ? "--local" : "--remote",
        "--command",
        sql,
        "--json",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    const start = out.indexOf("[");
    const rows = start === -1 ? [] : (JSON.parse(out.slice(start))[0]?.results ?? []);
    if (rows.length === 0) throw new Error(`no mail found for ${address} in ${table}`);

    for (const row of rows as Array<Record<string, string>>) {
      const links = String(row[bodyCol] ?? "").match(/https?:\/\/[^\s<>"')]+/g) ?? [];
      const match = contains ? links.find((l) => l.includes(contains)) : links[0];
      if (match) {
        return jsonResult({
          link: match,
          subject: row.subject,
          sentAt: row[createdCol],
          allLinks: links.slice(0, 5),
        });
      }
    }
    throw new Error(
      `mail found for ${address} but no link${contains ? ` containing "${contains}"` : ""} in the ${rows.length} most recent message(s)`
    );
  }
);

// --- flows ------------------------------------------------------------------
// Flow files live in the repo at .argus/flows/<name>.json — git-reviewed,
// human-readable, the project's living test suite. The cloud replays them
// deterministically; this process reads/writes the files.

function flowsDir(): string {
  // Walk up from cwd to the directory holding .argus (or create one at cwd).
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, ".argus"))) return join(dir, ".argus", "flows");
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return join(process.cwd(), ".argus", "flows");
}

/**
 * Secrets/inputs: any string in a flow file may contain `${VAR}` placeholders
 * (login emails, passwords, app URLs). They resolve from the environment at
 * replay time — on this machine, before anything is sent to the cloud — so
 * secrets never live in the committed flow file. A missing variable is a
 * loud error naming what to provide, so the agent can ask the user for it.
 */
function resolveEnv(value: unknown, missing: Set<string>): unknown {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
      const v = process.env[name];
      if (v === undefined) {
        missing.add(name);
        return "";
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map((v) => resolveEnv(v, missing));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, resolveEnv(v, missing)])
    );
  }
  return value;
}

/** Raw flow JSON from disk — placeholders intact (for listing and heal-rewrite). */
function loadFlowsRaw(names?: string[]): Array<Record<string, unknown>> {
  const dir = flowsDir();
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
  const flows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const name = basename(f, ".json");
    if (names && !names.includes(name)) continue;
    flows.push(JSON.parse(readFileSync(join(dir, f), "utf8")));
  }
  return flows;
}

/** Env-resolved, schema-validated flows — what actually gets replayed. */
function loadFlows(names?: string[]): Flow[] {
  return loadFlowsRaw(names).map((raw) => {
    const missing = new Set<string>();
    const resolved = resolveEnv(raw, missing);
    if (missing.size > 0) {
      throw new Error(
        `flow "${String(raw.name)}" needs values for: ${[...missing].join(", ")} — ask the user to provide them ` +
          `(export ${[...missing][0]}=... in the environment running argus, or set them in .mcp.json env), then retry`
      );
    }
    return FlowSchema.parse(resolved);
  });
}

function saveFlow(flow: Flow): string {
  const dir = flowsDir();
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${flow.name}.json`);
  writeFileSync(file, JSON.stringify(flow, null, 2) + "\n");
  return file;
}

server.tool(
  "argus_record",
  "Start or stop recording on a session. While recording, every successful argus_act is captured as a semantic-anchored flow step (testid → role+name → text — never volatile refs). stop returns the recorded steps; then call argus_flow_save with success predicates to persist the flow.",
  {
    sessionId: z.string(),
    action: z.enum(["start", "stop"]),
    name: z.string().optional(),
  },
  async ({ sessionId, action, name }) =>
    jsonResult(
      await api(
        "POST",
        `/v1/session/${sessionId}/record-${action}`,
        action === "start" ? { name } : {}
      )
    )
);

server.tool(
  "argus_flow_save",
  "Persist a flow to .argus/flows/<name>.json (git-reviewed, replayable forever). Provide the steps (usually from argus_record stop, optionally with per-step expect predicates added) and the success predicates — the golden end condition, ideally network/route consequences rather than DOM presence.",
  {
    name: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/),
    startUrl: z.string().url(),
    viewport: ViewportNameSchema.optional(),
    steps: z
      .array(
        z.object({
          action: ActionSchema,
          anchor: AnchorSchema.optional(),
          expect: z.array(PredicateSchema).optional(),
          label: z.string().optional(),
        })
      )
      .min(1),
    success: z.array(PredicateSchema).min(1),
    dynamic: z.array(AnchorSchema).optional(),
    auth: z
      .string()
      .optional()
      .describe("run this flow signed in, using a saved auth profile"),
    saveAuthAs: z
      .string()
      .optional()
      .describe("this is a login flow: on success, save the session as this profile"),
  },
  async (args) => {
    const flow = FlowSchema.parse({
      version: 1,
      name: args.name,
      startUrl: args.startUrl,
      viewport: args.viewport ?? "desktop",
      steps: args.steps.map((s) => ({ ...s, expect: s.expect ?? [] })),
      success: args.success,
      dynamic: args.dynamic ?? [],
      ...(args.auth ? { auth: args.auth } : {}),
      ...(args.saveAuthAs ? { saveAuthAs: args.saveAuthAs } : {}),
    });
    const file = saveFlow(flow);
    return jsonResult({ saved: file, steps: flow.steps.length });
  }
);

server.tool(
  "argus_flow_list",
  "List the flows saved in .argus/flows/.",
  {},
  async () =>
    jsonResult(
      loadFlowsRaw().map((f) => ({
        name: f.name,
        startUrl: f.startUrl,
        steps: Array.isArray(f.steps) ? f.steps.length : 0,
      }))
    )
);

server.tool(
  "argus_flow_replay",
  "Deterministically replay one saved flow in the cloud (no model). Returns ok / drift / error with a decision envelope: what changed, the nearest surviving anchor, and the next action.",
  { name: z.string() },
  async ({ name }) => {
    const flows = loadFlows([name]);
    if (flows.length === 0) throw new Error(`flow "${name}" not found in ${flowsDir()}`);
    return jsonResult(await api("POST", "/v1/flow/replay", { flow: flows[0] }));
  }
);

server.tool(
  "argus_flow_verify",
  "Replay EVERY saved flow (or a named subset) in parallel in the cloud — the regression check to run after any change. Returns one consolidated verdict; only failures carry detail. Pass baseUrl to run the same suite against another environment (a version-preview or staging URL) without editing any flow file. Login flows run first so authenticated flows never race a missing profile.",
  {
    names: z.array(z.string()).optional(),
    concurrency: z.number().int().min(1).max(8).optional(),
    baseUrl: z
      .string()
      .url()
      .optional()
      .describe("re-home the suite onto this origin (deploy gating)"),
    project: z.string().optional().describe("tag the run so the dashboard groups it per app"),
  },
  async ({ names, concurrency, baseUrl, project }) => {
    const flows = loadFlows(names);
    if (flows.length === 0) throw new Error(`no flows found in ${flowsDir()}`);
    return jsonResult(
      await api("POST", "/v1/flows/verify", { flows, concurrency, baseUrl, project })
    );
  }
);

server.tool(
  "argus_flow_heal",
  "Propose (apply:false, default) or apply (apply:true) nearest-match anchor rebinds for a drifted flow. Proposals come from replaying against the live page; apply rewrites .argus/flows/<name>.json.",
  { name: z.string(), apply: z.boolean().optional() },
  async ({ name, apply }) => {
    const flows = loadFlows([name]);
    if (flows.length === 0) throw new Error(`flow "${name}" not found`);
    const result = (await api("POST", "/v1/flow/replay", { flow: flows[0], heal: true })) as {
      status: string;
      proposals?: Array<{ step: number; from: string; to: string; confidence: number }>;
    };
    if (apply && result.proposals?.length) {
      // Rewrite the RAW file (placeholders intact) — never persist resolved secrets.
      const raw = loadFlowsRaw([name])[0] as unknown as Flow;
      for (const p of result.proposals) {
        const step = raw.steps[p.step];
        if (step?.anchor?.testid === p.from) step.anchor.testid = p.to;
      }
      const file = saveFlow(raw);
      return jsonResult({ ...result, applied: true, file });
    }
    return jsonResult({ ...result, applied: false });
  }
);

server.tool(
  "argus_flow_import_reticle",
  "Import flows from a Reticle workspace (.reticle/flows/*.json) into .argus/flows/. Maps testid/role anchors and success conditions; signal-based predicates (which need Reticle's in-app SDK) are converted to console-clean guards with a warning.",
  { startUrl: z.string().url().describe("the app URL these flows run against") },
  async ({ startUrl }) => {
    let dir = process.cwd();
    let reticleDir: string | undefined;
    for (;;) {
      if (existsSync(join(dir, ".reticle", "flows"))) {
        reticleDir = join(dir, ".reticle", "flows");
        break;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    if (!reticleDir) throw new Error("no .reticle/flows directory found walking up from cwd");

    const imported: string[] = [];
    const warnings: string[] = [];
    for (const f of readdirSync(reticleDir).filter((x) => x.endsWith(".json"))) {
      const raw = JSON.parse(readFileSync(join(reticleDir, f), "utf8"));
      const source = raw.flow ?? raw;
      const name = String(source.name ?? raw.name ?? basename(f, ".json")).replace(
        /[^a-zA-Z0-9_-]/g,
        "-"
      );
      const toAnchor = (anchor: Record<string, unknown> | undefined) => {
        if (!anchor) return undefined;
        if (typeof anchor.testid === "string") return { testid: anchor.testid };
        if (anchor.kind === "testid" && typeof anchor.value === "string") return { testid: anchor.value };
        if (typeof anchor.role === "string") {
          return { role: anchor.role, ...(typeof anchor.name === "string" ? { name: anchor.name } : {}) };
        }
        return undefined;
      };
      const toPredicates = (expect: Record<string, any> | undefined) => {
        const predicates: Array<Record<string, unknown>> = [];
        if (!expect) return predicates;
        if (expect.net) {
          predicates.push({
            kind: "network",
            urlIncludes: expect.net.urlContains ?? "",
            ...(expect.net.method ? { method: expect.net.method } : {}),
            ...(expect.net.status !== undefined ? { status: expect.net.status } : {}),
            minCount: expect.net.count ?? 1,
            ...(expect.net.count !== undefined ? { maxCount: expect.net.count } : {}),
            since: 0,
          });
        }
        if (expect.console?.absent !== false && expect.console) {
          predicates.push({ kind: "console-clean", since: 0 });
        } else if (expect.console) {
          warnings.push(`${name}: positive console expectation is not portable and was skipped`);
        }
        if (expect.element) {
          const anchor = toAnchor(expect.element);
          if (anchor) predicates.push({ kind: "visible", anchor });
        }
        if (expect.state?.path) {
          predicates.push({
            kind: "state",
            store: expect.state.store ?? "default",
            path: expect.state.path,
            ...(expect.state.equals !== undefined ? { equals: expect.state.equals } : { exists: true }),
          });
        }
        if (expect.signal) {
          warnings.push(
            `${name}: signal expect "${expect.signal}" → console-clean guard (Reticle and Argus SDK signals are not interchangeable)`
          );
          predicates.push({ kind: "console-clean", since: 0 });
        }
        return predicates;
      };
      const steps = (source.steps ?? []).flatMap((s: Record<string, any>) => {
        const anchor = toAnchor(s.anchor);
        if (!anchor) {
          warnings.push(`${name}: skipped a step with an unsupported ${String(s.anchor?.kind ?? "missing")} anchor`);
          return [];
        }
        const actionName = s.action ?? "click";
        const args = s.args ?? {};
        let action: Record<string, unknown> | undefined;
        if (actionName === "click" || actionName === "hover") action = { action: actionName };
        else if (actionName === "fill" || actionName === "type") {
          action = { action: "fill", value: String(args.value ?? args.text ?? "") };
        } else if (actionName === "select") action = { action: "select", value: String(args.value ?? "") };
        else if (actionName === "press") action = { action: "press", key: String(args.key ?? "Enter") };
        if (!action) {
          warnings.push(`${name}: skipped unsupported action "${String(actionName)}"`);
          return [];
        }
        return [{ action, anchor, expect: toPredicates(s.expect) }];
      });
      if (steps.length === 0) {
        warnings.push(`${name}: skipped — no anchored steps`);
        continue;
      }
      const success = toPredicates(source.success);
      if (success.length === 0) {
        warnings.push(`${name}: no portable success condition; added console-clean (add a network/route assertion)`);
        success.push({ kind: "console-clean", since: 0 });
      }
      const importedUrl = source.startPath
        ? new URL(String(source.startPath), startUrl).toString()
        : startUrl;
      const flow = FlowSchema.parse({
        version: 1,
        name,
        startUrl: importedUrl,
        viewport: "desktop",
        steps,
        success,
        dynamic: [],
      });
      imported.push(saveFlow(flow));
    }
    return jsonResult({ imported, warnings });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);

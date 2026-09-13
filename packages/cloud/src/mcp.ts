/**
 * Remote MCP endpoint — Argus as a service an agent connects to by URL.
 *
 * The stdio server in packages/mcp runs on a developer's machine and owns the
 * repo's `.argus/flows/*.json`. This endpoint is the other half: it runs in the
 * Worker, authenticates the connection's tenant token, and forwards every tool
 * to the Worker's own /v1 API in-process — so the logic is byte-for-byte the
 * same as the CLI and the stdio server, with no second implementation to drift.
 *
 * Flows live in R2 per tenant (see flows-store.ts), which is what removes the
 * need for a checkout. Tools that inherently touch the local disk — importing
 * Reticle files, reading a local D1 outbox via wrangler — stay in the stdio
 * server only.
 *
 * Stateless by design: one server + transport per request, JSON responses,
 * no session id. Workers isolates come and go; nothing depends on staying warm.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import {
  ActionSchema,
  AnchorSchema,
  PredicateSchema,
  ViewportNameSchema,
} from "@argus/shared";
import type { Env } from "./env";
import { getFlow, listFlows } from "./flows-store";

export interface McpDeps {
  env: Env;
  /** Resolved by the caller from the bearer token — never trusted from input. */
  tenantId: string;
  /** The Worker's own origin, used to build the internal /v1 request. */
  origin: string;
  /** The bearer token this connection authenticated with. */
  token: string;
  /** In-process dispatch into the Worker's Hono app. */
  dispatch(request: Request): Promise<Response>;
}

export async function handleMcp(request: Request, deps: McpDeps): Promise<Response> {
  const server = buildServer(deps);
  const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
  await server.connect(transport);
  return transport.handleRequest(request);
}

function buildServer(deps: McpDeps): McpServer {
  const jsonResult = (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
  });

  /** Call this Worker's own API as the connection's tenant. */
  const call = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const res = await deps.dispatch(
      new Request(deps.origin + path, {
        ...init,
        headers: {
          authorization: `Bearer ${deps.token}`,
          "content-type": "application/json",
          ...((init.headers as Record<string, string> | undefined) ?? {}),
        },
      })
    );
    const text = await res.text();
    let data: unknown;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = data as { error?: string; detail?: string };
      throw new Error(`${err.error ?? res.status}${err.detail ? ` — ${err.detail}` : ""}`);
    }
    return data;
  };

  const server = new McpServer(
    { name: "argus", version: "0.1.0" },
    {
      instructions: `Argus runs a real cloud Chromium and returns evidence-graded verdicts.

Loop: argus_lease a URL (one session per concurrent agent) → argus_query → argus_act_batch →
argus_observe → argus_assert (network / route / console-clean / stream / storage / signal /
state, composed with allOf/anyOf) → argus_screenshot → argus_release.

Record a journey with argus_record, save it with argus_flow_save (it lives on the server for
this tenant), and re-verify forever with argus_flow_verify. Only argus_assert and flow
expect/success predicates produce a verdict — argus_act proves nothing. A verdict reports the
WEAKEST evidence tier it rests on; never upgrade it. Release every session.`,
    }
  );

  const catalog: Array<{ name: string; yieldsVerdict: boolean }> = [];
  const VERDICT_TOOLS = new Set(["argus_assert", "argus_flow_replay", "argus_flow_verify"]);
  function tool<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    schema: Shape,
    handler: (args: z.infer<z.ZodObject<Shape>>) => Promise<unknown>
  ) {
    catalog.push({ name, yieldsVerdict: VERDICT_TOOLS.has(name) });
    return (server.tool as (...args: unknown[]) => unknown)(name, description, schema, handler);
  }

  // --- sessions --------------------------------------------------------------
  tool(
    "argus_lease",
    "Lease an isolated cloud browser session pointed at a URL. Returns a sessionId used by every other argus tool. Each parallel agent/flow should hold its own lease.",
    {
      url: z.string().url(),
      viewport: ViewportNameSchema.optional(),
      colorScheme: z.enum(["light", "dark"]).optional(),
      label: z.string().max(80).optional(),
      authProfile: z.string().optional().describe("start already signed in (see argus_auth_list)"),
    },
    async (args) => jsonResult(await call("/v1/lease", { method: "POST", body: JSON.stringify(args) }))
  );

  tool(
    "argus_release",
    "Release a leased session, freeing its slot.",
    { sessionId: z.string() },
    async ({ sessionId }) => jsonResult(await call(`/v1/session/${sessionId}`, { method: "DELETE" }))
  );

  tool("argus_sessions", "List active cloud browser sessions.", {}, async () =>
    jsonResult(await call("/v1/sessions"))
  );

  // --- drive / read ----------------------------------------------------------
  tool(
    "argus_query",
    "Find elements by the anchor ladder (testid → role+name → text → css), or list the interactive surface. Returns refs.",
    {
      sessionId: z.string(),
      anchor: AnchorSchema.optional(),
      interactive: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
    async ({ sessionId, ...body }) =>
      jsonResult(await call(`/v1/session/${sessionId}/query`, { method: "POST", body: JSON.stringify(body) }))
  );

  tool(
    "argus_act",
    "Perform one action (goto/click/fill/select/press/hover/scroll/back/reload/wait) and report the observed effects. Does NOT produce a verdict.",
    { sessionId: z.string(), action: ActionSchema, ref: z.string().optional(), anchor: AnchorSchema.optional() },
    async ({ sessionId, ...body }) =>
      jsonResult(await call(`/v1/session/${sessionId}/act`, { method: "POST", body: JSON.stringify(body) }))
  );

  tool(
    "argus_act_batch",
    "Run up to 50 ordered actions in one call; per-step effects, stops on the first failure by default.",
    {
      sessionId: z.string(),
      steps: z.array(
        z.object({ action: ActionSchema, anchor: AnchorSchema.optional(), ref: z.string().optional() })
      ).min(1).max(50),
      stopOnError: z.boolean().optional(),
    },
    async ({ sessionId, ...body }) =>
      jsonResult(await call(`/v1/session/${sessionId}/act-batch`, { method: "POST", body: JSON.stringify(body) }))
  );

  tool(
    "argus_observe",
    "Read network requests, console messages, stream events (WebSocket frames / SSE connections) and the current route since a cursor.",
    {
      sessionId: z.string(),
      since: z.number().int().optional(),
      what: z.array(z.enum(["network", "console", "route", "stream"])).optional(),
    },
    async ({ sessionId, ...body }) =>
      jsonResult(await call(`/v1/session/${sessionId}/observe`, { method: "POST", body: JSON.stringify(body) }))
  );

  tool(
    "argus_assert",
    "Assert evidence-tiered predicates: network, console-clean, route, stream, storage, visible/hidden/text, and (with the SDK) signal/state. Compose with allOf/anyOf. The verdict reports the WEAKEST tier it rests on — prefer network/route/signal over DOM presence.",
    { sessionId: z.string(), predicates: z.array(PredicateSchema).min(1).max(20) },
    async ({ sessionId, predicates }) =>
      jsonResult(await call(`/v1/session/${sessionId}/assert`, { method: "POST", body: JSON.stringify({ predicates }) }))
  );

  tool(
    "argus_screenshot",
    "Screenshot the page; returns an artifact URL you can fetch.",
    { sessionId: z.string(), fullPage: z.boolean().optional(), label: z.string().max(80).optional() },
    async ({ sessionId, ...body }) =>
      jsonResult(await call(`/v1/session/${sessionId}/screenshot`, { method: "POST", body: JSON.stringify(body) }))
  );

  // --- auth profiles ---------------------------------------------------------
  tool(
    "argus_auth_save",
    "Save this session's cookies/localStorage as a reusable auth profile — call it AFTER driving a real login.",
    { sessionId: z.string(), profile: z.string() },
    async ({ sessionId, profile }) =>
      jsonResult(await call(`/v1/session/${sessionId}/auth-save`, { method: "POST", body: JSON.stringify({ profile }) }))
  );

  tool("argus_auth_list", "List saved auth profiles with their age.", {}, async () =>
    jsonResult(await call("/v1/auth/profiles"))
  );

  tool(
    "argus_auth_delete",
    "Delete a saved auth profile (host-scoped — pass the host from argus_auth_list).",
    { profile: z.string(), host: z.string() },
    async ({ profile, host }) =>
      jsonResult(await call(`/v1/auth/profile/${encodeURIComponent(profile)}?host=${encodeURIComponent(host)}`, { method: "DELETE" }))
  );

  // --- verification runs -----------------------------------------------------
  tool(
    "argus_smoke",
    "Zero-config smoke suite: load, console/network clean, responsive overflow, screenshots.",
    {
      url: z.string().url(),
      viewports: z.array(ViewportNameSchema).optional(),
      colorSchemes: z.array(z.enum(["light", "dark"])).optional(),
      project: z.string().max(60).optional(),
    },
    async (args) => jsonResult(await call("/v1/smoke", { method: "POST", body: JSON.stringify(args) }))
  );

  tool(
    "argus_audit",
    "Full UX/visual audit: axe-core a11y, perf (FCP/LCP/CLS), broken links, overflow, visual regression.",
    {
      url: z.string().url(),
      viewports: z.array(ViewportNameSchema).optional(),
      colorSchemes: z.array(z.enum(["light", "dark"])).optional(),
      checks: z.array(z.enum(["a11y", "perf", "links", "visual"])).optional(),
      updateBaseline: z.boolean().optional(),
      project: z.string().max(60).optional(),
    },
    async (args) => jsonResult(await call("/v1/audit", { method: "POST", body: JSON.stringify(args) }))
  );

  tool("argus_runs", "List recent verification runs.", {}, async () => jsonResult(await call("/v1/runs")));

  tool(
    "argus_findings",
    "Full report for a run: findings, severities, decision envelopes, perf, visual diffs, flow verdicts.",
    { runId: z.string() },
    async ({ runId }) => jsonResult(await call(`/v1/run/${encodeURIComponent(runId)}`))
  );

  // --- recording + flows (stored server-side for this tenant) ----------------
  tool(
    "argus_record",
    "Start or stop recording this session's successful acts as semantic-anchored flow steps.",
    { sessionId: z.string(), action: z.enum(["start", "stop"]), name: z.string().optional() },
    async ({ sessionId, action, name }) =>
      jsonResult(
        await call(`/v1/session/${sessionId}/record-${action}`, {
          method: "POST",
          body: JSON.stringify(action === "start" ? { name } : {}),
        })
      )
  );

  tool(
    "argus_flow_save",
    "Save a deterministic flow for this tenant (server-side). Provide the steps (usually from argus_record stop, with per-step expect predicates) and success predicates — prefer network/route consequences over DOM presence.",
    {
      name: z.string(),
      startUrl: z.string().url(),
      steps: z.array(
        z.object({ action: ActionSchema, anchor: AnchorSchema.optional(), expect: z.array(PredicateSchema).optional(), label: z.string().optional() })
      ).min(1),
      success: z.array(PredicateSchema).min(1),
      viewport: ViewportNameSchema.optional(),
      dynamic: z.array(AnchorSchema).optional(),
      auth: z.string().optional(),
      saveAuthAs: z.string().optional(),
    },
    async (args) => jsonResult(await call(`/v1/flows/${encodeURIComponent(args.name)}`, { method: "PUT", body: JSON.stringify(args) }))
  );

  tool("argus_flow_list", "List the flows saved for this tenant.", {}, async () =>
    jsonResult(await call("/v1/flows"))
  );

  tool(
    "argus_flow_delete",
    "Delete a saved flow.",
    { name: z.string() },
    async ({ name }) => jsonResult(await call(`/v1/flows/${encodeURIComponent(name)}`, { method: "DELETE" }))
  );

  tool(
    "argus_flow_replay",
    "Deterministically replay one saved flow (no model); returns ok/drift/error with a decision envelope.",
    { name: z.string(), heal: z.boolean().optional() },
    async ({ name, heal }) => {
      const flow = await getFlow(deps.env, deps.tenantId, name);
      if (!flow) throw new Error(`no flow named "${name}" — argus_flow_list to see what exists`);
      return jsonResult(await call("/v1/flow/replay", { method: "POST", body: JSON.stringify({ flow, heal: heal ?? false }) }));
    }
  );

  tool(
    "argus_flow_verify",
    "Replay every saved flow (or a subset) in parallel; baseUrl re-homes the suite onto another environment. This is the regression gate — run it after every change.",
    {
      names: z.array(z.string()).optional(),
      baseUrl: z.string().url().optional(),
      concurrency: z.number().int().min(1).max(8).optional(),
      project: z.string().max(60).optional(),
    },
    async ({ names, baseUrl, concurrency, project }) => {
      const all = await listFlows(deps.env, deps.tenantId);
      const flows = names?.length ? all.filter((f) => names.includes(f.name)) : all;
      if (flows.length === 0) {
        throw new Error("no saved flows — record one (argus_record → argus_flow_save) or run `argus preset`");
      }
      return jsonResult(
        await call("/v1/flows/verify", {
          method: "POST",
          body: JSON.stringify({ flows, baseUrl, concurrency, project }),
        })
      );
    }
  );

  tool(
    "argus_tools",
    "List every tool this endpoint exposes and whether it returns a verdict.",
    {},
    async () => jsonResult({ tools: catalog, note: "Only tools with yieldsVerdict: true produce pass/fail evidence." })
  );

  return server;
}

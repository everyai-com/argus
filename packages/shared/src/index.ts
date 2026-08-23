/**
 * @argus/shared — the wire contract.
 *
 * Every constant and schema that crosses a boundary (CLI ⇄ cloud, MCP ⇄ cloud,
 * dashboard ⇄ cloud) lives here, once. The Worker zod-parses every inbound
 * request body against these schemas; clients type against the same shapes.
 * Neither side can invent a message the other doesn't understand.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const API_VERSION = "v1" as const;
export const DEFAULT_LEASE_TTL_SECONDS = 300;
export const MAX_LEASE_TTL_SECONDS = 540; // browser keep_alive hard cap is 600s
export const RING_BUFFER_LIMIT = 500;

export const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const ViewportNameSchema = z.enum(["mobile", "tablet", "desktop"]);

/** Evidence tiers, strongest first (adopted from Reticle's grading). */
export const EvidenceTierSchema = z.enum([
  "signal", // tier 1 — an app-emitted signal (requires SDK opt-in)
  "consequence", // tier 2 — network + route + state truth
  "dom", // tier 3 — DOM/text presence (weakest)
  "visual", // screenshot-based evidence
]);
export type EvidenceTier = z.infer<typeof EvidenceTierSchema>;

// ---------------------------------------------------------------------------
// Anchors — semantic element addressing with a resolution ladder
// (testid → role+name → text → css). Verify-or-refuse: a step that cannot
// verify its outcome fails loudly, it never "probably worked".
// ---------------------------------------------------------------------------

export const AnchorSchema = z
  .object({
    testid: z.string().optional(),
    role: z.string().optional(),
    name: z.string().optional(), // accessible name, used with role
    text: z.string().optional(), // visible text content
    css: z.string().optional(), // last-resort structural selector
  })
  .refine((a) => a.testid || a.role || a.text || a.css, {
    message: "anchor needs at least one of testid/role/text/css",
  });
export type Anchor = z.infer<typeof AnchorSchema>;

/** How an anchor actually resolved — recorded so drift is explainable. */
export const AnchorResolutionSchema = z.object({
  via: z.enum(["testid", "role", "text", "css"]),
  matched: z.number().int(), // how many elements matched (1 is healthy)
});
export type AnchorResolution = z.infer<typeof AnchorResolutionSchema>;

// ---------------------------------------------------------------------------
// Sessions / leases
// ---------------------------------------------------------------------------

/**
 * Auth profile name — a saved browser storage state (cookies + localStorage)
 * captured after a login flow, so every other flow starts already signed in.
 * Profiles live in R2 behind the API token, never on disk in the repo.
 */
export const AuthProfileNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "single safe path segment")
  .max(60);

export const LeaseRequestSchema = z.object({
  url: z.string().url(),
  viewport: ViewportNameSchema.default("desktop"),
  colorScheme: z.enum(["light", "dark"]).default("light"),
  ttlSeconds: z
    .number()
    .int()
    .min(30)
    .max(MAX_LEASE_TTL_SECONDS)
    .default(DEFAULT_LEASE_TTL_SECONDS),
  label: z.string().max(80).optional(), // e.g. the flow being driven
  /** Start this session already signed in, using a saved auth profile. */
  authProfile: AuthProfileNameSchema.optional(),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

export const LeaseResponseSchema = z.object({
  sessionId: z.string(),
  ready: z.boolean(),
  url: z.string(),
  title: z.string().optional(),
  expiresAt: z.string(), // ISO timestamp
});
export type LeaseResponse = z.infer<typeof LeaseResponseSchema>;

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  url: z.string().optional(),
  label: z.string().optional(),
  createdAt: z.string(),
  expiresAt: z.string(),
  released: z.boolean().default(false),
  /** Which tenant (project) holds this lease — drives per-tenant fair capping. */
  tenantId: z.string().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// ---------------------------------------------------------------------------
// Multi-tenant — many projects share one CF browser fleet, fairly.
//
// Each tenant gets its own token, a RESERVED floor (browsers it can always
// get, even under contention) and a burst CEILING. Admission honours every
// tenant's floor before letting anyone burst into shared headroom, so a greedy
// project can never starve a reserved one. The warm pool and the 1/sec launch
// limiter stay GLOBAL — a parked Chromium is tenant-agnostic, and the launch
// rate is a physical account limit, not a per-tenant one.
// ---------------------------------------------------------------------------

export const TenantIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase id, single safe path segment")
  .max(40);

/** Public view of a tenant — never carries the token (only its hash is stored). */
export const TenantSchema = z.object({
  id: TenantIdSchema,
  name: z.string().max(80),
  /** Guaranteed concurrent browsers — the floor admission always satisfies. */
  reserved: z.number().int().min(0).max(120).default(0),
  /** Hard ceiling on this tenant's concurrent browsers (its burst cap). */
  maxBurst: z.number().int().min(1).max(120).default(120),
  createdAt: z.string(),
  disabled: z.boolean().default(false),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const CreateTenantRequestSchema = z.object({
  id: TenantIdSchema,
  name: z.string().max(80).optional(),
  reserved: z.number().int().min(0).max(120).default(0),
  maxBurst: z.number().int().min(1).max(120).default(120),
});
export type CreateTenantRequest = z.infer<typeof CreateTenantRequestSchema>;

export const UpdateTenantRequestSchema = z
  .object({
    name: z.string().max(80).optional(),
    reserved: z.number().int().min(0).max(120).optional(),
    maxBurst: z.number().int().min(1).max(120).optional(),
    disabled: z.boolean().optional(),
  })
  .refine((p) => Object.keys(p).length > 0, { message: "empty update" });
export type UpdateTenantRequest = z.infer<typeof UpdateTenantRequestSchema>;

/** A freshly minted tenant, returned once with its raw token (never re-shown). */
export const TenantCreatedSchema = z.object({
  tenant: TenantSchema,
  token: z.string(), // show once; only the hash is persisted
});
export type TenantCreated = z.infer<typeof TenantCreatedSchema>;

/** One tenant's live slice of the fleet. */
export const TenantUsageSchema = z.object({
  id: TenantIdSchema,
  name: z.string(),
  active: z.number().int(),
  reserved: z.number().int(),
  maxBurst: z.number().int(),
  disabled: z.boolean().default(false),
});
export type TenantUsage = z.infer<typeof TenantUsageSchema>;

/** Fleet capacity snapshot for the live dashboard + fairness proofs. */
export const CapacityStatsSchema = z.object({
  active: z.number().int(),
  cap: z.number().int(),
  warm: z.number().int(),
  warmCap: z.number().int(),
  /** How far ahead the next cold-launch slot is booked (0 = launch now). */
  launchQueueMs: z.number().int(),
  reservedTotal: z.number().int(), // Σ reserved across tenants (must be ≤ cap)
  cumulative: z.object({
    acquires: z.number().int(),
    rejects: z.number().int(),
    launches: z.number().int(),
    releases: z.number().int(),
  }),
  since: z.string(),
  tenants: z.array(TenantUsageSchema).default([]),
});
export type CapacityStats = z.infer<typeof CapacityStatsSchema>;

// ---------------------------------------------------------------------------
// Platform projects — committed configuration consumed by the GitHub App.
// This deliberately contains no credentials: auth profiles and provider
// secrets remain tenant-scoped in Argus/Cloudflare, never in the repository.
// ---------------------------------------------------------------------------

export const PlatformCheckSchema = z.enum(["smoke", "audit", "flows"]);
export type PlatformCheck = z.infer<typeof PlatformCheckSchema>;

export const GitHubPlatformConfigSchema = z
  .object({
    targetUrl: z.string().url(),
    project: z.string().max(60).optional(),
    checks: z
      .array(PlatformCheckSchema)
      .min(1)
      .default(["smoke", "audit", "flows"]),
    viewports: z.array(ViewportNameSchema).min(1).default(["mobile", "desktop"]),
    colorSchemes: z
      .array(z.enum(["light", "dark"]))
      .min(1)
      .default(["light"]),
    flowConcurrency: z.number().int().min(1).max(8).default(3),
    authProfile: AuthProfileNameSchema.optional(),
  })
  .strict();
export type GitHubPlatformConfig = z.infer<typeof GitHubPlatformConfigSchema>;

// ---------------------------------------------------------------------------
// Query — find elements, get stable refs
// ---------------------------------------------------------------------------

export const QueryRequestSchema = z.object({
  anchor: AnchorSchema.optional(), // resolve a specific target
  interactive: z.boolean().default(false), // or: list the interactive surface
  limit: z.number().int().min(1).max(100).default(30),
});
export type QueryRequest = z.infer<typeof QueryRequestSchema>;

export const ElementRefSchema = z.object({
  ref: z.string(), // e.g. "e12" — stable for the life of the page
  role: z.string().optional(),
  name: z.string().optional(),
  testid: z.string().optional(),
  text: z.string().optional(), // trimmed, capped
  tag: z.string().optional(),
  visible: z.boolean(),
  enabled: z.boolean().optional(),
  bounds: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
});
export type ElementRef = z.infer<typeof ElementRefSchema>;

export const QueryResponseSchema = z.object({
  elements: z.array(ElementRefSchema),
  resolution: AnchorResolutionSchema.optional(),
  pageUrl: z.string(),
  pageTitle: z.string(),
});
export type QueryResponse = z.infer<typeof QueryResponseSchema>;

// ---------------------------------------------------------------------------
// Act — perform an action; report its observed effects (never just "done")
// ---------------------------------------------------------------------------

export const ActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("goto"), url: z.string().url() }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("reload") }),
  z.object({
    action: z.literal("click"),
    ref: z.string().optional(),
    anchor: AnchorSchema.optional(),
  }),
  z.object({
    action: z.literal("fill"),
    ref: z.string().optional(),
    anchor: AnchorSchema.optional(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("select"),
    ref: z.string().optional(),
    anchor: AnchorSchema.optional(),
    value: z.string(),
  }),
  z.object({
    action: z.literal("press"),
    key: z.string(), // e.g. "Enter"
    ref: z.string().optional(),
    anchor: AnchorSchema.optional(),
  }),
  z.object({
    action: z.literal("hover"),
    ref: z.string().optional(),
    anchor: AnchorSchema.optional(),
  }),
  z.object({
    action: z.literal("scroll"),
    direction: z.enum(["up", "down"]).default("down"),
    amount: z.number().int().default(600),
  }),
  z.object({ action: z.literal("wait"), ms: z.number().int().min(50).max(10_000) }),
]);
export type Action = z.infer<typeof ActionSchema>;

/** What actually happened as a result of an action. */
export const ActEffectsSchema = z.object({
  urlBefore: z.string(),
  urlAfter: z.string(),
  navigated: z.boolean(),
  domNodeDelta: z.number(), // crude but honest mutation signal
  newConsoleErrors: z.number(),
  newNetworkFailures: z.number(),
  focusMoved: z.boolean().optional(),
});
export type ActEffects = z.infer<typeof ActEffectsSchema>;

export const ActResultSchema = z.object({
  ok: z.boolean(),
  effects: ActEffectsSchema.optional(),
  resolution: AnchorResolutionSchema.optional(),
  error: z.string().optional(),
});
export type ActResult = z.infer<typeof ActResultSchema>;

/** Batched actions (axstream-style): executed in order, per-step effects. */
export const ActBatchRequestSchema = z.object({
  steps: z.array(ActionSchema).min(1).max(50),
  stopOnError: z.boolean().default(true),
});
export type ActBatchRequest = z.infer<typeof ActBatchRequestSchema>;

export const ActBatchResultSchema = z.object({
  results: z.array(ActResultSchema),
  completed: z.number().int(),
});
export type ActBatchResult = z.infer<typeof ActBatchResultSchema>;

// ---------------------------------------------------------------------------
// Observe — network / console / route digests from the ring buffers
// ---------------------------------------------------------------------------

export const NetworkEventSchema = z.object({
  seq: z.number().int(),
  method: z.string(),
  url: z.string(),
  status: z.number().int().optional(), // absent = still pending or failed
  failed: z.boolean().default(false),
  resourceType: z.string().optional(),
  durationMs: z.number().optional(),
});
export type NetworkEvent = z.infer<typeof NetworkEventSchema>;

export const ConsoleEventSchema = z.object({
  seq: z.number().int(),
  level: z.enum(["log", "info", "warn", "error"]),
  text: z.string(),
  /** URL of the script that emitted this (absent for page-level errors). */
  sourceUrl: z.string().optional(),
});
export type ConsoleEvent = z.infer<typeof ConsoleEventSchema>;

export const ObserveRequestSchema = z.object({
  since: z.number().int().default(0), // cursor: only events with seq > since
  what: z
    .array(z.enum(["network", "console", "route"]))
    .default(["network", "console", "route"]),
});
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;

export const ObserveResponseSchema = z.object({
  cursor: z.number().int(),
  network: z.array(NetworkEventSchema).default([]),
  console: z.array(ConsoleEventSchema).default([]),
  route: z.object({ url: z.string(), title: z.string() }).optional(),
});
export type ObserveResponse = z.infer<typeof ObserveResponseSchema>;

// ---------------------------------------------------------------------------
// Assert — evidence-tiered predicates over program truth
// ---------------------------------------------------------------------------

export const PredicateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("network"),
    urlIncludes: z.string(),
    method: z.string().optional(),
    status: z.number().int().optional(), // expected status
    minCount: z.number().int().default(1),
    maxCount: z.number().int().optional(), // cardinality guard (e.g. exactly 1 POST)
    since: z.number().int().default(0),
  }),
  z.object({
    kind: z.literal("console-clean"),
    since: z.number().int().default(0),
    /** Count errors from third-party scripts too (default: first-party only —
     * a Turnstile/analytics script's console noise isn't your app's bug). */
    includeThirdParty: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("route"), includes: z.string() }),
  z.object({ kind: z.literal("visible"), anchor: AnchorSchema }),
  z.object({ kind: z.literal("hidden"), anchor: AnchorSchema }),
  z.object({
    kind: z.literal("text"),
    anchor: AnchorSchema,
    includes: z.string(),
  }),
  /**
   * Tier-1: the app itself declared this happened (@argus/sdk `signal()`).
   * A wrong-but-visible element cannot fake it, which is why it outranks
   * every DOM check. Requires the optional in-app SDK.
   */
  z.object({
    kind: z.literal("signal"),
    name: z.string(),
    minCount: z.number().int().default(1),
    maxCount: z.number().int().optional(),
    since: z.number().int().default(0),
  }),
  /**
   * The app's own store — truth no DOM read can reach (e.g. a deploy that
   * only *looks* shipped on screen). Requires `registerStore()`.
   */
  z.object({
    kind: z.literal("state"),
    store: z.string(),
    path: z.string().optional().describe('dot path within the store, e.g. "items.0.status"'),
    equals: z.unknown().optional(),
    includes: z.string().optional(),
    exists: z.boolean().optional(),
  }),
]);
export type Predicate = z.infer<typeof PredicateSchema>;

export const AssertRequestSchema = z.object({
  predicates: z.array(PredicateSchema).min(1).max(20),
});
export type AssertRequest = z.infer<typeof AssertRequestSchema>;

export const PredicateResultSchema = z.object({
  pass: z.boolean(),
  tier: EvidenceTierSchema,
  evidence: z.string(), // human/agent-readable one-liner of what was seen
});
export type PredicateResult = z.infer<typeof PredicateResultSchema>;

export const AssertResponseSchema = z.object({
  pass: z.boolean(),
  tier: EvidenceTierSchema, // weakest tier among passing evidence — honesty
  results: z.array(PredicateResultSchema),
});
export type AssertResponse = z.infer<typeof AssertResponseSchema>;

// ---------------------------------------------------------------------------
// Screenshot
// ---------------------------------------------------------------------------

export const ScreenshotRequestSchema = z.object({
  fullPage: z.boolean().default(false),
  label: z.string().max(80).optional(),
});
export type ScreenshotRequest = z.infer<typeof ScreenshotRequestSchema>;

export const ScreenshotResponseSchema = z.object({
  key: z.string(), // R2 object key
  url: z.string(), // fetchable via the worker
  width: z.number().int(),
  height: z.number().int(),
});
export type ScreenshotResponse = z.infer<typeof ScreenshotResponseSchema>;

// ---------------------------------------------------------------------------
// Smoke suite — the zero-config "just point it at my app" check
// ---------------------------------------------------------------------------

export const SmokeRequestSchema = z.object({
  url: z.string().url(),
  viewports: z.array(ViewportNameSchema).default(["mobile", "tablet", "desktop"]),
  colorSchemes: z.array(z.enum(["light", "dark"])).default(["light"]),
  /** Which app this run belongs to — powers the fleet view. */
  project: z.string().max(60).optional(),
});
export type SmokeRequest = z.infer<typeof SmokeRequestSchema>;

export const FindingSchema = z.object({
  id: z.string(),
  severity: z.enum(["critical", "major", "minor", "info"]),
  category: z.enum([
    "load",
    "console-error",
    "network-failure",
    "slow-request",
    "a11y",
    "visual",
    "responsive",
    "flow",
    "perf",
    "link",
  ]),
  summary: z.string(),
  detail: z.string().optional(),
  evidence: z
    .object({
      screenshotKey: z.string().optional(),
      network: z.array(NetworkEventSchema).optional(),
      console: z.array(ConsoleEventSchema).optional(),
      viewport: ViewportNameSchema.optional(),
    })
    .optional(),
  // The decision envelope: what to do next, machine-actionable.
  decision: z
    .object({
      whatChanged: z.string(),
      whereInSource: z.string().optional(), // file:line when source-mappable
      nextAction: z.string(),
    })
    .optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const SmokeReportSchema = z.object({
  runId: z.string(),
  url: z.string(),
  status: z.enum(["pass", "fail", "error"]),
  startedAt: z.string(),
  durationMs: z.number(),
  checks: z.object({
    loaded: z.boolean(),
    consoleErrors: z.number(),
    failedRequests: z.number(),
    responsiveOverflow: z.array(ViewportNameSchema), // viewports with x-overflow
  }),
  screenshots: z.array(
    z.object({
      viewport: ViewportNameSchema,
      colorScheme: z.enum(["light", "dark"]),
      key: z.string(),
      url: z.string(),
    })
  ),
  findings: z.array(FindingSchema),
});
export type SmokeReport = z.infer<typeof SmokeReportSchema>;

// ---------------------------------------------------------------------------
// Audit — the full UX/visual pass: a11y, perf, links, visual regression
// ---------------------------------------------------------------------------

export const AuditRequestSchema = z.object({
  url: z.string().url(),
  viewports: z.array(ViewportNameSchema).default(["mobile", "desktop"]),
  colorSchemes: z.array(z.enum(["light", "dark"])).default(["light"]),
  checks: z
    .array(z.enum(["a11y", "perf", "links", "visual"]))
    .default(["a11y", "perf", "links", "visual"]),
  /** Baseline set to compare against / create. Defaults to a hash of the URL. */
  baselineKey: z.string().max(120).optional(),
  /** Update baselines to the current screenshots after diffing. */
  updateBaseline: z.boolean().default(false),
  /** Which app this run belongs to — powers the fleet view. */
  project: z.string().max(60).optional(),
  /**
   * Audit pages behind the login wall. Without this the whole authenticated
   * product — usually most of the app — can never be checked for
   * accessibility, performance or visual regressions.
   */
  authProfile: AuthProfileNameSchema.optional(),
});
export type AuditRequest = z.infer<typeof AuditRequestSchema>;

export const PerfMetricsSchema = z.object({
  viewport: ViewportNameSchema,
  fcpMs: z.number().optional(),
  lcpMs: z.number().optional(),
  cls: z.number().optional(),
  loadMs: z.number().optional(),
  requests: z.number().int().optional(),
  transferKb: z.number().optional(),
});
export type PerfMetrics = z.infer<typeof PerfMetricsSchema>;

export const VisualDiffSchema = z.object({
  viewport: ViewportNameSchema,
  colorScheme: z.enum(["light", "dark"]),
  status: z.enum(["match", "diff", "baseline-created", "size-mismatch"]),
  diffRatio: z.number().optional(), // 0..1 fraction of pixels changed
  currentKey: z.string(),
  baselineKey: z.string().optional(),
  diffKey: z.string().optional(), // rendered diff image
});
export type VisualDiff = z.infer<typeof VisualDiffSchema>;

export const AuditReportSchema = z.object({
  runId: z.string(),
  url: z.string(),
  status: z.enum(["pass", "fail", "error"]),
  startedAt: z.string(),
  durationMs: z.number(),
  smoke: SmokeReportSchema.shape.checks,
  perf: z.array(PerfMetricsSchema).default([]),
  visual: z.array(VisualDiffSchema).default([]),
  a11yViolations: z.number().int().default(0),
  linksChecked: z.number().int().default(0),
  brokenLinks: z.number().int().default(0),
  screenshots: SmokeReportSchema.shape.screenshots,
  findings: z.array(FindingSchema),
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

// ---------------------------------------------------------------------------
// Flows — recorded, semantic-anchored, deterministically replayable
// (superset of Reticle's flow JSON v1 so .reticle/flows import cleanly)
// ---------------------------------------------------------------------------

export const FlowStepSchema = z.object({
  action: ActionSchema,
  anchor: AnchorSchema.optional(), // semantic anchor (never a raw ref)
  expect: z.array(PredicateSchema).default([]),
  label: z.string().optional(),
});
export type FlowStep = z.infer<typeof FlowStepSchema>;

export const FlowSchema = z.object({
  version: z.literal(1),
  name: z
    .string()
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/, "single safe path segment"),
  startUrl: z.string().url(),
  viewport: ViewportNameSchema.default("desktop"),
  steps: z.array(FlowStepSchema).min(1),
  success: z.array(PredicateSchema).min(1), // the golden end condition
  dynamic: z.array(AnchorSchema).default([]), // regions whose CONTENT isn't asserted
  /**
   * Start this flow already signed in with a saved auth profile. Everything
   * behind a login wall (dashboards, settings, CRUD) needs this.
   */
  auth: AuthProfileNameSchema.optional(),
  /**
   * On success, persist the resulting browser session as this auth profile.
   * Set on the login flow; every other flow then references it via `auth`.
   */
  saveAuthAs: AuthProfileNameSchema.optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

export const FlowReplayResultSchema = z.object({
  flow: z.string(),
  status: z.enum(["ok", "drift", "error"]),
  stepsRun: z.number().int(),
  failedStep: z.number().int().optional(),
  decision: z
    .object({
      verdict: z.string(),
      whatChanged: z.string(),
      suggestedFix: z.string().optional(),
      nextAction: z.string(),
    })
    .optional(),
  evidenceTier: EvidenceTierSchema.optional(),
  durationMs: z.number(),
  screenshotKey: z.string().optional(), // final-state screenshot
});
export type FlowReplayResult = z.infer<typeof FlowReplayResultSchema>;

// ---------------------------------------------------------------------------
// Runs — a verification run groups flow replays + audits into one verdict
// ---------------------------------------------------------------------------

export const RunStatusSchema = z.enum(["queued", "running", "pass", "fail", "error"]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const RunSummarySchema = z.object({
  runId: z.string(),
  kind: z.enum(["smoke", "flows", "audit", "full"]),
  url: z.string(),
  status: RunStatusSchema,
  startedAt: z.string(),
  durationMs: z.number().optional(),
  totals: z
    .object({
      flows: z.number().int().default(0),
      passed: z.number().int().default(0),
      failed: z.number().int().default(0),
      findings: z.number().int().default(0),
    })
    .optional(),
});
export type RunSummary = z.infer<typeof RunSummarySchema>;

// ---------------------------------------------------------------------------
// API error envelope
// ---------------------------------------------------------------------------

export const ApiErrorSchema = z.object({
  error: z.string(),
  detail: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

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
/** The hosted Argus cloud — CLI/MCP/init default here so most projects pass no URL. */
export const ARGUS_CLOUD_API = "https://argus-cloud.everyai-com.workers.dev";

export const VIEWPORTS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1280, height: 800 },
  /**
   * A real phone, not a narrow desktop: touch input, a mobile Chrome identity,
   * `<meta viewport>` honoured, 2x pixels. Same size as `mobile`, which stays a
   * plain small window so existing mobile baselines keep comparing like for like.
   */
  phone: { width: 375, height: 812 },
} as const;
export type ViewportName = keyof typeof VIEWPORTS;
export const ViewportNameSchema = z.enum(["mobile", "tablet", "desktop", "phone"]);

/**
 * Network throttling, matching Chrome DevTools' presets (throughput in bytes/s,
 * latency in ms of added round-trip). `none` lifts throttling; `offline` is an
 * action-only state (a lease can't load its start URL offline).
 */
export const NETWORK_PROFILES = {
  slow3g: { downloadThroughput: 50_000, uploadThroughput: 50_000, latency: 2_000 },
  fast3g: { downloadThroughput: 180_000, uploadThroughput: 84_375, latency: 563 },
  "4g": { downloadThroughput: 1_012_500, uploadThroughput: 168_750, latency: 165 },
} as const;
export const LeaseNetworkSchema = z.enum(["none", "4g", "fast3g", "slow3g"]);
export type LeaseNetwork = z.infer<typeof LeaseNetworkSchema>;
export const NetworkProfileSchema = z.enum(["none", "4g", "fast3g", "slow3g", "offline"]);
export type NetworkProfile = z.infer<typeof NetworkProfileSchema>;

/**
 * A URL a cloud browser may open: http(s) only. Browsers are reused across
 * tenants, so `file:` (the browser host's disk), `javascript:`, `data:` and
 * `chrome:` pages must never be reachable through the API.
 */
export const HttpUrlSchema = z
  .string()
  .url()
  .refine((u) => {
    try {
      return ["http:", "https:"].includes(new URL(u).protocol);
    } catch {
      return false;
    }
  }, "only http(s) URLs can be opened");

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
  url: HttpUrlSchema,
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
  /** Throttle the whole session (e.g. slow3g for a phone on a bad connection). */
  network: LeaseNetworkSchema.optional(),
});
export type LeaseRequest = z.infer<typeof LeaseRequestSchema>;

export const LeaseResponseSchema = z.object({
  sessionId: z.string(),
  ready: z.boolean(),
  url: z.string(),
  title: z.string().optional(),
  expiresAt: z.string(), // ISO timestamp
  /** Where lease time went, per phase (ms) — makes slow leases diagnosable. */
  timings: z
    .object({
      warm: z.boolean(), // reconnected to a parked browser (vs cold launch)
      browserMs: z.number(),
      contextMs: z.number(),
      gotoMs: z.number(),
      settleMs: z.number(),
    })
    .optional(),
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
  /**
   * `batch` = a browser held by a flow replay / smoke / audit run. It counts
   * against the same caps as an interactive lease but is not addressable
   * through /v1/session/:id.
   */
  kind: z.enum(["lease", "batch"]).optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

// ---------------------------------------------------------------------------
// Multi-tenant — many projects share one CF browser fleet, fairly.
//
// Each tenant gets its own token, a RESERVED floor (browsers it can always
// get, even under contention) and a burst CEILING. Admission honours every
// tenant's floor before letting anyone burst into shared headroom, so a greedy
// project can never starve a reserved one. The warm pool and the 3/sec launch
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
  /** Self-serve tenants: the account that owns it — token rotation is refused for anyone else. */
  ownerUserId: z.string().optional(),
});
export type Tenant = z.infer<typeof TenantSchema>;

export const CreateTenantRequestSchema = z.object({
  id: TenantIdSchema,
  name: z.string().max(80).optional(),
  reserved: z.number().int().min(0).max(120).default(0),
  maxBurst: z.number().int().min(1).max(120).default(120),
}).refine((t) => t.maxBurst >= t.reserved, {
  // A floor above the ceiling is unreachable, yet it would still withhold
  // capacity from every other tenant.
  message: "maxBurst must be ≥ reserved",
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
    /** Test one stable environment as soon as a pull request changes. */
    targetUrl: z.string().url().optional(),
    /** Or wait for a provider/GitHub Actions preview deployment to succeed. */
    deployment: z
      .object({
        environments: z.array(z.string().min(1).max(80)).max(20).default([]),
      })
      .strict()
      .optional(),
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
  .strict()
  .refine((config) => Boolean(config.targetUrl) !== Boolean(config.deployment), {
    message: "configure exactly one of targetUrl or deployment",
  });
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
  z.object({ action: z.literal("goto"), url: HttpUrlSchema }),
  z.object({ action: z.literal("back") }),
  z.object({ action: z.literal("reload") }),
  z.object({
    action: z.literal("click"),
    ref: z.string().optional(),
    anchor: AnchorSchema.optional(),
    /** 2 = double-click (two click events + dblclick): finds double-submit bugs. */
    clickCount: z.number().int().min(1).max(3).optional(),
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
  /**
   * Change the screen mid-session: a preset (mobile/tablet/desktop), an exact
   * size, and/or the colour scheme — one session, or one flow, checks phone,
   * desktop and dark mode without re-leasing.
   */
  z.object({
    action: z.literal("viewport"),
    viewport: ViewportNameSchema.optional(),
    width: z.number().int().min(240).max(3840).optional(),
    height: z.number().int().min(240).max(2400).optional(),
    colorScheme: z.enum(["light", "dark"]).optional(),
  }),
  /**
   * Change network conditions mid-session: throttle, go `offline` (then try to
   * submit), or restore with `none`. Flows replay it like `viewport`.
   */
  z.object({ action: z.literal("network"), profile: NetworkProfileSchema }),
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
  /** DOM mutations (nodes, attributes, text) the action caused. */
  domMutations: z.number().optional(),
  /**
   * An interaction (click/select/press) that produced NOTHING observable: no
   * navigation, no DOM mutation, no focus move, no request, no console. The
   * dead-button class, flagged the moment it happens.
   */
  silentAction: z.boolean().optional(),
  /** A request failed (≥400 / network error) and the page showed no change — an error the user never sees. */
  unsurfacedFailure: z.boolean().optional(),
  /**
   * The page fits the viewport before the action and overflows sideways after
   * it (e.g. a long unbroken value rendered without wrapping) — layout the
   * action broke, which a check on first load never sees.
   */
  newHorizontalOverflow: z.boolean().optional(),
  /**
   * Deterministic layout/content problems present after the action that were
   * not there before it (covered controls, raw `NaN`/`undefined` text, broken
   * images…) — one entry per rule, with samples. After a navigation: the new
   * page's problems.
   */
  newLayoutIssues: z
    .array(z.object({ rule: z.string(), count: z.number().int(), samples: z.array(z.string()) }))
    .optional(),
  /**
   * The app's own request failed, the page changed anyway, and no error was
   * shown (no alert, no "error/failed/try again" text appeared) — a failure
   * presented as success. The optimistic-UI lie, caught as it happens.
   */
  failureShownAsSuccess: z.boolean().optional(),
  /**
   * What the page showed WHILE the action's own request was still in flight —
   * sampled once, only when a request stayed pending ≥150ms (a fast request
   * needs no spinner). `feedback` false on an interaction = the user stared at
   * an unchanged screen while the app worked: double-taps and rage-clicks
   * start here. Tier: dom.
   */
  pending: z
    .object({
      inFlight: z.number().int(),
      afterMs: z.number(),
      feedback: z.boolean(),
      signals: z.array(z.string()),
    })
    .optional(),
  /** Where the act's time went (ms): measure-before, the action itself, settling, measure-after. */
  timings: z.object({ before: z.number(), action: z.number(), settle: z.number(), after: z.number() }).optional(),
});
export type ActEffects = z.infer<typeof ActEffectsSchema>;

/**
 * The browser connection was lost and re-established. `pageReattached: false`
 * means the page (and its cookies/storage) is NEW — anything the app kept
 * client-side is gone, so a later "data lost" finding is Argus's, not the app's.
 */
export const RecoveredSchema = z.object({
  at: z.string(),
  pageReattached: z.boolean(),
  /** Where a new page was put back (the last URL the session was on). */
  url: z.string().optional(),
});
export type Recovered = z.infer<typeof RecoveredSchema>;

export const ActResultSchema = z.object({
  ok: z.boolean(),
  effects: ActEffectsSchema.optional(),
  resolution: AnchorResolutionSchema.optional(),
  error: z.string().optional(),
  /** Set on the act during which the session recovered — never a silent reset. */
  recovered: RecoveredSchema.optional(),
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

/**
 * A streaming transport event — WebSocket frames and SSE/EventSource activity.
 * Neither shows up as a request/response pair, so a "real-time" feature can be
 * silently dead while every REST check stays green.
 */
export const StreamEventSchema = z.object({
  seq: z.number().int(),
  stream: z.enum(["websocket", "sse"]),
  url: z.string(),
  /** Frames are sent/received; open/close are the connection lifecycle. */
  direction: z.enum(["sent", "received", "open", "close"]).default("received"),
  data: z.string().optional(),
  at: z.number().int(),
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const ObserveRequestSchema = z.object({
  since: z.number().int().default(0), // cursor: only events with seq > since
  what: z
    .array(z.enum(["network", "console", "route", "stream"]))
    .default(["network", "console", "route"]),
});
export type ObserveRequest = z.infer<typeof ObserveRequestSchema>;

export const ObserveResponseSchema = z.object({
  cursor: z.number().int(),
  network: z.array(NetworkEventSchema).default([]),
  console: z.array(ConsoleEventSchema).default([]),
  stream: z.array(StreamEventSchema).default([]),
  route: z.object({ url: z.string(), title: z.string() }).optional(),
  /**
   * Present when events after `since` may be MISSING: per buffer, every event
   * with seq ≤ the value might have been dropped (ring-buffer overflow, or the
   * session's DO restarted and its in-memory buffers were lost). Absence-based
   * conclusions over that window are unverifiable — re-run the action.
   */
  lostThrough: z
    .object({
      network: z.number().int().optional(),
      console: z.number().int().optional(),
      stream: z.number().int().optional(),
    })
    .optional(),
  /** The session's DO restarted; `pageReattached: false` means the page was reloaded at its start URL. */
  recovered: RecoveredSchema.optional(),
});
export type ObserveResponse = z.infer<typeof ObserveResponseSchema>;

// ---------------------------------------------------------------------------
// Assert — evidence-tiered predicates over program truth
// ---------------------------------------------------------------------------

/** Leaf predicates — the concrete evidence checks (everything but combinators). */
export const LeafPredicateSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("network"),
    urlIncludes: z.string(),
    method: z.string().optional(),
    status: z.number().int().optional(), // expected status
    minCount: z.number().int().default(1),
    maxCount: z.number().int().optional(), // cardinality guard (e.g. exactly 1 POST)
    since: z.number().int().default(0),
    /** Step `expect` only: observe the whole run so far instead of "since this step started". */
    cumulative: z.boolean().default(false),
  }),
  z.object({
    kind: z.literal("console-clean"),
    since: z.number().int().default(0),
    /** Step `expect` only: observe the whole run so far instead of "since this step started". */
    cumulative: z.boolean().default(false),
    /** Count errors from third-party scripts too (default: first-party only —
     * a Turnstile/analytics script's console noise isn't your app's bug). */
    includeThirdParty: z.boolean().default(false),
  }),
  z.object({ kind: z.literal("route"), includes: z.string() }),
  /**
   * A streaming transport actually did something — a WebSocket frame, or an
   * SSE/EventSource connection. Real-time features fail silently when nobody
   * reads the socket, and a REST check can't see it.
   */
  z.object({
    kind: z.literal("stream"),
    urlIncludes: z.string(),
    stream: z.enum(["websocket", "sse"]).optional(),
    direction: z.enum(["sent", "received", "open", "close"]).optional(),
    dataIncludes: z.string().optional(),
    minCount: z.number().int().default(1),
    maxCount: z.number().int().optional(),
    since: z.number().int().default(0),
    /** Step `expect` only: observe the whole run so far instead of "since this step started". */
    cumulative: z.boolean().default(false),
  }),
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
    /** Step `expect` only: observe the whole run so far instead of "since this step started". */
    cumulative: z.boolean().default(false),
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
  /**
   * Browser storage — the client's own persisted truth (localStorage /
   * sessionStorage). Use it when the app reads from storage and the stored
   * value, not the rendered DOM, is the thing that must be right.
   */
  z.object({
    kind: z.literal("storage"),
    area: z.enum(["local", "session"]).default("local"),
    key: z.string(),
    exists: z.boolean().optional(),
    equals: z.string().optional(),
    includes: z.string().optional(),
  }),
]);
export type LeafPredicate = z.infer<typeof LeafPredicateSchema>;

/** Group predicates: `allOf` needs every child, `anyOf` needs at least one. */
export interface PredicateCombinator {
  kind: "allOf" | "anyOf";
  predicates: Predicate[];
}

export type Predicate = LeafPredicate | PredicateCombinator;

/**
 * Predicates are recursive so `allOf`/`anyOf` can nest. Authored as a lazy
 * union rather than a discriminated union because zod cannot build a recursive
 * discriminated union directly; the leaf schema still carries the `kind`
 * discriminator for every concrete check.
 */
export const PredicateSchema: z.ZodType<Predicate> = z.lazy(() =>
  z.union([
    LeafPredicateSchema,
    z.object({
      kind: z.literal("allOf"),
      predicates: z.array(PredicateSchema).min(1).max(20),
    }),
    z.object({
      kind: z.literal("anyOf"),
      predicates: z.array(PredicateSchema).min(1).max(20),
    }),
  ])
) as unknown as z.ZodType<Predicate>;

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
// Judge — the vision decision layer (Cloudflare Clef, Jev-API compatible)
//
// Deterministic engines stay the verdict source of truth: predicates decide
// pass/fail, pixel-diff detects change. The judge only ADDS judgments on top:
// visual-diff adjudication (regression vs rendering noise) and failure triage
// (bug class + severity + needs-human). Every judgment is optional, labeled
// with its model, and the raw deterministic signal is always preserved beside
// it — a judgment refines a heuristic severity, never a predicate verdict.
// ---------------------------------------------------------------------------

/** Clef model selector: full precision vs latency-critical flash. */
export const JudgeModelSchema = z.enum(["clef", "clef-flash"]);
export type JudgeModel = z.infer<typeof JudgeModelSchema>;

/** What the vision judge saw in a baseline-vs-current screenshot pair. */
export const VisualAdjudicationSchema = z.object({
  verdict: z.enum(["real_regression", "rendering_noise", "content_change", "inconclusive"]),
  confidence: z.number().min(0).max(1),
  /** Human-level visible impact (none = nothing a user would notice). */
  severity: z.enum(["critical", "major", "minor", "info", "none"]),
  model: JudgeModelSchema,
  latencyMs: z.number().int().optional(),
});
export type VisualAdjudication = z.infer<typeof VisualAdjudicationSchema>;

/** Bug classes the judge triages replay/audit failures into. */
export const JudgeBugClassSchema = z.enum([
  "visual_regression",
  "console_error",
  "dead_button",
  "wrong_state",
  "network_failure",
  "auth_failure",
  "flaky_infra",
  "unknown",
]);
export type JudgeBugClass = z.infer<typeof JudgeBugClassSchema>;

/** One-call triage attached to a failed replay (additive — status untouched). */
export const FailureTriageSchema = z.object({
  bugClass: JudgeBugClassSchema,
  severity: z.enum(["critical", "major", "minor", "info"]),
  /** True when a human should review before acting (ambiguous cause/risky fix). */
  needsHuman: z.boolean(),
  confidence: z.number().min(0).max(1),
  model: JudgeModelSchema,
  latencyMs: z.number().int().optional(),
});
export type FailureTriage = z.infer<typeof FailureTriageSchema>;

/**
 * A judge-refined finding severity. When present, `Finding.severity` already
 * reflects the judged value and `note` names the original deterministic one.
 */
export const JudgedSeveritySchema = z.object({
  severity: z.enum(["critical", "major", "minor", "info"]),
  confidence: z.number().min(0).max(1),
  model: JudgeModelSchema,
  note: z.string().max(200).optional(),
});
export type JudgedSeverity = z.infer<typeof JudgedSeveritySchema>;

// ---------------------------------------------------------------------------
// Smoke suite — the zero-config "just point it at my app" check
// ---------------------------------------------------------------------------

export const SmokeRequestSchema = z.object({
  url: HttpUrlSchema,
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
    "layout", // deterministic geometry: occlusion, zero-size, tap targets, imagery
    "content", // leaked placeholders, raw i18n keys, "undefined"/"NaN" in the UI
  ]),
  /** Stable rule id, e.g. "a11y/color-contrast", "layout/occlusion". */
  rule: z.string().optional(),
  /** Identity across runs: hash(host, path, rule, subject[, viewport]). Survives few-px shifts. */
  fingerprint: z.string().optional(),
  /** What triage memory knows about this finding (absent when triage did not run). */
  triage: z
    .object({
      state: z.enum(["new", "known", "regression"]),
      firstSeen: z.string().optional(),
      occurrences: z.number().int().optional(),
    })
    .optional(),
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
  /** Judge-refined severity, when the judge ran and was confident. */
  judged: JudgedSeveritySchema.optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

/** A finding the team dismissed — kept out of `findings` and the verdict, but never silently. */
export const SuppressedFindingSchema = z.object({
  fingerprint: z.string(),
  summary: z.string(),
  reason: z.string().optional(),
});

/** Triage counts shared by smoke and audit reports. */
const TriageCountsShape = {
  /** Findings never seen before on this host. */
  newFindings: z.number().int().optional(),
  /** Findings that were fixed (or auto-closed) and came back. */
  regressions: z.number().int().optional(),
  suppressed: z.array(SuppressedFindingSchema).optional(),
};

export const TriageStatusSchema = z.enum(["open", "dismissed", "fixed"]);
export const TriageUpdateSchema = z.object({
  /** Host the finding belongs to (or a URL on it). */
  host: z.string().min(1).max(253),
  fingerprint: z.string().regex(/^[a-f0-9]{16}$/),
  status: z.enum(["open", "dismissed"]),
  reason: z.string().max(300).optional(),
});
export type TriageUpdate = z.infer<typeof TriageUpdateSchema>;

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
  ...TriageCountsShape,
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

export const AuditCheckSchema = z.enum(["a11y", "perf", "links", "visual", "layout"]);

export const AuditRequestSchema = z.object({
  url: HttpUrlSchema,
  viewports: z.array(ViewportNameSchema).default(["mobile", "desktop"]),
  colorSchemes: z.array(z.enum(["light", "dark"])).default(["light"]),
  checks: z.array(AuditCheckSchema).default(["a11y", "perf", "links", "visual", "layout"]),
  /**
   * CSS selectors painted over before the visual compare (avatars, live
   * counters). The masked share of the screen is reported on every diff, and a
   * mostly-masked compare is flagged as hollow — masking is never silent.
   */
  masks: z.array(z.string().min(1).max(200)).max(20).optional(),
  /**
   * Pin the page clock for the visual capture (ISO instant) so rendered dates
   * match across runs. Default: the real time when the capture starts.
   */
  freezeClock: z.string().datetime().optional(),
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
  /**
   * Run the vision decision layer (Clef) over visual diffs and findings.
   * Default true. Set false for pure-deterministic runs with zero model cost.
   */
  judge: z.boolean().default(true),
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
  /** `unstable`: the screen never produced two identical frames — not compared, not a diff. */
  status: z.enum(["match", "diff", "baseline-created", "size-mismatch", "unstable"]),
  /** Share of the screen (0..1) painted over by `masks`. */
  maskedPct: z.number().optional(),
  /** Third-party analytics/ads/chat requests blocked during the capture. */
  blockedRequests: z.number().int().optional(),
  /** Frames captured before two consecutive ones were byte-identical. */
  stableAfterFrames: z.number().int().optional(),
  diffRatio: z.number().optional(), // 0..1 fraction of pixels changed
  currentKey: z.string(),
  baselineKey: z.string().optional(),
  diffKey: z.string().optional(), // rendered diff image
  /** Vision-judge adjudication, when the judge ran (see Judge section). */
  judgment: VisualAdjudicationSchema.optional(),
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
  ...TriageCountsShape,
});
export type AuditReport = z.infer<typeof AuditReportSchema>;

// ---------------------------------------------------------------------------
// Crawl — sweep a whole site in parallel cloud browsers, detectors on every page
// ---------------------------------------------------------------------------

export const CrawlRequestSchema = z.object({
  url: HttpUrlSchema,
  /** Pages to visit at most (breadth-first from `url`). */
  maxPages: z.number().int().min(1).max(60).default(20),
  /** Parallel browsers (each holds a tenant slot, like any other browser). */
  concurrency: z.number().int().min(1).max(6).default(3),
  viewport: ViewportNameSchema.default("desktop"),
  /** Only follow links under this path prefix (default: the whole origin). */
  include: z.string().startsWith("/").max(200).optional(),
  /** Crawl behind the login wall with a saved auth profile. */
  authProfile: AuthProfileNameSchema.optional(),
  project: z.string().max(60).optional(),
});
export type CrawlRequest = z.infer<typeof CrawlRequestSchema>;

export const CrawlPageSchema = z.object({
  url: z.string(),
  /** The page that linked here first (absent for the start page). */
  from: z.string().optional(),
  title: z.string().optional(),
  /** HTTP status of the document — recorded, never trusted alone (SPAs answer 200 everywhere). */
  httpStatus: z.number().int().optional(),
  /** The RENDERED page is a not-found page (status 404 or "not found" content). */
  notFound: z.boolean(),
  loadMs: z.number().optional(),
  findings: z.number().int(),
  linksOut: z.number().int(),
  screenshotKey: z.string().optional(),
  error: z.string().optional(),
  /** Not tested, and why — e.g. a linked JSON/API document is not a page. */
  skipped: z.string().optional(),
});

export const CrawlReportSchema = z.object({
  runId: z.string(),
  url: z.string(),
  status: z.enum(["pass", "fail", "error"]),
  startedAt: z.string(),
  durationMs: z.number(),
  pages: z.array(CrawlPageSchema),
  /** More same-site links were found than maxPages allowed. */
  truncated: z.boolean(),
  screenshots: SmokeReportSchema.shape.screenshots,
  findings: z.array(FindingSchema),
  ...TriageCountsShape,
});
export type CrawlReport = z.infer<typeof CrawlReportSchema>;

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
  startUrl: HttpUrlSchema,
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
  /**
   * What must STILL hold after one reload once `success` passed — a save the
   * page only pretended to make passes `success` and fails here. `"success"`
   * re-checks the success predicates that describe state (text, visible,
   * hidden, state, storage, route); event-window ones (network, console,
   * stream, signal) describe the past and are skipped. Keep toasts and other
   * deliberately transient UI out of it.
   */
  persists: z.union([z.literal("success"), z.array(PredicateSchema).min(1).max(20)]).optional(),
});
export type Flow = z.infer<typeof FlowSchema>;

/**
 * Machine-readable IDs for every replay failure mode. Agents switch on these —
 * never on prose. Additive-only: new verdicts extend the enum, existing IDs
 * never change meaning.
 */
export const FlowVerdictSchema = z.enum([
  "drift",
  "ambiguous_anchor",
  "auth_profile_missing",
  "expectation_failed",
  "success_condition_failed",
  "error",
  /** No browser slot within the wait budget — the app was NOT tested. */
  "fleet_busy",
  /** `success` held, then a reload lost it (`persists`): the outcome was never really saved. */
  "not_persisted",
]);
export type FlowVerdict = z.infer<typeof FlowVerdictSchema>;

/**
 * An executable next step attached to a decision: an MCP tool call (for agents)
 * or a shell command (for humans). Present only when the fix is fully
 * determined — no placeholders, no guessing.
 */
export const FlowActionSchema = z.union([
  z.object({ tool: z.string().min(1), args: z.record(z.string(), z.unknown()).default({}) }),
  z.object({ command: z.string().min(1) }),
]);
export type FlowAction = z.infer<typeof FlowActionSchema>;

/**
 * A failed replay is re-run once before it counts. `confirmed`: both runs
 * failed the same way (code decided it twice). `flaky`: they disagreed — the
 * flow was not reliably tested, and a flaky result never fails a build.
 */
export const ReplayConfirmationSchema = z.object({
  state: z.enum(["confirmed", "flaky"]),
  second: z
    .object({
      status: z.enum(["ok", "drift", "error"]),
      verdict: FlowVerdictSchema.optional(),
      failedStep: z.number().int().optional(),
      whatChanged: z.string().optional(),
    })
    .optional(),
});

/** Suite outcome: `untested` = Argus could not test (no browser slot, target unreachable) — distinct from a regression. */
export const SuiteStatusSchema = z.enum(["pass", "fail", "flaky", "untested"]);
export type SuiteStatus = z.infer<typeof SuiteStatusSchema>;

export const FlowReplayResultSchema = z.object({
  flow: z.string(),
  status: z.enum(["ok", "drift", "error"]),
  stepsRun: z.number().int(),
  failedStep: z.number().int().optional(),
  decision: z
    .object({
      verdict: FlowVerdictSchema,
      whatChanged: z.string(),
      suggestedFix: z.string().optional(),
      nextAction: z.string(),
      action: FlowActionSchema.optional(),
    })
    .optional(),
  evidenceTier: EvidenceTierSchema.optional(),
  durationMs: z.number(),
  screenshotKey: z.string().optional(), // final-state screenshot
  /** Vision-judge triage, attached to failures when the judge ran. */
  triage: FailureTriageSchema.optional(),
  confirmation: ReplayConfirmationSchema.optional(),
  /** A saved flow that reproduces this failure (replay it with argus_flow_replay). */
  reproFlow: z.string().optional(),
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
  /** Stable machine-readable code (snake_case) — agents switch on this. */
  error: z.string(),
  detail: z.string().optional(),
  /** Safe to retry (with backoff) when true; fix the cause first when false. */
  retryable: z.boolean().default(false),
  /** What to do about it, in one sentence. */
  remediation: z.string().optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

/**
 * Who/what triggered a run — `cli`, `mcp`, `github-app`, `ci:<workflow>`,
 * `agent:<name>`. Free-form but short; powers multi-actor attribution in run
 * history. Clients may override via ARGUS_ACTOR.
 */
export const ActorSchema = z.string().max(80);
export type Actor = z.infer<typeof ActorSchema>;

/** Retry/remediation defaults per error code — the typed-errors catalogue. */
export const API_ERROR_DEFAULTS: Record<string, { retryable: boolean; remediation: string }> = {
  bad_request: {
    retryable: false,
    remediation: "fix the request body against the schema hint in detail, then retry",
  },
  unauthorized: {
    retryable: false,
    remediation: "check the Bearer token (ARGUS_TOKEN or .argus/config.json) and that the tenant is not revoked",
  },
  forbidden: {
    retryable: false,
    remediation: "this route needs the admin token",
  },
  not_found: {
    retryable: false,
    remediation: "check the id; call the matching list route to see what exists",
  },
  unknown_command: {
    retryable: false,
    remediation: "use one of the documented session commands",
  },
  tenant_disabled: {
    retryable: false,
    remediation: "contact the admin — this tenant is disabled",
  },
  tenant_burst_reached: {
    retryable: true,
    remediation: "release an idle session or ask the admin to raise maxBurst, then retry",
  },
  fleet_saturated: {
    retryable: true,
    remediation: "wait a few seconds and retry; the fleet frees sessions as runs finish",
  },
  session_cap_reached: {
    retryable: true,
    remediation: "wait a few seconds and retry",
  },
  smoke_failed: {
    retryable: true,
    remediation: "retry once; if it persists the target page or the fleet is at fault — see detail",
  },
  audit_failed: {
    retryable: true,
    remediation: "retry once; if it persists the target page or the fleet is at fault — see detail",
  },
  replay_failed: {
    retryable: true,
    remediation: "retry once; replay crashes are usually a dead start URL or fleet pressure — see detail",
  },
  verify_failed: {
    retryable: true,
    remediation: "retry once; suite crashes are usually a dead start URL or fleet pressure — see detail",
  },
  auth_not_configured: {
    retryable: false,
    remediation: "the server owner must set the auth secret",
  },
  auth_unavailable: {
    retryable: true,
    remediation: "retry shortly; if it persists the auth backend is down",
  },
  mint_failed: {
    retryable: true,
    remediation: "retry; if it persists the tenant registry is unreachable — see detail",
  },
  github_app_not_configured: {
    retryable: false,
    remediation: "the server owner must configure the GitHub App credentials",
  },
  invalid_signature: {
    retryable: false,
    remediation: "check the webhook secret matches the GitHub App settings",
  },
  invalid_delivery: {
    retryable: false,
    remediation: "re-deliver the event from the GitHub App settings page",
  },
  invalid_json: {
    retryable: false,
    remediation: "send a valid JSON body",
  },
  reserved_id: {
    retryable: false,
    remediation: "choose a different tenant id",
  },
  session_command_failed: {
    retryable: true,
    remediation: "retry once; if it persists the browser session is wedged — release it and lease a fresh one",
  },
  tenant_create_failed: {
    retryable: false,
    remediation: "see detail — usually a duplicate id or a reserved total over the fleet cap",
  },
  tenant_update_failed: {
    retryable: false,
    remediation: "see detail — usually an unknown id or a reserved total over the fleet cap",
  },
  tenant_token_failed: {
    retryable: false,
    remediation: "check the tenant id exists, then retry",
  },
};

/** Build a typed API error — every route's failure path goes through here. */
export function apiError(
  code: string,
  detail?: string,
  overrides?: { retryable?: boolean; remediation?: string }
): ApiError {
  const defaults = API_ERROR_DEFAULTS[code];
  return {
    error: code,
    ...(detail === undefined ? {} : { detail }),
    retryable: overrides?.retryable ?? defaults?.retryable ?? false,
    ...(overrides?.remediation ?? defaults?.remediation
      ? { remediation: (overrides?.remediation ?? defaults?.remediation) as string }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Persona launch QA — five first-time users, one ranked list
// ---------------------------------------------------------------------------

export const EvidenceTierNameSchema = z.enum(["signal", "consequence", "dom", "visual"]);
export const PersonaSeveritySchema = z.enum(["blocker", "major", "minor"]);

export const PersonaMomentSchema = z.object({
  kind: z.string().max(40),
  where: z.string().max(500),
  element: z.record(z.string(), z.string()).optional(),
  symptom: z.string().max(80),
  tried: z.string().max(2000).optional(),
  expected: z.string().max(2000).optional(),
  saw: z.string().max(4000).optional(),
  severity: z.string().max(20),
  evidence: z
    .object({
      screenshot: z.string().max(500).optional(),
      tier: z.string().max(20).optional(),
      effects: z.record(z.string(), z.unknown()).optional(),
    })
    .optional(),
});
export type PersonaMoment = z.infer<typeof PersonaMomentSchema>;

export const PersonaReportSchema = z.object({
  persona: z.string().max(40),
  reachedSuccess: z.boolean(),
  moments: z.array(PersonaMomentSchema).max(100),
  coverage: z.unknown().optional(),
});
export type PersonaReport = z.infer<typeof PersonaReportSchema>;

/** One issue after the merge: a page + element + symptom, with every user who hit it. */
export const PersonaIssueSchema = z.object({
  key: z.string().max(700),
  symptom: z.string().max(80),
  where: z.string().max(500),
  element: z.string().max(300),
  personas: z.array(z.string().max(40)).max(10),
  severity: z.string().max(20),
  /** The strongest sighting's tier, each sighting already checked against its evidence. */
  tier: EvidenceTierNameSchema,
  saw: z.array(z.string().max(4100)).max(20),
  expected: z.array(z.string().max(2100)).max(20).default([]),
  tried: z.array(z.string().max(2100)).max(20).default([]),
  screenshots: z.array(z.string().max(500)).max(30),
});
export type PersonaIssue = z.infer<typeof PersonaIssueSchema>;

export const PersonaRunUploadSchema = z.object({
  url: HttpUrlSchema,
  goal: z.string().min(1).max(300),
  reports: z.array(PersonaReportSchema).max(10),
  issues: z.array(PersonaIssueSchema).max(200),
  project: z.string().max(60).optional(),
});
export type PersonaRunUpload = z.infer<typeof PersonaRunUploadSchema>;

export const PersonaRunSchema = PersonaRunUploadSchema.extend({
  id: z.string(),
  createdAt: z.string(),
});
export type PersonaRun = z.infer<typeof PersonaRunSchema>;

/** The list view: enough to draw a row without fetching every run. */
export const PersonaRunSummarySchema = z.object({
  id: z.string(),
  url: z.string(),
  goal: z.string(),
  createdAt: z.string(),
  reached: z.number().int(),
  personas: z.number().int(),
  issues: z.number().int(),
  worst: z.string().optional(),
});
export type PersonaRunSummary = z.infer<typeof PersonaRunSummarySchema>;

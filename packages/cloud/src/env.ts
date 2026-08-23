export interface Env {
  BROWSER: Fetcher;
  ARTIFACTS: R2Bucket;
  BROWSER_SESSION: DurableObjectNamespace;
  COORDINATOR: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** Bearer token guarding the API. Unset = API fails closed. Set via `wrangler secret put ARGUS_TOKEN`. */
  ARGUS_TOKEN?: string;
  /** Max simultaneously-active browser sessions (paid Browser Rendering allows ~120). */
  ARGUS_MAX_SESSIONS?: string;
  /** How many browsers to keep WARM when idle (separate from the cap, so a big cap
   * doesn't leave a big pool of idle browsers billing). Default 12. */
  ARGUS_MAX_WARM?: string;
  /** GitHub App ID used to mint short-lived installation access tokens. */
  ARGUS_GITHUB_APP_ID?: string;
  /** GitHub App private key PEM. Store with `wrangler secret put`, never in vars. */
  ARGUS_GITHUB_PRIVATE_KEY?: string;
  /** HMAC secret used to authenticate every GitHub webhook delivery. */
  ARGUS_GITHUB_WEBHOOK_SECRET?: string;
  /** Public GitHub App slug, used only to build the dashboard install link. */
  ARGUS_GITHUB_APP_SLUG?: string;
  /** Canonical public dashboard/API origin. Falls back to the request origin. */
  ARGUS_PUBLIC_URL?: string;
}

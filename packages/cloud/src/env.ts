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
}

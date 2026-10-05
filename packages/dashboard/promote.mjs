/**
 * Promote a dashboard build into the cloud worker's static assets.
 *
 * The dashboard builds into its own gitignored `dist/` so routine checks never
 * touch the committed bundle. Promoting is the explicit, reviewable step that
 * ships a new UI — and it refuses while `public/` is vendored from production
 * (see `.vendored-from-prod`), so a rebuild can never silently regress the
 * live dashboard. Override only during source recovery:
 * ALLOW_DASHBOARD_PROMOTE=1.
 */
import { existsSync, rmSync, cpSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const dist = join(here, "dist");
const pub = join(here, "..", "cloud", "public");
const marker = join(pub, ".vendored-from-prod");

if (!existsSync(dist)) {
  console.error("promote: no dist/ — run `pnpm --filter @argus/dashboard build` first");
  process.exit(1);
}
if (existsSync(marker) && process.env.ALLOW_DASHBOARD_PROMOTE !== "1") {
  console.error(
    "promote: REFUSED — packages/cloud/public is vendored from production " +
      "(redesign source missing). See .vendored-from-prod for recovery."
  );
  process.exit(1);
}
rmSync(join(pub, "assets"), { recursive: true, force: true });
rmSync(join(pub, "index.html"), { force: true });
cpSync(dist, pub, { recursive: true });
console.log(`promote: dist/ → ${pub}`);

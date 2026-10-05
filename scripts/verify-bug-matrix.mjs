/**
 * Dogfood negative controls: every demo `?bug=` mode MUST fail verification
 * with its predicted signature. A mode that PASSES is a product bug — the
 * dogfood didn't catch what it exists to catch.
 *
 * Run on demand only (it burns ~10 browser sessions); never in CI.
 *   node scripts/verify-bug-matrix.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const api = (process.env.ARGUS_API_URL ?? "https://argus-cloud.everyai-com.workers.dev").replace(/\/$/, "");
const demo = (process.env.ARGUS_DEMO_URL ?? "https://argus-demo.everyai-com.workers.dev").replace(/\/$/, "");
const token =
  process.env.ARGUS_E2E_TOKEN ??
  process.env.ARGUS_TOKEN ??
  JSON.parse(readFileSync(join(root, ".argus", "config.json"), "utf8")).token;

if (!token) throw new Error("no token — set ARGUS_E2E_TOKEN or keep .argus/config.json");

async function request(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  assert.equal(response.status, 200, `${method} ${path}: ${JSON.stringify(data).slice(0, 300)}`);
  return data;
}

const addTask = JSON.parse(readFileSync(join(root, ".argus", "flows", "add-task.json"), "utf8"));

/** Each mode: how to probe it, and the signature its failure must carry. */
const modes = [
  {
    bug: "consoleerror",
    probe: () =>
      request("POST", "/v1/smoke", {
        url: `${demo}/?bug=consoleerror`,
        viewports: ["desktop"],
        colorSchemes: ["light"],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status !== "pass" && JSON.stringify(r.findings).toLowerCase().includes("console error"),
    want: "smoke fails with a console-error finding",
  },
  {
    bug: "overflow",
    probe: () =>
      request("POST", "/v1/smoke", {
        url: `${demo}/?bug=overflow`,
        viewports: ["desktop"],
        colorSchemes: ["light"],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status !== "pass" && JSON.stringify(r.findings).toLowerCase().includes("overflow"),
    want: "smoke fails with a responsive-overflow finding",
  },
  {
    // slowreq delays the task list behind setTimeout, but the static hero text
    // paints immediately — so LCP can't see it. The add-task flow catches it
    // instead, with timing-dependent evidence: "Loading…" (checked before the
    // 8s load lands) or "1"/"2 task(s)". ("2" exposes a real demo race: the
    // late initial-load write clobbers the just-added task. Never "3".)
    bug: "slowreq",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=slowreq` }],
        project: "dogfood-matrix",
      }),
    caught: (r) =>
      r.status !== "pass" &&
      r.failed === 1 &&
      /text is \\"(Loading…|1 task\(s\)|2 task\(s\))\\"/.test(JSON.stringify(r.results)),
    want: "flow fails with count stuck at Loading/1/2 (never the expected 3)",
  },
  {
    bug: "silent500",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=silent500` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status !== "pass" && r.failed === 1 && JSON.stringify(r.results).includes("201"),
    want: "flow fails on the unmet POST-201 expectation",
  },
  {
    bug: "deadbutton",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=deadbutton` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status !== "pass" && r.failed === 1 && JSON.stringify(r.results).includes("no request"),
    want: "flow fails: dead button makes no POST at all",
  },
  {
    bug: "wrongstate",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=wrongstate` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status !== "pass" && r.failed === 1 && JSON.stringify(r.results).includes("42"),
    want: "flow fails showing the hardcoded 42",
  },
];

const settled = await Promise.allSettled(modes.map((m) => m.probe()));
let failures = 0;
settled.forEach((s, i) => {
  const mode = modes[i];
  if (s.status === "rejected") {
    failures++;
    console.log(`FAIL ?bug=${mode.bug}: probe errored: ${String(s.reason).slice(0, 200)}`);
    return;
  }
  if (mode.caught(s.value)) {
    console.log(`CAUGHT ?bug=${mode.bug}: ${mode.want}`);
  } else {
    failures++;
    console.log(
      `MISSED ?bug=${mode.bug}: expected [${mode.want}] got: ${JSON.stringify(s.value).slice(0, 400)}`
    );
  }
});
if (failures > 0) {
  console.error(`\nbug matrix: ${failures}/${modes.length} modes NOT caught as predicted`);
  process.exit(1);
}
console.log(`\nbug matrix: all ${modes.length} modes caught as predicted`);

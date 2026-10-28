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

/** A deterministic bug must fail the same way twice — and leave a repro. */
const confirmed = (r) =>
  r.results?.[0]?.confirmation?.state === "confirmed" && /^repro-/.test(r.results?.[0]?.reproFlow ?? "");

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
    // 8s load lands) or "1 task"/"2 tasks". ("2" exposes a real demo race: the
    // late initial-load write clobbers the just-added task. Never "3".)
    bug: "slowreq",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=slowreq` }],
        project: "dogfood-matrix",
      }),
    // A timing race: the re-run may fail the same way (confirmed) or differently
    // (flaky) — either way it must never pass, and the evidence must show it.
    caught: (r) =>
      r.status !== "pass" &&
      r.failed + (r.flaky ?? 0) === 1 &&
      /text is \\"(Loading…|1 task|2 tasks)\\"/.test(JSON.stringify(r.results)),
    want: "flow fails (confirmed or flaky) with count stuck at Loading/1/2 (never the expected 3)",
  },
  {
    bug: "silent500",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=silent500` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status === "fail" && r.failed === 1 && confirmed(r) && JSON.stringify(r.results).includes("201"),
    want: "flow fails on the unmet POST-201 expectation",
  },
  {
    bug: "deadbutton",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=deadbutton` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status === "fail" && r.failed === 1 && confirmed(r) && JSON.stringify(r.results).includes("no request"),
    want: "flow fails: dead button makes no POST at all",
  },
  {
    bug: "wrongstate",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=wrongstate` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status === "fail" && r.failed === 1 && confirmed(r) && JSON.stringify(r.results).includes("42"),
    want: "flow fails showing the hardcoded 42",
  },
  {
    // The add works on screen and the POST is a 201 — only a reload shows the
    // task was never kept. add-task's `persists: "success"` is what catches it.
    bug: "nopersist",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/?bug=nopersist` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status === "fail" && r.failed === 1 && confirmed(r) && JSON.stringify(r.results).includes("not_persisted"),
    want: "flow fails with not_persisted after the reload",
  },
];

// Positive control: the same probes against the clean demo MUST pass — a
// checker that fails everything would otherwise "catch" every bug above.
modes.push(
  {
    bug: "none (smoke)",
    probe: () =>
      request("POST", "/v1/smoke", {
        url: `${demo}/`,
        viewports: ["desktop"],
        colorSchemes: ["light"],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status === "pass",
    want: "clean demo smoke passes",
  },
  {
    bug: "none (flow)",
    probe: () =>
      request("POST", "/v1/flows/verify", {
        flows: [{ ...addTask, startUrl: `${demo}/` }],
        project: "dogfood-matrix",
      }),
    caught: (r) => r.status === "pass" && r.passed === 1,
    want: "clean demo add-task flow passes",
  }
);

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
    console.log(`${mode.bug.startsWith("none") ? "PASSED" : "CAUGHT"} ?bug=${mode.bug}: ${mode.want}`);
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

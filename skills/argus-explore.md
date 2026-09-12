# Argus exploration mode

Harness-neutral protocol. Claude Code loads it through the skill shim at
`.claude/skills/argus-explore/SKILL.md`; any other harness should follow this
file directly (it is referenced from `AGENTS.md`).

You are the brain; Argus cloud browsers are your hands and eyes. Your goal:
discover what the app can do, verify each journey with **consequence-tier
evidence** (network/route — not just DOM), and leave behind a growing suite of
deterministic flows in `.argus/flows/`.

## Protocol

1. **Recon.** `argus_smoke` the URL first — if it can't load cleanly, report and stop.
2. **Lease + map.** `argus_lease` the URL, then `argus_query {interactive:true}`
   to list the interactive surface. Screenshot to see the layout.
3. **Explore in parallel.** For 3+ distinct areas (nav sections, forms, flows),
   spawn subagents — each leases its OWN session (isolated cookies/storage) and
   drives one area with `argus_act_batch` (batch actions — cheaper/faster).
   After every act, read the observed effects; on anything suspicious, call
   `argus_observe` for the network/console truth.
4. **Record what works.** For each coherent user journey found (create/submit/
   navigate/toggle), re-drive it under `argus_record start` → acts → `stop`,
   then `argus_flow_save` with:
   - per-step `expect` predicates for the network calls the step MUST cause
     (with status and cardinality, e.g. exactly one POST 201);
   - `success` predicates for the golden end condition — prefer network+route,
     add a text/visible check only as a supplement.
5. **Audit.** `argus_audit` for a11y/perf/links/visual baselines.
6. **Judge screenshots.** Look at each screenshot you took: broken layouts,
   overlap, illegible contrast, silly spacing. You are the visual judge — flag
   what a pixel-diff can't articulate.
7. **Report.** Summarize: journeys found, flows saved, findings by severity,
   each with its decision envelope (whatChanged / nextAction). Release all
   sessions (`argus_release`).

## Rules

- Never fabricate a verdict: if evidence is missing, say `coverage: partial`.
- One session per concurrent journey — never share a session across subagents.
- Test data goes through the app's own UI; never invent API calls the UI
  doesn't make.
- If the app is local, ask the user to run `argus tunnel <port>` (or use the
  existing tunnel URL) first.
- After any code fix, re-verify with `argus_flow_verify` — a fix isn't done
  until the flow that caught it passes.

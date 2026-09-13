---
name: verify-until-green
description: Drive the Argus verdict loop to completion — verify, read each failure's next action, fix, and re-verify until READY. Use whenever you change UI, routes, or API handlers, and never report work as done before the verdict is green.
---

# Verify until green

Argus is the thing that stops "I fixed it" from being a guess. Your job is a loop, not a report.

```
verify → read failures + nextAction → fix → verify again → … → READY
```

## Loop

1. **Verify.** `argus_flow_verify` (all saved flows, in parallel) and `argus_audit` on the pages you
   changed. Or one command end to end:
   `node <ARGUS_REPO>/packages/cli/dist/index.js verify <app-url>`.
2. **Read the failure, not just the red.** Every failure carries a decision envelope
   (`whatChanged → suggestedFix → nextAction`). Do what `nextAction` says.
3. **Fix the cause, in the app or the flow.**
   - Wrong app behaviour → fix the code.
   - Right behaviour, wrong expectation → fix the flow (re-record, or `argus_flow_heal` and review).
   - **Never** loosen a predicate to silence a real failure.
4. **Repeat** until the verdict is green. Then, and only then, say it is done.

## Building the suite as you go

A task that adds user-facing behaviour adds a flow: drive it once under `argus_record`, then
`argus_flow_save` with per-step `expect` predicates (the network/route consequence, with status and
cardinality) and a `success` oracle. A flow that only clicks passes even when the feature is broken.

## Rules

- Only `argus_assert` and a flow's `expect`/`success` return a verdict — `argus_act` proves nothing.
- Report the **weakest** evidence tier the verdict rests on (signal > consequence > dom > visual).
  Never upgrade it.
- Unresolvable or ambiguous anchors are errors. Fix the anchor; never guess.
- Missing evidence is `coverage: partial`. Say so; do not present it as a pass.
- Release every lease (`argus_release`) when the loop ends.

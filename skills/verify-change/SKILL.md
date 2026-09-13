---
name: verify-change
description: Re-verify a change with Argus before declaring it done — replay every saved flow and audit the changed pages. Use after editing UI, routes, or API handlers, or before shipping.
---

# Verify a change

Only evidence-bearing calls count. `argus_act` moves the app and proves nothing —
the verdict comes from `argus_assert` and from flow `expect` / `success` predicates.

1. `argus_flow_verify` — replay every saved flow in parallel cloud browsers. Fix each
   failure from its decision envelope (`whatChanged → nextAction`), then re-verify.
2. `argus_audit` on the pages you changed — treat critical/major findings (a11y, visual
   diff, perf, broken links) as part of the task, not follow-ups.
3. Built a new user-facing feature? Drive it once under `argus_record`, then
   `argus_flow_save` with network/route predicates — the suite must grow with the app.
4. Report the **weakest** tier the verdict rests on. Missing evidence is
   `coverage: partial`, never a pass.

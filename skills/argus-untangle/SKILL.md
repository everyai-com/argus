---
name: argus-untangle
description: Untangle a codebase with an agent and prove behavior didn't change — Argus replays the suite before and against a preview after. Use when asked to untangle, restructure or broadly refactor a codebase, or to "refactor without breaking anything".
---

# Untangle, held to the suite

The method is caldoai's untangle-codebase skill (MIT); the proof is Argus's.

1. **Contract first.** `argus verify <url>` — every flow that passes now is the
   behavior the refactor must keep. No passing flow, no contract: build the
   suite (`argus verify` generates one) before refactoring.
2. **Run it.** `argus untangle <url> --preview "<cmd that prints the branch's
   preview URL>" [--pr] [--comments] [--tests] [--focus "<area>"]`. The agent
   works in its own worktree: list hidden links, needless links, surplus and
   special cases → redesign from first principles → fix → repeat.
3. **Read the outcome.**
   - `pr` / `verified` — every contract flow passes on the preview.
   - `rejected` — a flow failed twice (behavior changed), or the agent edited
     `.argus/` (the contract). The branch is kept for inspection.
   - `unverified` — no preview, or a flow was flaky/untested: never a PR.
4. **Measure.** The PR carries the special-case count (sleeps/timers, swallowed
   errors, disabled tests) before → after, and the agent's decision log.

Doing the refactor yourself instead? Same bar: run `argus_flow_verify` before
you start, and again on a preview of your branch — every flow that passed must
still pass. Never edit a flow to make a refactor pass.

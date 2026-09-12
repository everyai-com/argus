---
name: argus-explore
description: AI exploration mode — the agent maps an app with Argus cloud browsers, discovers user journeys, saves them as replayable flows, and audits UI/UX. Use when asked to "explore and test" an app, generate a test suite for a URL, or verify software end-to-end with Argus.
---

# Argus exploration mode

Follow the harness-neutral protocol in
[`skills/argus-explore.md`](../../../skills/argus-explore.md): recon → lease +
map → explore in parallel → record → audit → judge screenshots → report.

The short version: `argus_smoke` first; `argus_lease` a session per concurrent
journey; drive with `argus_act_batch`; read `argus_observe` for network/console
truth; save journeys with `argus_record` + `argus_flow_save` carrying
network/route predicates; `argus_audit` for a11y/perf/visual; release every
session. Never fabricate a verdict — report `coverage: partial` instead.

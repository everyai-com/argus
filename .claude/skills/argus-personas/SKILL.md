---
name: argus-personas
description: Launch QA with five first-time-user personas (impatient, skeptic, mobile on slow 3G, literal non-native reader, breaker) in their own Argus cloud browsers — log every confusing/stuck/annoying moment with screenshots, rank by how many personas hit it, fix in one pass, rerun all five to prove it. Use for "launch QA", "first-time user test", "persona test", or a prompt that names user personas.
---

# Argus persona launch QA

Follow the harness-neutral protocol in
[`skills/argus-personas/SKILL.md`](../../../skills/argus-personas/SKILL.md):
set one goal → five persona subagents in parallel, each on its own lease
(mobile = `viewport:"mobile"` + `network:"slow3g"`; breaker uses
`clickCount:2`, `back`, `network:"offline"`) → friction log JSON with a
screenshot per moment → merge by `path|anchor|symptom`, rank by distinct
personas → pin each issue as a red `persona-*` flow → fix in one pass →
`argus_flow_verify` + rerun all five → before/after table.

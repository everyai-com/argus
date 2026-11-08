---
name: argus-untangle
description: Untangle a codebase with an agent and prove behavior didn't change — Argus replays the suite before and against a preview after. Use when asked to untangle, restructure or broadly refactor a codebase, or to "refactor without breaking anything".
---

# Untangle, held to the suite

Follow [`skills/argus-untangle/SKILL.md`](../../../skills/argus-untangle/SKILL.md).

The short version: the flows that pass now are the contract; run
`argus untangle <url> --preview "<cmd>" [--pr]`; every contract flow must pass
on the preview, `.argus/` is off-limits, and no preview means no PR.

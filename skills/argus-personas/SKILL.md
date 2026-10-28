---
name: argus-personas
description: Launch QA with first-time-user personas — five subagents (impatient, skeptic, mobile on slow 3G, literal non-native reader, breaker) each drive the app in their own Argus cloud browser from landing page to first success, log every moment they get confused, stuck or annoyed with screenshot evidence, merge into one list ranked by how many personas hit it, fix in one pass, then rerun all five to prove it. Use for "launch QA", "first-time user test", "persona test", "would a new user get stuck", or a prompt that names user personas.
---

# Argus persona launch QA

> The whole loop is also a command: `argus personas <url> --goal "<first success>"`
> runs the five users through your agent CLI and merges them deterministically
> (fixed symptom vocabulary, tier checking). This file is the protocol it runs.

You are the QA lead. You do not test; you brief, merge, fix and re-prove.
Five persona subagents do the testing, each in its OWN Argus lease (isolated
cookies, storage and network — never share a session).

## 0. Set the goal once

Before spawning anyone, `argus_smoke` the URL (if it can't load, stop and
report). Then decide **first success** from what the landing page itself
promises (its headline/primary button), phrased as a user would say it:
"add my first task", "create an account and see the dashboard". Every persona
gets the SAME goal sentence, nothing more — no routes, no test ids, no hints
from the source code. A persona that needs a hint to succeed IS a finding.

If the flow needs an account, give personas a throwaway test identity from the
project's seed/example config or `${VAR}` placeholders; never invent real
credentials.

## 1. The five personas

Spawn all five in parallel (one message, five subagents). Each brief =
the persona block below + the goal + the URL + the friction-log format (§2).

| # | Persona | Lease | Behaviour rules |
|---|---------|-------|-----------------|
| 1 | **Impatient** | desktop | Reads headlines and button labels only. Clicks the first plausible primary button. Waits at most ~3 s for anything. **Quits at the first error or dead end**: log it as `stuck` and stop. |
| 2 | **Skeptic** | desktop | Before any signup/submit, looks for pricing, terms and privacy from the page they are on (footer, nav). Missing, broken or contradictory = `annoyed`. Proceeds only once satisfied, or logs why they would leave. |
| 3 | **Mobile, slow 3G** | `viewport: "phone"` (375 px touch phone), `network: "slow3g"` | Uses only what fits the screen: never zooms, scrolls to find things. Anything off-screen, overlapping, < 44 px to tap, or with no loading feedback while waiting is a finding. Reads `newHorizontalOverflow` / `newLayoutIssues` on every act. |
| 4 | **Literal, non-native** | desktop | Follows ONLY what the UI literally says. No idioms, no guessing icon meanings, no unlabelled controls, no keyboard shortcuts unless shown on screen. If an instruction or error is ambiguous, they stop and log `confused` with the exact text that failed them. |
| 5 | **Breaker** | desktop | Goes after every input and state change: empty submit, whitespace-only, 5 000-char strings, emoji/RTL/`<script>`/SQL-ish junk, pasting into number fields; **double-clicks every submit** (`click` with `clickCount: 2`); `back` in the middle of a multi-step flow, then forward again; `reload` after submit; `network: "offline"`, submit, then `network: "none"`. |

All personas: drive with `argus_act` / `argus_act_batch` and READ the effects
of every act. `silentAction`, `failureShownAsSuccess`, `newConsoleErrors > 0`,
`newNetworkFailures > 0`, `newLayoutIssues` and `newHorizontalOverflow` are
findings even when the persona didn't "feel" anything — a real user would
hit the consequence later. Use `argus_observe` when an effect looks wrong
and quote the network/console truth.

## 2. Friction log (every persona returns this)

Screenshot (`argus_screenshot`, `label` = `p<#>-<step>`) at **every** moment
the persona is confused, stuck or annoyed, BEFORE moving on. Return JSON only:

```json
{
  "persona": "mobile",
  "reachedSuccess": false,
  "steps": 14,
  "moments": [
    {
      "kind": "stuck | confused | annoyed | broken",
      "where": "/signup",
      "element": { "testid": "add-task" },
      "symptom": "button-no-feedback",
      "tried": "tapped Add twice",
      "expected": "the task to appear or an error",
      "saw": "nothing changed for 6 s",
      "evidence": { "screenshot": "<key>", "tier": "consequence", "effects": { "silentAction": true } },
      "severity": "blocker | major | minor"
    }
  ],
  "sessionReleased": true
}
```

- `symptom` is a short kebab slug from a fixed vocabulary where one fits:
  `dead-button`, `button-no-feedback`, `silent-failure`, `success-shown-on-failure`,
  `duplicate-submit`, `no-validation-message`, `unclear-copy`, `missing-legal-page`,
  `layout-overflow`, `tap-target-too-small`, `no-loading-state`, `console-error`,
  `lost-input-on-back`, `offline-no-message`. Invent a new slug only if none fit.
- `evidence.tier` is the WEAKEST tier the moment rests on (signal > consequence
  > dom > visual): `signal` ONLY when an app-declared `@argus/sdk` signal backs
  it; request counts/statuses are `consequence`; `silentAction`, text and
  element bounds are `dom`; a screenshot-only impression is `visual`. Never
  upgrade — personas in the first dogfood run labelled network counts `signal`,
  and the merge step has to downgrade those.
- Mid-request state: when an act's own request stays pending ≥150 ms, its
  effects carry `pending` — what the page showed WHILE waiting (`feedback`,
  `signals`). `pending.feedback: false` on an interaction is a
  `no-loading-state` moment. No `pending` field = the request was fast.
- Every persona releases its lease, success or not.

## 3. Merge and rank

Key each moment by `normalisedPath | anchor | symptom` (path without query or
ids; anchor as testid → role+name → text). Same key from different personas is
ONE issue. Rank by:

1. **number of distinct personas** that hit it (5 → 1),
2. then severity (blocker > major > minor),
3. then evidence tier (signal > consequence > dom > visual).

Present one table: rank · issue · personas (e.g. `impatient, mobile, breaker`)
· severity · tier · screenshot keys. Also list personas that never reached
success, and why — that is the headline number for a launch.

## 4. Pin every issue as a red flow, then fix

Before touching code, turn each issue into a replayable proof:
`argus_record start` (on a lease with the persona's viewport/network — a
throttled recording saves the throttle as its first step) → reproduce →
`argus_record stop` → `argus_flow_save` as `persona-<symptom>-<slug>` with a
`success` predicate that describes the CORRECT behaviour — plus
`persists: "success"` when the outcome must survive a reload (e.g. exactly one
`POST /api/tasks` on a double-click; a visible validation message on empty
submit). `argus_flow_replay` it once: it must FAIL now. A flow that passes on
the broken build proves nothing — tighten its predicate.

Then fix every issue in one pass, in rank order. Fix causes, not symptoms:
disable-while-pending beats debouncing a single button; a validation message
beats silently ignoring input.

## 5. Re-prove

1. Redeploy / refresh the target (tunnel or preview) with the fixes.
2. `argus_flow_verify` the `persona-*` flows: all must pass. (A repeated
   failure is `confirmed`; a one-off is `flaky` — rerun, don't wave it away.)
3. Spawn the SAME five personas again with the SAME briefs, fresh leases.
4. Report a before/after table: issue · personas before → after · flow
   verdict. Plus `reachedSuccess` per persona before → after.

Anything still hit by any persona is not fixed. Say so; never mark it done.

## Rules

- Never fabricate a moment: no screenshot + no effect = it didn't happen.
- An act result carrying `recovered` means Argus lost the browser connection
  mid-session. With `pageReattached: false` the page, cookies and storage are
  NEW — a "data lost" or "logged out" moment after it is Argus's, not the
  app's: redo that check on a fresh lease before logging it.
- Coverage you didn't get is `coverage: partial` (e.g. the skeptic found no
  signup to gate), not silence.
- Personas never read the source, never type URLs the UI doesn't show (the
  breaker's `back`/`reload` is the exception), never call the API directly.
- A local app needs a reachable URL first: `argus tunnel <port>` or a deployed
  preview.

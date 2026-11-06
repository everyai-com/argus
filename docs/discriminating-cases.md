# Discriminating cases for generated suites (sketch)

Status: built. The shared schema (`rows` with `some`/`someNot`,
`step.snapshot: { name, item }`, `precondition`, `precondition_unmet`), replay
support in `flows.ts`, `judgeRows` in `verify.ts`, the generator and the
run-twice gate in `cli/src/preset.ts` + `generatePresetSuite`. Dogfood: the demo
has a "Filter tasks" box; `?bug=ignoredfilter` makes the generated
`list-filter-applies` fail with `row without "everything": "Ship Argus"`.
Open: the signed-in list probe runs only once an auth profile exists (the
first `verify` mints it), and debounced server search may need a request wait. Borrowed from Pomerado's live-test rules
(MIT, `docs/how-it-works.md` in github.com/Pomerado/pomerado), adapted to
Argus's invariants.

## The gap

`argus verify` auto-generates a baseline suite when none exists
(`packages/cli/src/preset.ts`). Every generated flow proves a page *exists and
renders*: landing loads, sign-in has a password field, the protected route is
not the not-found page. None proves the app returns *right data*.

The bugs that slip past that suite:

- a search box or filter the app ignores (the list looks fine, just unfiltered)
- a "Next page" that re-renders page one
- a filter that empties the list for every value

A naive check can't catch them either. "Type `acme`, assert a row contains
`acme`" passes when the filter is ignored, because the unfiltered list contains
`acme` too. That is an absence claim without complete evidence, which the
invariants already forbid.

## Pomerado's rule, restated for Argus

A filter case only counts when the value is chosen so that **at least one
visible row must disappear and at least one must stay**. Then:

- ignored filter → the excluded row is still there → fail
- broken filter (empties everything) → the kept row is gone → fail
- working filter → pass

Pagination gets the same treatment: page two must hold at least one row page
one did not. A page two that is a subset of page one fails.

## What has to change

### 1. Wire contract (`packages/shared`, first, per the invariants)

**New leaf predicate `rows`** (tier: `dom`). It asserts over a *set* of
elements, where today's anchors resolve to exactly one:

```ts
z.object({
  kind: z.literal("rows"),
  item: AnchorSchema,                 // matches EVERY row, e.g. { role: "row" }
  every: z.object({ includes: z.string() }).optional(),
  none:  z.object({ includes: z.string() }).optional(),
  minCount: z.number().int().optional(),
  maxCount: z.number().int().optional(),
  /** Compare against the row texts a named snapshot recorded earlier in this run. */
  fewerThan: z.string().optional(),       // count < snapshot's count
  notSubsetOf: z.string().optional(),     // ≥1 row text absent from the snapshot
})
```

"Ambiguous anchors are errors" stays true everywhere else: `item` is the one
place an anchor is *meant* to match many, and it's a separate field so nobody
reuses it by accident. Zero matches with `every` set fails as unverifiable, not
as a vacuous pass. This is the absence-claim rule again.

**New step field `snapshot: string`.** It records the `item` row texts after
the step settles. It lives in replay memory for this run only and is never
persisted. This lets `fewerThan` / `notSubsetOf` compare within one run, with
no row data baked into the flow file.

**New flow field `precondition: Predicate[]`, plus a new verdict
`precondition_unmet`** (additive to `FlowVerdictSchema`). It checks the data
shape the case depends on before step 1. If it fails, the flow is
**untested**, like `fleet_busy`. That keeps it from being read as a
regression: live data changes between runs, and a missing row is drift in the
test data, not a bug in the app.

### 2. Probe (`preset.ts`, `probeApp`)

On the authed page (`protectedPath`, with the auth profile), render once and
find:

- a search control: `role: searchbox`, else a `textbox` whose name matches
  `/search|filter/i`
- a row set: `role: row` (minus header), else `listitem` inside the main region
- a pager: `role: button | link` named `/^next( page)?$|›|»/i`

It reads the DOM only. It types nothing, clicks nothing and submits nothing
while probing, like `/v1/crawl`. Anything it finds goes into `ProbeResult`
as role+name anchors. It never stores `eN` refs.

### 3. Picking the discriminating value (generation time)

From the probed row texts, pick a value `V` such that

```
some rows include V   AND   some rows do not
```

There are several reasonable ways to pick `V`. This is the one real design
decision, see "Open questions".

### 4. The generated flows

**`list-filter-applies`**

```
precondition: rows{ item, minCount: 2 }
              anyOf: rows include V / rows lacking V   (both must exist)
step 1: wait                          snapshot: "before"
step 2: fill V into search control
step 3: wait for the act's own requests (waitForQuiet, as every act does)
success: rows{ item, every: { includes: V }, minCount: 1, fewerThan: "before" }
         console-clean
```

`fewerThan: "before"` is what replaces baking an excluded row into the file.
It only works because the precondition already proved that the before-set held
a row without `V`.

**`list-next-page-advances`** (only if a pager was found)

```
step 1: wait                          snapshot: "p1"
step 2: click pager
success: rows{ item, minCount: 1, notSubsetOf: "p1" }
         console-clean
```

### 5. Generation gate (Pomerado publishes at ≥70% of its own cases)

Argus's version, built on "only a repeated failure counts". Run each new case
twice right after generating it:

| first run × second run | outcome |
| --- | --- |
| pass × pass | saved to `.argus/flows/` |
| same failure × same failure | saved as `candidate-<name>.json`, reported, **not** in the suite. It may be a real bug or a bad case; a human decides once. |
| disagree | dropped and listed under `skipped` with the reason |
| precondition_unmet | dropped and listed under `skipped` |

A generated case never fails CI before a human has seen it fail once. That
matches "automation never overwrites a human decision", seen from the other
side.

## Out of scope

- Write-side cases (create → read back). `persists` already covers that class.
- Sort order. That needs typed comparisons (dates, money) and is a separate design.
- Anything using the judge. These are deterministic DOM verdicts; the judge
  may annotate a failure, never decide one.

## Open questions

1. **Value choice.** Options: the longest token shared by between 20% and 80% of
   rows (most selective but stable), the first word of the first row (simple,
   often too broad), or a token from a specific column (needs column detection).
2. **Where the probe runs.** It needs the authed page, so it has to run after
   the `auth-login` flow mints its profile. `verifyFlows` already runs
   profile-minting flows as a first wave; generation needs the same ordering.
3. **Server-side search with debounce.** `waitForQuiet` waits for the act's own
   requests. A search that debounces for 300ms before it fetches starts its
   request *after* the act settles. Step 3 may need a bounded "wait for a
   request matching the list endpoint" form.

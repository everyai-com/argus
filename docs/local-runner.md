# Local runner — `argus run`

Code-first tests on a Chromium on your machine. No cloud, no tunnel, no Argus
token, no model: `argus run` starts your app, runs the tests, stops your app.

```ts
// tests/task-board.argus.ts
import { expect, test } from "@argus/runner";

test("Add posts the task and lists it", async ({ page, network }) => {
  await page.goto("/");
  await page.getByPlaceholder("New task title").fill("Buy milk");
  await page.getByRole("button", "Add").click();

  await expect(network).toHaveRequest({ method: "POST", url: "/api/tasks", status: 201, times: 1 });
  await expect(page.getByTestId("task-count")).toHaveText("3 task(s)");
});
```

```ts
// argus.config.ts
import { defineConfig } from "@argus/runner";

export default defineConfig({
  app: { url: "http://127.0.0.1:5199", command: "vite preview --port 5199 --strictPort" },
});
```

```bash
argus run                      # every *.argus.ts under the config
argus run tests/task-board     # files whose path contains this
argus run --grep "Add posts"   # tests whose title contains this
argus run --headed             # watch it
argus run --json               # the result as JSON on stdout
argus run --install-browser    # download Playwright's Chromium first if missing (~110 MB, once)
```

Exit code `0` all passed · `1` a test failed · `2` the run could not happen
(bad config, port taken, app did not start, no browser). Needs Node ≥ 22.18:
test files are TypeScript loaded natively, so they use erasable syntax only
(no `enum`, no parameter properties) and relative imports carry `.ts`.

## What is different from a locator runner

**One anchor model.** `page.getByRole("button", "Add")` is not a second locator
language: it builds the same semantic `Anchor` a saved flow carries
(`{ role: "button", name: "Add" }`) and resolves it with the same code the cloud
replay uses (`@argus/core`). The ladder is testid → role+name → label →
placeholder → text → css.

**Verify-or-refuse.** Acting on an anchor, or reading one element through it,
requires exactly one match. Several is `ambiguous_anchor`, naming the
candidates — never the first one. So there is no `.first()` or `.nth()`;
tighten the anchor. Counting and listing are plural by nature and are the two
assertions many elements may answer: `toHaveCount(n)` and `toHaveText([...])`.

**Audit gates.** Every test also fails if its page logged a first-party console
error (`console_error`) or ends up scrolling sideways (`horizontal_overflow`) —
the two classes a locator-only test passes straight over. A test that provokes
an error on purpose declares it: `audit.allowConsoleErrors("status of 401")`.
Turn a gate off per test (`test("…", { audit: { horizontalOverflow: false } }, fn)`)
or for the project (`audit` in the config).

**Consequences, not just pixels.** `expect(network).toHaveRequest(...)` is the
wire `network` predicate: a POST that returned 500 fails it even when the UI
rendered optimistically. `expect(page).toSatisfy(predicate)` takes any predicate
from a saved flow (`network`, `route`, `console-clean`, `storage`, `signal`,
`state`, `allOf`/`anyOf`, …) and reports the weakest evidence tier it rests on.

**No false greens from a missing `await`.** A runner call nobody awaited could
not have failed its test, so the test fails (`unawaited`) and points at the line.

**Secure fields.** The value of a password field (or a `one-time-code` /
card-data field) is never returned — not by `value()`, `toHaveValue`, or
`toHaveAttribute("value")`, and a value typed into a field never appears in a
failure message. Assert a consequence instead.

**Failures are decisions.** Same envelope as a flow replay:

```
1) task board › Add posts the task and lists it
   tests/task-board.argus.ts:28:27
   > await expect(network).toHaveRequest({ method: "POST", url: "/api/tasks", status: 201, times: 1 });
   expectation_failed [consequence]: 0 matching request(s) for "/api/tasks" status=201 (wanted ≥1, ≤1) — saw: POST …/api/tasks → 500
   next: the action landed but its expected consequence did not occur — this is the silent-failure class; …
   also: console error — Failed to load resource: the server responded with a status of 500
   screenshot: .argus/runs/local/task-board-add-posts-the-task-and-lists-it.png
```

Verdicts (agents switch on these, never on prose): the flow verdicts `drift`,
`ambiguous_anchor`, `expectation_failed`, `error`, plus `assertion_failed`,
`secure_field`, `console_error`, `horizontal_overflow`, `timeout`, `unawaited`.

## API

Fixtures: `page`, `network`, `audit`.

| | |
|---|---|
| `page.goto(pathOrUrl)` · `reload()` · `back()` · `press(key)` · `scroll()` · `wait(ms)` · `url()` · `title()` · `screenshot()` | a path resolves against `app.url` |
| `page.getByTestId(id)` · `getByRole(role, name?)` · `getByLabel(text)` · `getByPlaceholder(text)` · `getByText(text)` · `locator(css)` · `anchor({...})` | each returns a `Locator` — an anchor, nothing more. `getByRole("button", { name })` works too |
| `locator.click()` · `fill(v)` · `clear()` · `press(key)` · `hover()` · `selectOption(v)` | exactly one match, or a refusal |
| `locator.text()` · `value()` · `count()` · `isVisible()` | one-shot reads |
| `expect(locator)` `.toBeVisible()` `.toBeHidden()` `.toBeEnabled()` `.toBeDisabled()` `.toBeChecked()` `.toHaveText(s \| re \| [...])` `.toContainText(s \| re)` `.toHaveValue(s \| re)` `.toHaveAttribute(name, s \| re)` `.toHaveCount(n)` | wait until true or the budget ends; `.not` inverts. Text is rendered text (a CSS-uppercased label reads uppercased) — pass `{ ignoreCase: true }` or a regex |
| `expect(page)` `.toHaveURL(s \| re)` `.toHaveTitle(s \| re)` `.toSatisfy(predicate \| [...])` `.toHaveNoConsoleErrors()` `.toHaveNoHorizontalOverflow()` | |
| `expect(network)` `.toHaveRequest({ url, method?, status?, times?, since? })` | positive: succeeded (or returned `status`). `.not`: never made at all, after the network goes quiet |
| `network.requests(match?)` · `network.mark()` | observed traffic; a mark scopes later assertions (`since`) |
| `audit.allowConsoleErrors(...patterns)` · `consoleErrors()` · `horizontalOverflow()` | |
| `expect(value)` `.toBe` `.toEqual` `.toContain` `.toMatch` `.toHaveLength` `.toBeTruthy` … | plain synchronous comparisons |
| `test(title, [options], fn)` · `test.skip` · `test.only` · `describe` · `beforeEach` · `afterEach` | options: `timeout`, `viewport`, `audit`. `.only` is refused when `CI` is set |

## Config

| Key | Default | |
|---|---|---|
| `tests` | `**/*.argus.ts` | globs, relative to the config file |
| `app.url` | — | where the app answers; base for `page.goto("/path")` |
| `app.command` | — | shell command that starts it (`node_modules/.bin` is on PATH). The whole process tree is stopped after the run |
| `app.cwd` · `app.env` · `app.readyUrl` · `app.startupTimeout` | config dir · — · `app.url` · 60000 | |
| `viewport` | `desktop` | `mobile` \| `tablet` \| `desktop` (the wire contract's sizes) or `{ width, height }` |
| `timeout` · `expectTimeout` · `actionTimeout` | 30000 · 5000 · 5000 | ms |
| `audit` | both gates on | `{ consoleErrors, horizontalOverflow, includeThirdParty }` |
| `workers` | 1 | test files run side by side |
| `browser` | Playwright's Chromium | `{ headless, channel, executablePath }`; `ARGUS_BROWSER_PATH` also works. Falls back to an installed Chrome |
| `outputDir` | `.argus/runs/local` | failure screenshots and `app.log` |

With `app.command`, the port must be free: something already listening there is
an error (`port 5199 is already in use — something is listening on
127.0.0.1:5199`), never a silent reuse — it is usually yesterday's build.
Without `app.command`, the runner tests whatever already answers at `app.url`.

## How it is built

```
test file ──► page / network / audit / expect        packages/runner/src/api.ts, expect.ts
                  │  plain data: Action + Anchor, Predicate, ElementCheck
                  ▼
              Driver (interface)                       packages/runner/src/driver.ts
                  │
        ┌─────────┴─────────┐
   LocalDriver          (fleet driver — not built)
   playwright-core      /v1/sessions/:id/act|query|assert|observe
        │
   @argus/core  ◄── also imported by packages/cloud (flow replay, sessions, smoke, audit)
   anchor ladder · ambiguity refusal · predicates · event buffers · audit signals
```

A test file never holds a Playwright object. Everything it does crosses the
`Driver` interface as data from the wire contract, and waiting happens on the
driver's side. That is the seam that lets the same file run on the cloud fleet
later: a second `Driver` that speaks to a leased session, with no change to the
tests. The pieces still to come attach here too — request interception to the
`network` fixture, model-driven steps as a new fixture beside `page`, reports to
the `RunResult` JSON (`--json` prints it today), retries and sharding to the
loop in `run.ts`.

## In this repo

| Suite | Runs against | Command |
|---|---|---|
| `apps/demo/tests` | the task board under `vite preview` | `pnpm --filter @argus/demo test:local` |
| `apps/demo/tests/bug-matrix.mjs` | the same suite, once per `?bug=` variant — each must fail with its predicted verdict | (part of the above) |
| `packages/cloud/tests` | the console on the real Worker under `wrangler dev --local` | `pnpm --filter @argus/cloud test:local` |
| `packages/runner/tests` | the runner itself, on a fixture page, plus negative controls that must fail | `pnpm --filter @argus/runner test:local` |

`pnpm test` runs all of them after the unit tests (`pnpm test:local` alone skips
the unit tests).

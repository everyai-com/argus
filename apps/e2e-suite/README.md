# e2e trial suite

A trial of the [`e2e`](https://github.com/e2e-inc/e2e) test runner (Playwright-based,
pre-1.0) against Argus's own UIs. It sits beside Argus's tests (`pnpm test`,
`scripts/live-e2e.mjs`, `.argus/flows/`) and replaces none of them. Whether Argus
adopts e2e is not decided.

| Suite | What it drives | Server |
| --- | --- | --- |
| `tests/demo` | the dogfood task board (`apps/demo`): load, add by button, add by Enter, blank title | `vite preview` of the production build, port 5199 |
| `tests/console` | the Argus console: signed-out landing, sign up → mint MCP token → read the fleet, rejected token, admin capacity view | the **real Worker** under local workerd (`wrangler dev --local`) with throwaway D1/R2/DO state, port 8787 — nothing mocked |

Every step is a locator or an `expect`. No `agent.*` step, no model, no key —
so CI needs no secret. Cloud browsers are not involved either: Chromium runs on
the machine.

## Run

```bash
export E2E_TELEMETRY_DISABLED=1          # always: no usage data leaves the machine
pnpm install
pnpm --filter @argus/e2e-suite browsers  # one-time Chromium download (~125 MB)
pnpm --filter @argus/e2e-suite test:e2e  # or test:demo / test:console
```

Needs Node `^22.22.3 || >=24.8`. Each config starts and stops its own server
(`app.command`); reports and traces land in the gitignored `.e2e/`.

## Notes for whoever edits these tests

- e2e matches **rendered** text: a CSS-uppercased label reads as `TOKEN REJECTED`.
  Match such text with a case-insensitive regex.
- e2e refuses to read a password field's value (`POLICY_DENIED`). The rail's
  token field is `type="password"`, so assert a consequence instead.
- `--output` must stay inside this directory.
- The console suite tests the **promoted** bundle in `packages/cloud/public`,
  i.e. what ships — not `packages/dashboard/src` until it is promoted.
- The admin token and auth secret in `scripts/serve-console.mjs` are local-only
  test values passed to `wrangler dev --var`; they exist nowhere else.

# Contributing

## Local verification

Use Node.js 22 and pnpm 11.3.0, then run:

```bash
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` includes the local browser suites (`pnpm test:local`): the first
run downloads Playwright's Chromium (~110 MB), and the suites start and stop
their own servers on ports 5199–5205, 5295–5298, 5391–5394 and 8797 — a port already in use
fails the run by design. They need no token and no Cloudflare login.

Pull requests must keep typechecking, tests, and production builds green. Add a
regression test for behavior changes whenever the affected code can be tested
without a live Cloudflare browser. Live Browser Rendering checks belong in a
separate deployment workflow so pull requests never receive production secrets.

Never commit tokens, `.dev.vars`, `.argus/config.json`, browser storage state,
screenshots containing private data, or generated run artifacts.

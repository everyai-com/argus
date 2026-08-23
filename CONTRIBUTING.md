# Contributing

## Local verification

Use Node.js 22 and pnpm 11.3.0, then run:

```bash
pnpm install --frozen-lockfile
pnpm check
```

Pull requests must keep typechecking, tests, and production builds green. Add a
regression test for behavior changes whenever the affected code can be tested
without a live Cloudflare browser. Live Browser Rendering checks belong in a
separate deployment workflow so pull requests never receive production secrets.

Never commit tokens, `.dev.vars`, `.argus/config.json`, browser storage state,
screenshots containing private data, or generated run artifacts.

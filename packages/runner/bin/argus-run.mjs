#!/usr/bin/env node
// `argus run` without the CLI package: the runner's own entry point.
// Plain JS on purpose — it has to exist before anything is built.
if (!process.features.typescript) {
  console.error(
    `argus run needs Node >= 22.18 (it loads TypeScript test files natively); this is ${process.version}`
  );
  process.exit(2);
}
const { main } = await import("../src/cli.ts");
process.exit(await main(process.argv.slice(2)));

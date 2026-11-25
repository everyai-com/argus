/**
 * e2e trial — the dogfood task board (apps/demo), served as the production
 * build by `vite preview`. Build it first: `pnpm --filter @argus/demo build`
 * (the `test:demo` script does). No agent/model is configured on purpose:
 * everything here is locators + `expect`, so the run needs no model key.
 */
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  tests: ['tests/demo/**/*.e2e.ts'],
  output: '.e2e/demo',
  targets: [{
    name: 'demo',
    engine: web(),
    app: {
      url: 'http://127.0.0.1:5199',
      command: {
        executable: 'pnpm',
        args: ['exec', 'vite', 'preview', '--host', '127.0.0.1', '--port', '5199', '--strictPort'],
        cwd: '../demo',
        log: '.e2e/demo/logs/app.log',
        reuseExisting: true,
      },
    },
  }],
} satisfies E2EConfig;

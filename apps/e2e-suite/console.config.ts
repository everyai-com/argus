/**
 * e2e trial — the Argus console (the dashboard bundle promoted into
 * packages/cloud/public) served by the REAL Worker under local workerd:
 * Hono API, better-auth on local D1, R2, Coordinator DO. Nothing is mocked.
 * scripts/serve-console.mjs gives every run a throwaway D1/R2/DO state dir.
 * No agent/model is configured: locators + `expect` only, no model key.
 */
import type { E2EConfig } from 'e2e';
import { web } from '@e2e-dev/web';

export default {
  tests: ['tests/console/**/*.e2e.ts'],
  output: '.e2e/console',
  targets: [{
    name: 'console',
    engine: web(),
    app: {
      url: 'http://127.0.0.1:8787',
      readyUrl: 'http://127.0.0.1:8787/health',
      command: {
        executable: 'node',
        args: ['scripts/serve-console.mjs', '8787'],
        log: '.e2e/console/logs/app.log',
        startupTimeout: 120_000,
      },
    },
  }],
} satisfies E2EConfig;

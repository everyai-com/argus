// Serves the real Argus Worker locally for the e2e trial: applies the D1
// migrations into a throwaway state dir, then runs `wrangler dev --local`.
// The admin token and auth secret below are local-only test values.
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ADMIN_TOKEN = 'e2e-local-admin-token';
const port = process.argv[2] ?? '8787';
const cloud = resolve(dirname(fileURLToPath(import.meta.url)), '../../../packages/cloud');
const state = mkdtempSync(join(tmpdir(), 'argus-e2e-'));
const env = { ...process.env, CI: '1', WRANGLER_SEND_METRICS: 'false' };

const migrate = spawnSync(
  'pnpm',
  ['exec', 'wrangler', 'd1', 'migrations', 'apply', 'argus-accounts', '--local', '--persist-to', state],
  { cwd: cloud, env, stdio: 'inherit' },
);
if (migrate.status !== 0) process.exit(migrate.status ?? 1);

const dev = spawn(
  'pnpm',
  [
    'exec', 'wrangler', 'dev', '--local', '--ip', '127.0.0.1', '--port', port,
    '--persist-to', state, '--show-interactive-dev-session=false',
    '--var', `ARGUS_TOKEN:${ADMIN_TOKEN}`,
    '--var', 'BETTER_AUTH_SECRET:e2e-local-only-secret-not-used-anywhere-else',
  ],
  { cwd: cloud, env, stdio: 'inherit' },
);
const stop = () => { dev.kill('SIGTERM'); };
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
dev.on('exit', (code) => {
  rmSync(state, { recursive: true, force: true });
  process.exit(code ?? 0);
});

import { test } from '@e2e-dev/web';
import { describe, expect } from 'e2e';

// Must match scripts/serve-console.mjs — a local-only value, not a secret.
const ADMIN_TOKEN = 'e2e-local-admin-token';

describe('console', () => {
  test('a signed-out visitor lands on account creation', async ({ app, screen }) => {
    await app.open('/');

    await expect(screen.getByRole('heading', 'Create your Argus account')).toBeVisible();
    const create = screen.getByRole('button', 'Create account');
    await expect(create).toBeDisabled();

    await screen.getByLabel('Email').fill('short-pass@example.test');
    await screen.getByLabel('Password').fill('1234567');
    await expect(create).toBeDisabled();

    await screen.getByLabel('Password').fill('12345678');
    await expect(create).toBeEnabled();
  });

  test('sign up, mint an MCP token, and read the fleet with it', async ({ app, browser, screen }) => {
    const email = `e2e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
    await app.open('/');

    await screen.getByLabel('Email').fill(email);
    await screen.getByLabel('Password').fill('correct-horse-battery');
    await screen.getByRole('button', 'Create account').tap();

    await expect(screen.getByText('signed in')).toBeVisible();
    await expect(screen.getByText(email)).toBeVisible();

    const [minted] = await Promise.all([
      browser.waitForResponse({ method: 'POST', url: '**/api/mcp-token' }),
      screen.getByRole('button', 'Create MCP token').tap(),
    ]);
    expect(minted.status).toBe(200);

    await expect(screen.getByText('Copy it now — it is not shown again.')).toBeVisible();
    // The token is shown once. (It also lands in the rail's password field, but
    // e2e refuses to read a secure field's value — POLICY_DENIED — so assert the
    // consequence instead: the rail now offers "Clear token".)
    await expect(screen.getByText(/^argus_[A-Za-z0-9_-]{16,}$/)).toBeVisible();
    await expect(screen.getByRole('button', 'Clear token')).toBeVisible();

    // The real /v1 API accepts the minted token: the fleet view renders its
    // empty state instead of the "Token rejected" alert.
    await screen.getByRole('button', 'Fleet').tap();
    await expect(screen.getByRole('heading', 'Fleet')).toBeVisible();
    await expect(screen.getByText('No tagged runs yet')).toBeVisible();
    await expect(screen.getByRole('alert')).toHaveCount(0);
  });

  test('a wrong token is rejected with a way out', async ({ app, screen }) => {
    await app.open('/?tab=runs');

    await screen.getByLabel('API token').fill('argus_not-a-real-token');

    const alert = screen.getByRole('alert');
    // The label is CSS-uppercased and e2e matches rendered text, so match by regex.
    await expect(alert).toContainText(/token rejected/i);
    await expect(alert).toContainText('401');
    await alert.getByRole('button', 'Open Account').tap();
    await expect(screen.getByRole('heading', 'Create your Argus account')).toBeVisible();
  });

  test('the admin token reads live capacity', async ({ app, screen }) => {
    await app.open('/?tab=capacity');

    await screen.getByLabel('API token').fill(ADMIN_TOKEN);

    await expect(screen.getByRole('heading', 'Capacity')).toBeVisible();
    await expect(screen.getByRole('heading', 'Tenants')).toBeVisible();
    await expect(screen.getByText('60 browser slots free')).toBeVisible();
    await expect(screen.getByRole('alert')).toHaveCount(0);
  });
});

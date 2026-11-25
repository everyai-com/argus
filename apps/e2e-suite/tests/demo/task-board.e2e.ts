import { test } from '@e2e-dev/web';
import { describe, expect } from 'e2e';

describe('task board', () => {
  test('loads the seeded tasks', async ({ app, screen }) => {
    await app.open('/');

    await expect(screen.getByRole('heading', 'Task Board')).toBeVisible();
    await expect(screen.getByTestId('task-count')).toHaveText('2 task(s)');
    await expect(screen.getByRole('listitem')).toHaveCount(2);
    await expect(screen.getByRole('listitem').first()).toHaveText('Ship Argus');
  });

  test('Add posts the task and lists it', async ({ app, browser, screen }) => {
    await app.open('/');
    await expect(screen.getByTestId('task-count')).toHaveText('2 task(s)');

    await screen.getByPlaceholder('New task title').fill('Write the e2e trial');
    const [response] = await Promise.all([
      browser.waitForResponse({ method: 'POST', url: '**/api/tasks*' }),
      screen.getByRole('button', 'Add').tap(),
    ]);

    // Consequence first (the POST really succeeded), then what the user sees.
    expect(response.status).toBe(201);
    await expect(screen.getByRole('listitem')).toHaveCount(3);
    await expect(screen.getByRole('listitem').last()).toHaveText('Write the e2e trial');
    await expect(screen.getByTestId('task-count')).toHaveText('3 task(s)');
    await expect(screen.getByPlaceholder('New task title')).toHaveValue('');
  });

  test('Enter in the title field adds the task', async ({ app, browser, screen }) => {
    await app.open('/');
    await expect(screen.getByTestId('task-count')).toHaveText('2 task(s)');

    const title = screen.getByPlaceholder('New task title');
    await title.fill('Added with Enter');
    const [response] = await Promise.all([
      browser.waitForResponse({ method: 'POST', url: '**/api/tasks*' }),
      title.press('Enter'),
    ]);

    expect(response.status).toBe(201);
    await expect(screen.getByText('Added with Enter')).toBeVisible();
    await expect(screen.getByTestId('task-count')).toHaveText('3 task(s)');
  });

  test('a blank title adds nothing and sends no request', async ({ app, browser, screen }) => {
    let posts = 0;
    await browser.route('**/api/tasks*', async (route) => {
      if (route.request.method === 'POST') posts += 1;
      await route.continue();
    });
    await app.open('/');
    await expect(screen.getByTestId('task-count')).toHaveText('2 task(s)');

    await screen.getByPlaceholder('New task title').fill('   ');
    await screen.getByRole('button', 'Add').tap();

    await expect(screen.getByRole('listitem')).toHaveCount(2);
    await expect(screen.getByTestId('task-count')).toHaveText('2 task(s)');
    expect(posts).toBe(0);
  });
});

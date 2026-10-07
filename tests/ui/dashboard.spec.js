import { test, expect } from '@playwright/test';

test.describe.configure({ mode: 'serial' });
test('desktop and mobile layouts are readable and do not overflow', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Your time. Back.' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Review request' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
    await page.getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Connect your accounts' })).toBeVisible();
    expect(
      await page
        .locator('#settings-dialog')
        .evaluate((node) => node.scrollWidth <= node.clientWidth),
    ).toBeTruthy();
    await page.getByRole('button', { name: 'Close settings' }).click();
  }
  expect(errors).toEqual([]);
});
test('demo flows through review, IVR, hold, private guidance, explicit confirmation, and deletion', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Cancel an appointment', exact: true }).click();
  await page.getByRole('button', { name: 'Review request' }).click();
  await expect(page.locator('#review-dialog')).toBeVisible();
  await expect(page.locator('#start-call')).toBeDisabled();
  await page.locator('#confirmed').check();
  await page.locator('#start-call').click();
  await expect(page.locator('#status')).toHaveText('Listening');
  await page.getByRole('button', { name: 'Phone menu', exact: true }).click();
  await expect(page.locator('#transcript')).toContainText('Pressed 1');
  await page.getByRole('button', { name: 'Put on hold', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Listening');
  await page.getByRole('button', { name: 'Live agent', exact: true }).click();
  await expect(page.locator('#transcript')).toContainText('I’m an AI assistant');
  await page.getByRole('button', { name: 'Ask for details', exact: true }).click();
  await expect(page.locator('#question-box')).toBeVisible();
  await page.locator('#guidance').fill('The account holder can verify directly.');
  await page.locator('#guide-form').getByRole('button', { name: 'Send', exact: true }).click();
  await expect(page.locator('#question-box')).toBeHidden();
  await expect(page.locator('#transcript')).toContainText('You · private');
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Session ended');
  await expect(page.locator('#summary-box')).toContainText('DEMO-123');
  await expect(page.locator('#outcome-label')).toHaveText('REQUEST CONFIRMED');
  await page.reload();
  await expect(page.locator('#summary-box')).toContainText('DEMO-123');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download transcript' }).click();
  expect((await download).suggestedFilename()).toMatch(/^call-.*\.txt$/);
  await page.getByRole('button', { name: 'Delete transcript' }).click();
  await expect(page.locator('#empty-state')).toBeVisible();
});
test('company replies are rendered as text, and pause/resume and manual stop work', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Cancel an appointment', exact: true }).click();
  await page.getByRole('button', { name: 'Review request' }).click();
  await page.locator('#confirmed').check();
  await page.locator('#start-call').click();
  await page.getByRole('button', { name: 'Pause agent', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Agent paused');
  await page
    .locator('#company-line')
    .fill('<img src=x onerror="window.injected=true"> Hello, how can I help?');
  await page.locator('#transcript-form').getByRole('button', { name: 'Reply' }).click();
  await expect(page.locator('#transcript')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  await page.getByRole('button', { name: 'Resume agent', exact: true }).click();
  await expect(page.locator('#transcript')).toContainText('I’m an AI assistant');
  await page.getByRole('button', { name: 'End session', exact: true }).click();
  await expect(page.locator('#status')).toHaveText('Session ended');
  await expect(page.locator('#outcome-label')).toHaveText('CALL SUMMARY');
  await page.getByRole('button', { name: 'Delete transcript' }).click();
});
test('invalid settings errors are visible inside the settings dialog', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.locator('#publicUrl').fill('http://example.com');
  await page.getByRole('button', { name: 'Save settings' }).click();
  await expect(page.locator('#settings-result')).toContainText('public HTTPS tunnel');
  await page.getByRole('button', { name: 'Close settings' }).click();
});
test('phone-call review shows the recording choice and supports opting out', async ({ page }) => {
  await page.route('**/api/settings', (route) =>
    route.fulfill({
      json: {
        browserReady: true,
        phoneReady: true,
        fromNumber: '+13125550123',
        environmentFields: [],
      },
    }),
  );
  await page.goto('/');
  await page.getByRole('button', { name: 'Cancel an appointment', exact: true }).click();
  await page.locator('#mode').selectOption('phone');
  await page.locator('#to').fill('+13125550124');
  await expect(page.locator('#record-call')).toBeEnabled();
  await expect(page.locator('#record-call')).toBeChecked();
  await page.getByRole('button', { name: 'Review request' }).click();
  await expect(page.locator('#review-recording')).toContainText('On — saved locally');
  await page.getByRole('button', { name: 'Edit request' }).click();
  await page.locator('#record-call').uncheck();
  await page.getByRole('button', { name: 'Review request' }).click();
  await expect(page.locator('#review-recording')).toHaveText('Off');
  await page.getByRole('button', { name: 'Edit request' }).click();
});
test('recording library survives reload, renders safely, and offers file download and deletion', async ({
  page,
}) => {
  const id = 'e41a959f-bd36-49a0-b82c-7927d7cf69dd';
  let recordings = [
    {
      id,
      company: '<img src=x onerror="window.injected=true"> Clinic',
      createdAt: '2026-10-07T16:00:00.000Z',
      status: 'ready',
      filename: `call-2026-10-07T16-00-00-${id}.mp3`,
      duration: 45,
      bytes: 2048,
    },
  ];
  await page.route('**/api/recordings', (route) =>
    route.fulfill({ json: { directory: '/Users/example/recordings', recordings } }),
  );
  await page.route(`**/api/recordings/${id}`, async (route) => {
    recordings = [];
    await route.fulfill({ status: 204 });
  });
  await page.route(`**/api/recordings/${id}/audio?download=1`, (route) =>
    route.fulfill({
      contentType: 'audio/mpeg',
      body: Buffer.from('ID3test-audio'),
      headers: { 'Content-Disposition': `attachment; filename="${recordings[0].filename}"` },
    }),
  );
  await page.goto('/');
  await expect(page.locator('#recordings-list audio')).toHaveAttribute('controls', '');
  await expect(page.locator('#recordings-directory')).toContainText('/Users/example/recordings');
  await expect(page.locator('#recordings-list')).toContainText('<img src=x');
  expect(await page.evaluate(() => window.injected)).toBeUndefined();
  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
    ).toBeTruthy();
  }
  await page.reload();
  await expect(page.locator('#recordings-list audio')).toBeVisible();
  const download = page.waitForEvent('download');
  await page.getByRole('link', { name: 'Download MP3' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.mp3$/);
  await page.getByRole('button', { name: 'Delete local recording' }).click();
  await expect(page.locator('#recordings-list')).toContainText('No recorded calls yet');
});

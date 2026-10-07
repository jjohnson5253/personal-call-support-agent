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

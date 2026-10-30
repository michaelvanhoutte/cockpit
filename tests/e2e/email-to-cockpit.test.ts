import type { Page, Response } from '@playwright/test';
import { ACCOUNT_WIDE } from '@cockpit/shared';
import { arrange } from './support/arrange';
import { expect, openFirstWorkspace, openSettings, press, test } from './support/app';

/**
 * F3, because each joins the panel to what the account keeps ("Get an Email to
 * Cockpit address, and receive mail at it", issue 1466): the address Settings ›
 * Connections shows after a reload is the one the press made, renewed or
 * turned off. At a desk only, since a phone's Settings holds Appearance alone.
 * What the panel draws and asks is EmailToCockpit.test.tsx, and which mail an
 * address then receives is email-to-cockpit.test.ts under apps/api.
 */

const PART = /^[a-z0-9]{16,64}@mail\.cockpit\.localhost$/;
const ARRANGED = 'k7f3q9xwk7f3q9xwe2e0';

/** The server's answer to a change, which is what a walk waits on rather than on what is drawn. */
function answerTo(page: Page, change: string): Promise<Response> {
  return page.waitForResponse(
    (response) => response.request().method() === 'POST' && new URL(response.url()).pathname === `/v1/commands/${change}`,
  );
}

/** The account's address as Settings › Connections draws it once the page is read afresh. */
async function addressAfterAReload(page: Page, isMobile: boolean) {
  await page.reload();
  const settings = await openSettings(page, 'Connections', isMobile);
  return settings.getByRole('group', { name: 'Your account' });
}

/** The account is shared by every walk in the run: leave it holding no address. */
const turnOff = (page: Page) =>
  arrange(page, 'set_email_address', { workspaceId: ACCOUNT_WIDE, localPart: null }).catch(() => {});

test.describe('Email to Cockpit', () => {
  test.describe('the Your account panel gets, renews and turns off the account’s address', () => {
    test('Get an address shows an address at once, and the account still holds it after a reload', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone holds Appearance alone');
      await openFirstWorkspace(page, isMobile);
      try {
        const settings = await openSettings(page, 'Connections', isMobile);
        const account = settings.getByRole('group', { name: 'Your account' });
        const kept = answerTo(page, 'set_email_address');
        await press(account.getByRole('button', { name: 'Get an address' }), isMobile);
        const shown = account.getByText(PART);
        await expect(shown).toBeVisible();
        await expect(account.getByRole('button', { name: 'Copy' })).toBeVisible();
        const address = await shown.textContent();
        expect((await kept).ok()).toBe(true);

        await expect((await addressAfterAReload(page, isMobile)).getByText(address!)).toBeVisible();
      } finally {
        await turnOff(page);
      }
    });

    test('Make a new address asks first, then holds a different address after a reload', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone holds Appearance alone');
      await openFirstWorkspace(page, isMobile);
      await arrange(page, 'set_email_address', { workspaceId: ACCOUNT_WIDE, localPart: ARRANGED });
      try {
        const account = await addressAfterAReload(page, isMobile);
        await expect(account.getByText(`${ARRANGED}@mail.cockpit.localhost`)).toBeVisible();
        await press(account.getByRole('button', { name: 'More for Email to Cockpit' }), isMobile);
        await press(page.getByRole('menuitem', { name: 'Make a new address…' }), isMobile);
        const kept = answerTo(page, 'set_email_address');
        await press(page.getByRole('button', { name: 'Make a new address' }), isMobile);
        expect((await kept).ok()).toBe(true);

        const after = await addressAfterAReload(page, isMobile);
        await expect(after.getByText(PART)).toBeVisible();
        await expect(after.getByText(`${ARRANGED}@mail.cockpit.localhost`)).toHaveCount(0);
      } finally {
        await turnOff(page);
      }
    });

    test('Turn off asks first, then offers Get an address again after a reload', async ({ page, isMobile }) => {
      test.skip(isMobile, 'a phone holds Appearance alone');
      await openFirstWorkspace(page, isMobile);
      await arrange(page, 'set_email_address', { workspaceId: ACCOUNT_WIDE, localPart: ARRANGED });
      try {
        const account = await addressAfterAReload(page, isMobile);
        await press(account.getByRole('button', { name: 'More for Email to Cockpit' }), isMobile);
        await press(page.getByRole('menuitem', { name: 'Turn off' }), isMobile);
        const kept = answerTo(page, 'set_email_address');
        await press(page.getByRole('button', { name: 'Turn off Email to Cockpit' }), isMobile);
        expect((await kept).ok()).toBe(true);

        const after = await addressAfterAReload(page, isMobile);
        await expect(after.getByRole('button', { name: 'Get an address' })).toBeVisible();
        await expect(after.getByText(PART)).toHaveCount(0);
      } finally {
        await turnOff(page);
      }
    });
  });
});

import { type Page } from '@playwright/test';
import { themeOf } from '@cockpit/shared';
import {
  STARTING_WORKSPACE,
  chooseTabAction,
  dashboardBar,
  deleteWorkspace,
  dragTabOnto,
  expect,
  expectNoSidewaysScroll,
  groundOf,
  makeWorkspace,
  openFirstWorkspace,
  press,
  switchTo,
  tabOnIsWhollyInView,
  test,
  uniqueTitle,
  workspaceTab,
  workspaceTabs,
} from './support/app';

/** The swatch this walk presses, and the one it then expects the page to wear. */
const OLIVE_TINT = '#7d8f3f';

/** `#rrggbb` as a browser reports a background colour back. */
function asRgb(hex: string): string {
  const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  return `rgb(${r}, ${g}, ${b})`;
}

/**
 * F3, because none of this exists below a real browser: a tab's menu is opened
 * by a right-click on a 1280px screen and by a tap on a 480px one, the drag
 * that moves a tab is measured off real rectangles, and a workspace renamed on
 * one tab has to change in a header that was already drawn.
 *
 * It is not re-proving the naming rules, which
 * apps/api/tests/integration/http/workspace-management.test.ts owns against a
 * real database, nor what the tab's menu and its form send, which
 * apps/web/tests/unit/components/WorkspaceTabs.test.tsx owns, nor where the
 * router sends you when a workspace is gone, which
 * apps/web/tests/unit/router.test.tsx owns. One walk per capability - making
 * one, changing one, moving one, deleting one - saying it works for a person.
 *
 * None of them touches the workspace an account starts with. Every spec in a
 * run, under both projects, shares one database (support/app.ts), so deleting
 * Workspace 1 would take the other specs' workspace with it; each walk makes
 * the workspace it is going to change, and puts it back. That is also why "the
 * last workspace can be deleted" is not here: it needs a database with nothing
 * in it, which this tier cannot arrange without emptying it for everything
 * else. The router's side of it is proved in apps/web/tests/unit/router.test.tsx,
 * and the server's in the integration tests above.
 */
test.describe('Workspace management', () => {
  test.describe('a workspace you make is one you can switch to', () => {
    /**
     * The `+` at the end of the strip is the only way in, and the question it
     * opens says what a workspace is - which is the moment somebody pressing it
     * is asking.
     */
    test('makes one from the tab strip, on a question that says what a workspace is', async ({
      page,
      isMobile,
    }) => {
      await openFirstWorkspace(page, isMobile);

      await press(page.getByRole('button', { name: 'Add a workspace' }), isMobile);

      // Matched on a clause rather than the whole sentence, so rewording it
      // does not re-break this walk - and on the half that carries the example,
      // which is the half that does the work.
      await expect(
        page.getByRole('dialog').getByText(/A contractor working for two customers/),
      ).toBeVisible();

      const name = uniqueTitle('Bookkeeping');
      await page.getByLabel('Name of the new workspace').fill(name);
      await page.getByLabel('Name of the new workspace').press('Enter');

      // At the end of the strip, and opened: a new workspace goes after every
      // one the account has ever had, and making one then having to find it is
      // two gestures for what reads as one.
      await expect(workspaceTab(page, name)).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Dashboard 1' })).toBeVisible();
      // Holding the panel every dashboard arrives with, so it can be filed
      // into from the moment it exists.
      await expect(page.getByRole('region', { name: 'Panel 1' })).toBeVisible();
      await expectNoSidewaysScroll(page);

      // Put back: the run shares one database, and every workspace left behind
      // is one more tab in every other spec's strip.
      await deleteWorkspace(page, name, isMobile);
    });

    test('refuses a name another workspace already has, and says which', async ({
      page,
      isMobile,
    }) => {
      const taken = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, taken, isMobile);

      await press(page.getByRole('button', { name: 'Add a workspace' }), isMobile);
      await page.getByLabel('Name of the new workspace').fill(taken);
      await page.getByLabel('Name of the new workspace').press('Enter');

      // Still open, with what was typed in it, so the name is corrected rather
      // than typed again from nothing.
      await expect(page.getByRole('alert')).toContainText(taken);
      await expect(page.getByLabel('Name of the new workspace')).toHaveValue(taken);

      await press(page.getByRole('button', { name: 'Cancel' }), isMobile);
      await deleteWorkspace(page, taken, isMobile);
    });
  });

  test.describe('changing a workspace does not take the workspace away', () => {
    /**
     * F3 and only F3: what the shell is painted in, and how tall it is, are
     * things a browser computes. In jsdom every rectangle is zero pixels tall
     * in the same place, so nothing below this tier can tell a shell that
     * changed from one that did not.
     */
    test('leaves the header, its colour and the workspace behind the form', async ({
      page,
      isMobile,
    }) => {
      /** The header and the band under it, as they are painted right now. */
      const chrome = () =>
        page.evaluate(() => {
          const header = document.querySelector('header')!;
          const band = header.nextElementSibling!;
          return {
            colour: getComputedStyle(header).backgroundColor,
            ends: Math.round(band.getBoundingClientRect().bottom),
          };
        });

      const name = uniqueTitle('Bookkeeping');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, name, isMobile);
      await switchTo(page, name, isMobile);
      const before = await chrome();

      await chooseTabAction(page, workspaceTab(page, name), 'Edit…', isMobile);
      await expect(page.getByLabel(`Name of ${name}`)).toBeVisible();

      // The workspaces were a page, and reaching it took the shell somewhere it
      // has no state for: no workspace to colour the header, fill a tab or
      // offer Capture… The form opens over the workspace instead, and none of
      // that moves.
      expect(await chrome()).toEqual(before);
      // By selector, for the reason `workspaceTab` gives: a modal hides what is
      // behind it from assistive technology, and the point here is that the
      // header is still on the screen. Capture is a tab to a screen of its own
      // ("Capture something before you know which workspace it belongs to",
      // issue 165), so it is a link rather than a control.
      await expect(page.locator('header a[href="/capture"]')).toBeVisible();

      // And cancelling puts you back with nothing to reload.
      await press(page.getByRole('button', { name: 'Cancel' }), isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      expect(await chrome()).toEqual(before);

      await switchTo(page, STARTING_WORKSPACE, isMobile);
      await deleteWorkspace(page, name, isMobile);
    });
  });

  test.describe('a workspace you rename is called that everywhere you see it', () => {
    test('changes the name in the tabs, from the tab’s own menu', async ({ page, isMobile }) => {
      const before = uniqueTitle('Bookkeeping');
      const after = uniqueTitle('Accounts');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, before, isMobile);

      await chooseTabAction(page, workspaceTab(page, before), 'Edit…', isMobile);
      await page.getByLabel(`Name of ${before}`).fill(after);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);

      await expect(workspaceTab(page, after)).toBeVisible();
      await expect(workspaceTab(page, before)).toHaveCount(0);
      await expectNoSidewaysScroll(page);

      await deleteWorkspace(page, after, isMobile);
    });
  });

  test.describe('a workspace you move is where you put it in the tabs', () => {
    /**
     * F3 for both halves, for different reasons. The menu's half has to be
     * proved in the *header*: what the entry sends is settled in
     * apps/web/tests/unit/components/WorkspaceTabs.test.tsx, and that the
     * server keeps the order in apps/api/tests/integration/http. The drag
     * exists nowhere below a browser at all - where the pointer is over the
     * strip is measured from the tabs' rectangles, and jsdom has no layout
     * engine to give it any.
     *
     * Two workspaces of this walk's own, for the reason every spec here makes
     * its own: the run shares one database, so a walk that moved a seeded
     * workspace would reorder the tabs under every other spec. Both are put
     * back afterwards.
     */
    async function twoOfMyOwn(page: Page, isMobile: boolean): Promise<[string, string]> {
      const first = uniqueTitle('Anchor');
      const second = uniqueTitle('Mover');
      await openFirstWorkspace(page, isMobile);
      for (const name of [first, second]) await makeWorkspace(page, name, isMobile);
      // Made one after the other, so the second is after the first - which is
      // the thing the move is about to change.
      await expect
        .poll(async () => {
          const tabs = await workspaceTabs(page);
          return tabs.indexOf(second) - tabs.indexOf(first);
        })
        .toBe(1);
      return [first, second];
    }

    test('moves it in the tabs, from the tab’s own menu', async ({ page, isMobile }) => {
      const [first, second] = await twoOfMyOwn(page, isMobile);

      await chooseTabAction(page, workspaceTab(page, second), 'Move left', isMobile);

      await expect
        .poll(async () => {
          const tabs = await workspaceTabs(page);
          return tabs.indexOf(second) - tabs.indexOf(first);
        })
        .toBe(-1);
      await expectNoSidewaysScroll(page);

      for (const name of [first, second]) await deleteWorkspace(page, name, isMobile);
    });

    /**
     * The pointer's half, and the phone project deliberately skips it: an
     * HTML5-less pointer drag is a mouse gesture, and the way a finger moves a
     * tab is the menu above. Playwright's touchscreen can tap and nothing
     * else, so a finger drag cannot be expressed here at all.
     */
    test('moves it in the tabs when the tab is dragged over another', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'a drag is the pointer’s; a finger moves a tab from its menu');
      const [first, second] = await twoOfMyOwn(page, isMobile);

      await dragTabOnto(page, second, first);

      await expect
        .poll(async () => {
          const tabs = await workspaceTabs(page);
          return tabs.indexOf(second) - tabs.indexOf(first);
        })
        .toBe(-1);
      await expectNoSidewaysScroll(page);

      for (const name of [first, second]) await deleteWorkspace(page, name, isMobile);
    });
  });

  test.describe('the page is painted in the colours of the workspace you are in', () => {
    test('takes the colour you choose, and changes back when you switch workspace', async ({
      page,
      isMobile,
    }) => {
      // F3 for the reason the whole rule is F3: "the page is a different
      // colour" is a computed style, and there is no computed style without a
      // browser. Everything below it - which four colours a theme is, what the
      // form asks for, what the server stores - is settled at its own level.
      const mine = uniqueTitle('Repainted');
      await openFirstWorkspace(page, isMobile);
      const firstGround = await groundOf(page);
      await makeWorkspace(page, mine, isMobile);

      // Deliberately not asserting that a *new* workspace already differs from
      // the first: which colour it is handed depends on how many workspaces
      // exist, every spec in the run shares one database, and the palette wraps
      // once all eight are taken - so that claim is true or false depending on
      // what ran before. It is the server's rule anyway, and is proved against
      // a real database in apps/api/tests/integration/http.
      //
      // Through the tab's own form, which is where a colour is chosen: the
      // swatches are a draft until Save, so nothing is sent by looking.
      await chooseTabAction(page, workspaceTab(page, mine), 'Edit…', isMobile);
      await press(page.getByRole('button', { name: `Olive for ${mine}` }), isMobile);
      await press(page.getByRole('button', { name: 'Save' }), isMobile);
      await switchTo(page, mine, isMobile);
      await expect(dashboardBar(page)).toBeVisible();

      // Repainted, without a reload anywhere in the walk.
      //
      // Polled rather than read once, and the difference is not cosmetic. Every
      // other assertion in this walk is an `expect(locator)`, which retries;
      // this one reads a computed style out of the page in a single
      // `page.evaluate` and would have to be right on the first try. What it is
      // waiting for is the workspace list being re-read after the colour was
      // accepted, so the window is however long that round trip takes - 12ms on
      // one run and 184ms on the next, and the slow one failed on a phone in CI
      // while the same commit passed on the desktop project beside it.
      // Read off the palette rather than written out, so a change to the
      // theme's colours is not also a change to this walk.
      await expect.poll(() => groundOf(page)).toBe(asRgb(themeOf(OLIVE_TINT).ground));

      // And switching away takes the colour with it. Polled for the same reason.
      await switchTo(page, STARTING_WORKSPACE, isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      await expect.poll(() => groundOf(page)).toBe(firstGround);

      await deleteWorkspace(page, mine, isMobile);
    });
  });

  test.describe('deleting the workspace you were looking at leaves you somewhere that works', () => {
    test('takes the workspace out of the tabs and lands you on one that is still there', async ({
      page,
      isMobile,
    }) => {
      const name = uniqueTitle('Doomed');
      await openFirstWorkspace(page, isMobile);
      await makeWorkspace(page, name, isMobile);

      // Look at it, so what is deleted is the workspace being viewed.
      const tab = workspaceTab(page, name);
      await switchTo(page, name, isMobile);
      await expect(dashboardBar(page)).toBeVisible();
      const itsUrl = page.url();

      await chooseTabAction(page, tab, 'Delete', isMobile);
      // What goes with it, before it goes: nothing was put in this one.
      await expect(page.getByText(`Delete ${name}? There is nothing in it.`)).toBeVisible();
      await press(page.getByRole('button', { name: `Yes, delete ${name}` }), isMobile);

      await expect(tab).toHaveCount(0);
      await expectNoSidewaysScroll(page);

      // The focus lands in the strip rather than at the top of a page you
      // cannot see: the question closes by ceasing to exist along with the tab
      // it was asked from, so nothing else puts it anywhere - and the workspace
      // it should land on is one the app is still moving to when the question
      // goes, which is the half only a browser can hold.
      await expect(page.locator('nav[aria-label="Workspaces"] a:focus')).toHaveCount(1);

      // **The workspace moves on by itself**, without going anywhere by hand:
      // the one being deleted is the one on the screen, so leaving the app on
      // it would leave it on a workspace that is not there, its tabs short one
      // and its dashboards empty.
      await expect.poll(() => page.url()).not.toBe(itsUrl);
      await expect(dashboardBar(page)).toBeVisible();

      // And the address it left is not a dead end either: a workspace you can
      // work in, not a failed read of one that is gone.
      await page.goto(itsUrl);
      await expect(dashboardBar(page)).toBeVisible();
      expect(page.url()).not.toBe(itsUrl);
    });
  });
});

test.describe('Workspace management', () => {
  test.describe('the tab strip stays inside the screen however many workspaces there are', () => {
    test('keeps the page from scrolling sideways and the tab you are on from being cut off', async ({
      page,
      isMobile,
    }) => {
      /*
       * F3 because both halves are measurements of a real viewport: a page
       * that widened and a tab scrolled out of its strip are both geometry,
       * and jsdom has neither layout nor `scrollIntoView` to produce them.
       * The 480px project is where this actually bites.
       *
       * **What it holds, and what it does not.** Take the bringing-into-view
       * away and this goes red, so the rule itself is covered. It does *not*
       * cover the second half of how the shell does it - the pass once the
       * webfont has landed - and that was checked rather than assumed:
       * removing `document.fonts.ready` leaves this green. By the time this
       * walk switches workspace the font is long cached, so the race it exists
       * for cannot happen here; reproducing it needs a cold first paint
       * straight onto a workspace, which is where it was found by hand. Worth
       * knowing before trusting this to catch a regression in that line.
       */
      await openFirstWorkspace(page, isMobile);

      // Enough of them that the strip has to scroll on a phone. They are made
      // rather than assumed: every spec in a run shares one database, so how
      // many workspaces already exist is whatever ran before.
      const names = [0, 1, 2].map((n) => uniqueTitle(`Crowding the strip ${n}`));
      for (const name of names) await makeWorkspace(page, name, isMobile);

      // The last one made is the last one in the strip, which is the one most
      // likely to be outside it.
      const last = names[names.length - 1]!;
      await switchTo(page, last, isMobile);
      await expect(dashboardBar(page)).toBeVisible();

      await expectNoSidewaysScroll(page);
      // Polled: the tab is brought into view again once the font has landed,
      // and how long that takes is not something to assert against once.
      await expect.poll(() => tabOnIsWhollyInView(page)).toBe(true);

      // Put back, the way the other walks put theirs back: every workspace
      // left behind is one more tab every later walk has to reach past on a
      // 480px screen.
      await switchTo(page, STARTING_WORKSPACE, isMobile);
      for (const name of names) await deleteWorkspace(page, name, isMobile);
    });
  });
});

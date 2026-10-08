import { type Page } from '@playwright/test';
import {
  ADA,
  capture,
  choosePanelAction,
  dashboardBar,
  expect,
  fileOnto,
  holdRow,
  inbox,
  itemRow,
  itemsOn,
  openDashboard,
  press,
  signIn,
  tapRow,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3: the walk that says picking several rows out of the Inbox and filing them
 * together works for a person ("Select several items, and file them all in one
 * go", issue 169; "Start a selection with a long press, so a phone can do it
 * too", issue 170; "Pick a row by ctrl/shift-click instead of aiming for a
 * checkbox, and suspend single-row actions while a selection is held", issue
 * 438).
 *
 * What a click on a row *means* is proved in
 * apps/web/tests/unit/components/ItemRow.test.tsx, which rows a shift-click's
 * span covers is apps/web/tests/unit/selection.test.ts's, what counts as
 * holding still is apps/web/tests/unit/hold.test.ts's, the orders a filing of
 * several carries is apps/web/tests/unit/filing.test.ts's, and what choosing a
 * panel sends is apps/web/tests/unit/components/ItemList.test.tsx's. **What is
 * only true in a browser** is that a real ctrl/cmd- or shift-click on a real
 * row reaches the row as the modifier it is, that a real touch reaches it as a
 * `touch` pointer, and that three rows really do leave one list and arrive on
 * another together.
 *
 * **Both projects, by different doors.** From the first row on the two are the
 * same gesture: a long press starts a selection on either, and every later
 * pick is a ctrl/cmd-click on desktop or a tap on a phone. The range stays
 * desktop-only, because a shift-click is not something a phone can make.
 */

/** A panel added to the dashboard on screen, named for this walk. */
async function addPanel(page: Page, label: string, isMobile: boolean): Promise<string> {
  const panel = uniqueTitle(label);
  await press(page.getByRole('button', { name: '+ Panel' }), isMobile);
  await page.getByLabel('Name of the new panel').fill(panel);
  await page.getByLabel('Name of the new panel').press('Enter');
  await expect(page.getByRole('region', { name: panel })).toBeVisible();
  return panel;
}

/** An empty dashboard of this walk's own, with one panel on it. */
async function ownDashboardWithAPanel(
  page: Page,
  isMobile: boolean,
): Promise<{ dashboard: string; panel: string }> {
  const dashboard = uniqueTitle('Today');
  await signIn(page, ADA, isMobile);
  await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
  await page.getByLabel('Name of the new dashboard').fill(dashboard);
  await page.getByLabel('Name of the new dashboard').press('Enter');
  await expect(dashboardBar(page).getByRole('link', { name: dashboard })).toBeVisible();

  const panel = await addPanel(page, 'Falcon', isMobile);
  return { dashboard, panel };
}

/**
 * Where the Inbox and the dashboard are: two columns of one screen with a
 * mouse, two screens with a finger. The same two helpers filing.test.ts keeps,
 * because the walk has to get to both lists to say an item moved between them.
 */
async function goToTheInbox(page: Page, isMobile: boolean): Promise<void> {
  if (isMobile) await press(dashboardBar(page).getByRole('link', { name: 'Inbox' }), isMobile);
  await expect(inbox(page)).toBeVisible();
}

async function goToTheDashboard(page: Page, dashboard: string, isMobile: boolean): Promise<void> {
  await openDashboard(page, dashboard, isMobile);
  await expect(page.getByRole('heading', { name: dashboard, level: 2 })).toBeVisible();
}

/**
 * The first row picked, by whichever door this device has: a finger rests on
 * the row to start a selection, a pointer ctrl/cmd-clicks it - from anywhere on
 * the row, since the checkbox that used to carry this is gone.
 */
async function startSelecting(
  page: Page,
  title: string,
  isMobile: boolean,
  nearTheTop = false,
): Promise<void> {
  if (isMobile) {
    await holdRow(page, title, nearTheTop);
    return;
  }
  await itemRow(page, title).click({ modifiers: ['ControlOrMeta'] });
}

/**
 * A later row added to a selection already held: a tap on a phone, which is
 * what it has instead of a ctrl/cmd-click; a ctrl/cmd-click on a pointer,
 * unless `withShift` reaches back across the rows between.
 */
async function addToSelection(
  page: Page,
  title: string,
  isMobile: boolean,
  withShift = false,
): Promise<void> {
  if (isMobile) {
    await tapRow(page, title);
    return;
  }
  await itemRow(page, title).click({ modifiers: withShift ? ['Shift'] : ['ControlOrMeta'] });
}

/**
 * Edit ▾ ▸ a field ▸ an option, the way each device chooses: a finger taps its
 * way down, a pointer travels from the field to the option in steps - a few
 * pixels at a time, as a hand does, rather than jumping - because a submenu
 * that closes as the pointer crosses the next field's trigger is exactly what
 * a real pointer would meet and a jump never does.
 */
async function chooseFromEdit(
  page: Page,
  field: string,
  option: string,
  isMobile: boolean,
): Promise<void> {
  await press(page.getByRole('button', { name: 'Edit ▾' }), isMobile);
  const trigger = page.getByRole('menuitem', { name: new RegExp(`^${field}`) });
  const target = page.getByRole('menuitemradio', { name: option, exact: true });
  if (isMobile) {
    await trigger.tap();
    await target.tap();
    return;
  }
  await trigger.hover();
  await expect(target).toBeVisible();
  const from = (await trigger.boundingBox())!;
  const to = (await target.boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 12 });
  await expect(target).toBeVisible();
  await target.click();
}

test.describe('Selection', () => {
  test.describe('rows picked out of the Inbox are filed together, and can be put back together', () => {
    test('picks three out and files them onto a panel, then takes it back', async ({
      page,
      isMobile,
    }) => {
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const first = uniqueTitle('Reply to Bart');
      const second = uniqueTitle('Renew the domain');
      const third = uniqueTitle('Chase the purchase order');
      await goToTheInbox(page, isMobile);
      for (const title of [first, second, third]) await capture(page, title, isMobile);

      await startSelecting(page, first, isMobile);
      await expect(inbox(page).getByText('1 selected')).toBeVisible();

      // A range is a shift-click, which a phone cannot make; there, each row is
      // one more tap.
      await addToSelection(page, second, isMobile);
      await expect(inbox(page).getByText('2 selected')).toBeVisible();
      await addToSelection(page, third, isMobile, true);
      await expect(inbox(page).getByText('3 selected')).toBeVisible();
      // On a phone the Inbox is a screen of its own, and the bar is held to the
      // screen there too.
      await expect(inbox(page).getByText('3 selected')).toBeInViewport();
      await expect(inbox(page).getByRole('button', { name: 'Move to…' })).toBeInViewport();

      await page.getByRole('button', { name: 'Move to…' }).click();
      const picker = page.getByRole('dialog');
      await expect(picker.getByRole('heading', { name: 'Move 3 items to' })).toBeVisible();
      await picker.getByRole('button', { name: panel, exact: true }).click();
      await expect(picker).toHaveCount(0);

      // All three left the Inbox, and arrived on the panel in the order the
      // Inbox was showing them.
      for (const title of [first, second, third]) {
        await expect(inbox(page).getByText(title)).toHaveCount(0);
      }
      await goToTheDashboard(page, dashboard, isMobile);
      await expect.poll(() => itemsOn(page, panel)).toEqual([first, second, third]);

      // One way back for the whole filing, not three.
      await expect(page.getByText(`3 items moved to ${panel}`)).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();

      await expect.poll(() => itemsOn(page, panel)).toEqual([]);
      await goToTheInbox(page, isMobile);
      for (const title of [first, second, third]) {
        await expect(inbox(page).getByText(title)).toBeVisible();
      }
    });

    test('keeps the bar in view when the panel’s rows scroll', async ({ page, isMobile }) => {
      // A panel's rows scroll inside a box of a fixed height, so a bar placed
      // below them is one you have to scroll to - and what scrolls it away is
      // the row you just picked. A Dashboard's bar is the board's, stuck to the
      // foot of its column. Only true in a browser, because nothing below it
      // lays anything out.
      //
      // **On a phone the page scrolls too**, so the bar is held to the screen
      // rather than to the panel: a panel taller than what is left of the
      // screen otherwise puts the bar below the fold. The screen is cut short
      // here to make the panel that tall.
      const { dashboard, panel } = await ownDashboardWithAPanel(page, isMobile);
      const titles = [uniqueTitle('Reply to Bart'), uniqueTitle('Renew the domain')];
      await goToTheInbox(page, isMobile);
      for (const title of titles) await capture(page, title, isMobile);
      // Cut short before the filing rather than after it, so as little as
      // possible stands between the undo offer appearing and it being read
      // below: it goes after ten seconds.
      if (isMobile) {
        const { width } = page.viewportSize()!;
        await page.setViewportSize({ width, height: 320 });
      }

      await startSelecting(page, titles[0]!, isMobile);
      await addToSelection(page, titles[1]!, isMobile);
      await page.getByRole('button', { name: 'Move to…' }).click();
      const picker = page.getByRole('dialog');
      await picker.getByRole('button', { name: panel, exact: true }).click();
      await expect(picker).toHaveCount(0);

      await goToTheDashboard(page, dashboard, isMobile);
      const onThePanel = page.getByRole('region', { name: panel });
      await expect(onThePanel.getByText(titles[0]!)).toBeVisible();
      if (isMobile) await onThePanel.getByText(titles[0]!).scrollIntoViewIfNeeded();
      // Near its top edge: the offer drawn over this short a screen is three
      // buttons wide and two lines tall, and covers the middle of the row.
      await startSelecting(page, titles[0]!, isMobile, true);

      await expect(page.getByText('1 selected')).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Move to…' })).toBeInViewport();
      if (!isMobile) return;

      // The filing above is still on offer to undo, drawn at the same edge:
      // the bar's actions and the offer must not cover one another. Read
      // before anything slow, since the offer goes after ten seconds.
      const moveTo = page.getByRole('button', { name: 'Move to…' });
      const undo = page.getByRole('button', { name: 'Undo' });
      await expect(undo).toBeVisible();
      const offer = (await undo.locator('..').boundingBox())!;
      const actions = (await moveTo.boundingBox())!;
      expect(offer.y + offer.height).toBeLessThanOrEqual(actions.y);

      // Scrolled as far as it goes, the last row clears the bar rather than
      // ending under it.
      const lastRow = itemRow(page, titles[1]!);
      await lastRow.evaluate((row) => {
        for (let up: Element | null = row; up; up = up.parentElement) up.scrollTop = up.scrollHeight;
      });
      const row = (await lastRow.boundingBox())!;
      const bar = (await page.getByText('1 selected').locator('xpath=../..').boundingBox())!;
      expect(row.y + row.height).toBeLessThanOrEqual(bar.y);
    });
  });

  test.describe('rows picked across a dashboard’s panels share one selection and one bar', () => {
    test('picks on two panels, selects all, ends it from the Inbox, files and edits every pick together', async ({
      page,
      isMobile,
    }) => {
      // The longest walk here: it reaches the state every step after the first
      // needs, so what Edit adds is extended onto it rather than set up again.
      test.slow();
      const { dashboard, panel: falcon } = await ownDashboardWithAPanel(page, isMobile);
      const reading = await addPanel(page, 'Reading', isMobile);
      const done = await addPanel(page, 'Done', isMobile);
      const [first, second, third, inInbox] = [
        uniqueTitle('Reply to Bart'),
        uniqueTitle('Renew the domain'),
        uniqueTitle('Chase the purchase order'),
        uniqueTitle('Left in the Inbox'),
      ] as const;
      await goToTheInbox(page, isMobile);
      for (const title of [first, second, third, inInbox]) await capture(page, title, isMobile);
      await startSelecting(page, first, isMobile);
      await addToSelection(page, second, isMobile);
      await page.getByRole('button', { name: 'Move to…' }).click();
      await page.getByRole('dialog').getByRole('button', { name: falcon, exact: true }).click();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await fileOnto(page, third, reading, isMobile);
      await goToTheDashboard(page, dashboard, isMobile);
      await expect.poll(() => itemsOn(page, falcon)).toEqual([first, second]);
      await expect.poll(() => itemsOn(page, reading)).toEqual([third]);

      // Picks on two panels are one selection under one bar - at the foot of
      // the dashboard, in view, and not over the Inbox beside it.
      await startSelecting(page, first, isMobile);
      await addToSelection(page, third, isMobile);
      await expect(page.getByText('2 selected')).toHaveCount(1);
      await expect(page.getByText('2 selected')).toBeInViewport();
      await expect(page.getByRole('button', { name: 'Move to…' })).toHaveCount(1);
      if (!isMobile) {
        const bar = (await page.getByText('2 selected').locator('xpath=../..').boundingBox())!;
        const column = (await inbox(page).boundingBox())!;
        expect(bar.x + bar.width <= column.x || column.x + column.width <= bar.x).toBe(true);
      }

      // Select all on a panel adds its rows to what the other holds.
      await choosePanelAction(page, falcon, 'Select all', isMobile);
      await expect(page.getByText('3 selected')).toBeVisible();

      // And so does the dashboard's own menu, from a fresh start.
      await page.getByRole('button', { name: 'Clear' }).click();
      await expect(page.getByText(/ selected$/)).toHaveCount(0);
      await press(page.getByRole('button', { name: `Actions for ${dashboard}` }), isMobile);
      await press(page.getByRole('menuitem', { name: 'Select all items' }), isMobile);
      await expect(page.getByText('3 selected')).toBeVisible();

      // The Inbox keeps a selection of its own: starting one ends this. (A
      // phone shows one or the other, so there is nothing beside it to end.)
      if (!isMobile) {
        await startSelecting(page, inInbox, isMobile);
        await expect(inbox(page).getByText('1 selected')).toBeVisible();
        await expect(page.getByText(/ selected$/)).toHaveCount(1);
      }
      await page.getByRole('button', { name: 'Clear' }).click();
      await expect(page.getByText(/ selected$/)).toHaveCount(0);

      // Move to… files every pick, from whichever panel, and one Undo puts
      // them all back where each was.
      await startSelecting(page, first, isMobile);
      await addToSelection(page, third, isMobile);
      await page.getByRole('button', { name: 'Move to…' }).click();
      const picker = page.getByRole('dialog');
      await expect(picker.getByRole('heading', { name: 'Move 2 items to' })).toBeVisible();
      await picker.getByRole('button', { name: done, exact: true }).click();
      await expect(picker).toHaveCount(0);
      await expect.poll(() => itemsOn(page, done)).toEqual([first, third]);
      await expect.poll(() => itemsOn(page, falcon)).toEqual([second]);
      await expect(page.getByText(/ selected$/)).toHaveCount(0);

      await expect(page.getByText(`2 items moved to ${done}`)).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect.poll(() => itemsOn(page, done)).toEqual([]);
      await expect.poll(() => itemsOn(page, falcon)).toEqual([first, second]);
      await expect.poll(() => itemsOn(page, reading)).toEqual([third]);

      // Edit sets a field on every pick, from whichever panel: both rows take
      // the priority, the selection is still held, and the field now reads
      // what both share.
      const high = (title: string) => itemRow(page, title).getByRole('img', { name: 'High priority' });
      await startSelecting(page, first, isMobile);
      await addToSelection(page, third, isMobile);

      // The offer an edit makes stays clear of the bar, and of the menu the
      // next edit is made from: a second field is set straight after the first,
      // while the offer is still up, and a click on a choice it covered would
      // fail here as intercepted.
      await chooseFromEdit(page, 'Status', 'In progress', isMobile);
      await expect(page.getByText('Status set to In progress on 2 items')).toBeVisible();
      const offer = page.getByRole('status').filter({ hasText: 'Status set to' }).locator(':scope > div');
      const bar = (await page.getByText('2 selected').locator('xpath=../..').boundingBox())!;
      const offered = (await offer.boundingBox())!;
      expect(offered.y + offered.height <= bar.y || bar.y + bar.height <= offered.y).toBe(true);
      await chooseFromEdit(page, 'Priority', 'High', isMobile);
      await expect(high(first)).toBeVisible();
      await expect(high(third)).toBeVisible();
      await expect(page.getByText('2 selected')).toBeVisible();
      await press(page.getByRole('button', { name: 'Edit ▾' }), isMobile);
      await expect(page.getByRole('menuitem', { name: /^Priority/ })).toContainText('High');
      await page.keyboard.press('Escape');

      // One Undo puts both back.
      await expect(page.getByText('Priority set to High on 2 items')).toBeVisible();
      await page.getByRole('button', { name: 'Undo' }).click();
      await expect(high(first)).toHaveCount(0);
      await expect(high(third)).toHaveCount(0);
      await page.getByRole('button', { name: 'Clear' }).click();

      // The Inbox's bar offers the same Edit.
      await goToTheInbox(page, isMobile);
      await startSelecting(page, inInbox, isMobile);
      await chooseFromEdit(page, 'Priority', 'High', isMobile);
      await expect(high(inInbox)).toBeVisible();
    });
  });

  test.describe('a selection suspends what a row would otherwise do on its own', () => {
    // Desktop only: the case is a plain click on a mouse specifically, which is
    // what ending a selection is - a phone has no such click, a tap while
    // selecting extends it instead, already proved above.
    test('a plain click while a selection is held clears it, without opening the row it landed on', async ({
      page,
      isMobile,
    }) => {
      // A plain click no longer opens a row on its own ("Require a
      // double-click to open a row again, now that a plain click opens it",
      // issue 456) - a double-click still does.
      test.skip(isMobile, 'a plain click ending a selection is a mouse-only gesture');

      const first = uniqueTitle('Reply to Bart');
      const second = uniqueTitle('Renew the domain');
      await signIn(page, ADA, isMobile);
      await goToTheInbox(page, isMobile);
      for (const title of [first, second]) await capture(page, title, isMobile);

      await startSelecting(page, first, isMobile);
      await expect(inbox(page).getByText('1 selected')).toBeVisible();

      await itemRow(page, second).click();

      await expect(inbox(page).getByText('1 selected')).toHaveCount(0);
      await expect(page.getByRole('dialog')).toHaveCount(0);

      await itemRow(page, second).dblclick();

      await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Title' })).toHaveValue(
        second,
      );
    });

    test('a picked row’s own menu does not open while a selection is held', async ({
      page,
      isMobile,
    }) => {
      const title = uniqueTitle('Reply to Bart');
      await signIn(page, ADA, isMobile);
      await goToTheInbox(page, isMobile);
      await capture(page, title, isMobile);

      await startSelecting(page, title, isMobile);
      await expect(inbox(page).getByText('1 selected')).toBeVisible();

      const menu = itemRow(page, title).getByRole('button', { name: 'Item actions' });
      await expect(menu).toBeDisabled();
      // Pressed, not merely found disabled: a disabled button can still be
      // pressed in a browser, and what matters is that pressing it opens
      // nothing, not that the attribute is there (found in review - this
      // assertion passed even before the press was added, since nothing had
      // opened a menu for it to find). `force` because it is `aria-disabled`
      // rather than natively `disabled` - reachable on purpose, so Playwright's
      // own actionability check refuses the press unless told the control is
      // meant to be pressed anyway.
      if (isMobile) await menu.tap({ force: true });
      else await menu.click({ force: true });
      await expect(page.getByRole('menuitem', { name: /^Status/ })).toHaveCount(0);
    });
  });
});

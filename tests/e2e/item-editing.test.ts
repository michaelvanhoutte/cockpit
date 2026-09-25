import type { Page } from '@playwright/test';
import { MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import {
  STARTING_WORKSPACE,
  capture,
  captureBox,
  dashboardTab,
  deleteWorkspace,
  expect,
  itemRow,
  makeWorkspace,
  openDashboard,
  openInbox,
  press,
  switchTo,
  test,
  uniqueTitle,
} from './support/app';

/** Opens one row's form the way both devices can: from the row's own menu. */
async function openItem(page: Page, row: string, isMobile: boolean): Promise<void> {
  await press(itemRow(page, row).getByRole('button', { name: 'Item actions' }), isMobile);
  await press(page.getByRole('menuitem', { name: 'Open' }), isMobile);
}

const form = (page: Page) => page.getByRole('dialog');
/** The form's own boxes. Scoped, because the row's mark is also labelled with
 *  the word "description" and a page-wide lookup matches both. */
const titleBox = (page: Page) => form(page).getByRole('textbox', { name: 'Title' });
const descriptionBox = (page: Page) => form(page).getByRole('textbox', { name: 'Description' });
const priorityBox = (page: Page) => form(page).getByLabel('Priority');
const dueDateBox = (page: Page) => form(page).getByLabel('Due date');

/**
 * The description's editor is fetched behind the form (architecture,
 * "Performance budgets"), so for the first moment the box is the read-only
 * stand-in that says formatting is on its way. Filling that fills nothing.
 *
 * **The toolbar alone is not the editor.** It is drawn as soon as the chunk
 * arrives and its buttons are disabled until the document has been built from
 * the description - so a walk gated on the toolbar being visible is gated on
 * the chrome around an editor that may still be empty. The buttons coming alive
 * is the editor saying its document is there, which is what the walks after
 * this line act on.
 */
async function theEditorIsThere(page: Page): Promise<void> {
  const toolbar = form(page).getByRole('toolbar', { name: 'Formatting' });
  await expect(toolbar).toBeVisible();
  await expect(toolbar.getByRole('button', { name: 'bold' })).toBeEnabled();
}

/**
 * The caret, put in the description by hand.
 *
 * `focus()` alone leaves a ProseMirror editor focused with no selection in it,
 * and every command works on the selection - so a walk that skips this presses
 * bold on nothing and gets its text back unchanged.
 */
async function putTheCaretInTheDescription(page: Page, isMobile: boolean): Promise<void> {
  await press(descriptionBox(page), isMobile);
  await descriptionBox(page).press('ControlOrMeta+a');
}

/**
 * Between the formatted view and the Markdown behind it, and back.
 *
 * The one control is labelled with the view it goes to, so its absence means
 * that view is already up - and asking for the view you are on is a no-op
 * rather than a wait for a button that will never appear.
 */
const other = { Source: 'Formatted', Formatted: 'Source' } as const;

async function show(page: Page, which: 'Source' | 'Formatted', isMobile: boolean): Promise<void> {
  const toggle = form(page).getByRole('button', { name: which });
  if ((await toggle.count()) > 0) await press(toggle, isMobile);
  // Named for the view it goes to, so the control now offering the other one is
  // the proof the switch happened rather than the press having been skipped.
  if (which === 'Formatted') await theEditorIsThere(page);
  await expect(form(page).getByRole('button', { name: other[which] })).toBeVisible();
}

/** An item of this walk's own, opened with its form on the description. */
async function anItemToWriteOn(page: Page, label: string, isMobile: boolean): Promise<string> {
  await openInbox(page, isMobile);
  const thought = uniqueTitle(label);
  await capture(page, thought, isMobile);
  await openItem(page, thought, isMobile);
  await theEditorIsThere(page);
  return thought;
}

/**
 * F3, because this is the capability: a person opens an item, writes something
 * about it, and finds it again. What a saved text survives is proved against a
 * real database in apps/api/tests/integration/http/item-changes.test.ts, what
 * the form sends in apps/web/tests/unit/components/ItemForm.test.tsx, and what
 * a row's label is in packages/shared/tests/unit/domain/item.test.ts. None of
 * those can say the form opens, takes what is typed, and closes.
 *
 * Both projects, because the two ways in differ by device: a double-click is a
 * mouse gesture and a phone has only the menu, so the menu is what
 * both have in common and what the walk uses.
 */
test.describe('Item editing', () => {
  test.describe('writing something about an item, and finding it again', () => {
    test('keeps the title and the description, and marks the row', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Ask Novy about part 11');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);

      // The title box holds what the row was showing, which is the whole of
      // what capture wrote it from: one title, in the one place it is edited.
      await expect(titleBox(page)).toHaveValue(thought);
      // And what was captured is on the Details tab as a record, which can
      // never be edited. Scoped to that tab's own panel, because the
      // description's editor writes paragraphs of its own the moment it
      // arrives, which is a race against this line.
      //
      // **The fields go, really.** The Item panel stays mounted while Details
      // shows, so the editor and whatever is half-typed survive the switch
      // (`ItemForm.tsx`) - which makes it hidden by a class rather than
      // unrendered, and that is a claim no jsdom can make: the unit runner
      // loads no stylesheet, so `ItemForm.test.tsx` can only ask what each tab
      // holds, never whether the other one is out of sight (found by the
      // review on this pull request, which is why this is here rather than in
      // a walk of its own).
      const files = form(page).getByText('Attachments', { exact: true });
      await expect(files).toBeVisible();
      await press(form(page).getByRole('tab', { name: 'Details' }), isMobile);
      await expect(form(page).getByRole('tabpanel').getByText(thought)).toBeVisible();
      await expect(files).toBeHidden();
      await press(form(page).getByRole('tab', { name: 'Item' }), isMobile);
      await expect(files).toBeVisible();

      const named = uniqueTitle('Part 11');
      await titleBox(page).fill(named);
      await theEditorIsThere(page);
      await descriptionBox(page).fill('Tolerances, and the sign-off date');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      // The row now reads by its title rather than by what was captured, and
      // says there is something written behind it.
      await expect(itemRow(page, named)).toBeVisible();
      await expect(itemRow(page, named).getByLabel('Has a description')).toBeVisible();

      // And it is still there on the way back in, which is the half a form that
      // only looked right would not have.
      await openItem(page, named, isMobile);
      await expect(titleBox(page)).toHaveValue(named);
      await theEditorIsThere(page);
      await expect(descriptionBox(page)).toHaveText('Tolerances, and the sign-off date');
    });

    test('throws away what was typed when the form is cancelled', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Left as it was');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await theEditorIsThere(page);
      await descriptionBox(page).fill('Typed and then abandoned');
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // No question asked on the way out, and nothing kept: Cancel means cancel.
      await expect(descriptionBox(page)).toHaveCount(0);
      await expect(itemRow(page, thought).getByLabel('Has a description')).toHaveCount(0);
    });

    test('is opened and closed by the address, so the back button closes it', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Linkable');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await expect(page).toHaveURL(/[?&]item=/);
      const openAt = page.url();

      await page.goBack();
      await expect(titleBox(page)).toHaveCount(0);

      // And closing collapses the entry opening made rather than stacking one
      // on it: Back after Cancel leaves the page rather than putting the form
      // straight back up.
      await openItem(page, thought, isMobile);
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);
      await expect(titleBox(page)).toHaveCount(0);
      await page.goBack();
      await expect(titleBox(page)).toHaveCount(0);

      // The address on its own opens it, which is what makes it a link rather
      // than a state only this tab knows about.
      await page.goto(openAt);
      await expect(titleBox(page)).toBeVisible();
    });
  });

  /**
   * F3, because this is the capability: a person sets or clears an item's
   * priority and due date and finds the row marked accordingly. What the form
   * sends is proved without a browser in
   * apps/web/tests/unit/components/ItemForm.test.tsx - the one-click shortcuts
   * beside the date field included, what each of them computes being
   * apps/web/tests/unit/dueDateShortcuts.test.ts's own claim; what pill a date
   * wears is apps/web/tests/unit/dueDate.test.ts and
   * apps/web/tests/unit/components/ItemRow.test.tsx; and that a save waits for
   * the re-read before the row can be trusted is
   * apps/web/tests/unit/api/queries.test.tsx. None of those can say the row's
   * own marks actually change on screen ("Show and edit an item's priority",
   * issue 433; "Show and set an item's due date", issue 462), nor that the
   * flag column leaves every title on one left edge.
   */
  test.describe('a priority and a due date mark the row, and clearing them takes the marks off', () => {
    test('shows what was chosen, keeps every title on one left edge, and leaves nothing behind once cleared', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const plain = uniqueTitle('No level here');
      const marked = uniqueTitle('Renew the passport');
      await capture(page, plain, isMobile);
      await capture(page, marked, isMobile);

      await openItem(page, marked, isMobile);
      await priorityBox(page).selectOption('high');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      await expect(itemRow(page, marked).getByLabel('High priority')).toBeVisible();

      // Layout, which JSDOM cannot measure: the flag column is always there, so
      // a title is where the others are with or without a level. Asked while
      // neither row has a due date, because a pill is drawn on the title line
      // and how near a date is depends on the day the suite runs.
      const left = async (title: string) =>
        Math.round((await itemRow(page, title).getByText(title).boundingBox())!.x);
      expect(await left(marked)).toBe(await left(plain));

      // The level is still there on the way back in, held rather than only
      // having been drawn once, and the date goes on the same item.
      await openItem(page, marked, isMobile);
      await expect(priorityBox(page)).toHaveValue('high');
      await dueDateBox(page).fill('2026-09-30');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      await expect(itemRow(page, marked).getByText('Due Sep 30, 2026')).toBeVisible();

      await openItem(page, marked, isMobile);
      await expect(dueDateBox(page)).toHaveValue('2026-09-30');
      await priorityBox(page).selectOption('');
      await dueDateBox(page).fill('');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      // The dialog gone first, the same as the cancel walk above asserts -
      // otherwise the list sits behind Radix's aria-hidden while the dialog
      // is still up mid-save, and the row would read as unmarked from that
      // alone, whether or not the clear actually landed.
      await expect(priorityBox(page)).toHaveCount(0);
      await expect(itemRow(page, marked).getByLabel('High priority')).toHaveCount(0);
      await expect(itemRow(page, marked).getByText('Due Sep 30, 2026')).toHaveCount(0);

      // Its type and its status, from the same form ("Change an item's type,
      // and its status, from its form, and see where it is shown", issue 528):
      // the type is still the one picked on the way back in, the Inbox is where
      // Details says it is shown, and finishing it takes it off the list.
      await openItem(page, marked, isMobile);
      const types = form(page).getByLabel('Type');
      const other = await types.locator('option:not(:checked)').first().getAttribute('value');
      await types.selectOption(other!);
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);
      await expect(priorityBox(page)).toHaveCount(0);

      await openItem(page, marked, isMobile);
      await expect(form(page).getByLabel('Type')).toHaveValue(other!);
      await press(form(page).getByRole('tab', { name: 'Details' }), isMobile);
      await expect(form(page).getByText('Shown on')).toBeVisible();
      await expect(form(page).getByText('Inbox', { exact: true })).toBeVisible();
      await press(form(page).getByRole('tab', { name: 'Item' }), isMobile);
      await form(page).getByLabel('Status').selectOption('done');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);
      await expect(priorityBox(page)).toHaveCount(0);
      await expect(itemRow(page, marked)).toHaveCount(0);
    });
  });

  /**
   * F3, because storing a file, refusing an oversized or disallowed one, and
   * serving it back are proved against a real R2 bucket and a real database
   * in apps/api/tests/integration/http/attachments.test.ts, and what the
   * form draws from a snapshot it is handed is proved without a browser in
   * apps/web/tests/unit/components/ItemForm.test.tsx ("Attach a file to an
   * item", issue 441). Neither can say a real `<input type="file">`, a real
   * drop and a real click on a chip actually add, refuse and open a file.
   */
  test.describe('the files attached to an item', () => {
    /** A minimal, valid 1x1 PNG - small enough to embed, real enough to decode. */
    const A_PNG = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
      'base64',
    );

    function attachmentInput(page: Page) {
      return form(page).locator('input[type="file"]');
    }

    function uploadResponse(page: Page) {
      return page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          /\/v1\/items\/[^/]+\/attachments$/.test(new URL(response.url()).pathname),
      );
    }

    test('adds one by button, draws it as a chip, opens the real file from a click on it, and takes it off for good', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Scanned receipt');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      const uploaded = uploadResponse(page);
      await attachmentInput(page).setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: A_PNG });
      expect((await uploaded).status()).toBe(201);

      // A thumbnail for an image, per the issue's own chip rule.
      await expect(form(page).getByRole('img', { name: 'receipt.png' })).toBeVisible();

      const [popup] = await Promise.all([
        page.waitForEvent('popup'),
        press(form(page).getByRole('link', { name: /receipt\.png/ }), isMobile),
      ]);
      await expect(popup).toHaveURL(/\/v1\/attachments\//);
      expect(await popup.locator('img').first().evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(1);
      await popup.close();

      const removed = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === '/v1/commands/remove_attachment',
      );
      await press(form(page).getByRole('button', { name: 'Remove receipt.png' }), isMobile);
      expect((await removed).status()).toBe(200);
      await expect(form(page).getByText('receipt.png')).toHaveCount(0);

      // Removal is sent the moment it happens, not batched into Save - so a
      // Save pressed afterwards, with nothing else changed, has nothing to
      // resurrect (issue 441's own UI test case).
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);
      await openItem(page, thought, isMobile);
      await expect(form(page).getByText('receipt.png')).toHaveCount(0);
    });

    test('refuses a file over the size cap, and a kind not on the allowlist, naming why', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Rejected files');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      await attachmentInput(page).setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('just words'),
      });
      await expect(form(page).getByRole('alert')).toHaveText(/not a kind of file Cockpit accepts/);
      // A chip, not any text on the form: the refusal itself names the file,
      // which `getByText` would otherwise also match.
      await expect(form(page).getByRole('link', { name: 'notes.txt' })).toHaveCount(0);

      await attachmentInput(page).setInputFiles({
        name: 'huge.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(MAX_ATTACHMENT_SIZE + 1),
      });
      await expect(form(page).getByRole('alert')).toHaveText(/over the/);
      await expect(form(page).getByRole('link', { name: 'huge.png' })).toHaveCount(0);
    });

  });

  /**
   * End to end, because this is where a real selection in a real editor is: the
   * unit runner gives ProseMirror rectangles that are all zero and a caret that
   * does not exist, so nothing about applying a mark to a selection can be
   * asked below the browser. That the two views hold one text is settled there
   * instead, in apps/web/tests/unit/description/syntax.test.ts and
   * apps/web/tests/unit/components/DescriptionBox.test.tsx.
   */
  test.describe('the toolbar and the shortcuts make the same five things', () => {
    /** One word, selected, with the formatting under test applied to it. */
    async function appliedTo(
      page: Page,
      isMobile: boolean,
      apply: () => Promise<void>,
    ): Promise<string> {
      await show(page, 'Source', isMobile);
      await descriptionBox(page).fill('Tolerances');
      await show(page, 'Formatted', isMobile);
      await putTheCaretInTheDescription(page, isMobile);
      await apply();
      await show(page, 'Source', isMobile);
      return descriptionBox(page).inputValue();
    }

    test('by button, by shortcut, and not at all for an address that would not be a link', async ({
      page,
      isMobile,
    }) => {
      await anItemToWriteOn(page, 'Five things', isMobile);
      const button = (name: string) => form(page).getByRole('button', { name, exact: true });

      for (const [name, made] of [
        ['bold', '**Tolerances**'],
        ['italic', '*Tolerances*'],
        ['bullet list', '* Tolerances'],
        ['numbered list', '1. Tolerances'],
      ] as const) {
        expect(
          await appliedTo(page, isMobile, () => press(button(name), isMobile)),
          `${name} by button`,
        ).toContain(made);
      }

      const address = () => form(page).getByRole('textbox', { name: 'Address' });
      const linked = await appliedTo(page, isMobile, async () => {
        await press(button('link'), isMobile);
        await address().fill('example.com/runbook');
        await press(button('Add link'), isMobile);
      });
      expect(linked).toContain('[Tolerances](https://example.com/runbook)');

      // And a link already made is edited rather than made again. Applying a
      // mark that is already there removes it, so the obvious call takes the
      // link off and drops the new address on the floor.
      await show(page, 'Formatted', isMobile);
      await putTheCaretInTheDescription(page, isMobile);
      await press(button('link'), isMobile);
      await expect(address()).toHaveValue('https://example.com/runbook');
      await address().fill('example.com/handover');
      await press(button('Add link'), isMobile);
      await show(page, 'Source', isMobile);
      await expect(descriptionBox(page)).toHaveValue(
        /^\[Tolerances\]\(https:\/\/example\.com\/handover\)\s*$/,
      );

      // The same five things from the keyboard, on the same item: what the
      // shortcuts make is the claim, and a second item to make it on would be
      // the setup done twice.
      for (const [keys, made] of [
        ['ControlOrMeta+b', '**Tolerances**'],
        ['ControlOrMeta+i', '*Tolerances*'],
        ['ControlOrMeta+Shift+8', '* Tolerances'],
        ['ControlOrMeta+Shift+7', '1. Tolerances'],
      ] as const) {
        expect(
          await appliedTo(page, isMobile, () => descriptionBox(page).press(keys)),
          `${keys}`,
        ).toContain(made);
      }

      const byShortcut = await appliedTo(page, isMobile, async () => {
        await descriptionBox(page).press('ControlOrMeta+k');
        await form(page).getByRole('textbox', { name: 'Address' }).fill('example.com/runbook');
        await form(page).getByRole('textbox', { name: 'Address' }).press('Enter');
      });
      expect(byShortcut).toContain('[Tolerances](https://example.com/runbook)');

      // And the address that is not one is refused where it is typed. Which
      // addresses those are is apps/web/tests/unit/description/safeHref.test.ts;
      // that the button is wired to it and says so has nowhere below this to
      // be asked, the link window having no test of its own at all.
      await show(page, 'Source', isMobile);
      await descriptionBox(page).fill('Tolerances');
      await show(page, 'Formatted', isMobile);
      await putTheCaretInTheDescription(page, isMobile);
      await press(button('link'), isMobile);
      await form(page).getByRole('textbox', { name: 'Address' }).fill('javascript:alert(1)');
      await press(form(page).getByRole('button', { name: 'Add link' }), isMobile);
      await expect(form(page).getByRole('alert')).toHaveText(
        'A link can only go to a web address or an email address.',
      );

      // Escape gives up the address and nothing else. The form is a dialog that
      // closes on Escape and discards what is in it, so an Escape that reached
      // it from here would throw the whole description away.
      await form(page).getByRole('textbox', { name: 'Address' }).press('Escape');
      await expect(form(page).getByRole('textbox', { name: 'Address' })).toHaveCount(0);
      await show(page, 'Source', isMobile);
      await expect(descriptionBox(page)).toHaveValue('Tolerances');
    });
  });

  /**
   * F3, because whether a hand can take hold of the frame at all - and get the
   * size back afterwards - is a claim about a real pointer against a real
   * layout that nothing below the browser can make. That the frame itself
   * ignores what loads or is typed inside it is proved without a browser in
   * apps/web/tests/unit/components/ItemForm.test.tsx; what a drag on the
   * native handle actually leaves the box at is only provable here.
   */
  test.describe('the dialog can be resized, and a size dragged to sticks', () => {
    /**
     * The default used to double as its own ceiling - a drag could shrink the
     * box but never grow it - which is what "Give the item's form more room,
     * and put clutter out of the way" (issue 480) puts a real ceiling above.
     */
    test('offers the handle at a desk and none on a phone, and holds a drag at the ceiling and at the floor', async ({
      page,
      isMobile,
    }) => {
      // Taller than the suite's own default viewport, so the ceiling's own
      // headroom above the default height is not itself clamped away by the
      // screen before the drag ever gets there - the default's own height
      // already sits close to a laptop-sized screen by design.
      if (!isMobile) await page.setViewportSize({ width: 1280, height: 1000 });

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Resize handle');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      // That a phone's form still fills the screen it always has is
      // tests/e2e/screen-edges.test.ts's claim, not this one's to re-prove;
      // what is new here is only whether the handle is offered at all.
      const resize = await form(page).evaluate((el) => getComputedStyle(el).resize);
      if (isMobile) {
        expect(resize, 'a phone has no room to spare, and no handle').toBe('none');
        // Returned rather than skipped: the phone's half of this rule is the
        // assertion just made, and everything below is the drag it has no
        // handle for. A `test.skip` here would report that assertion as never
        // having run.
        return;
      }
      expect(resize, 'a desk has room to spare, and a corner handle to shrink into it').toBe('both');

      // The handle is the box's own bottom-right corner, drawn by the browser
      // rather than a testid this can look up - so a drag starts a few pixels
      // inside it instead.
      const takeHold = async () => {
        const box = (await form(page).boundingBox())!;
        const grip = { x: box.x + box.width - 6, y: box.y + box.height - 6 };
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        return { box, grip };
      };

      const { box: before, grip: outward } = await takeHold();
      // Dragged outward on both axes - past where the old default, which
      // used to double as its own ceiling, would have stopped it.
      await page.mouse.move(outward.x + 250, outward.y + 150, { steps: 8 });
      await page.mouse.up();
      const grown = (await form(page).boundingBox())!;
      expect(grown.width, 'grew past the old default width').toBeGreaterThan(before.width + 100);
      expect(grown.height, 'grew past the old default height').toBeGreaterThan(before.height + 100);

      // And back the other way, far past where the floor sits, so the
      // assertion is about the floor holding rather than about how far the
      // drag reached.
      const { grip: inward } = await takeHold();
      await page.mouse.move(inward.x - 1000, inward.y - 1000, { steps: 8 });
      await page.mouse.up();
      const shrunk = (await form(page).boundingBox())!;
      expect(shrunk.width, 'shrank to the floor, not any smaller').toBeGreaterThanOrEqual(318);
      expect(shrunk.width).toBeLessThanOrEqual(322);
      expect(shrunk.height, 'shrank to the floor, not any smaller').toBeGreaterThanOrEqual(286);
      expect(shrunk.height).toBeLessThanOrEqual(290);
    });

    test('remembers a dragged size across items and a reopen, clamped to whatever screen it opens on next, and never carries one axis into the other', async ({
      page,
      isMobile,
    }) => {
      // Dragging is a pointer gesture, the same reason sizing a panel's own
      // row and column is desktop-only in tests/e2e/panels.test.ts.
      test.skip(isMobile, 'resizing is a pointer gesture');

      const full = page.viewportSize()!;
      // Short rather than narrow, so the ceiling clamps the height alone -
      // the axis the first drag below never touches - and wide enough that
      // the resize handle is still offered.
      await page.setViewportSize({ width: 900, height: 500 });

      await openInbox(page, isMobile);
      const first = uniqueTitle('Dragged smaller');
      const second = uniqueTitle('Same size here too');
      await capture(page, first, isMobile);
      await capture(page, second, isMobile);

      await openItem(page, first, isMobile);
      const firstUrl = page.url();

      // The handle is the box's own bottom-right corner, drawn by the browser
      // rather than a testid this can look up - so the drag starts a few
      // pixels inside it instead.
      const takeHold = async () => {
        const box = (await form(page).boundingBox())!;
        const grip = { x: box.x + box.width - 6, y: box.y + box.height - 6 };
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        return { box, grip };
      };

      // **One axis first, with nothing remembered yet.** Dragged along the
      // width only - the same height as the grip started at, so nothing here
      // ever asks the height to move.
      const { grip: oneAxis } = await takeHold();
      await page.mouse.move(oneAxis.x - 150, oneAxis.y, { steps: 8 });
      await page.mouse.up();
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // Back on a screen tall enough for the full default, the height this
      // never touched is the default, not the short screen's own clamp of
      // it - the claim the rest of this walk makes for a screen reclamping a
      // size that *was* remembered, made here for one clamping the default
      // before anything was ever remembered at all.
      await page.setViewportSize(full);
      await page.goto(firstUrl);
      const untouched = (await form(page).boundingBox())!;
      expect(
        untouched.height,
        'the untouched axis is the full default, not the short screen’s clamp of it',
      ).toBeGreaterThan(600);

      const { box: before, grip } = await takeHold();
      await page.mouse.move(grip.x - 150, grip.y - 100, { steps: 8 });
      await page.mouse.up();
      const dragged = (await form(page).boundingBox())!;
      expect(dragged.width, 'the drag moved the handle in by 150px').toBeLessThan(before.width - 50);
      expect(dragged.height, 'the drag moved the handle up by 100px').toBeLessThan(before.height - 50);
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // The same item, reopened by address rather than through the Inbox -
      // this walk goes on to change the viewport, which is free to change how
      // the Inbox itself lays out, and that is not what is under test here.
      await page.goto(firstUrl);
      const reopened = (await form(page).boundingBox())!;
      expect(Math.round(reopened.width)).toBe(Math.round(dragged.width));
      expect(Math.round(reopened.height)).toBe(Math.round(dragged.height));
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // A different item, opened for the first time - the size belongs to the
      // browser, not to whichever item was open when it was dragged.
      await openItem(page, second, isMobile);
      const secondUrl = page.url();
      const otherItem = (await form(page).boundingBox())!;
      expect(Math.round(otherItem.width)).toBe(Math.round(dragged.width));
      expect(Math.round(otherItem.height)).toBe(Math.round(dragged.height));
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // A screen too small for the dragged size clamps it down without
      // touching what was remembered.
      await page.setViewportSize({ width: 500, height: 500 });
      await page.goto(secondUrl);
      const clamped = (await form(page).boundingBox())!;
      expect(clamped.width, 'clamped to the small screen, not overflowing it').toBeLessThanOrEqual(500);
      expect(clamped.height, 'clamped to the small screen, not overflowing it').toBeLessThanOrEqual(500);
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // Back on a screen big enough for it, the original drag is what comes
      // back - not the size the small screen clamped it down to.
      await page.setViewportSize(full);
      await page.goto(secondUrl);
      const restored = (await form(page).boundingBox())!;
      expect(Math.round(restored.width)).toBe(Math.round(dragged.width));
      expect(Math.round(restored.height)).toBe(Math.round(dragged.height));

      // The window shrinking while the dialog is still open reclamps it live
      // - the same formula that clamps a size too big for the screen it
      // opens on - and closing untouched must not mistake that reclamp for a
      // drag: the size a screen only ever clamps is not one it gets to keep.
      await page.setViewportSize({ width: 500, height: 500 });
      const reclamped = (await form(page).boundingBox())!;
      expect(reclamped.width, 'the still-open dialog reclamped to the smaller window').toBeLessThan(
        dragged.width,
      );
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      await page.setViewportSize(full);
      await page.goto(secondUrl);
      const afterReclamp = (await form(page).boundingBox())!;
      expect(Math.round(afterReclamp.width)).toBe(Math.round(dragged.width));
      expect(Math.round(afterReclamp.height)).toBe(Math.round(dragged.height));
    });
  });

  /**
   * F3, because every claim here is about real text in a real font in a real
   * box, which no jsdom layout can measure: "Normal", the longest priority,
   * was clipped to "Nor" at the half of a 240px sidebar it was given; the
   * description's own box growing as the dialog is dragged is a different
   * thing from the frame ignoring what is *typed or loaded* into it, which is
   * apps/web/tests/unit/components/ItemForm.test.tsx's claim; and a broken
   * `@container` setup would leave every other walk in this file green - none
   * of them ever narrow the dialog through the breakpoint - while the split
   * silently never collapsed at all ("Give the item's form more room, and put
   * clutter out of the way", issue 480).
   */
  test.describe('the form opens big enough for what is in it, and what is inside answers to its own width', () => {
    test('opens at its default width with room for the longest choice, gives the description whatever room a drag makes, and stacks into one column once it is narrow', async ({
      page,
      isMobile,
    }) => {
      test.skip(
        isMobile,
        'a phone opens the form at the screen’s own size, and resizing is a pointer gesture',
      );

      // Taller than the suite's own default viewport, the same reason the
      // resize walk sets one: the default height already sits close to a
      // laptop-sized screen, so there is no room for a drag to grow it
      // further without one.
      await page.setViewportSize({ width: 1280, height: 1000 });

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Opens big enough');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);
      await theEditorIsThere(page);

      // 56rem, on a window wide enough that nothing clamps it.
      expect(Math.round((await form(page).boundingBox())!.width)).toBe(896);

      // The room a choice has is the box less its own padding, border and an
      // allowance for the native arrow - measured against the widest label it
      // has to hold, in the font the box is actually drawn in.
      const { widest, room } = await priorityBox(page).evaluate((element) => {
        const select = element as HTMLSelectElement;
        const style = getComputedStyle(select);
        const probe = document.createElement('span');
        probe.style.cssText = `position:absolute;visibility:hidden;white-space:nowrap;font:${style.font}`;
        document.body.appendChild(probe);
        let widest = 0;
        for (const option of Array.from(select.options)) {
          probe.textContent = option.text;
          widest = Math.max(widest, probe.getBoundingClientRect().width);
        }
        probe.remove();
        const room =
          select.getBoundingClientRect().width -
          parseFloat(style.paddingLeft) -
          parseFloat(style.paddingRight) -
          parseFloat(style.borderLeftWidth) -
          parseFloat(style.borderRightWidth);
        return { widest, room };
      });
      const NATIVE_ARROW_ALLOWANCE = 24;
      expect(
        room - NATIVE_ARROW_ALLOWANCE,
        'the widest priority fits, less an allowance for the native arrow',
      ).toBeGreaterThanOrEqual(widest);

      // Type, the first of the short fields, and the description's own toolbar
      // sit on the same row when there is room for two columns - both near the
      // top of their own
      // column - and one column drops below the other's whole height once
      // there is not. The toolbar, not the description box itself: the box
      // sits below its own toolbar, which is otherwise close enough to
      // the first field's own row to read as "the same row" even stacked.
      const toolbar = form(page).getByRole('toolbar', { name: 'Formatting' });
      const sideBySide = async () => {
        const firstField = (await form(page).getByLabel('Type').boundingBox())!;
        const description = (await toolbar.boundingBox())!;
        return Math.abs(firstField.y - description.y) < 40;
      };
      expect(await sideBySide(), 'two columns at the dialog’s own default width').toBe(true);

      // The gap between the toolbar and the footer is the room the
      // description has, measured without depending on how much text is in
      // it - a fixed-height box would leave that gap unmoved by a drag.
      const saveButton = form(page).getByRole('button', { name: 'Save' });
      const gap = async () => {
        const toolbarBox = (await toolbar.boundingBox())!;
        const saveBox = (await saveButton.boundingBox())!;
        return saveBox.y - (toolbarBox.y + toolbarBox.height);
      };
      const drag = async (byX: number, byY: number) => {
        const box = (await form(page).boundingBox())!;
        const grip = { x: box.x + box.width - 6, y: box.y + box.height - 6 };
        await page.mouse.move(grip.x, grip.y);
        await page.mouse.down();
        await page.mouse.move(grip.x + byX, grip.y + byY, { steps: 8 });
        await page.mouse.up();
      };

      const wasGiven = await gap();
      await drag(60, 150);
      expect(await gap(), 'the description grew with the dialog').toBeGreaterThan(wasGiven + 100);

      // Dragged well past the container-query breakpoint - the split collapses
      // below `@lg`, 512px of the dialog's own content box - on a viewport
      // that never itself narrows, the window staying wide throughout being
      // what tells the two apart. 500 rather than the 400 this walk used
      // before the drag above widened it: from 956px, 400 would land within a
      // pixel or two of the breakpoint itself.
      await drag(-500, 0);
      expect(await sideBySide(), 'one column once the dialog itself is narrow').toBe(false);

      /**
       * Stacked, the files used to come ahead of the description - the order
       * the two columns happened to be written in - which put text a person
       * is here to write below a list of files they are only attaching to it
       * (found in the docked form once it is dragged narrower than the split
       * needs).
       */
      const files = form(page).getByText('Attachments', { exact: true });
      const priority = (await priorityBox(page).boundingBox())!;
      const description = (await toolbar.boundingBox())!;
      const attached = (await files.boundingBox())!;
      expect(description.y - priority.y, 'one column, the description below the fields').toBeGreaterThanOrEqual(40);
      expect(priority.y, 'the short fields come first').toBeLessThan(description.y);
      expect(description.y, 'then the description, ahead of the files').toBeLessThan(attached.y);

      // What is drawn is also what Tab and a screen reader take: the
      // description comes before the files in the document itself, not only
      // on screen.
      const filesHandle = (await files.elementHandle())!;
      const descriptionFirst = await toolbar.evaluate(
        (element, other) => Boolean(element.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING),
        filesHandle,
      );
      expect(descriptionFirst, 'the description before the files in the document').toBe(true);
    });
  });

  /**
   * The account's own answer to the choice just sent - waited on before
   * anything that depends on it having landed, the same convention
   * `panels.test.ts`'s own `answerTo` follows.
   *
   * `timeout` is shortened in the cleanup path below: a `finally` block
   * cannot let an assertion already thrown in `try` propagate until its own
   * promise settles, so a wait with nothing to observe (found in review: the
   * "put it back" press failing without ever sending its own request) must
   * not sit for the default timeout and report that instead of the real
   * failure.
   */
  function answeredThePresentation(page: Page, timeout?: number): Promise<unknown> {
    return page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === '/v1/commands/set_item_form_presentation',
      // Not `{ timeout }`: with `exactOptionalPropertyTypes`, an options
      // object naming `timeout` at all has to hold a real number, never
      // `undefined` itself - so the default case passes no options object
      // rather than one carrying the key with nothing in it.
      timeout === undefined ? undefined : { timeout },
    );
  }

  /** The account is shared by every walk in the run, so an earlier one may have left it docked: a docking walk starts from centered either way. */
  async function centerIfDocked(page: Page, isMobile: boolean): Promise<void> {
    if (!(await form(page).getByRole('button', { name: 'Center' }).count().catch(() => 0))) return;
    const answered = answeredThePresentation(page);
    await press(form(page).getByRole('button', { name: 'Center' }), isMobile);
    await answered;
  }

  /** Every docking walk's `finally`: best effort, so a failure above is reported as itself rather than masked by a cleanup step failing on whatever broke it. */
  async function putItBackCentered(page: Page, isMobile: boolean): Promise<void> {
    if (await form(page).getByRole('button', { name: 'Center' }).count().catch(() => 0)) {
      const recentering = answeredThePresentation(page, 5_000).catch(() => {});
      await press(form(page).getByRole('button', { name: 'Center' }), isMobile).catch(() => {});
      await recentering;
    }
    await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile).catch(() => {});
  }

  /**
   * "Let the item's form dock to the side of the screen instead of opening
   * as a dialog" (issue 481): an account-wide choice, so this walk restores
   * it to centered in a `finally` - the same reason `deleteWorkspace` puts a
   * workspace back, but guarded here because a failure partway through would
   * otherwise leave every other item-form walk sharing this account finding
   * it docked (found in review).
   */
  test.describe('the form can be docked to the side of the screen, an account-wide choice', () => {
    test('docks flush to the side, leaves the page beside it whole and clickable, is remembered on reopening, and falls back to centered on a window too narrow for it', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'docking is its own, separate discussion on a phone, by design');

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Dock to the side');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      // Whatever the shared account already has - centered, on a run where
      // nothing else has touched this yet.
      await centerIfDocked(page, isMobile);

      // The page's own right edge: its header, which spans the whole shell.
      const shellRight = async () => {
        const box = (await page.locator('header').first().boundingBox())!;
        return Math.round(box.x + box.width);
      };
      const viewport = page.viewportSize()!;
      try {
        const centered = (await form(page).boundingBox())!;
        expect(await shellRight(), 'the whole window while the form is centered').toBe(viewport.width);

        const docking = answeredThePresentation(page);
        await press(form(page).getByRole('button', { name: 'Dock' }), isMobile);
        await docking;

        const docked = (await form(page).boundingBox())!;
        // Flush against the right edge and full height - unlike centered,
        // which sits away from every edge.
        expect(Math.round(docked.x + docked.width)).toBe(viewport.width);
        expect(Math.round(docked.y)).toBe(0);
        expect(Math.round(docked.height)).toBe(viewport.height);
        expect(Math.round(docked.x)).not.toBe(Math.round(centered.x));

        // A companion beside the dashboards, so the page gives up the room it
        // takes rather than being covered by it. Polled: the server's answer
        // is not the page having repainted.
        await expect
          .poll(shellRight, { message: 'ends where the docked form begins' })
          .toBe(Math.round(docked.x));

        // Non-modal: the page behind it can still be worked, which a real
        // click - not merely filling a value in - is what actually proves,
        // since a click Playwright judges blocked by a covering overlay
        // throws rather than landing.
        await captureBox(page).click({ timeout: 5_000 });
        await captureBox(page).fill('Still usable behind the docked form');
        await expect(captureBox(page)).toHaveValue('Still usable behind the docked form');
        await captureBox(page).fill('');

        // Resized by dragging its own left edge, unlike the centered
        // presentation's bottom-right corner - dragged toward the right edge
        // it is docked to, which is what narrows it (the default viewport is
        // wide enough that it opens at its own ceiling already, so widening it
        // further has nowhere to go). The page takes the room back as the
        // form gives it.
        const handle = form(page).getByRole('separator', { name: 'Resize the form' });
        const grip = (await handle.boundingBox())!;
        await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
        await page.mouse.down();
        await page.mouse.move(grip.x + 200, grip.y, { steps: 8 });
        await page.mouse.up();
        const narrowed = (await form(page).boundingBox())!;
        expect(narrowed.width, 'dragging toward the edge it is docked to narrowed it').toBeLessThan(
          docked.width - 100,
        );
        expect(narrowed.x, 'the form is narrower').toBeGreaterThan(docked.x + 100);
        await expect
          .poll(shellRight, { message: 'follows the form’s new edge' })
          .toBe(Math.round(narrowed.x));

        // Both the choice and the width it was dragged to are the account's
        // and this device's own, so they are there again on a fresh page
        // load - not only on the tab that just made them, which the open
        // form's own already-warm cache would answer from regardless of what
        // the account and this browser actually hold.
        //
        // **Reloaded rather than reopened through `openInbox`.** `openInbox`
        // signs in again, and signing in leaves the application and comes
        // back through the logon page - which clears everything this browser
        // remembers (`session/forget.ts`), the dragged width included. The
        // still-valid cookie is what a real reload keeps, landing straight
        // back on the same authenticated workspace without passing through
        // that page at all (found in review: the first version of this walk
        // reopened through `openInbox` after the reload, and had the drag it
        // had just proven immediately forgotten by its own next step).
        await press(form(page).getByRole('button', { name: 'Close' }), isMobile);
        await page.reload();
        await expect(captureBox(page)).toBeVisible();
        await openItem(page, thought, isMobile);
        await expect(form(page).getByRole('button', { name: 'Center' })).toBeVisible();
        const reopened = (await form(page).boundingBox())!;
        expect(Math.round(reopened.width)).toBe(Math.round(narrowed.width));

        // **"Out of scope" for a phone means "falls back to centered", not
        // "renders anyway"** (found in review, on the pull request itself): a
        // jsdom unit test proved the class name changes, but a docked
        // account's own form actually redrawing itself once the window it is
        // open in gets too narrow is a real window and a real layout.
        // Narrowed live, with the form already open - the same reactive width
        // the docked resize clamp answers to, not only a fresh open's read
        // of it.
        await page.setViewportSize({ width: 375, height: 700 });
        // Polled rather than read once: falling back to centered swaps the
        // dialog's own modal and non-modal content, which is drawn afresh a
        // beat after the resize rather than in the same frame.
        await expect(async () => {
          const narrow = await form(page).boundingBox();
          expect(narrow, 'the form is drawn').not.toBeNull();
          expect(Math.round(narrow!.x + narrow!.width), 'no longer flush against the edge').not.toBe(375);
        }).toPass();
        // The account is still docked - only what is drawn fell back - so the
        // control still offers to undock it, not to dock what already is.
        await expect(form(page).getByRole('button', { name: 'Center' })).toBeVisible();

        // Centered by hand on a window with room again, and the page has the
        // whole of it back.
        await page.setViewportSize(viewport);
        const centering = answeredThePresentation(page);
        await press(form(page).getByRole('button', { name: 'Center' }), isMobile);
        await centering;
        await expect.poll(shellRight, { message: 'the whole window again' }).toBe(viewport.width);
      } finally {
        // Put back, so every other item-form walk sharing this account goes
        // on finding the centered presentation it was written against -
        // best effort, so a failure above is reported as itself rather than
        // masked by a cleanup step failing on whatever broke it.
        await page.setViewportSize(viewport);
        await putItBackCentered(page, isMobile);
      }
    });

    /**
     * What a docked form follows, and what it writes on the way. Three issues
     * meet in one walk because they share every step of the setup: "Let the
     * item's form dock to the side of the screen instead of opening as a
     * dialog" (issue 481) for the click that lands on a real row beside a real
     * dock, "Save a docked item's fields as you finish them, not behind one
     * Save button" (issue 483) for a real blur, a real select and the real bar
     * reaching the server, and "Keep a docked item open across dashboards in
     * the same workspace" (issue 482) for the address a real browser holds.
     * None of the three can be asked of jsdom; the rest of the routing rule is
     * apps/web/tests/unit/router.test.tsx.
     *
     * In a workspace of its own, so the dashboard it adds goes with the
     * workspace it is deleted with.
     */
    test('follows the row you click and the note you capture, writes each field as it is finished, and stays open across the dashboards of its own workspace', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'docking is its own, separate discussion on a phone, by design');

      const answeredTo = (command: string) =>
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === `/v1/commands/${command}`,
        );

      const home = uniqueTitle('Docked walk');
      const anotherDashboard = uniqueTitle('Second');
      await openInbox(page, isMobile);
      await makeWorkspace(page, home, isMobile);
      // Making it only waits for its tab, and the capture below acts on
      // whichever workspace is on screen until the router has moved.
      await switchTo(page, home, isMobile);

      const first = uniqueTitle('Follow first');
      const next = uniqueTitle('Follow second');
      await capture(page, first, isMobile);
      await capture(page, next, isMobile);
      await openItem(page, first, isMobile);
      await centerIfDocked(page, isMobile);

      let followedTo = first;
      try {
        const docking = answeredThePresentation(page);
        await press(form(page).getByRole('button', { name: 'Dock' }), isMobile);
        await docking;
        // No Save button at all: a docked form writes each field as it is
        // finished rather than behind one press.
        await expect(form(page).getByRole('button', { name: 'Save' })).toHaveCount(0);
        await expect(titleBox(page)).toHaveValue(first);
        await expect(itemRow(page, first)).toHaveAttribute('aria-current', 'true');

        // A plain click on another row moves the dock to it, and what was
        // typed in the one it leaves is written by the real unmount.
        const renamed = uniqueTitle('Follow renamed');
        await titleBox(page).fill(renamed);
        await itemRow(page, next).click();
        followedTo = next;
        await expect(titleBox(page)).toHaveValue(next);
        await expect(itemRow(page, next)).toHaveAttribute('aria-current', 'true');
        await expect(itemRow(page, renamed)).toBeVisible();

        // A capture moves it again and leaves the keyboard in the capture
        // box, so a run of notes can be typed one after another: real focus,
        // and a real dialog that would otherwise take it.
        const captured = uniqueTitle('Capture follow');
        await captureBox(page).fill(captured);
        await captureBox(page).press('Enter');
        followedTo = captured;
        await expect(titleBox(page)).toHaveValue(captured);
        await expect(itemRow(page, captured)).toHaveAttribute('aria-current', 'true');
        await expect(captureBox(page)).toBeFocused();

        // One open form changing its Item, so Back leaves the page rather than
        // stepping back through the rows it has followed.
        await page.goBack();
        await expect(form(page)).toHaveCount(0);
        await openItem(page, captured, isMobile);

        // Each field as it is finished, on the item the dock has followed to.
        const prioritised = answeredTo('set_priority');
        await priorityBox(page).selectOption('high');
        await prioritised;

        const titled = answeredTo('set_title');
        await titleBox(page).fill(`${captured} edited`);
        await titleBox(page).press('Tab');
        await titled;
        await expect(page.getByRole('status')).toContainText('Changed the title');

        // The last change, taken back - the bar offers one step, so the
        // priority stays, and so does the rename the row click wrote on its
        // way out, which is what tells this apart from an Undo that reached
        // the wrong change.
        const undone = answeredTo('set_title');
        await press(page.getByRole('status').getByRole('button', { name: 'Undo' }), isMobile);
        await undone;
        await expect(titleBox(page)).toHaveValue(captured);
        await expect(itemRow(page, renamed)).toBeVisible();

        // Closing keeps a box still holding the cursor.
        const closing = answeredTo('set_description');
        await theEditorIsThere(page);
        await descriptionBox(page).fill('Written, cursor still there');
        await press(form(page).getByRole('button', { name: 'Close' }), isMobile);
        await closing;
        await expect(form(page)).toHaveCount(0);

        // Opened only once the server's own copy has been read back: a reload
        // first paints from what this browser stored, which cannot yet hold a
        // write made a moment before, and the form fills once from whichever
        // copy it is opened on.
        const readBack = page.waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            /\/v1\/workspaces\/[^/]+\/snapshot$/.test(new URL(response.url()).pathname),
        );
        await page.reload();
        await readBack;
        await expect(captureBox(page)).toBeVisible();
        await openItem(page, captured, isMobile);
        await expect(priorityBox(page)).toHaveValue('high');
        await expect(titleBox(page)).toHaveValue(captured);
        await theEditorIsThere(page);
        await expect(descriptionBox(page)).toHaveText('Written, cursor still there');

        // And it stays open across this workspace's dashboards - through the
        // `+`, which switches to the dashboard it makes, and through a tab,
        // both ways.
        await press(page.getByRole('button', { name: 'Add a dashboard' }), isMobile);
        await page.getByLabel('Name of the new dashboard').fill(anotherDashboard);
        await page.getByLabel('Name of the new dashboard').press('Enter');
        await expect(dashboardTab(page, anotherDashboard)).toHaveClass(/(^|\s)active(\s|$)/);
        await expect(titleBox(page)).toHaveValue(captured);
        await openDashboard(page, 'Dashboard 1', isMobile);
        await expect(titleBox(page)).toHaveValue(captured);
        await openDashboard(page, anotherDashboard, isMobile);
        await expect(titleBox(page)).toHaveValue(captured);
        expect(new URL(page.url()).searchParams.get('item')).not.toBeNull();

        // And lets go at the workspace boundary, which the walk leaves by.
        await switchTo(page, STARTING_WORKSPACE, isMobile);
        await expect(form(page)).toHaveCount(0);
        await switchTo(page, home, isMobile);
        await expect(dashboardTab(page, anotherDashboard)).toBeVisible();
        await expect(form(page)).toHaveCount(0);
      } finally {
        // Put back for every other walk sharing this account, best effort so
        // a failure above is reported as itself. The form may not be open by
        // now, so it is reopened - docked, as the account has it - to centre
        // it.
        if (!(await form(page).count().catch(() => 0))) {
          await openItem(page, followedTo, isMobile).catch(() => {});
        }
        await putItBackCentered(page, isMobile);
      }
      await deleteWorkspace(page, home, isMobile);
    });

  });
});

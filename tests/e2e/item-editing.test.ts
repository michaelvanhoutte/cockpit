import type { Page } from '@playwright/test';
import { MAX_ATTACHMENT_SIZE } from '@cockpit/shared';
import { capture, captureBox, expect, itemRow, openInbox, press, test, uniqueTitle } from './support/app';

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
      // And what was captured is behind the disclosure as a record, which can
      // never be edited. Scoped to the disclosure's own group rather than
      // the form - the panel is portalled to the end of the document, not a
      // descendant of the dialog, which is what lets it escape its
      // `overflow-hidden` - and to that group specifically, because the
      // description's editor writes paragraphs of its own the moment it
      // arrives, which is a race against this line.
      await press(form(page).getByText('What was captured'), isMobile);
      await expect(page.getByRole('group').getByRole('paragraph')).toHaveText(thought);

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
   * priority and finds the row marked accordingly. What the form sends is
   * proved without a browser in apps/web/tests/unit/components/ItemForm.test.tsx,
   * and that a save waits for the re-read before the row can be trusted is
   * proved in apps/web/tests/unit/api/queries.test.tsx. Neither can say the
   * row's own mark actually changes on screen ("Show and edit an item's
   * priority", issue 433).
   */
  test.describe('setting a priority marks the row, and clearing it removes the mark', () => {
    test('shows the level chosen, and nothing once it is cleared', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Renew the passport');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await priorityBox(page).selectOption('high');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      await expect(itemRow(page, thought).getByLabel('High priority')).toBeVisible();

      // And it is still there on the way back in, holding the level rather
      // than only having drawn it once.
      await openItem(page, thought, isMobile);
      await expect(priorityBox(page)).toHaveValue('high');

      await priorityBox(page).selectOption('');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      // The dialog gone first, the same as the cancel walk above asserts -
      // otherwise the list sits behind Radix's aria-hidden while the dialog
      // is still up mid-save, and the row's mark would read as absent from
      // that alone, whether or not the clear actually landed.
      await expect(priorityBox(page)).toHaveCount(0);
      await expect(itemRow(page, thought).getByLabel('High priority')).toHaveCount(0);
    });
  });

  /**
   * F3, because this is the capability: a person sets or clears an item's due
   * date and finds the row showing it accordingly. What the form sends is
   * proved without a browser in apps/web/tests/unit/components/ItemForm.test.tsx,
   * and that a save waits for the re-read before the row can be trusted is
   * proved in apps/web/tests/unit/api/queries.test.tsx. Neither can say the
   * row itself actually changes on screen ("Show and set an item's due date",
   * issue 462).
   */
  test.describe('setting a due date shows it on the row, and clearing it removes it', () => {
    test('shows the date chosen, and nothing once it is cleared', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Renew the passport');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await dueDateBox(page).fill('2026-09-30');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      await expect(itemRow(page, thought).getByText('Due Sep 30, 2026')).toBeVisible();

      // And it is still there on the way back in, holding the date rather
      // than only having drawn it once.
      await openItem(page, thought, isMobile);
      await expect(dueDateBox(page)).toHaveValue('2026-09-30');

      await dueDateBox(page).fill('');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      // The dialog gone first, the same as the cancel walk above asserts -
      // otherwise the list sits behind Radix's aria-hidden while the dialog
      // is still up mid-save, and the row would read as unset from that
      // alone, whether or not the clear actually landed.
      await expect(dueDateBox(page)).toHaveCount(0);
      await expect(itemRow(page, thought).getByText('Due Sep 30, 2026')).toHaveCount(0);
    });

    /**
     * The one-click shortcuts beside the field itself ("Give the item's form
     * more room, and put clutter out of the way", issue 480) - what each one
     * computes is tests/unit/dueDateShortcuts.test.ts's own claim; what is
     * asked here is that a real press on a real button actually reaches the
     * field, the same way typing into it does above.
     */
    test('a one-click shortcut fills the field too, and reaches the row the same way', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('One-click due date');
      await capture(page, thought, isMobile);

      await openItem(page, thought, isMobile);
      await press(form(page).getByRole('button', { name: 'Today' }), isMobile);
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);

      await expect(dueDateBox(page)).toHaveCount(0);
      const now = new Date();
      const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      await openItem(page, thought, isMobile);
      await expect(dueDateBox(page)).toHaveValue(today);
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

    test('adds one by button, drawn as a chip, and opens the real file from a click on it', async ({
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

    test('removing one takes it off the item for good, and a second Save does not bring it back', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Attached and removed');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      const uploaded = uploadResponse(page);
      await attachmentInput(page).setInputFiles({ name: 'receipt.png', mimeType: 'image/png', buffer: A_PNG });
      await uploaded;
      await expect(form(page).getByText('receipt.png')).toBeVisible();

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
  });

  /**
   * End to end, because this is where a real selection in a real editor is: the
   * unit runner gives ProseMirror rectangles that are all zero and a caret that
   * does not exist, so nothing about switching views with something selected
   * can be asked below the browser.
   */
  test.describe('the formatted description and its source are one text', () => {
    test('shows the same description either way round, and leaves it alone', async ({
      page,
      isMobile,
    }) => {
      const thought = await anItemToWriteOn(page, 'Two views', isMobile);

      // Written as Markdown, it comes back formatted.
      await show(page, 'Source', isMobile);
      await descriptionBox(page).fill('- milk\n- bread');
      await show(page, 'Formatted', isMobile);
      await expect(form(page).getByRole('listitem')).toHaveText(['milk', 'bread']);

      // Formatted, it comes back as the marks that make it.
      await putTheCaretInTheDescription(page, isMobile);
      await press(form(page).getByRole('button', { name: 'bold' }), isMobile);
      await show(page, 'Source', isMobile);
      await expect(descriptionBox(page)).toHaveValue(/\*\*milk\*\*/);

      // And what was written stays written. `- ` is the marker the editor
      // rewrites to `* ` the moment it prints a list of its own, so a
      // description that came back tidied here would be one the editor had
      // silently rewritten on the way past.
      await descriptionBox(page).fill('- milk\n- bread');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);
      await openItem(page, thought, isMobile);
      await theEditorIsThere(page);
      await show(page, 'Source', isMobile);
      await expect(descriptionBox(page)).toHaveValue('- milk\n- bread');

      // Twice through both views, with nothing typed in either.
      await show(page, 'Formatted', isMobile);
      await show(page, 'Source', isMobile);
      await show(page, 'Formatted', isMobile);
      await show(page, 'Source', isMobile);
      await expect(descriptionBox(page)).toHaveValue('- milk\n- bread');
      await press(form(page).getByRole('button', { name: 'Save' }), isMobile);
      await openItem(page, thought, isMobile);
      await theEditorIsThere(page);
      await show(page, 'Source', isMobile);
      await expect(descriptionBox(page)).toHaveValue('- milk\n- bread');
    });
  });

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

    test('by button', async ({ page, isMobile }) => {
      await anItemToWriteOn(page, 'By button', isMobile);
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
    });

    test('by shortcut', async ({ page, isMobile }) => {
      await anItemToWriteOn(page, 'By shortcut', isMobile);

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

      const linked = await appliedTo(page, isMobile, async () => {
        await descriptionBox(page).press('ControlOrMeta+k');
        await form(page).getByRole('textbox', { name: 'Address' }).fill('example.com/runbook');
        await form(page).getByRole('textbox', { name: 'Address' }).press('Enter');
      });
      expect(linked).toContain('[Tolerances](https://example.com/runbook)');
    });

    // The refusal is the visible half of the address allowlist, whose rules are
    // in apps/web/tests/unit/description/safeHref.test.ts. What is asked here
    // is only that the button is wired to it and says so.
    test('refuses a link that would not be a link', async ({ page, isMobile }) => {
      await anItemToWriteOn(page, 'A bad address', isMobile);
      await show(page, 'Source', isMobile);
      await descriptionBox(page).fill('Tolerances');
      await show(page, 'Formatted', isMobile);
      await putTheCaretInTheDescription(page, isMobile);

      await press(form(page).getByRole('button', { name: 'link', exact: true }), isMobile);
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
    test('offers the handle at a desk, and none on a phone', async ({ page, isMobile }) => {
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
      } else {
        expect(resize, 'a desk has room to spare, and a corner handle to shrink into it').toBe(
          'both',
        );
      }
    });

    /**
     * The default used to double as its own ceiling - a drag could shrink the
     * box but never grow it - which is what "Give the item's form more room,
     * and put clutter out of the way" (issue 480) puts a real ceiling above.
     */
    test('grows past the old default size, up to a real ceiling above it', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'resizing is a pointer gesture');

      // Taller than the suite's own default viewport, so the ceiling's own
      // headroom above the default height is not itself clamped away by the
      // screen before the drag ever gets there - the default's own height
      // already sits close to a laptop-sized screen by design.
      await page.setViewportSize({ width: 1280, height: 1000 });

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Grow past the old default');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      const before = (await form(page).boundingBox())!;
      const grip = { x: before.x + before.width - 6, y: before.y + before.height - 6 };
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      // Dragged outward on both axes - past where the old default, which
      // used to double as its own ceiling, would have stopped it.
      await page.mouse.move(grip.x + 250, grip.y + 150, { steps: 8 });
      await page.mouse.up();
      const grown = (await form(page).boundingBox())!;

      expect(grown.width, 'grew past the old default width').toBeGreaterThan(before.width + 100);
      expect(grown.height, 'grew past the old default height').toBeGreaterThan(before.height + 100);
    });

    test('shrinks to a floor, and no further', async ({ page, isMobile }) => {
      test.skip(isMobile, 'resizing is a pointer gesture');

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Shrink to the floor');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      const before = (await form(page).boundingBox())!;
      const grip = { x: before.x + before.width - 6, y: before.y + before.height - 6 };
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      // Dragged far past where the floor sits, so the assertion is about the
      // floor holding rather than about how far the drag reached.
      await page.mouse.move(grip.x - 1000, grip.y - 1000, { steps: 8 });
      await page.mouse.up();
      const shrunk = (await form(page).boundingBox())!;

      expect(shrunk.width, 'shrank to the floor, not any smaller').toBeGreaterThanOrEqual(318);
      expect(shrunk.width).toBeLessThanOrEqual(322);
      expect(shrunk.height, 'shrank to the floor, not any smaller').toBeGreaterThanOrEqual(286);
      expect(shrunk.height).toBeLessThanOrEqual(290);
    });

    test('remembers a dragged size across items and a reopen, clamped to whatever screen it opens on next', async ({
      page,
      isMobile,
    }) => {
      // Dragging is a pointer gesture, the same reason sizing a panel's own
      // row and column is desktop-only in tests/e2e/panels.test.ts.
      test.skip(isMobile, 'resizing is a pointer gesture');

      await openInbox(page, isMobile);
      const first = uniqueTitle('Dragged smaller');
      const second = uniqueTitle('Same size here too');
      await capture(page, first, isMobile);
      await capture(page, second, isMobile);

      await openItem(page, first, isMobile);
      const firstUrl = page.url();
      const before = (await form(page).boundingBox())!;
      // The handle is the box's own bottom-right corner, drawn by the browser
      // rather than a testid this can look up - so the drag starts a few
      // pixels inside it instead.
      const grip = { x: before.x + before.width - 6, y: before.y + before.height - 6 };
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
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
      const full = page.viewportSize()!;
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

    test('a drag on one axis, with nothing remembered yet, does not carry a clamped screen into the other', async ({
      page,
      isMobile,
    }) => {
      // Dragging is a pointer gesture, the same reason sizing a panel's own
      // row and column is desktop-only in tests/e2e/panels.test.ts.
      test.skip(isMobile, 'resizing is a pointer gesture');

      // Short rather than narrow, so the ceiling clamps the height alone -
      // the axis this walk never touches - and wide enough that the resize
      // handle is still offered.
      const full = page.viewportSize()!;
      await page.setViewportSize({ width: 900, height: 500 });

      await openInbox(page, isMobile);
      const thought = uniqueTitle('One axis, nothing remembered yet');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);
      const thoughtUrl = page.url();

      const before = (await form(page).boundingBox())!;
      const grip = { x: before.x + before.width - 6, y: before.y + before.height - 6 };
      // Dragged along one axis only - the same height as the grip started
      // at, so nothing here ever asks the height to move.
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x - 150, grip.y, { steps: 8 });
      await page.mouse.up();
      await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);

      // Back on a screen tall enough for the full default, the height this
      // never touched is the default, not the short screen's own clamp of
      // it - the same claim the other test in this block makes for a screen
      // reclamping a size that was remembered, made here for one clamping
      // the *default* before anything was ever remembered at all.
      await page.setViewportSize(full);
      await page.goto(thoughtUrl);
      const reopened = (await form(page).boundingBox())!;
      expect(
        reopened.height,
        'the untouched axis is the full default, not the short screen’s clamp of it',
      ).toBeGreaterThan(600);
    });
  });

  /**
   * F3, because whether the description's own box actually grows and shrinks
   * on screen as the dialog is dragged is a claim about a real layout that
   * nothing below the browser can make - the frame not reacting to what is
   * *typed or loaded* into it is `apps/web/tests/unit/components/ItemForm.test.tsx`'s
   * own claim, and is a different thing from the description reacting to the
   * frame ("Give the item's form more room, and put clutter out of the way",
   * issue 480).
   */
  test.describe('the description fills whatever room the form has', () => {
    test('grows and shrinks with the dialog, rather than a fixed size', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'resizing is a pointer gesture');

      // Taller than the suite's own default viewport, the same reason the
      // resize block's own growth test sets one: the default height already
      // sits close to a laptop-sized screen, so there is no room for a drag
      // to grow it further without one.
      await page.setViewportSize({ width: 1280, height: 1000 });

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Description fills the form');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);
      await theEditorIsThere(page);

      // The gap between the toolbar and the footer is the room the
      // description has, measured without depending on how much text is in
      // it - a fixed-height box would leave that gap unmoved by a drag.
      const toolbar = form(page).getByRole('toolbar', { name: 'Formatting' });
      const saveButton = form(page).getByRole('button', { name: 'Save' });
      const gap = async () => {
        const toolbarBox = (await toolbar.boundingBox())!;
        const saveBox = (await saveButton.boundingBox())!;
        return saveBox.y - (toolbarBox.y + toolbarBox.height);
      };
      const before = await gap();

      const box = (await form(page).boundingBox())!;
      const grip = { x: box.x + box.width - 6, y: box.y + box.height - 6 };
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      await page.mouse.move(grip.x + 60, grip.y + 150, { steps: 8 });
      await page.mouse.up();

      expect(await gap(), 'grew with the dialog').toBeGreaterThan(before + 100);
    });
  });

  /**
   * F3, because whether the two-column split actually answers to a real
   * drag rather than to the viewport is a claim about real layout, the same
   * reason the resize and description-fill walks above are. A broken
   * `@container` setup would leave every other walk in this file green -
   * none of them ever narrow the dialog through the breakpoint - while the
   * split silently never collapsed at all ("Give the item's form more room,
   * and put clutter out of the way", issue 480).
   */
  test.describe('the two-column layout answers to the dialog’s own width, not the window’s', () => {
    test('stacks into one column once the dialog is dragged narrower than the split needs', async ({
      page,
      isMobile,
    }) => {
      test.skip(isMobile, 'resizing is a pointer gesture');

      await openInbox(page, isMobile);
      const thought = uniqueTitle('Collapses to one column');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);
      await theEditorIsThere(page);

      // Priority and the description's own toolbar sit on the same row when
      // there is room for two columns - both near the top of their own
      // column - and one column drops below the other's whole height once
      // there is not. The toolbar, not the description box itself: the box
      // sits below its own toolbar, which is otherwise close enough to
      // Priority's own row to read as "the same row" even stacked.
      const toolbar = form(page).getByRole('toolbar', { name: 'Formatting' });
      const sideBySide = async () => {
        const priority = (await priorityBox(page).boundingBox())!;
        const description = (await toolbar.boundingBox())!;
        return Math.abs(priority.y - description.y) < 40;
      };
      expect(await sideBySide(), 'two columns at the dialog’s own default width').toBe(true);

      const box = (await form(page).boundingBox())!;
      const grip = { x: box.x + box.width - 6, y: box.y + box.height - 6 };
      await page.mouse.move(grip.x, grip.y);
      await page.mouse.down();
      // Dragged well past the container-query breakpoint, on a viewport
      // that never itself narrows - the window staying wide throughout is
      // what tells the two apart.
      await page.mouse.move(grip.x - 400, grip.y, { steps: 8 });
      await page.mouse.up();

      expect(await sideBySide(), 'one column once the dialog itself is narrow').toBe(false);
    });
  });

  /**
   * F3, because whether a press elsewhere actually dismisses one of these -
   * and only this, never the form under it - is a claim about a real Radix
   * `Popover` mounted through a real portal, which nothing below the
   * browser can prove ("Give the item's form more room, and put clutter out
   * of the way", issue 480).
   */
  test.describe('the footer disclosures close on a press elsewhere, and only one is open at a time', () => {
    test('a press on the title closes it without closing the form, and only one stays open at a time', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      const thought = uniqueTitle('Footer disclosures dismiss');
      await capture(page, thought, isMobile);
      await openItem(page, thought, isMobile);

      // Each disclosure's own panel is portalled to the end of the
      // document, not a descendant of the dialog - which is what lets it
      // escape the dialog's own `overflow-hidden` - so it is found on the
      // page rather than scoped to `form(page)`.
      await press(form(page).getByRole('button', { name: 'What was captured' }), isMobile);
      await expect(page.getByRole('group')).toBeVisible();

      // A press elsewhere in the form - the title field - closes the panel
      // without closing the form under it.
      await press(titleBox(page), isMobile);
      await expect(titleBox(page)).toHaveValue(thought);
      await expect(page.getByRole('group')).toHaveCount(0);

      // Opening the other one closes this one - Radix's own dismissable
      // layer answers the press that lands on the new trigger by closing
      // what was open, the same as it would a press anywhere else outside
      // the panel, rather than also treating that same press as the new
      // trigger's own - so switching is two presses, not one, and this
      // asks for both rather than assuming either alone opens the other.
      await press(form(page).getByRole('button', { name: 'What was captured' }), isMobile);
      await press(form(page).getByRole('button', { name: 'ID' }), isMobile);
      await expect(page.getByRole('group')).toHaveCount(0);
      await press(form(page).getByRole('button', { name: 'ID' }), isMobile);
      await expect(page.getByRole('group')).toHaveCount(1);
      await expect(page.getByRole('group').getByRole('button', { name: 'Copy' })).toBeVisible();
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

  /**
   * "Let the item's form dock to the side of the screen instead of opening
   * as a dialog" (issue 481): an account-wide choice, so this walk restores
   * it to centered in a `finally` - the same reason `deleteWorkspace` puts a
   * workspace back, but guarded here because a failure partway through would
   * otherwise leave every other item-form walk sharing this account finding
   * it docked (found in review).
   */
  test.describe('the form can be docked to the side of the screen, an account-wide choice', () => {
    test('docks to the side, leaves the page behind it clickable, is remembered on reopening, and is resizable', async ({
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
      if (await form(page).getByRole('button', { name: 'Center' }).count()) {
        const already = answeredThePresentation(page);
        await press(form(page).getByRole('button', { name: 'Center' }), isMobile);
        await already;
      }

      try {
        const centered = (await form(page).boundingBox())!;

        const docking = answeredThePresentation(page);
        await press(form(page).getByRole('button', { name: 'Dock' }), isMobile);
        await docking;

        const viewport = page.viewportSize()!;
        const docked = (await form(page).boundingBox())!;
        // Flush against the right edge and full height - unlike centered,
        // which sits away from every edge.
        expect(Math.round(docked.x + docked.width)).toBe(viewport.width);
        expect(Math.round(docked.y)).toBe(0);
        expect(Math.round(docked.height)).toBe(viewport.height);
        expect(Math.round(docked.x)).not.toBe(Math.round(centered.x));

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
        // further has nowhere to go).
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
        await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile);
        await page.reload();
        await expect(captureBox(page)).toBeVisible();
        await openItem(page, thought, isMobile);
        await expect(form(page).getByRole('button', { name: 'Center' })).toBeVisible();
        const reopened = (await form(page).boundingBox())!;
        expect(Math.round(reopened.width)).toBe(Math.round(narrowed.width));
      } finally {
        // Put back, so every other item-form walk sharing this account goes
        // on finding the centered presentation it was written against -
        // best effort, so a failure above is reported as itself rather than
        // masked by a cleanup step failing on whatever broke it.
        if (await form(page).getByRole('button', { name: 'Center' }).count().catch(() => 0)) {
          const recentering = answeredThePresentation(page, 5_000).catch(() => {});
          await press(form(page).getByRole('button', { name: 'Center' }), isMobile).catch(() => {});
          await recentering;
        }
        await press(form(page).getByRole('button', { name: 'Cancel' }), isMobile).catch(() => {});
      }
    });
  });
});

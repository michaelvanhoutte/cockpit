import type { Page } from '@playwright/test';
import { capture, expect, itemRow, openInbox, press, test, uniqueTitle } from './support/app';

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
      // never be edited. Scoped to the disclosure's own group, because the
      // description's editor writes paragraphs of its own the moment it
      // arrives, which is a race against this line.
      await press(form(page).getByText('What was captured'), isMobile);
      await expect(form(page).getByRole('group').getByRole('paragraph')).toHaveText(thought);

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
});

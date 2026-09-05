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
 */
async function theEditorIsThere(page: Page): Promise<void> {
  await expect(form(page).getByRole('toolbar', { name: 'Formatting' })).toBeVisible();
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

      // The captured message is what the row was showing, and it is behind the
      // disclosure rather than in a box: it can never be edited.
      await expect(titleBox(page)).toHaveValue('');
      await press(form(page).getByText('What was captured'), isMobile);
      // The paragraph the disclosure holds, not the heading, which now carries
      // the same label because the item has no title yet.
      await expect(form(page).getByRole('paragraph')).toHaveText(thought);

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

      const linked = await appliedTo(page, isMobile, async () => {
        await press(button('link'), isMobile);
        await form(page).getByRole('textbox', { name: 'Address' }).fill('example.com/runbook');
        await press(button('Add link'), isMobile);
      });
      expect(linked).toContain('[Tolerances](https://example.com/runbook)');
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
});

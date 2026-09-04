import {
  captureBox,
  expect,
  expectNoSidewaysScroll,
  inbox,
  itemRow,
  openInbox,
  press,
  test,
  uniqueTitle,
} from './support/app';

/**
 * F3, because the capture control is reached by a tap on a 480px screen and by
 * a mouse on a 1280px one, and neither the viewport nor the touch event path
 * exists below a real browser — jsdom, where the F1 tests run, has no layout
 * engine at all. It is not re-proving CaptureForm's logic, which
 * apps/web/tests/unit/components/CaptureForm.test.tsx already owns; it proves
 * the whole thing is tied together and usable on the device in hand.
 */
test.describe('Capture', () => {
  test.describe('a captured thought appears in the inbox, on a phone screen as on a desktop', () => {
    test('lists the thought to process, reachable without scrolling sideways', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);
      await expectNoSidewaysScroll(page);

      // Reachable, not merely present: an element rendered off the edge of a
      // phone satisfies toBeVisible and is still unusable.
      await expect(captureBox(page)).toBeInViewport();

      const thought = uniqueTitle('Buy milk');
      await captureBox(page).fill(thought);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);

      await expect(itemRow(page, thought)).toBeVisible();
      await expect(inbox(page).getByText(thought)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });

  test.describe('capturing a thought shows it in the inbox as a thought', () => {
    test('says what kind of thing it is on its own row', async ({ page, isMobile }) => {
      await openInbox(page, isMobile);

      const kind = page.getByLabel('What kind of thing this is');
      await expect(kind).toBeInViewport();

      const thought = uniqueTitle('Maybe split the pricing page');
      await captureBox(page).fill(thought);
      await kind.fill('Thought');
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);

      // The word under the title, which is one of the two marks the type took
      // from the status ("Capture a thought or an action, and see which it
      // is", issue 155).
      await expect(itemRow(page, thought).getByText('Thought')).toBeVisible();
      await expectNoSidewaysScroll(page);
    });

    test('makes a type by naming one that is not there, and captures as it', async ({
      page,
      isMobile,
    }) => {
      await openInbox(page, isMobile);

      const made = uniqueTitle('Kind');
      const thought = uniqueTitle('Why is this slow?');
      await captureBox(page).fill(thought);
      await page.getByLabel('What kind of thing this is').fill(made);
      await press(page.getByRole('button', { name: 'Capture' }), isMobile);

      await expect(itemRow(page, thought).getByText(made)).toBeVisible();
      await expectNoSidewaysScroll(page);
    });
  });
});

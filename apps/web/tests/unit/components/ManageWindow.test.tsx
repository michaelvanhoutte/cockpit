import { describe, expect, it } from 'vitest';
import { fireEvent, render } from '@testing-library/react';
import { ManageWindow } from '../../../src/components/ManageWindow';

/**
 * The shell every "manage a list of named things" window shares. What is
 * asked here is the one behaviour it carries for all of them: a file missed
 * onto the backdrop is kept from the browser, which would otherwise navigate
 * away to open it - the guard the Item form's own overlay already had, and
 * the one Capture's own window needs now that it takes files
 * ("Drop files and paste images while capturing a message", issue 557).
 */
describe('Management windows', () => {
  it('keeps a file dropped on the backdrop from the browser', () => {
    render(
      <ManageWindow title="Things" open onClose={() => {}}>
        <p>content</p>
      </ManageWindow>,
    );
    const overlay = document.querySelector('.bg-scrim\\/30')!;
    const carrying = { dataTransfer: { types: ['Files'], files: [] } };

    const leftToTheBrowser = fireEvent.drop(overlay, carrying);

    expect(leftToTheBrowser).toBe(false);
  });
});

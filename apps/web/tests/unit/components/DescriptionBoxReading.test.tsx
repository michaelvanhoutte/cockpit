import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DescriptionBox } from '../../../src/components/DescriptionBox';

/**
 * F1, with the real editor: a description drawn to be read, as an Item's page
 * on a phone draws it before anyone has asked to edit. What the form does with
 * a tap is `ItemForm.test.tsx`'s, against a stand-in; that a link in the
 * editor's own output is reached, and that nothing else in it is, can only be
 * said of the editor itself.
 */
afterEach(cleanup);

describe('Item editing', () => {
  describe('a tap on a description drawn to be read opens a link in a new tab, and anywhere else asks to edit', () => {
    const drawn = async (onReadingTap: () => void) => {
      render(
        <DescriptionBox
          reading
          value="Ring the supplier, see [the spec](https://example.com/spec) first"
          onChange={() => {}}
          editable={false}
          onAPage
          onReadingTap={onReadingTap}
        />,
      );
      return { link: await screen.findByRole('link', { name: 'the spec' }), user: userEvent.setup() };
    };

    it('a link opens its address in a new tab and does not ask to edit', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      try {
        const onReadingTap = vi.fn();
        const { link, user } = await drawn(onReadingTap);

        await user.click(link);

        expect(open).toHaveBeenCalledWith('https://example.com/spec', '_blank', 'noopener');
        expect(onReadingTap).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    });

    it('the words around it ask to edit and open nothing', async () => {
      const open = vi.spyOn(window, 'open').mockReturnValue(null);
      try {
        const onReadingTap = vi.fn();
        const { user } = await drawn(onReadingTap);
        await waitFor(() => expect(screen.getByRole('textbox', { name: 'Description' })).toHaveAttribute('contenteditable', 'false'));

        await user.click(screen.getByText(/Ring the supplier/));

        expect(onReadingTap).toHaveBeenCalledTimes(1);
        expect(open).not.toHaveBeenCalled();
      } finally {
        open.mockRestore();
      }
    });

    it('draws no toolbar and no Source toggle', async () => {
      await drawn(() => {});

      expect(screen.queryByRole('toolbar')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
    });
  });
});

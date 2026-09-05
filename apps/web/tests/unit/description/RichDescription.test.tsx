import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import RichDescription from '../../../src/description/RichDescription';

/**
 * F1: what the editor does the moment something changes in it.
 *
 * Only what a fake selection can reach lives here - a toolbar press with the
 * caret where the editor put it. Anything about a real selection is a walk in
 * tests/e2e/item-editing.test.ts, because jsdom gives ProseMirror rectangles
 * that are all zero and no caret of its own.
 */
describe('Item editing', () => {
  describe('a change to a description is known the moment it is made', () => {
    /**
     * It used to be known 200 milliseconds later, and not at all if the form
     * moved on first: Milkdown's listener debounces, and cancels what is
     * pending when the editor is taken down. So pressing a toolbar button and
     * then Source - or that button and then Save - lost the formatting,
     * silently. The browser walk found it twice before this test existed.
     */
    it('reports the new text without waiting', async () => {
      const changes: string[] = [];
      render(
        <RichDescription initial="Tolerances" onChange={(md) => changes.push(md)} editable />,
      );
      await screen.findByLabelText('Description');
      const user = userEvent.setup();

      await user.click(screen.getByRole('button', { name: 'bullet list' }));

      // Read at once, with nothing waited for beyond the press itself.
      expect(changes.at(-1)).toBe('* Tolerances\n');
    });

    /**
     * And nothing has changed when nothing has. The editor tidies what it
     * parses - `- ` becomes `* ` - so a change reported for the parse itself
     * would rewrite every description that was ever opened, on a Save that was
     * pressed for the title.
     *
     * Driven through the box being closed and opened again, which is what a
     * save in flight does to it, because that is the moment the editor is asked
     * to re-examine a document nobody touched.
     */
    it('says nothing has changed when nothing has', async () => {
      const changes: string[] = [];
      const box = (editable: boolean) => (
        <RichDescription
          initial={'- milk\n- bread'}
          onChange={(md) => changes.push(md)}
          editable={editable}
        />
      );
      const { rerender } = render(box(true));
      await waitFor(() => expect(screen.getByLabelText('Description')).toHaveTextContent('milk'));

      rerender(box(false));
      rerender(box(true));

      expect(changes).toEqual([]);
    });
  });

  describe('a description takes nothing more while it is being saved', () => {
    /**
     * The editor is built asynchronously, so a form that starts saving and then
     * comes back to the formatted view builds a *new* editor with the save
     * already in flight. That one came up writable: the effect that closes it
     * had run once against an editor which did not exist yet, and had no reason
     * to run again.
     */
    it('comes up closed when it is built during a save', async () => {
      render(<RichDescription initial="Tolerances" onChange={() => {}} editable={false} />);

      const box = await screen.findByLabelText('Description');
      await waitFor(() => expect(box).toHaveAttribute('contenteditable', 'false'));
    });

    /**
     * A save that did not land keeps the form open and says why. An address
     * half-typed before Save was pressed used to be waiting when it came back -
     * and being autofocused, it took the cursor off that message.
     */
    it('gives up an address being typed rather than hiding it', async () => {
      const box = (editable: boolean) => (
        <RichDescription initial="Tolerances" onChange={() => {}} editable={editable} />
      );
      const { rerender } = render(box(true));
      await screen.findByLabelText('Description');
      const user = userEvent.setup();
      const link = screen.getByRole('button', { name: 'link' });
      await waitFor(() => expect(link).toBeEnabled());
      await user.click(link);
      await user.type(screen.getByLabelText('Address'), 'example.com/half');

      rerender(box(false));
      rerender(box(true));

      expect(screen.queryByLabelText('Address')).toBeNull();
    });

    it('opens again once the save has landed', async () => {
      const box = (editable: boolean) => (
        <RichDescription initial="Tolerances" onChange={() => {}} editable={editable} />
      );
      const { rerender } = render(box(false));
      await screen.findByLabelText('Description');

      rerender(box(true));

      await waitFor(() =>
        expect(screen.getByLabelText('Description')).toHaveAttribute('contenteditable', 'true'),
      );
    });
  });
});

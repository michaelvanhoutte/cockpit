import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * F1: the form's description before, during and after the editor arrives.
 *
 * The editor is 140KB compressed and is fetched only once a form is open
 * (architecture, "Performance budgets"), so there is a window where the form is
 * on screen and the editor is not - and a case where it never comes. Both are
 * the form's own behaviour, which is what puts them here.
 *
 * The editor itself is replaced: what it does with Markdown is proved in
 * tests/unit/description/syntax.test.ts, and the only thing this file needs
 * from it is *when* it appears.
 */

/** What the fetch for the editor's chunk does. One of the three, per test. */
type Arrival = 'arrives' | 'still coming' | 'never comes';

/**
 * The box, with the chunk arriving the way this test wants it to.
 *
 * Mocked per test rather than once for the file: a module factory runs once and
 * its answer is cached, and `React.lazy` remembers the first answer it got, so
 * one registration would make these three tests share whichever arrival ran
 * first. Resetting the registry and registering again is what makes them three.
 */
async function theBox(arrival: Arrival, value = 'A **bold** word') {
  vi.resetModules();
  vi.doMock('../../../src/description/RichDescription', async () => {
    if (arrival === 'never comes') throw new Error('offline');
    if (arrival === 'still coming') await new Promise(() => {});
    return {
      default: ({ initial, editable }: { initial: string; editable: boolean }) => (
        <div>
          <div role="toolbar" aria-label="Formatting" />
          <div
            aria-label="Description"
            role="textbox"
            contentEditable={editable}
            suppressContentEditableWarning
          >
            {initial}
          </div>
        </div>
      ),
    };
  });
  const { DescriptionBox } = await import('../../../src/components/DescriptionBox');
  const changes: string[] = [];
  // The form holds the description and hands it back down, so the box is
  // rendered inside something that does the same. Handed a fixed value it would
  // be a box that cannot be typed in, and every edit here would read as the
  // first character of one.
  function Form() {
    const [markdown, setMarkdown] = useState(value);
    return (
      <DescriptionBox
        value={markdown}
        onChange={(written) => {
          changes.push(written);
          setMarkdown(written);
        }}
        editable
      />
    );
  }
  render(<Form />);
  return { changes, user: userEvent.setup() };
}

afterEach(cleanup);

describe('Item editing', () => {
  describe('the form works before its editor has loaded', () => {
    it('says the editor is coming, and shows the description meanwhile', async () => {
      // Never settles, so the form stays in the state it opens in.
      await theBox('still coming');

      expect(screen.getByText('Formatting is on its way…')).toBeInTheDocument();
      expect(screen.getByLabelText('Description')).toHaveValue('A **bold** word');
      // Readable, and not yet writable: an editor arriving under a cursor would
      // take what was being typed with it.
      expect(screen.getByLabelText('Description')).toHaveAttribute('readonly');
    });

    it('shows the editor once it arrives, with the description in it', async () => {
      await theBox('arrives');

      await waitFor(() => expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument());
      expect(screen.getByLabelText('Description')).toHaveTextContent('A **bold** word');
      expect(screen.queryByText('Formatting is on its way…')).toBeNull();
    });

    it('says so when it never loads, and leaves the description editable', async () => {
      await theBox('never comes');

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(/Formatting could not be loaded/),
      );
      const box = screen.getByLabelText('Description');
      expect(box).toHaveValue('A **bold** word');
      expect(box).toBeEnabled();
      expect(box).not.toHaveAttribute('readonly');
    });

    it('still sends what is typed when it never loads', async () => {
      const { changes, user } = await theBox('never comes');
      await screen.findByRole('alert');

      await user.type(screen.getByLabelText('Description'), '!');

      expect(changes.at(-1)).toBe('A **bold** word!');
    });
  });

  describe('the source of a description is one button away', () => {
    /**
     * What the source view shows is what would be stored, not what the editor
     * would re-print. The two differ until something is typed - parsing and
     * printing tidies - and showing the tidied text would mean opening a form,
     * touching nothing, and finding the description had changed.
     */
    it('shows the description as it would be stored, and takes an edit', async () => {
      const { changes, user } = await theBox('arrives', '- milk\n- bread');
      await screen.findByRole('toolbar', { name: 'Formatting' });

      await user.click(screen.getByRole('button', { name: 'Source' }));

      const source = screen.getByLabelText('Description');
      expect(source).toHaveValue('- milk\n- bread');
      await user.type(source, '{Enter}- eggs');
      expect(changes.at(-1)).toBe('- milk\n- bread\n- eggs');
    });

    it('goes back to the formatted view', async () => {
      const { user } = await theBox('arrives');
      await screen.findByRole('toolbar', { name: 'Formatting' });

      await user.click(screen.getByRole('button', { name: 'Source' }));
      await user.click(screen.getByRole('button', { name: 'Formatted' }));

      expect(screen.getByRole('toolbar', { name: 'Formatting' })).toBeInTheDocument();
    });

    // There is no formatted view to go to, so offering the toggle would be
    // offering a button that does nothing.
    it('is not offered where the editor never loaded', async () => {
      await theBox('never comes');
      await screen.findByRole('alert');

      expect(screen.queryByRole('button', { name: 'Source' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Formatted' })).toBeNull();
    });
  });
});

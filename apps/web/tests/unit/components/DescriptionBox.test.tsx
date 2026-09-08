import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * F1: the form's description before, during and after the editor arrives.
 *
 * The editor is the largest thing this app fetches - 115KB compressed, plus
 * the 21KB Markdown core it shares - and is fetched only once a form is open
 * (architecture, "Performance budgets"), so there is a window where the form is
 * on screen and the editor is not - and a case where it never comes. Both are
 * the form's own behaviour, which is what puts them here.
 *
 * The editor itself is replaced: what it does with Markdown is proved in
 * tests/unit/description/syntax.test.ts, and the only thing this file needs
 * from it is *when* it appears.
 */

/**
 * What the fetch for the editor's chunk does. `never comes` is the file not
 * being there; `arrives broken` is the file being there and the editor throwing
 * as it renders, which the same boundary catches and which is a bug rather than
 * a version behind.
 */
type Arrival = 'arrives' | 'still coming' | 'never comes' | 'arrives broken';

/**
 * The box, with the chunk arriving the way this test wants it to.
 *
 * Mocked per test rather than once for the file: a module factory runs once and
 * its answer is cached, and `React.lazy` remembers the first answer it got, so
 * one registration would make these three tests share whichever arrival ran
 * first. Resetting the registry and registering again is what makes them three.
 */
/**
 * What asking for the new version answers. Replaced rather than driven, because
 * what it decides is proved in tests/unit/components/Updating.test.tsx and what
 * is asked here is only that the box asks it and shows what comes back.
 */
const taken = vi.fn<() => 'taken' | 'nothing-new'>(() => 'taken');

async function theBox(arrival: Arrival, value = 'A **bold** word') {
  vi.resetModules();
  vi.doMock('../../../src/updating', () => ({ takeTheNewVersion: taken }));
  vi.doMock('../../../src/description/RichDescription', async () => {
    if (arrival === 'never comes') throw new Error('offline');
    if (arrival === 'still coming') await new Promise(() => {});
    if (arrival === 'arrives broken') {
      return {
        default: () => {
          throw new Error('the editor threw while rendering');
        },
      };
    }
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

afterEach(() => {
  cleanup();
  taken.mockReset();
  taken.mockReturnValue('taken');
});

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

  /**
   * A chunk that never came is this build asking for a part of itself and being
   * told it is gone, which happens when a tab is open across a deploy: what the
   * decision is, and why it is offered rather than taken, is on
   * `takeTheNewVersion` in src/updating.ts and on the message here.
   */
  describe('a description whose formatting has gone can pick up the new version', () => {
    it('offers it when the editor never arrives', async () => {
      const { user } = await theBox('never comes');
      await screen.findByRole('alert');

      await user.click(screen.getByRole('button', { name: 'Get the new version' }));

      expect(taken).toHaveBeenCalledTimes(1);
    });

    it('says so instead when this is already the newest', async () => {
      taken.mockReturnValue('nothing-new');
      const { user } = await theBox('never comes');
      await screen.findByRole('alert');

      await user.click(screen.getByRole('button', { name: 'Get the new version' }));

      expect(screen.getByRole('alert')).toHaveTextContent('Cockpit is already the newest version.');
      expect(screen.queryByRole('button', { name: 'Get the new version' })).toBeNull();
    });

    // The same boundary catches both, and they are not the same thing: an
    // editor that arrived and threw is a bug, and no version fixes it.
    it('offers nothing when the editor arrived and threw', async () => {
      await theBox('arrives broken');

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent(/Formatting could not be loaded/),
      );
      expect(screen.queryByRole('button', { name: 'Get the new version' })).toBeNull();
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

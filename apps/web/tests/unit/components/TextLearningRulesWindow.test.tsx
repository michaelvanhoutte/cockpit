import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TEXT_LEARNING_GUIDANCE } from '@cockpit/shared';
import { TextLearningRulesWindow } from '../../../src/components/TextLearningRulesWindow';
import { useSendCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/loadFailure', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/loadFailure')>()),
  diagnose: () => Promise.resolve('offline' as const),
}));

/**
 * F1: what this screen draws, and nothing about what the server stores.
 * That a rule really is kept and read back correctly is proved a tier down
 * (apps/api/tests/integration/http/text-learning-rules.test.ts) - this is
 * only the window ("Show what Cockpit is told, and say how you want it
 * changed", issue 398). A rule no longer reaches the prompt at all ("Cap the
 * text-learning prompt to the last 30 days, and drop rules and pinned
 * examples as inputs", issue 451).
 */

/** Whatever the status query answers with. */
const held = vi.hoisted(() => ({
  status: {
    rules: null as string | null,
    rulesSetAt: null as string | null,
    proposedTotal: 0,
    correctedTotal: 0,
    pinnedExamples: [] as { id: string; note: string; title: string; description: string | null }[],
  },
}));

vi.mock('../../../src/api/queries', () => ({
  useSendCommand: vi.fn(),
  textLearningStatusQuery: {
    queryKey: ['textLearningStatus'],
    queryFn: () => Promise.resolve(held.status),
  },
}));

function showWindow() {
  const send = vi.fn().mockResolvedValue(undefined);
  vi.mocked(useSendCommand).mockReturnValue(send);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TextLearningRulesWindow open onClose={() => {}} />
    </QueryClientProvider>,
  );
  return { send };
}

describe('What Cockpit is told', () => {
  it("draws Cockpit's own guidance, in plain English", async () => {
    held.status = { ...held.status, rules: null, proposedTotal: 0, correctedTotal: 0 };

    showWindow();

    for (const line of TEXT_LEARNING_GUIDANCE) {
      expect(await screen.findByText(line)).toBeInTheDocument();
    }
  });

  it('offers no way to edit the guidance - only the rules box is a form control', async () => {
    held.status = { ...held.status, rules: null };

    showWindow();

    await screen.findByText(TEXT_LEARNING_GUIDANCE[0]!);
    // The only textbox on this window is the rules box - the guidance list
    // above it carries no input of its own.
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
  });

  describe('the rules box', () => {
    it('draws the rule an account wrote', async () => {
      held.status = { ...held.status, rules: 'Never end a title with a question mark.' };

      showWindow();

      const box = await screen.findByLabelText('Your rules');
      await waitFor(() => expect(box).toHaveValue('Never end a title with a question mark.'));
    });

    it('says none have been written, rather than being empty, when the box is empty', async () => {
      held.status = { ...held.status, rules: null };

      showWindow();

      const box = await screen.findByLabelText('Your rules');
      await waitFor(() => expect(box).toHaveValue(''));
    });

    it('refuses a rule over the cap, naming by how much, rather than sending it', async () => {
      held.status = { ...held.status, rules: null };
      const send = vi.fn().mockResolvedValue(undefined);
      vi.mocked(useSendCommand).mockReturnValue(send);
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <QueryClientProvider client={client}>
          <TextLearningRulesWindow open onClose={() => {}} />
        </QueryClientProvider>,
      );

      const box = await screen.findByLabelText('Your rules');
      // `fireEvent.change` rather than `userEvent.type`: simulating 2,001
      // individual keystrokes is what timed this case out.
      fireEvent.change(box, { target: { value: 'x'.repeat(2_001) } });

      expect(await screen.findByRole('alert')).toHaveTextContent('1 characters too many');
      expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
      expect(send).not.toHaveBeenCalled();
    });
  });

  describe('how it is doing', () => {
    it('says nothing has been captured yet, rather than drawing two zeroes', async () => {
      held.status = { ...held.status, proposedTotal: 0, correctedTotal: 0 };

      showWindow();

      expect(await screen.findByText('Nothing proposed and seen yet.')).toBeInTheDocument();
    });

    it('draws the ratio the prompt itself reads', async () => {
      held.status = { ...held.status, proposedTotal: 10, correctedTotal: 3 };

      showWindow();

      expect(
        await screen.findByText('3 of 10 proposed texts were corrected; the rest stood unchanged.'),
      ).toBeInTheDocument();
    });
  });

  /**
   * "Pin an example of how you want a note written" (issue 397): add, edit
   * and delete land on this same window. A pinned example no longer reaches
   * the prompt at all ("Cap the text-learning prompt to the last 30 days,
   * and drop rules and pinned examples as inputs", issue 451) - this is only
   * what the window draws and sends.
   */
  describe('pinned examples', () => {
    const EXAMPLE = {
      id: 'example-1',
      note: 'bel novy ivm afspraak',
      title: 'Novy bellen over de afspraak',
      description: 'Novy bellen in verband met de afspraak.',
    };

    it('says nothing has been pinned yet, rather than drawing an empty list', async () => {
      held.status = { ...held.status, pinnedExamples: [] };

      showWindow();

      expect(await screen.findByText('Nothing pinned yet.', { exact: false })).toBeInTheDocument();
    });

    it("draws each pinned example's title and note", async () => {
      held.status = { ...held.status, pinnedExamples: [EXAMPLE] };

      showWindow();

      expect(await screen.findByText(EXAMPLE.title)).toBeInTheDocument();
      expect(screen.getByText(EXAMPLE.note)).toBeInTheDocument();
    });

    it('sends what was typed on the add form, once Save is pressed', async () => {
      held.status = { ...held.status, pinnedExamples: [] };
      const user = userEvent.setup();
      const { send } = showWindow();

      await user.click(await screen.findByRole('button', { name: 'Add example' }));
      const dialog = within(await screen.findByRole('dialog'));
      await user.type(dialog.getByLabelText('The captured note this example is for'), EXAMPLE.note);
      await user.type(dialog.getByLabelText('The title you would have written for this note'), EXAMPLE.title);
      await user.click(dialog.getByRole('button', { name: 'Save' }));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'pin_text_example',
          payload: expect.objectContaining({ note: EXAMPLE.note, title: EXAMPLE.title }),
        }),
      );
    });

    it("edits a pinned example from its own row's menu", async () => {
      held.status = { ...held.status, pinnedExamples: [EXAMPLE] };
      const user = userEvent.setup();
      const { send } = showWindow();

      await user.click(await screen.findByRole('button', { name: `Actions for the example "${EXAMPLE.title}"` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Edit…' }));
      const dialog = within(await screen.findByRole('dialog'));
      const titleBox = dialog.getByLabelText('The title you would have written for this note');
      await user.clear(titleBox);
      await user.type(titleBox, 'Novy mailen over de afspraak');
      await user.click(dialog.getByRole('button', { name: 'Save' }));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'edit_pinned_example',
          payload: expect.objectContaining({ exampleId: EXAMPLE.id, title: 'Novy mailen over de afspraak' }),
        }),
      );
    });

    it("deletes a pinned example from its own row's menu, after the question is answered", async () => {
      held.status = { ...held.status, pinnedExamples: [EXAMPLE] };
      const user = userEvent.setup();
      const { send } = showWindow();

      await user.click(await screen.findByRole('button', { name: `Actions for the example "${EXAMPLE.title}"` }));
      await user.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      const dialog = within(await screen.findByRole('alertdialog'));
      await user.click(dialog.getByRole('button', { name: `Yes, delete the example "${EXAMPLE.title}"` }));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'delete_pinned_example',
          payload: expect.objectContaining({ exampleId: EXAMPLE.id }),
        }),
      );
    });

    /**
     * The window stays mounted between openings (`pages/Layout.tsx` only
     * toggles `open`) - the same reason the rules box resets its own draft on
     * reopen. A half-typed "Add example" draft has to be forgotten the same
     * way, otherwise reopening the window pops the same draft back open,
     * pre-filled, with nothing ever sent.
     *
     * **Closed by re-rendering with `open={false}`, not by pressing Done.**
     * The add-example dialog is its own modal `Dialog.Root`, on top of the
     * window's - its overlay blocks the window's own Done button while it is
     * open, the same way it would in a real browser. What can genuinely leave
     * `exampleForm` set while the window itself closes is `pages/Layout.tsx`
     * switching `managing` to something else - an external change to `open`,
     * exactly what `rerender` drives here.
     */
    it('forgets a half-typed add-example draft once the window is closed and reopened', async () => {
      held.status = { ...held.status, pinnedExamples: [] };
      const user = userEvent.setup();
      vi.mocked(useSendCommand).mockReturnValue(vi.fn().mockResolvedValue(undefined));
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const onClose = vi.fn();

      const { rerender } = render(
        <QueryClientProvider client={client}>
          <TextLearningRulesWindow open onClose={onClose} />
        </QueryClientProvider>,
      );

      await user.click(await screen.findByRole('button', { name: 'Add example' }));
      const dialog = within(await screen.findByRole('dialog'));
      await user.type(dialog.getByLabelText('The captured note this example is for'), 'an abandoned note');

      rerender(
        <QueryClientProvider client={client}>
          <TextLearningRulesWindow open={false} onClose={onClose} />
        </QueryClientProvider>,
      );
      rerender(
        <QueryClientProvider client={client}>
          <TextLearningRulesWindow open onClose={onClose} />
        </QueryClientProvider>,
      );

      expect(await screen.findByText('Nothing pinned yet.', { exact: false })).toBeInTheDocument();
      // The window itself is a dialog too, so this checks for the
      // add-example one specifically, by the name its abandoned draft would
      // have reopened with.
      expect(screen.queryByRole('dialog', { name: 'Add example' })).not.toBeInTheDocument();
    });
  });
});

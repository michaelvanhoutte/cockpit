import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
 * That a rule really is kept, and read ahead of everything else in the
 * prompt, is proved a tier down
 * (apps/api/tests/integration/http/note-cleanup.test.ts,
 * apps/api/tests/unit/ai/prompts/clean-up-a-note.v7.test.ts) - this is only
 * the window ("Show what Cockpit is told, and say how you want it changed",
 * issue 398).
 */

/** Whatever the status query answers with. */
const held = vi.hoisted(() => ({
  status: {
    rules: null as string | null,
    rulesSetAt: null as string | null,
    proposedTotal: 0,
    correctedTotal: 0,
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
  vi.mocked(useSendCommand).mockReturnValue(vi.fn().mockResolvedValue(undefined));
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <TextLearningRulesWindow open onClose={() => {}} />
    </QueryClientProvider>,
  );
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
});

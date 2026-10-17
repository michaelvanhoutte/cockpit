import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MAX_CLAUDE_LINK_LENGTH, type ClaudeProposal } from '@cockpit/shared';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SendToClaudeWindow from '../../../src/components/SendToClaudeWindow';

/**
 * F1: what the review window draws and what it does on Open. That the Run is
 * really recorded once, and refused for an Item already going, are the
 * server's rules (apps/api/tests/integration/http/claude-sends.test.ts); the
 * address and the prompt are pure (packages/shared/tests/unit/domain/
 * claude-send.test.ts); that a person gets from a row to a chip is the
 * browser walk in tests/e2e/agents.test.ts. The connected-apps list is the
 * one read the real window makes of its own backend, faked at the network
 * edge as ManageConnectedApps.test.tsx does.
 */
const held = vi.hoisted(() => ({
  apps: [] as unknown[],
  links: {} as Record<string, string>,
  sent: [] as unknown[],
  opened: [] as string[],
  sendFails: null as string | null,
}));

vi.mock('../../../src/api/client', () => ({
  api: {
    v1: {
      'connected-apps': {
        $get: () => Promise.resolve(new Response(JSON.stringify({ apps: held.apps }))),
      },
      'attachment-links': {
        $post: () => Promise.resolve(new Response(JSON.stringify({ links: held.links }))),
      },
    },
  },
  refusal: (what: string, status: number) => new Error(`${what} failed: ${status}`),
  CommandRefused: class CommandRefused extends Error {
    constructor(
      readonly status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('../../../src/api/queries', async () => {
  const { CommandRefused } = await import('../../../src/api/client');
  return {
    useSendCommand: () => async (args: unknown) => {
      if (held.sendFails) throw new CommandRefused(409, held.sendFails);
      held.sent.push(args);
      return { ok: true, applied: true };
    },
  };
});

vi.mock('../../../src/openClaude', () => ({
  openClaude: (link: string) => void held.opened.push(link),
}));

const ITEM = {
  id: '018f0000-0000-7000-8000-000000000001',
  title: 'Pay the invoice',
  description: 'Due on Friday.',
  claudeProposals: null as ClaudeProposal[] | null,
  source: 'internal',
  sender: null as string | null,
};
const PNG = { id: 'att-1', filename: 'receipt.png', contentType: 'image/png' };

function showWindow(attachments = [PNG], item: typeof ITEM = ITEM) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onClose = vi.fn();
  render(
    <QueryClientProvider client={client}>
      <SendToClaudeWindow
        item={item}
        workspaceId="ws-1"
        attachments={attachments}
        onClose={onClose}
        sourceNames={{ gmail: 'Gmail' }}
      />
    </QueryClientProvider>,
  );
  return { onClose };
}

/** The prompt once the file links are made. */
async function prompt() {
  const box = await screen.findByLabelText('Prompt');
  await waitFor(() => expect(box).not.toBeDisabled());
  return box as HTMLTextAreaElement;
}

beforeEach(() => {
  held.apps = [{ id: 'grant-claude', name: 'Claude', connectedAt: '2026-10-01T09:00:00.000Z', lastCapturedAt: null }];
  held.links = { 'att-1': 'https://cockpit.test/v1/attachment-links/abc' };
  held.sent = [];
  held.opened = [];
  held.sendFails = null;
  try {
    window.localStorage.clear();
  } catch {
    // A runner with no storage has nothing to clear.
  }
});

describe('Agents', () => {
  describe('the window warns when no app is connected under MCP', () => {
    it('says the row will not follow the work and where to connect, and still offers Open', async () => {
      held.apps = [];

      showWindow();

      expect(await screen.findByRole('status')).toHaveTextContent(/No app is connected under Settings › MCP/);
      expect(await screen.findByRole('button', { name: /Open in Cowork/ })).toBeEnabled();
    });

    it('says nothing where an app is connected', async () => {
      showWindow();

      await prompt();
      await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument());
    });
  });

  describe('the window sends what it shows, and only after the Run is recorded', () => {
    it('starts on the plain prompt, with a link to each file and the closing naming the run', async () => {
      showWindow();

      const text = (await prompt()).value;

      expect(text).toMatch(/^Pay the invoice\n\nDue on Friday\./);
      expect(text).toContain('- receipt.png: https://cockpit.test/v1/attachment-links/abc');
      expect(text).toMatch(/sends, posts, buys or confirms/);
    });

    it('records the Run for the chosen destination and folder, then opens Claude with the edited prompt', async () => {
      const user = userEvent.setup();
      const { onClose } = showWindow();
      const box = await prompt();
      await user.clear(box);
      await user.type(box, 'Pay it & say "thanks"');
      await user.click(screen.getByRole('radio', { name: 'Code' }));
      await user.type(screen.getByLabelText('Folder'), 'C:\\GitHub\\Cockpit');

      await user.click(screen.getByRole('button', { name: /Open in Code/ }));

      await waitFor(() => expect(held.opened).toHaveLength(1));
      expect(held.sent).toEqual([
        {
          name: 'send_item_to_claude',
          payload: expect.objectContaining({
            workspaceId: 'ws-1',
            itemId: ITEM.id,
            destination: 'code',
            folder: 'C:\\GitHub\\Cockpit',
          }),
        },
      ]);
      const url = new URL(held.opened[0]!);
      expect(url.host).toBe('code');
      expect(url.searchParams.get('q')).toBe('Pay it & say "thanks"');
      expect(url.searchParams.get('folder')).toBe('C:\\GitHub\\Cockpit');
      expect(onClose).toHaveBeenCalled();
    });

    it('opens nothing, and says why, when the server refuses the send', async () => {
      held.sendFails = 'Claude is already on this item.';
      const user = userEvent.setup();
      const { onClose } = showWindow();
      await prompt();

      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));

      expect(await screen.findByRole('alert')).toHaveTextContent('Claude is already on this item.');
      expect(held.opened).toEqual([]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it('offers no Open for a prompt too long for the address Claude is opened at, and says so', async () => {
      const user = userEvent.setup();
      showWindow();
      const box = await prompt();
      fireEvent.change(box, { target: { value: 'x'.repeat(MAX_CLAUDE_LINK_LENGTH) } });

      expect(await screen.findByRole('alert')).toHaveTextContent(/too long to open in Claude/);
      expect(screen.getByRole('button', { name: /Open in Cowork/ })).toBeDisabled();
      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));
      expect(held.sent).toEqual([]);
      expect(held.opened).toEqual([]);
    });

    it('offers the folder last sent to the next time it opens', async () => {
      const user = userEvent.setup();
      showWindow();
      await prompt();
      await user.type(screen.getByLabelText('Folder'), '/home/me/app');
      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));
      await waitFor(() => expect(held.opened).toHaveLength(1));

      showWindow();

      expect((await screen.findAllByLabelText('Folder')).at(-1)).toHaveValue('/home/me/app');
    });
  });

  describe('the window opens on the proposal, and on the plain prompt where there is none', () => {
    const FIX: ClaudeProposal = {
      destination: 'code',
      label: 'Fix the rounding',
      folder: 'C:\\GitHub\\Billing',
      prompt: 'In the Billing repository, fix the rounding on invoice totals.',
    };
    const REPLY: ClaudeProposal = {
      destination: 'cowork',
      label: 'Draft the reply',
      folder: '',
      prompt: 'Draft a reply to the supplier saying it is paid.',
    };

    it('sets the switch, the folder and the prompt to a proposal for Code in a folder', async () => {
      showWindow([PNG], { ...ITEM, claudeProposals: [FIX] });

      const text = (await prompt()).value;

      expect(screen.getByRole('radio', { name: 'Code' })).toHaveAttribute('aria-checked', 'true');
      expect(screen.getByLabelText('Folder')).toHaveValue('C:\\GitHub\\Billing');
      expect(text).toMatch(/^In the Billing repository, fix the rounding on invoice totals\.\n\n/);
      expect(text).not.toContain('Due on Friday.');
    });

    it('offers both of two proposals, the first chosen, and takes the other when it is picked', async () => {
      const user = userEvent.setup();
      showWindow([PNG], { ...ITEM, claudeProposals: [FIX, REPLY] });
      await prompt();
      const offered = screen.getByRole('radiogroup', { name: 'Proposed' });

      expect(within(offered).getByRole('radio', { name: /Fix the rounding/ })).toHaveAttribute('aria-checked', 'true');
      await user.click(within(offered).getByRole('radio', { name: /Draft the reply/ }));

      expect(screen.getByRole('radio', { name: 'Cowork' })).toHaveAttribute('aria-checked', 'true');
      expect((await prompt()).value).toMatch(/^Draft a reply to the supplier saying it is paid\./);
    });

    it('leaves the folder empty where the proposal names none, and still offers the folder last sent to on an item with no proposal', async () => {
      window.localStorage.setItem('cockpit.claudeFolder', 'C:\\GitHub\\Cockpit');
      const user = userEvent.setup();

      showWindow([PNG], { ...ITEM, claudeProposals: [REPLY] });
      await prompt();
      expect(screen.getByLabelText('Folder')).toHaveValue('');
      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));
      await waitFor(() => expect(held.opened).toHaveLength(1));

      showWindow();

      expect((await screen.findAllByLabelText('Folder')).at(-1)).toHaveValue('C:\\GitHub\\Cockpit');
    });

    it('says when nothing is proposed, with the plain prompt still there to send', async () => {
      showWindow([PNG], { ...ITEM, claudeProposals: [{ destination: 'nothing', why: 'A quote to keep.' }] });

      expect((await prompt()).value).toMatch(/^Pay the invoice\n\nDue on Friday\./);
      expect(screen.getByText('Cockpit proposes nothing to do. You can still send it as it is.')).toBeInTheDocument();
      // The model's reason is quoted beside it, not said as Cockpit's own.
      expect(screen.getByText('A quote to keep.').tagName).toBe('Q');
      expect(screen.getByRole('button', { name: /Open in Cowork/ })).toBeEnabled();
    });

    it('names who sent an item someone else sent, beside the proposal and at the head of the prompt', async () => {
      showWindow([PNG], { ...ITEM, source: 'gmail', sender: 'Els Maes', claudeProposals: [REPLY] });

      const text = (await prompt()).value;

      expect(screen.getByText(/Cockpit proposes this from a Gmail message by Els Maes\./)).toBeInTheDocument();
      expect(text).toMatch(/^Prepared by Cockpit from a Gmail message by Els Maes - .*not mine:\n\nDraft a reply to the supplier/);
    });

    it('starts the proposed prompt on the task itself for an item the person captured', async () => {
      showWindow([PNG], { ...ITEM, claudeProposals: [REPLY] });

      expect((await prompt()).value).toMatch(/^Draft a reply to the supplier/);
      expect(screen.queryByText(/Cockpit proposes this from/)).not.toBeInTheDocument();
    });

    it('starts on the plain prompt where nothing has been proposed yet', async () => {
      showWindow([PNG], { ...ITEM, claudeProposals: null });

      expect((await prompt()).value).toMatch(/^Pay the invoice\n\nDue on Friday\./);
      expect(screen.queryByRole('radiogroup', { name: 'Proposed' })).not.toBeInTheDocument();
      expect(screen.getByRole('radio', { name: 'Cowork' })).toHaveAttribute('aria-checked', 'true');
    });
  });
});
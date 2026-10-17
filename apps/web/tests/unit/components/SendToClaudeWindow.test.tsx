import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MAX_CLAUDE_LINK_LENGTH, type ClaudeProposal } from '@cockpit/shared';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import SendToClaudeWindow from '../../../src/components/SendToClaudeWindow';
import { SettingsOpener } from '../../../src/settingsOpener';

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
  /** The runs an offer to remember was asked for, and what the server answers to it. */
  offersAsked: [] as string[],
  offer: null as (() => Promise<Response>) | null,
  /** The remembered sentences the account holds, as Settings lists them, and how often they were read. */
  sentences: [] as unknown[],
  sentencesRead: 0,
  /** The sentences *change* was pressed on. */
  settingsOpened: [] as unknown[][],
}));

vi.mock('../../../src/api/client', () => ({
  api: {
    v1: {
      'connected-apps': {
        $get: () => Promise.resolve(new Response(JSON.stringify({ apps: held.apps }))),
      },
      'claude-sends': {
        ':runId': {
          'remember-offer': {
            $post: (args: { param: { runId: string } }) => {
              held.offersAsked.push(args.param.runId);
              return held.offer ? held.offer() : Promise.resolve(new Response(JSON.stringify({ offer: null })));
            },
          },
        },
      },
      'remembered-sentences': {
        $get: () => {
          held.sentencesRead += 1;
          return Promise.resolve(new Response(JSON.stringify({ sentences: held.sentences })));
        },
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
      <SettingsOpener.Provider value={(...args) => void held.settingsOpened.push(args)}>
        <SendToClaudeWindow
          item={item}
          workspaceId="ws-1"
          attachments={attachments}
          onClose={onClose}
          sourceNames={{ gmail: 'Gmail' }}
        />
      </SettingsOpener.Provider>
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
  held.offersAsked = [];
  held.offer = null;
  held.sentences = [];
  held.sentencesRead = 0;
  held.settingsOpened = [];
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

      expect(screen.getByText(/Cockpit proposes this from a Gmail message by “Els Maes”\./)).toBeInTheDocument();
      expect(text).toMatch(/^Prepared by Cockpit from a Gmail message by “Els Maes” - .*not mine:\n\nDraft a reply to the supplier/);
    });

    it.each([
      { situation: 'nothing to do proposed', claudeProposals: [{ destination: 'nothing' as const, why: 'Looks like a phishing mail.' }], folder: '' },
      { situation: 'nothing proposed yet', claudeProposals: null, folder: 'C:\\GitHub\\Cockpit' },
    ])('names who sent an item someone else sent at the head of its own words, with $situation', async ({ claudeProposals, folder }) => {
      window.localStorage.setItem('cockpit.claudeFolder', 'C:\\GitHub\\Cockpit');

      showWindow([PNG], { ...ITEM, source: 'gmail', sender: 'Els Maes', claudeProposals });

      expect((await prompt()).value).toMatch(/^Prepared by Cockpit from a Gmail message by “Els Maes” - .*not mine:\n\nPay the invoice\n\nDue on Friday\./);
      expect(screen.getByLabelText('Folder')).toHaveValue(folder);
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
describe('Agents', () => {
  describe('after an edit the window offers one sentence to remember, and keeps it only when told to', () => {
    const REPLY: ClaudeProposal = {
      destination: 'cowork',
      label: 'Draft the reply',
      folder: '',
      prompt: 'Draft a reply to the supplier saying it is paid.',
    };
    const OFFER = {
      sentence: 'Mails to the supplier: Dutch, short, signed Michael.',
      action: 'reply to a mail',
      workspaceId: null as string | null,
      workspaceName: null as string | null,
      sourceKind: 'gmail',
    };
    const offerArrives = (offer: typeof OFFER | null) => {
      held.offer = () => Promise.resolve(new Response(JSON.stringify({ offer })));
    };

    /** The window opened on a proposal, edited, and Open pressed. */
    async function openedAfterEditing() {
      const user = userEvent.setup();
      const { onClose } = showWindow([], { ...ITEM, claudeProposals: [REPLY] });
      const box = await prompt();
      await user.clear(box);
      await user.type(box, 'Schrijf kort een antwoord.');
      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));
      return { user, onClose };
    }

    it('asks nothing, and closes as it always did, where the proposal was sent as it was', async () => {
      const user = userEvent.setup();
      const { onClose } = showWindow([], { ...ITEM, claudeProposals: [REPLY] });
      await prompt();

      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(held.offersAsked).toEqual([]);
    });

    it('asks nothing where nothing was proposed to edit', async () => {
      const user = userEvent.setup();
      const { onClose } = showWindow([], { ...ITEM, claudeProposals: null });
      const box = await prompt();
      await user.clear(box);
      await user.type(box, 'Pay it.');

      await user.click(screen.getByRole('button', { name: /Open in Cowork/ }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(held.offersAsked).toEqual([]);
    });

    it('opens Claude first, then shows the sentence when the answer arrives', async () => {
      let answer: (response: Response) => void = () => {};
      held.offer = () => new Promise<Response>((resolve) => (answer = resolve));

      const { onClose } = await openedAfterEditing();

      await waitFor(() => expect(held.opened).toHaveLength(1));
      expect(await screen.findByText(/Looking at what you changed/)).toBeInTheDocument();
      expect(screen.queryByLabelText('Remember this?')).not.toBeInTheDocument();
      expect(onClose).not.toHaveBeenCalled();

      answer(new Response(JSON.stringify({ offer: OFFER })));

      expect(await screen.findByLabelText('Remember this?')).toHaveValue(OFFER.sentence);
      expect(held.sent).toHaveLength(1);
    });

    it('keeps the sentence as it is on Remember, for every workspace', async () => {
      offerArrives(OFFER);
      const { user, onClose } = await openedAfterEditing();
      await screen.findByLabelText('Remember this?');

      await user.click(screen.getByRole('button', { name: 'Remember' }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(held.sent[1]).toEqual({
        name: 'remember_sentence',
        payload: expect.objectContaining({
          workspaceId: 'account',
          sentence: OFFER.sentence,
          action: 'reply to a mail',
          sourceKind: 'gmail',
        }),
      });
    });

    it('keeps the sentence as reworded, and for the workspace it names', async () => {
      offerArrives({ ...OFFER, workspaceId: '018f0000-0000-7000-8000-0000000000aa', workspaceName: 'Northwind' });
      const { user, onClose } = await openedAfterEditing();
      const box = await screen.findByLabelText('Remember this?');
      expect(screen.getByText(/in Northwind only/)).toBeInTheDocument();
      await user.clear(box);
      await user.type(box, 'Supplier mails: Dutch.');

      await user.click(screen.getByRole('button', { name: 'Remember' }));

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(held.sent[1]).toEqual({
        name: 'remember_sentence',
        payload: expect.objectContaining({ workspaceId: '018f0000-0000-7000-8000-0000000000aa', sentence: 'Supplier mails: Dutch.' }),
      });
    });

    it('keeps nothing on Just this once', async () => {
      offerArrives(OFFER);
      const { user, onClose } = await openedAfterEditing();
      await screen.findByLabelText('Remember this?');

      await user.click(screen.getByRole('button', { name: 'Just this once' }));

      expect(onClose).toHaveBeenCalled();
      expect(held.sent).toHaveLength(1);
    });

    it('keeps nothing where the window is closed with the offer showing', async () => {
      offerArrives(OFFER);
      const { user, onClose } = await openedAfterEditing();
      await screen.findByLabelText('Remember this?');

      await user.keyboard('{Escape}');

      expect(onClose).toHaveBeenCalled();
      expect(held.sent).toHaveLength(1);
    });

    it.each([
      { situation: 'the server finds nothing worth remembering', offer: () => Promise.resolve(new Response(JSON.stringify({ offer: null }))) },
      { situation: 'the request fails', offer: () => Promise.reject(new Error('offline')) },
      { situation: 'the server answers with an error', offer: () => Promise.resolve(new Response('no', { status: 500 })) },
    ])('closes with nothing asked of the person, and Claude already opened, where $situation', async ({ offer }) => {
      held.offer = offer;

      const { onClose } = await openedAfterEditing();

      await waitFor(() => expect(onClose).toHaveBeenCalled());
      expect(held.opened).toHaveLength(1);
      expect(held.sent).toHaveLength(1);
      expect(screen.queryByLabelText('Remember this?')).not.toBeInTheDocument();
    });
  });
});

describe('Agents', () => {
  describe('the window names the sentences that shaped this proposal, each with a way to change it', () => {
    const SENTENCE = (id: string, sentence: string) => ({
      id,
      sentence,
      action: 'reply to a mail',
      sourceKind: 'gmail',
      workspaceId: null,
      workspaceName: null,
      useCount: 1,
      lastUsedAt: '2026-10-17T10:00:00.000Z',
      createdAt: '2026-10-16T10:00:00.000Z',
    });
    const FIRST = '018f0000-0000-7000-8000-0000000000a1';
    const SECOND = '018f0000-0000-7000-8000-0000000000a2';
    const GONE = '018f0000-0000-7000-8000-0000000000a3';
    const REPLY: ClaudeProposal = {
      destination: 'cowork',
      label: 'Draft the reply',
      folder: '',
      prompt: 'Draft a reply to the supplier saying it is paid.',
      learnedFrom: [FIRST, SECOND, GONE],
    };

    it('names each sentence that is still remembered, as it now reads, and none that was deleted', async () => {
      held.sentences = [SENTENCE(FIRST, 'Mails to the supplier: Dutch.'), SENTENCE(SECOND, 'Sign as Michael.')];

      showWindow([], { ...ITEM, claudeProposals: [REPLY] });

      const learned = (await screen.findByText('Learned from you')).parentElement!;
      expect(within(learned).getByText('Mails to the supplier: Dutch.')).toBeInTheDocument();
      expect(within(learned).getByText('Sign as Michael.')).toBeInTheDocument();
      expect(within(learned).getAllByRole('listitem')).toHaveLength(2);
    });

    it('opens Settings on the sentence when change is pressed, leaving the window where it was', async () => {
      held.sentences = [SENTENCE(FIRST, 'Mails to the supplier: Dutch.')];
      const user = userEvent.setup();
      const { onClose } = showWindow([], { ...ITEM, claudeProposals: [{ ...REPLY, learnedFrom: [FIRST] }] });

      await user.click(await screen.findByRole('button', { name: 'Change \u201cMails to the supplier: Dutch.\u201d' }));

      expect(held.settingsOpened).toEqual([[FIRST]]);
      expect(onClose).not.toHaveBeenCalled();
    });

    it.each([
      { situation: 'the proposal learned from nothing', claudeProposals: [{ ...REPLY, learnedFrom: undefined }], reads: false },
      { situation: 'every sentence it learned from has been deleted', claudeProposals: [REPLY], reads: true },
      { situation: 'nothing has been proposed yet', claudeProposals: null, reads: false },
    ])('has no line where $situation', async ({ claudeProposals, reads }) => {
      showWindow([], { ...ITEM, claudeProposals });

      await prompt();
      // Where the sentences are read, the answer has come back before the absence means anything.
      if (reads) await waitFor(() => expect(held.sentencesRead).toBeGreaterThan(0));
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(screen.queryByText('Learned from you')).not.toBeInTheDocument();
    });
  });
});

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommandResult, SourceAccount } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, checkConnectionNow, fetchSnapshot, sendCommand } from '../../../src/api/client';
import ManageConnections from '../../../src/components/ManageConnections';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A connection change as each control makes it, with the server holding the
 * answer - the frontend-with-its-own-backend level (F2), run in this runner as
 * `WorkspacesAtOnce.test.tsx` is. The window, its queries and the tab's queue
 * are the app's own and only the network is replaced: a server that answers when
 * the test says, keeps the connections it is told to, and refuses what the real
 * one refuses. What each change draws is tests/unit/connectionsDrawnAhead.test.ts
 * and when it stops being drawn is tests/unit/changeQueue.test.ts; what is asked
 * here is that every control is wired to them.
 */

const held = vi.hoisted(() => ({
  /** What the list of connections answers with, and how many times it has been read. */
  accounts: [] as unknown[],
  reads: 0,
  /** While set, a read of the list looks at what the server holds and is then held until it is released. */
  hold: false,
  releases: [] as (() => void)[],
  registry: [] as unknown[],
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  api: {
    v1: {
      connectors: { $get: () => Promise.resolve(Response.json({ connectors: held.registry })) },
      workspaces: {
        ':workspaceId': {
          connections: {
            $get: async () => {
              held.reads += 1;
              const seen = structuredClone(held.accounts);
              if (held.hold) await new Promise<void>((resolve) => held.releases.push(resolve));
              return Response.json({ sourceAccounts: seen });
            },
          },
        },
      },
    },
  },
  fetchSnapshot: vi.fn(),
  sendCommand: vi.fn(),
  checkConnectionNow: vi.fn(),
}));

const MAIL_CARD = {
  id: 'outlook',
  displayName: 'Outlook',
  cardText: 'Mail arrives as items.',
  asksFirst: true,
  choice: {
    question: 'Bring in',
    options: [
      { value: 'flag', label: 'Flagged mail' },
      { value: 'all', label: 'Every message' },
    ],
  },
  names: { noun: 'category', example: 'a message with the category' },
};
const TEAMS_CARD = { id: 'teams', displayName: 'Microsoft Teams', cardText: 'Chats arrive as items.', asksFirst: false };

const MAIL: SourceAccount = {
  id: 'account-mail',
  connectorId: 'outlook',
  displayName: 'Ada’s mail',
  connectedAt: '2026-09-18T09:00:00.000Z',
  lastTestedAt: '2026-10-16T09:00:00.000Z',
  failingBecause: null,
  follows: 'flag',
  followsLabel: 'Flagged mail',
  filesByName: false,
  pulled: true,
  keepsHistory: true,
};
const TEAMS: SourceAccount = {
  id: 'account-teams',
  connectorId: 'teams',
  displayName: 'Ada Lovelace',
  connectedAt: '2026-09-18T09:05:00.000Z',
  lastTestedAt: null,
  failingBecause: null,
  filesByName: false,
};

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** What the server does with a connection change it accepts, and the refusal the real one gives. */
function keep(name: string, payload: Record<string, unknown>) {
  const accounts = held.accounts as SourceAccount[];
  const row = accounts.find((one) => one.id === payload.sourceAccountId);
  if (!row) throw new CommandRefused(404, 'that connection is not there');
  if (name === 'disconnect_source_account') held.accounts = accounts.filter((one) => one !== row);
  if (name === 'set_connection_choice') {
    const label = MAIL_CARD.choice.options.find((option) => option.value === payload.choice)!.label;
    held.accounts = accounts.map((one) => (one === row ? { ...one, follows: payload.choice as string, followsLabel: label } : one));
  }
  if (name === 'set_connection_files_by_name') {
    held.accounts = accounts.map((one) => (one === row ? { ...one, filesByName: payload.filesByName as boolean } : one));
  }
}

let client: QueryClient;

async function show(accounts: SourceAccount[]) {
  held.accounts = [...accounts];
  held.reads = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>
        <ManageConnections workspaceId="ws-work" workspaceName="Work" open onClose={() => {}} />
      </UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  await screen.findByText(accounts[0]!.displayName);
  return userEvent.setup();
}

const waitingFor = () => waiting.map((request) => request.name);
const cards = () => screen.queryAllByRole('listitem').map((card) => within(card).getByText(/^(Ada’s mail|Ada Lovelace)$/).textContent);

/** Lets what the app does between an answer and the next request, and the read behind it, happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => waiting.shift()!.answer());
  await settle();
}

async function chooseOnCard(user: ReturnType<typeof userEvent.setup>, name: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function disconnect(user: ReturnType<typeof userEvent.setup>, name: string) {
  await chooseOnCard(user, name, 'Disconnect');
  await user.click(await screen.findByRole('button', { name: `Yes, disconnect ${name}` }));
}

async function openTheForm(user: ReturnType<typeof userEvent.setup>, name: string) {
  await chooseOnCard(user, name, 'Change…');
  return screen.findByRole('dialog', { name: `Change ${name}` });
}

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  waiting = [];
  held.hold = false;
  held.releases = [];
  held.registry = [MAIL_CARD, TEAMS_CARD];
  vi.mocked(fetchSnapshot).mockResolvedValue({ sourceNames: { outlook: 'Outlook', teams: 'Microsoft Teams' } } as never);
  vi.mocked(checkConnectionNow).mockReset();
  vi.mocked(sendCommand).mockImplementation(
    (name, payload) =>
      new Promise<CommandResult>((resolve, reject) => {
        waiting.push({
          name,
          payload: payload as Record<string, unknown>,
          answer: () => {
            try {
              keep(name, payload as Record<string, unknown>);
              resolve({ ok: true, applied: true });
            } catch (error) {
              reject(error);
            }
          },
          refuse: (error) => reject(error),
        });
      }),
  );
});

afterEach(async () => {
  cleanup();
  resetStanding();
  for (let round = 0; round < 6 && changes.unanswered() > 0; round += 1) {
    await act(async () => waiting.splice(0).forEach((request) => request.answer()));
    await settle();
  }
  changes.forgetAnswered();
});

describe('Connector management', () => {
  describe('a connection change shows the moment it is made, with the server still holding the answer', () => {
    it('takes the card away and closes the question when a connection is disconnected', async () => {
      const user = await show([MAIL, TEAMS]);

      await disconnect(user, 'Ada Lovelace');

      expect(cards()).toEqual(['Ada’s mail']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(screen.getByText(/^1$/)).toBeVisible();
      expect(waitingFor()).toEqual(['disconnect_source_account']);
    });

    it('names the new choice on the card and closes the form when the choice is changed', async () => {
      const user = await show([MAIL]);

      const changing = await openTheForm(user, 'Ada’s mail');
      await user.click(within(changing).getByRole('radio', { name: 'Every message' }));
      await user.click(within(changing).getByRole('button', { name: 'Save' }));

      expect(screen.getByText('Every message')).toBeVisible();
      expect(screen.queryByText('Flagged mail')).toBeNull();
      expect(screen.queryByRole('dialog', { name: 'Change Ada’s mail' })).toBeNull();
      expect(waitingFor()).toEqual(['set_connection_choice']);
    });

    it('shows the choice and files by name together, with the form closed, when one form changes both', async () => {
      const user = await show([MAIL]);

      const changing = await openTheForm(user, 'Ada’s mail');
      await user.click(within(changing).getByRole('radio', { name: 'Every message' }));
      await user.click(within(changing).getByRole('checkbox', { name: /^File it on the panel named after its category$/ }));
      await user.click(within(changing).getByRole('button', { name: 'Save' }));

      expect(screen.getByText('Every message')).toBeVisible();
      expect(screen.getByText('Files by category')).toBeVisible();
      expect(screen.queryByRole('dialog', { name: 'Change Ada’s mail' })).toBeNull();
      expect(waitingFor()).toEqual(['set_connection_choice']);
    });

    it('says Checking at the click on Check now, before the request is answered', async () => {
      vi.mocked(checkConnectionNow).mockReturnValue(new Promise(() => {}));
      const user = await show([MAIL]);

      await user.click(screen.getByRole('button', { name: 'Check Ada’s mail now' }));

      expect(screen.getByRole('status')).toHaveTextContent('Checking Ada’s mail now.');
      expect(checkConnectionNow).toHaveBeenCalledWith('ws-work', 'account-mail');
    });

    it('takes the Checking note back and says so when the request does not reach the server', async () => {
      vi.mocked(checkConnectionNow).mockRejectedValue(new TypeError('network'));
      const user = await show([MAIL]);

      await user.click(screen.getByRole('button', { name: 'Check Ada’s mail now' }));

      expect(await screen.findByRole('alert')).toHaveTextContent('That did not reach the server. Try again.');
      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('a connection change stays on the screen until the list is read after its answer', () => {
    it('keeps Check now’s note when the list is read meanwhile', async () => {
      vi.mocked(checkConnectionNow).mockReturnValue(new Promise(() => {}));
      const user = await show([MAIL]);
      await user.click(screen.getByRole('button', { name: 'Check Ada’s mail now' }));

      await act(async () => void (await client.invalidateQueries({ queryKey: ['sourceAccounts', 'ws-work'] })));
      await settle();

      expect(screen.getByRole('status')).toHaveTextContent('Checking Ada’s mail now.');
    });

    it('keeps the card gone under a read of the list begun before the answer, and shows the server’s list after one begun later', async () => {
      const user = await show([MAIL, TEAMS]);
      await disconnect(user, 'Ada Lovelace');

      // A read begins now and is held: it saw the list as the server held it before the answer.
      held.hold = true;
      void client.invalidateQueries({ queryKey: ['sourceAccounts', 'ws-work'] });
      await waitFor(() => expect(held.releases).toHaveLength(1));
      await answerNext();
      held.hold = false;
      await act(async () => held.releases.splice(0).forEach((release) => release()));
      await settle();
      expect(cards()).toEqual(['Ada’s mail']);

      // Another device connects it again once the answer has been read: that is the server's now.
      held.accounts = [MAIL, TEAMS];
      await act(async () => void (await client.invalidateQueries({ queryKey: ['sourceAccounts', 'ws-work'] })));

      await waitFor(() => expect(cards()).toEqual(['Ada’s mail', 'Ada Lovelace']));
    });

    it('reads the list once after the answers when the choice and files by name are changed together', async () => {
      const user = await show([MAIL]);
      const changing = await openTheForm(user, 'Ada’s mail');
      await user.click(within(changing).getByRole('radio', { name: 'Every message' }));
      await user.click(within(changing).getByRole('checkbox', { name: /^File it on the panel named after its category$/ }));
      await user.click(within(changing).getByRole('button', { name: 'Save' }));
      const before = held.reads;

      await answerNext();
      await waitFor(() => expect(waitingFor()).toEqual(['set_connection_files_by_name']));
      expect(held.reads).toBe(before);
      await answerNext();

      await waitFor(() => expect(held.reads).toBe(before + 1));
      await settle();
      expect(held.reads).toBe(before + 1);
      expect(screen.getByText('Every message')).toBeVisible();
      expect(screen.getByText('Files by category')).toBeVisible();
    });
  });

  describe('a connection change the server refuses is put back, and says why', () => {
    it('brings the card back with the server’s words in the undo bar when a disconnect is refused', async () => {
      const user = await show([MAIL, TEAMS]);
      await disconnect(user, 'Ada Lovelace');
      expect(cards()).toEqual(['Ada’s mail']);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That connection is in use.')));
      await settle();

      expect(cards()).toEqual(['Ada’s mail', 'Ada Lovelace']);
      expect(await screen.findByRole('status', { hidden: true })).toHaveTextContent('“Ada Lovelace” was not disconnected. That connection is in use.');
    });

    it('brings the old choice back with the server’s words in the undo bar when a choice is refused', async () => {
      const user = await show([MAIL]);
      const changing = await openTheForm(user, 'Ada’s mail');
      await user.click(within(changing).getByRole('radio', { name: 'Every message' }));
      await user.click(within(changing).getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Every message')).toBeVisible();

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'that is not a choice this connection offers')));
      await settle();

      expect(screen.getByText('Flagged mail')).toBeVisible();
      expect(await screen.findByRole('status', { hidden: true })).toHaveTextContent('“Ada’s mail” was not changed. that is not a choice this connection offers');
    });
  });
});

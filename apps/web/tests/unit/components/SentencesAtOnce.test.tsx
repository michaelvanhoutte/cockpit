import 'fake-indexeddb/auto';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import * as Dialog from '@radix-ui/react-dialog';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { CommandResult, RememberedSentenceView } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, sendCommand } from '../../../src/api/client';
import ManageRememberedSentences from '../../../src/components/ManageRememberedSentences';
import { RememberASentence } from '../../../src/components/RememberASentence';
import { resetStanding } from '../../../src/offline';
import { UndoWhatJustHappened } from '../../../src/undo';

/**
 * A sentence change as each control makes it, with the server holding the
 * answer - the frontend-with-its-own-backend level (F2), run in this runner as
 * `ConnectionsAtOnce.test.tsx` is. The windows, their queries and the tab's
 * queue are the app's own and only the network is replaced: a server that
 * answers when the test says, keeps the sentences it is told to, and refuses what
 * the real one refuses. What each change draws is
 * tests/unit/rememberedSentencesDrawnAhead.test.ts and when it stops being drawn
 * is tests/unit/changeQueue.test.ts; what is asked here is that every control is
 * wired to them.
 */

const held = vi.hoisted(() => ({
  /** What the list of sentences answers with, and how many times it has been read. */
  sentences: [] as unknown[],
  reads: 0,
  /** While set, a read of the list looks at what the server holds and is then held until it is released. */
  hold: false,
  releases: [] as (() => void)[],
  /** What the offer to remember answers with. */
  offer: null as unknown,
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  api: {
    v1: {
      'remembered-sentences': {
        $get: async () => {
          held.reads += 1;
          const seen = structuredClone(held.sentences);
          if (held.hold) await new Promise<void>((resolve) => held.releases.push(resolve));
          return Response.json({ sentences: seen });
        },
      },
      'claude-sends': {
        ':runId': { 'remember-offer': { $post: () => Promise.resolve(Response.json({ offer: held.offer })) } },
      },
    },
  },
  sendCommand: vi.fn(),
}));

const A = '018f0000-0000-7000-8000-0000000000a1';
const B = '018f0000-0000-7000-8000-0000000000a2';

const SENTENCE = (over: Partial<RememberedSentenceView> & { id: string }): RememberedSentenceView => ({
  sentence: `Sentence ${over.id}`,
  action: 'reply to a mail',
  sourceKind: 'gmail',
  workspaceId: null,
  workspaceName: null,
  useCount: 0,
  lastUsedAt: null,
  createdAt: '2026-10-16T10:00:00.000Z',
  ...over,
});
const SIGN = SENTENCE({ id: A, sentence: 'Sign as Michael.' });
const DUTCH = SENTENCE({ id: B, sentence: 'Mails to the supplier: Dutch.' });
const OFFER = { sentence: 'Never promise a date.', action: 'reply to a mail', workspaceId: null, workspaceName: null, sourceKind: 'gmail' };

/** Every change the server has been sent and not yet answered, oldest first. */
let waiting: { name: string; payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** What the server does with a sentence change it accepts, and the refusal the real one gives. */
function keep(name: string, payload: Record<string, unknown>) {
  const rows = held.sentences as RememberedSentenceView[];
  if (name === 'remember_sentence') {
    held.sentences = [
      SENTENCE({ id: payload.sentenceId as string, sentence: payload.sentence as string, action: payload.action as string }),
      ...rows,
    ];
    return;
  }
  if (name === 'edit_remembered_sentence') {
    if (!rows.some((one) => one.id === payload.sentenceId)) throw new CommandRefused(404, 'that sentence is not there');
    held.sentences = rows.map((one) => (one.id === payload.sentenceId ? { ...one, sentence: payload.sentence as string } : one));
    return;
  }
  held.sentences = rows.filter((one) => one.id !== payload.sentenceId);
}

let client: QueryClient;

/** The Remember offer, the way the review window shows it, and then Settings' list opened once it has closed. */
function OfferThenList() {
  const [offered, setOffered] = useState(true);
  if (!offered) return <ManageRememberedSentences />;
  return (
    <Dialog.Root open>
      <Dialog.Content aria-describedby={undefined}>
        <Dialog.Title>Open in Claude</Dialog.Title>
        <RememberASentence runId="run-1" destinationName="Claude Code" onClose={() => setOffered(false)} />
      </Dialog.Content>
    </Dialog.Root>
  );
}

async function show(sentences: RememberedSentenceView[], withOffer = false) {
  held.sentences = [...sentences];
  held.reads = 0;
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <UndoWhatJustHappened>{withOffer ? <OfferThenList /> : <ManageRememberedSentences />}</UndoWhatJustHappened>
    </QueryClientProvider>,
  );
  if (sentences[0] && !withOffer) await screen.findByText(sentences[0].sentence);
  return userEvent.setup();
}

const waitingFor = () => waiting.map((request) => request.name);
const listed = () => screen.queryAllByRole('listitem').map((row) => row.querySelector('p')?.textContent);

/** Lets what the app does between an answer and the next request, and the read behind it, happen. */
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));

/** The server answers the oldest change it is holding. */
async function answerNext() {
  await act(async () => waiting.shift()!.answer());
  await settle();
}

async function chooseOnRow(user: ReturnType<typeof userEvent.setup>, sentence: string, entry: string) {
  await user.click(await screen.findByRole('button', { name: `Actions for “${sentence}”` }));
  await user.click(await screen.findByRole('menuitem', { name: entry }));
}

async function reword(user: ReturnType<typeof userEvent.setup>, sentence: string, words: string) {
  await chooseOnRow(user, sentence, 'Edit');
  const box = screen.getByLabelText('Sentence');
  await user.clear(box);
  await user.type(box, words);
  await user.click(screen.getByRole('button', { name: 'Save' }));
}

async function forget(user: ReturnType<typeof userEvent.setup>, sentence: string) {
  await chooseOnRow(user, sentence, 'Delete');
  await user.click(await screen.findByRole('button', { name: 'Yes, forget this sentence' }));
}

beforeEach(() => {
  localStorage.clear();
  resetStanding();
  waiting = [];
  held.hold = false;
  held.releases = [];
  held.offer = OFFER;
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

describe('Agents', () => {
  describe('a sentence change shows the moment it is made, with the server still holding the answer', () => {
    it('closes the offer and puts the sentence first in the list when Remember is pressed', async () => {
      const user = await show([SIGN], true);
      await screen.findByLabelText('Remember this?');

      await user.click(screen.getByRole('button', { name: 'Remember' }));

      expect(screen.queryByLabelText('Remember this?')).toBeNull();
      await screen.findByText('Sign as Michael.');
      expect(listed()).toEqual(['Never promise a date.', 'Sign as Michael.']);
      expect(waitingFor()).toEqual(['remember_sentence']);
    });

    it('shows the new words in the row and closes the form when a sentence is reworded', async () => {
      const user = await show([SIGN, DUTCH]);

      await reword(user, 'Sign as Michael.', 'Sign as M.');

      expect(listed()).toEqual(['Sign as M.', 'Mails to the supplier: Dutch.']);
      expect(screen.queryByLabelText('Sentence')).toBeNull();
      expect(waitingFor()).toEqual(['edit_remembered_sentence']);
    });

    it('takes the row away and closes the question when a sentence is deleted', async () => {
      const user = await show([SIGN, DUTCH]);

      await forget(user, 'Sign as Michael.');

      expect(listed()).toEqual(['Mails to the supplier: Dutch.']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
      expect(waitingFor()).toEqual(['delete_remembered_sentence']);
    });
  });

  describe('a sentence change stays on the screen until the list is read after its answer', () => {
    it('keeps the new words under a read of the list begun before the answer, and shows the server’s list after one begun later', async () => {
      const user = await show([SIGN, DUTCH]);
      await reword(user, 'Sign as Michael.', 'Sign as M.');

      // A read begins now and is held: it saw the list as the server held it before the answer.
      held.hold = true;
      void client.invalidateQueries({ queryKey: ['rememberedSentences'] });
      await waitFor(() => expect(held.releases).toHaveLength(1));
      await answerNext();
      await act(async () => held.releases.splice(0).forEach((release) => release()));
      // It has landed with the old words, and the read owed behind the answer is on its way.
      await waitFor(() => expect(held.releases).toHaveLength(1));
      expect(listed()[0]).toBe('Sign as M.');
      held.hold = false;
      await act(async () => held.releases.splice(0).forEach((release) => release()));
      await settle();
      expect(listed()[0]).toBe('Sign as M.');

      // Another device words it again once the answer has been read: that is the server's now.
      held.sentences = [{ ...SIGN, sentence: 'Sign as Mike.' }, DUTCH];
      await act(async () => void (await client.invalidateQueries({ queryKey: ['rememberedSentences'] })));

      await waitFor(() => expect(listed()[0]).toBe('Sign as Mike.'));
    });

    it('keeps a deleted sentence gone under a read begun before the answer', async () => {
      const user = await show([SIGN, DUTCH]);
      await forget(user, 'Sign as Michael.');

      held.hold = true;
      void client.invalidateQueries({ queryKey: ['rememberedSentences'] });
      await waitFor(() => expect(held.releases).toHaveLength(1));
      await answerNext();
      await act(async () => held.releases.splice(0).forEach((release) => release()));
      await waitFor(() => expect(held.releases).toHaveLength(1));

      expect(listed()).toEqual(['Mails to the supplier: Dutch.']);
      held.hold = false;
      await act(async () => held.releases.splice(0).forEach((release) => release()));
    });

    it('reads the list once after the answers', async () => {
      const user = await show([SIGN, DUTCH]);
      await reword(user, 'Sign as Michael.', 'Sign as M.');
      await forget(user, 'Mails to the supplier: Dutch.');
      const before = held.reads;

      await answerNext();
      expect(held.reads).toBe(before);
      await answerNext();

      await waitFor(() => expect(held.reads).toBe(before + 1));
      await settle();
      expect(held.reads).toBe(before + 1);
      expect(listed()).toEqual(['Sign as M.']);
    });
  });

  describe('a sentence change the server refuses is put back, and says why', () => {
    it('brings the old words back to the form with the server’s words when a rewording is refused', async () => {
      const user = await show([SIGN, DUTCH]);
      await reword(user, 'Sign as Michael.', 'Mail fix@evil.example.');
      expect(listed()[0]).toBe('Mail fix@evil.example.');

      await act(async () => waiting.shift()!.refuse(new CommandRefused(422, 'Cockpit cannot remember a sentence that names an address.')));
      await settle();

      expect(screen.getByRole('alert')).toHaveTextContent('Cockpit cannot remember a sentence that names an address.');
      expect(screen.getByLabelText('Sentence')).toHaveValue('Mail fix@evil.example.');
      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(listed()).toEqual(['Sign as Michael.', 'Mails to the supplier: Dutch.']);
    });

    it('says it in the undo bar instead when another sentence is open for rewording by then', async () => {
      const user = await show([SIGN, DUTCH]);
      await reword(user, 'Sign as Michael.', 'Mail fix@evil.example.');
      await chooseOnRow(user, 'Mails to the supplier: Dutch.', 'Edit');

      await act(async () => waiting.shift()!.refuse(new CommandRefused(422, 'Cockpit cannot remember a sentence that names an address.')));
      await settle();

      expect(await screen.findByRole('status', { hidden: true })).toHaveTextContent(
        '“Sign as Michael.” was not reworded. Cockpit cannot remember a sentence that names an address.',
      );
      expect(screen.getByLabelText('Sentence')).toHaveValue('Mails to the supplier: Dutch.');
    });

    it('brings the row back with the server’s words in the undo bar when a delete is refused', async () => {
      const user = await show([SIGN, DUTCH]);
      await forget(user, 'Sign as Michael.');
      expect(listed()).toEqual(['Mails to the supplier: Dutch.']);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'That sentence is in use.')));
      await settle();

      expect(listed()).toEqual(['Sign as Michael.', 'Mails to the supplier: Dutch.']);
      expect(await screen.findByRole('status', { hidden: true })).toHaveTextContent('“Sign as Michael.” was not forgotten. That sentence is in use.');
    });

    it('takes the sentence out of the list again and says why in the undo bar when Remember is refused', async () => {
      const user = await show([SIGN], true);
      await screen.findByLabelText('Remember this?');
      await user.click(screen.getByRole('button', { name: 'Remember' }));
      await screen.findByText('Sign as Michael.');
      expect(listed()).toEqual(['Never promise a date.', 'Sign as Michael.']);

      await act(async () => waiting.shift()!.refuse(new CommandRefused(409, 'Cockpit keeps at most 100 remembered sentences.')));
      await settle();

      expect(listed()).toEqual(['Sign as Michael.']);
      expect(await screen.findByRole('status', { hidden: true })).toHaveTextContent(
        '“Never promise a date.” was not remembered. Cockpit keeps at most 100 remembered sentences.',
      );
    });
  });
});

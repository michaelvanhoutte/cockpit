import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import type { ItemOnWhiteboards } from '@cockpit/shared/board';
import { CommandRefused, sendCommand } from '../../src/api/client';
import { refusalFrom, useSendCommand, type CommandArgs } from '../../src/api/queries';
import TakeOffQuestion from '../../src/components/TakeOffQuestion';
import { forgetTheQuestion, putCardsBackAfter } from '../../src/whiteboardQuestion';

/**
 * F1: the question "Take it off there too?" ("Brainstorming: give every
 * Dashboard a whiteboard of its own", issue 1829). What each change writes when
 * sent again taking the cards off, and what *put back* restores, is the API's
 * (`apps/api/tests/integration/http/board.test.ts`). What is the screen's own:
 * that a change refused naming Items with cards asks once, sends itself again
 * taking them off only on *Take off both*, and that its Undo puts the cards back
 * behind its own inverse. Every screen sending one of those changes goes
 * through this one path (`sendChange`), so it is proved here once. The server is
 * replaced at the edge (`sendCommand`); the tab's queue is the real one.
 */
vi.mock('../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/api/client')>()),
  sendCommand: vi.fn(),
}));
const sends = vi.mocked(sendCommand);

const novel = (itemId: string, title: string): ItemOnWhiteboards => ({
  itemId,
  title,
  cards: [{ cardId: `card-${itemId}`, dashboardId: 'dash-novel', dashboardName: 'Novel' }],
});

/** The server: refuses each change named in `refusing` until it is sent taking the cards off. */
function aServerRefusing(refusing: Record<string, ItemOnWhiteboards>) {
  sends.mockImplementation(async (name, payload) => {
    const { itemId, takeCardsOff } = payload as { itemId?: string; takeCardsOff?: boolean };
    const held = itemId ? refusing[itemId] : undefined;
    if (held && name === 'remove_item_from_panel' && !takeCardsOff) throw new CommandRefused(409, `${held.title} is also on the whiteboard of Novel. Take it off there too?`, [held]);
    if (name === 'set_title') throw new CommandRefused(400, 'That title is too long.');
    return { ok: true, applied: true };
  });
}

const sentAs = () => sends.mock.calls.map(([name, payload]) => ({ name, ...(payload as { itemId?: string; takeCardsOff?: boolean; cardIds?: string[] }) }));

const removal = (itemId: string): CommandArgs => ({
  name: 'remove_item_from_panel',
  payload: { commandId: crypto.randomUUID(), issuedAt: '2026-11-20T10:00:00.000Z', workspaceId: 'ws', itemId, panelId: 'panel-people' },
});

let send: (args: CommandArgs) => Promise<unknown> = async () => undefined;
function Sender() {
  send = useSendCommand();
  return null;
}
function onScreen(children: ReactNode = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Sender />
      <TakeOffQuestion />
      {children}
    </QueryClientProvider>,
  );
}

afterEach(() => {
  sends.mockReset();
  forgetTheQuestion();
});

describe('Whiteboard', () => {
  describe('an Item on a whiteboard is asked about before it goes to the Inbox, and comes off the board with it', () => {
    it('asks once, naming the Item and the Dashboard, and on Take off both sends the change again taking its cards off', async () => {
      aServerRefusing({ a: novel('a', 'Ferry scene') });
      onScreen();
      const answer = send(removal('a'));
      expect(await screen.findByText('Ferry scene is also on the whiteboard of Novel. Take it off there too?')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Take off both' }));
      await expect(answer).resolves.toMatchObject({ cardsTakenOff: ['card-a'] });
      expect(sentAs().map(({ itemId, takeCardsOff }) => [itemId, takeCardsOff])).toEqual([
        ['a', undefined],
        ['a', true],
      ]);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('changes nothing on Cancel, and says nothing about it', async () => {
      aServerRefusing({ a: novel('a', 'Ferry scene') });
      onScreen();
      const answer = send(removal('a'));
      answer.catch(() => {});
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
      const kept = await answer.then(
        () => null,
        (error: unknown) => error,
      );
      expect(refusalFrom({ error: kept })).toBeNull();
      expect(sentAs()).toHaveLength(1);
    });

    it('asks one question for a selection of three, and one answer sends all three again', async () => {
      aServerRefusing({ a: novel('a', 'Ferry scene'), b: novel('b', 'Storm scene'), c: novel('c', 'Harbour scene') });
      onScreen();
      const answers = ['a', 'b', 'c'].map((id) => send(removal(id)));
      expect(await screen.findByText('3 Items are also on whiteboards. Take them off there too?')).toBeVisible();
      await userEvent.click(screen.getByRole('button', { name: 'Take off both' }));
      await Promise.all(answers);
      expect(sentAs().filter((one) => one.takeCardsOff).map((one) => one.itemId)).toEqual(['a', 'b', 'c']);
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('asks nothing for an Item with no cards, or a change refused for another reason', async () => {
      aServerRefusing({});
      onScreen();
      await send(removal('a'));
      const refused = send({ name: 'set_title', payload: { commandId: crypto.randomUUID(), issuedAt: '2026-11-20T10:00:00.000Z', workspaceId: 'ws', itemId: 'a', title: 'x' } });
      await expect(refused).rejects.toThrow('That title is too long.');
      expect(screen.queryByRole('alertdialog')).toBeNull();
    });

    it('puts the cards back behind its own Undo, after Take off both', async () => {
      aServerRefusing({ a: novel('a', 'Ferry scene') });
      onScreen();
      const answer = send(removal('a'));
      await userEvent.click(await screen.findByRole('button', { name: 'Take off both' }));
      await answer;
      const inverse = () => send({ name: 'add_item_to_panel', payload: { ...removal('a').payload, order: ['a'] } } as CommandArgs);
      await act(() => putCardsBackAfter(send as never, 'ws', [answer], inverse)());
      await waitFor(() => expect(sentAs().slice(-2).map((one) => [one.name, one.cardIds])).toEqual([
        ['add_item_to_panel', undefined],
        ['put_cards_back', ['card-a']],
      ]));
    });
  });
});

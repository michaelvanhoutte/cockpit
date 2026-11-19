import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConnectionHistory, WorkspaceSnapshot } from '@cockpit/shared';
import { InboxHeading } from '../../../src/components/InboxPanel';
import { announceCheckEnded } from '../../../src/checkEnds';
import { ConnectionHistoryOpener } from '../../../src/settingsOpener';
import { rememberChosen, resetStanding, stand } from '../../../src/offline';
import { RECONNECTED } from '../../../src/updating';
import { A_DESK, A_PHONE, onAScreen } from '../onAScreen';

/**
 * F1: the Inbox's ↻ - when it is drawn, what it says while it waits, and what
 * it says once every connection it asked for has ended ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835). The
 * request, the live stream's announcements and the clock are replaced; what
 * the store marks due and what an announcement carries are proved against the
 * real store in apps/api/tests/integration/connectors/workspace-check-now.test.ts.
 */

const GMAIL = { sourceAccountId: 'gmail-1', name: 'Gmail · me@home.com' };
const OUTLOOK = { sourceAccountId: 'outlook-1', name: 'Outlook · me@work.com' };
const PRESSED_AT = '2026-10-05T10:00:00.000Z';
const LATER = '2026-10-05T10:00:03.000Z';

const held = vi.hoisted(() => ({
  checkable: [] as { sourceAccountId: string; name: string }[] | undefined,
  /** Whether the request answers for the Workspace's checkable connections, fails, or waits to be released; and how often it was sent. */
  answer: { kind: 'answers' } as { kind: 'answers' } | { kind: 'fails' } | { kind: 'waits'; release: (() => void) | null },
  sent: 0,
  /** What each connection's history read answers with, and which were read. */
  histories: {} as Record<string, unknown>,
  read: [] as string[],
}));

vi.mock('../../../src/api/useSnapshot', () => ({
  useSnapshot: () => ({
    data: { items: [], filings: [], panels: [], checkable: held.checkable } as unknown as WorkspaceSnapshot,
  }),
}));

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  api: {
    v1: {
      workspaces: {
        ':workspaceId': {
          connections: {
            ':sourceAccountId': {
              history: {
                $get: async ({ param }: { param: { sourceAccountId: string } }) => {
                  held.read.push(param.sourceAccountId);
                  return Response.json(held.histories[param.sourceAccountId]);
                },
              },
            },
            'check-now': {
              $post: async () => {
                held.sent += 1;
                const answer = held.answer;
                if (answer.kind === 'fails') return new Response('', { status: 500 });
                if (answer.kind === 'waits') await new Promise<void>((resolve) => (answer.release = resolve));
                return Response.json({
                  at: PRESSED_AT,
                  connections: (held.checkable ?? []).map(({ sourceAccountId }) => ({ sourceAccountId, status: 'queued' })),
                });
              },
            },
          },
        },
      },
    },
  },
}));

const opened: [string, string][] = [];

/** The heading, once the ↻'s own chunk has arrived where the Workspace lists a connection to check. */
async function heading() {
  const drawn = render(
    <ConnectionHistoryOpener.Provider value={(workspaceId, sourceAccountId) => opened.push([workspaceId, sourceAccountId])}>
      <InboxHeading workspaceId="ws-privé" />
    </ConnectionHistoryOpener.Provider>,
  );
  if (held.checkable?.length) await screen.findByRole('button', { name: 'Check connections now' });
  return drawn;
}

const refresh = () => screen.queryByRole('button', { name: 'Check connections now' });

const ended = (who: typeof GMAIL, over: Partial<Parameters<typeof announceCheckEnded>[0]> = {}) =>
  act(() =>
    announceCheckEnded({
      type: 'connection_history_changed',
      workspaceId: 'ws-privé',
      sourceAccountId: who.sourceAccountId,
      outcome: 'worked',
      message: null,
      broughtIn: 0,
      closed: 0,
      at: LATER,
      ...over,
    }),
  );

async function pressed() {
  await userEvent.click(refresh()!);
  await screen.findByText(/Checking \d connections? now\./);
}

const lineOf = (outcome: 'worked' | 'failed', did = { broughtIn: 0, closed: 0 }, lastAt = LATER) => ({
  id: crypto.randomUUID(),
  outcome,
  reason: 'check-now',
  message: null,
  messageCut: false,
  status: null,
  count: 1,
  firstAt: lastAt,
  lastAt,
  did: {
    broughtIn: { count: did.broughtIn, items: [] },
    closed: { count: did.closed, items: [] },
    sentBack: { count: 0, items: [] },
    refused: { count: 0, items: [] },
    named: { count: 0, messages: [] },
  },
  listed: null,
  startedAt: null,
});

beforeEach(() => {
  onAScreen(A_DESK);
  held.checkable = [GMAIL, OUTLOOK];
  held.sent = 0;
  held.histories = {};
  held.read = [];
  opened.length = 0;
  held.answer = { kind: 'answers' };
  resetStanding();
  stand({ connecting: false });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetStanding();
});

describe('Inbox', () => {
  describe('the Inbox heading draws ↻ only where its Workspace has a connection to check', () => {
    it.each([
      { situation: 'on a desk, with Gmail and Outlook connected', screen: A_DESK, checkable: [GMAIL, OUTLOOK], drawn: true },
      { situation: 'on a phone, with Gmail connected', screen: A_PHONE, checkable: [GMAIL], drawn: true },
      { situation: 'with nothing to check, as the guest has', screen: A_DESK, checkable: [], drawn: false },
      { situation: 'before the Workspace read says', screen: A_PHONE, checkable: undefined, drawn: false },
    ])('$situation', async ({ screen: width, checkable, drawn }) => {
      onAScreen(width);
      held.checkable = checkable;

      await heading();

      expect(refresh() !== null).toBe(drawn);
      if (drawn) expect(refresh()).toHaveAccessibleName('Check connections now');
      if (drawn) expect(refresh()).toHaveAttribute('title', 'Check connections now');
    });
  });

  describe('a press of ↻ spins until every connection it asked for has ended, then says what they found', () => {
    it('spins and says what it is doing before the server answers, and a second press sends nothing', async () => {
      held.answer = { kind: 'waits', release: null };
      await heading();

      await userEvent.click(refresh()!);
      expect(screen.getByText('Checking 2 connections now.')).toBeInTheDocument();
      expect(refresh()!.querySelector('.animate-spin')).not.toBeNull();

      await userEvent.click(refresh()!);
      expect(held.sent).toBe(1);
    });

    it('ticks off a connection by an announcement at or after the server’s time, and ignores older ones and other Workspaces', async () => {
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));
      await screen.findByText('Checking 2 connections now.');

      ended(GMAIL, { at: '2026-10-05T09:59:00.000Z' });
      ended(OUTLOOK, { workspaceId: 'ws-elsewhere' });
      ended(GMAIL, { broughtIn: 3 });

      // Only Gmail has ended, so Outlook is still out and the spin stays.
      expect(refresh()!.querySelector('.animate-spin')).not.toBeNull();
      expect(screen.queryByText(/^Checked/)).toBeNull();
    });

    it.each([
      {
        situation: 'two brought in and one closed between them',
        announced: [{ who: GMAIL, over: { broughtIn: 2 } }, { who: OUTLOOK, over: { closed: 1 } }],
        says: 'Checked 2 connections · 2 new, 1 closed',
      },
      {
        situation: 'nothing between them',
        announced: [{ who: GMAIL, over: {} }, { who: OUTLOOK, over: {} }],
        says: 'Checked 2 connections · nothing new',
      },
    ])('says $says when $situation', async ({ announced, says }) => {
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));

      for (const { who, over } of announced) ended(who, over);

      expect(await screen.findByText(says)).toBeInTheDocument();
      expect(refresh()!.querySelector('.animate-spin')).toBeNull();
    });

    it('says the one connection in the singular', async () => {
      held.checkable = [GMAIL];
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));
      expect(screen.getByText('Checking 1 connection now.')).toBeInTheDocument();

      ended(GMAIL, { broughtIn: 1 });

      expect(await screen.findByText('Checked 1 connection · 1 new')).toBeInTheDocument();
    });

    it('hears an announcement that came before the server’s answer', async () => {
      held.answer = { kind: 'waits', release: null };
      await heading();
      await userEvent.click(refresh()!);
      await screen.findByText('Checking 2 connections now.');

      ended(GMAIL);
      ended(OUTLOOK);
      expect(screen.queryByText(/^Checked/)).toBeNull();
      await act(async () => held.answer.kind === 'waits' && held.answer.release?.());

      expect(await screen.findByText('Checked 2 connections · nothing new')).toBeInTheDocument();
    });

    it('names a failed connection, and on a desk the name opens its history in Settings', async () => {
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));

      ended(GMAIL);
      ended(OUTLOOK, { outcome: 'failed', message: 'denied' });

      const note = await screen.findByRole('status');
      expect(within(note).getByText(/^Checked 2 connections/)).toBeInTheDocument();
      await userEvent.click(within(note).getByRole('button', { name: OUTLOOK.name }));
      expect(opened).toEqual([['ws-privé', OUTLOOK.sourceAccountId]]);
      expect(note).toHaveTextContent(`${OUTLOOK.name} failed`);
    });

    it('names a failed connection on a phone without making it a link', async () => {
      onAScreen(A_PHONE);
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));

      ended(GMAIL);
      ended(OUTLOOK, { outcome: 'failed' });

      const note = await screen.findByRole('status');
      expect(note).toHaveTextContent(`${OUTLOOK.name} failed`);
      expect(within(note).queryByRole('button')).toBeNull();
    });

    it('says which connection is still out after a minute, and still ends when it does', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));
      ended(OUTLOOK);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000);
      });
      expect(screen.getByText(new RegExp(`Still checking ${GMAIL.name}: nothing back after a minute`))).toBeInTheDocument();

      ended(GMAIL);
      expect(await screen.findByText('Checked 2 connections · nothing new')).toBeInTheDocument();
    });

    it.each([
      { situation: 'the server refuses', answer: { kind: 'fails' } as const },
    ])('stops spinning and says so when $situation', async ({ answer }) => {
      held.answer = answer;
      await heading();

      await userEvent.click(refresh()!);

      expect(await screen.findByText('That did not reach the server. Try again.')).toBeInTheDocument();
      expect(refresh()!.querySelector('.animate-spin')).toBeNull();
    });

    it('is refused while working offline, and sends nothing', async () => {
      await heading();
      rememberChosen(true);
      act(() => stand({ chosen: true }));

      await userEvent.click(refresh()!);

      expect(screen.getByText("You're working offline")).toBeInTheDocument();
      expect(held.sent).toBe(0);
      expect(refresh()!.querySelector('.animate-spin')).toBeNull();
    });
  });

  describe('when the live stream comes back during a wait, each connection still out is read once', () => {
    it('ticks off the one that ended meanwhile, and leaves the other waiting', async () => {
      await heading();
      await pressed();
      await waitFor(() => expect(held.sent).toBe(1));
      held.histories[GMAIL.sourceAccountId] = { lines: [lineOf('worked', { broughtIn: 1, closed: 0 })], olderRemain: false } satisfies Partial<ConnectionHistory>;
      held.histories[OUTLOOK.sourceAccountId] = { lines: [lineOf('worked', { broughtIn: 0, closed: 0 }, '2026-10-05T09:00:00.000Z')], olderRemain: false };

      // Past the server's answer, which is what says since when each is waited on.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      act(() => void globalThis.dispatchEvent(new Event(RECONNECTED)));

      await waitFor(() => expect(held.read.sort()).toEqual([GMAIL.sourceAccountId, OUTLOOK.sourceAccountId]));
      expect(screen.queryByText(/^Checked/)).toBeNull();
      expect(refresh()!.querySelector('.animate-spin')).not.toBeNull();

      ended(OUTLOOK);
      expect(await screen.findByText('Checked 2 connections · 1 new')).toBeInTheDocument();
    });

    it('reads nothing where no press is waiting', async () => {
      await heading();

      act(() => void globalThis.dispatchEvent(new Event(RECONNECTED)));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(held.read).toEqual([]);
    });
  });
});


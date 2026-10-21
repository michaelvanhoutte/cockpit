import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { itemSchema, type CommandResult, type Item, type Workspace, type WorkspaceSnapshot } from '@cockpit/shared';
import { changes } from '../../../src/api/changes';
import { CommandRefused, fetchMe, fetchSnapshot, fetchWorkspaces, sendCommand } from '../../../src/api/client';
import { CaptureNote } from '../../../src/components/CaptureNote';
import { InboxPanel } from '../../../src/components/InboxPanel';
import {
  CaptureOutbox,
  OutboxProvider,
  browserOutboxStore,
  inTabLock,
  serverSender,
  useSendingCaptures,
} from '../../../src/captureOutboxSender';
import { resetStanding } from '../../../src/offline';

/**
 * A captured note in the Inbox as the Capture form makes it, with the server
 * holding the answer - the frontend-with-its-own-backend level (F2), run in this
 * runner as `WorkspacesAtOnce.test.tsx` is. The form, the outbox, the tab's
 * queue, the queries and the Inbox are the app's own and only the network is
 * replaced: a server that answers a capture when the test says, stores the
 * Item with the rewrite Cockpit gives it, and answers a read of a Workspace with
 * what it holds. What is drawn of a capture is tests/unit/drawnAhead.test.ts,
 * when it stops being drawn is tests/unit/changeQueue.test.ts, and how the outbox
 * feeds it is tests/unit/captureOutboxSender.test.tsx; what is asked here is
 * that the form, the outbox and the Inbox are wired to them.
 */

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  fetchSnapshot: vi.fn(),
  fetchWorkspaces: vi.fn(),
  fetchMe: vi.fn(),
  sendCommand: vi.fn(),
}));

// Nothing here moves the address, so the router is the one stand-in beyond the network.
vi.mock('@tanstack/react-router', () => ({
  Link: ({ children, to: _to, params: _params, ...rest }: { children?: React.ReactNode; to?: unknown; params?: unknown } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href="#" {...rest}>
      {children}
    </a>
  ),
  useNavigate: () => () => Promise.resolve(),
  useParams: () => ({ workspaceId: 'ws-work' }),
  useRouterState: ({ select }: { select: (state: unknown) => unknown }) => select({ location: { pathname: '/w/ws-work' } }),
}));

const aWorkspace = (id: string, name: string): Workspace =>
  ({ id, tenantId: 'tenant', name, color: '#6f62b5', bar: '#dbd7ee', ground: '#e3e1f2', header: '#d2cdea' }) as Workspace;
const WORK = aWorkspace('ws-work', 'Work');
const HOME = aWorkspace('ws-home', 'Home');

/** What Cockpit makes of the note once it has read it: the capital and the full stop. */
const REWRITTEN = 'Call Bart.';
const NOTE = 'call bart';

/** The Items the server holds. */
let stored: Item[];

/** Every capture the server has been sent and not yet answered, oldest first. */
let waiting: { payload: Record<string, unknown>; answer: () => void; refuse: (error: Error) => void }[];

/** While set, a read of a Workspace is held until `releaseReads` lets it go, with what the server holds then. */
let holdingReads: boolean;
let held: (() => void)[];

/** Whether the connection is up, as the outbox asks it. */
let online: boolean;

let client: QueryClient;
let outbox: CaptureOutbox;

function theServerItem(payload: Record<string, unknown>): Item {
  return {
    ...Object.fromEntries(Object.keys(itemSchema.shape).map((field) => [field, null])),
    id: payload.itemId,
    tenantId: 'tenant',
    workspaceId: payload.workspaceId,
    workspaceDecided: payload.workspaceDecided !== false,
    capturedMessage: payload.message,
    source: 'internal',
    title: REWRITTEN,
    unseen: false,
    createdAt: payload.issuedAt,
    updatedAt: payload.issuedAt,
  } as Item;
}

function theWorkspace(workspaceId: string): WorkspaceSnapshot {
  return {
    workspace: workspaceId === HOME.id ? HOME : WORK,
    // An Item that belongs to no Workspace is in every Workspace's Inbox.
    items: stored.filter((item) => item.workspaceId === workspaceId || !item.workspaceDecided),
    dashboards: [],
    panels: [],
    layouts: [],
    associations: [],
    attachments: [],
    duplicates: [],
    filings: [],
    agentRuns: [],
    itemFormPresentation: 'centered',
    generatedAt: '2026-10-21T09:00:00.000Z',
  } as unknown as WorkspaceSnapshot;
}

/** The page the Capture window opens and the Inbox beside it, as the shell sends the outbox for them. */
function Screen() {
  useSendingCaptures('user-ada');
  return (
    <>
      <CaptureNote startsIn="ws-work" dictating={{ transcriber: false }} />
      <InboxPanel workspaceId="ws-work" />
    </>
  );
}

async function show() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  outbox = new CaptureOutbox({ store: browserOutboxStore(), sender: serverSender, lock: inTabLock(), online: () => online });
  outbox.signedInAs('user-ada');
  render(
    <QueryClientProvider client={client}>
      <OutboxProvider value={outbox}>
        <Screen />
      </OutboxProvider>
    </QueryClientProvider>,
  );
  await screen.findByRole('button', { name: 'Home' });
  await waitFor(() => expect(screen.queryByText('Loading…')).toBeNull());
  return userEvent.setup();
}

async function capture(user: ReturnType<typeof userEvent.setup>, where: string, note = NOTE) {
  await user.click(screen.getByRole('button', { name: where }));
  await user.type(screen.getByLabelText('What is on your mind?'), note);
  await user.click(screen.getByRole('button', { name: 'Capture' }));
}

/** The Inbox on screen: what its rows say. */
const theInbox = () => within(document.querySelector<HTMLElement>('[data-inbox]')!).queryAllByRole('listitem').map((row) => row.textContent);
const inboxHolds = (...rows: string[]) => waitFor(() => expect(theInbox()).toEqual(rows.map((row) => expect.stringContaining(row))));
const readsOfWork = () => vi.mocked(fetchSnapshot).mock.calls.filter(([asked]) => asked === WORK.id).length;
const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
const releaseReads = () => act(async () => held.splice(0).forEach((release) => release()));

beforeEach(() => {
  // A browser of its own for every case: nothing kept by the last one.
  globalThis.indexedDB = new IDBFactory();
  localStorage.clear();
  localStorage.setItem('cockpit.last-visited.workspace', WORK.id);
  resetStanding();
  stored = [];
  waiting = [];
  held = [];
  holdingReads = false;
  online = true;
  vi.mocked(fetchMe).mockResolvedValue({ user: { id: 'user-ada', name: 'Ada', role: 'user' } } as never);
  vi.mocked(fetchWorkspaces).mockImplementation(async () => ({ workspaces: [WORK, HOME] }));
  vi.mocked(fetchSnapshot).mockReset();
  vi.mocked(fetchSnapshot).mockImplementation(async (workspaceId: string) => {
    if (holdingReads) await new Promise<void>((release) => held.push(release));
    return structuredClone(theWorkspace(workspaceId));
  });
  vi.mocked(sendCommand).mockReset();
  vi.mocked(sendCommand).mockImplementation(
    (_name, payload) =>
      new Promise<CommandResult>((resolve, reject) => {
        waiting.push({
          payload: payload as Record<string, unknown>,
          answer: () => {
            stored.push(theServerItem(payload as Record<string, unknown>));
            resolve({ ok: true, applied: true, at: '2026-10-21T10:00:00.000Z' });
          },
          refuse: reject,
        });
      }),
  );
});

afterEach(() => {
  outbox.signedInAs(null);
  outbox.stop();
  changes.forgetAnswered();
});

describe('Capture', () => {
  describe('a captured note shows in the Inbox the moment it is made, with the server still holding the answer', () => {
    it.each([
      { situation: 'captured to this Workspace', where: 'Work', connected: true, inThisInbox: [NOTE] },
      { situation: 'captured to Any workspace', where: 'Any workspace', connected: true, inThisInbox: [NOTE] },
      { situation: 'captured to another Workspace', where: 'Home', connected: true, inThisInbox: [] },
      { situation: 'captured without a connection, still waiting to send', where: 'Work', connected: false, inThisInbox: [NOTE] },
    ])('$situation', async ({ where, connected, inThisInbox }) => {
      online = connected;
      const user = await show();

      await capture(user, where);

      await inboxHolds(...inThisInbox);
      expect(theInbox()).toHaveLength(inThisInbox.length);
      await settle();
      // The server has not been heard from: a request waits for its answer, or none could go.
      expect(waiting).toHaveLength(connected ? 1 : 0);
      expect(stored).toEqual([]);
    });
  });

  describe('a landed note stays in the Inbox until a read that began after it landed has landed', () => {
    it('keeps the note when the Workspace is read before the server has stored it', async () => {
      const user = await show();
      await capture(user, 'Work');
      await inboxHolds(NOTE);

      await act(async () => void (await client.invalidateQueries({ queryKey: ['snapshot', WORK.id] })));
      await settle();

      expect(theInbox()).toEqual([expect.stringContaining(NOTE)]);
    });

    it('keeps the note as typed through the read the landing asks for, then shows the server’s row in its place, once', async () => {
      const user = await show();
      await capture(user, 'Work');
      await inboxHolds(NOTE);
      await waitFor(() => expect(waiting).toHaveLength(1));
      holdingReads = true;

      await act(async () => waiting.shift()!.answer());
      await settle();

      // The server has the note and the read for it is on its way: the note stays as it was typed.
      expect(held).toHaveLength(1);
      expect(theInbox()).toEqual([expect.stringContaining(NOTE)]);

      await releaseReads();

      await inboxHolds(REWRITTEN);
      expect(theInbox()).toHaveLength(1);
    });
  });

  describe('a landed note reads the Workspace once', () => {
    it.each([
      { situation: 'captured to this Workspace', where: 'Work' },
      { situation: 'captured to Any workspace', where: 'Any workspace' },
    ])('$situation', async ({ where }) => {
      const user = await show();
      await capture(user, where);
      await waitFor(() => expect(waiting).toHaveLength(1));
      await settle();
      const before = readsOfWork();

      await act(async () => waiting.shift()!.answer());
      await settle();

      expect(readsOfWork() - before).toBe(1);
      await inboxHolds(REWRITTEN);
    });
  });

  describe('a refused note leaves the Inbox and goes back in the box with the reason', () => {
    it('takes the row away, says why it was not sent, and Put back returns the note to the box', async () => {
      const user = await show();
      await capture(user, 'Work');
      await inboxHolds(NOTE);
      await waitFor(() => expect(waiting).toHaveLength(1));

      await act(async () => waiting.shift()!.refuse(new CommandRefused(404, 'That workspace is not there.')));

      await waitFor(() => expect(theInbox()).toEqual([]));
      expect(await screen.findByText('1 not sent')).toBeVisible();
      expect(screen.getByText('That workspace is not there.')).toBeVisible();
      await user.click(screen.getByRole('button', { name: 'Put back' }));
      expect(screen.getByLabelText('What is on your mind?')).toHaveValue(NOTE);
      expect(theInbox()).toEqual([]);
    });
  });
});

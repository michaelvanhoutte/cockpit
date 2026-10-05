import 'fake-indexeddb/auto';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MAX_ATTACHMENT_SIZE, type Item, type ItemType } from '@cockpit/shared';
import { CommandRefused, sendCommand, uploadAttachment } from '../../../src/api/client';
import {
  CaptureNote,
  NO_WORKSPACE,
  STILL_LISTED,
  STILL_READING,
  pasteKeyFor,
} from '../../../src/components/CaptureNote';
import { dueDateLabel } from '../../../src/dueDate';
import {
  CaptureOutbox,
  OutboxProvider,
  browserOutboxStore,
  inTabLock,
  serverSender,
  type OutboxStore,
} from '../../../src/captureOutboxSender';
import { NO_TYPES } from '../../../src/itemTypes';
import { forgetEverything } from '../../../src/session/forget';
import {
  DICTATION_BLOCKED,
  DICTATION_NO_MICROPHONE,
  DICTATION_OFFLINE,
  type EngineFactory,
} from '../../../src/dictation';
import { anEngine } from '../support/speech';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
  sendCommand: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
  uploadAttachment: vi.fn(() => Promise.resolve({ ok: true as const, applied: true })),
}));

/**
 * F1: the page is chips, a box and a list, and every rule here is what it sends
 * and what it then shows. Nothing needs a browser - that a note captured
 * without a workspace really does turn up in every workspace's Inbox is a
 * query, proved against a real store in
 * apps/api/tests/integration/http/panel-items.test.ts, and the walk from the
 * header to the Inbox is tests/e2e/workspace-capture.test.ts.
 *
 * The API client is what is replaced, and IndexedDB is a fake one, so what
 * capturing does is the real outbox sending through the real sender
 * (`captureOutboxSender.tsx`); "reloaded" is the form drawn again over the same
 * stored outbox. When the outbox goes, and what it does with each answer, is
 * tests/unit/captureOutboxSender.test.tsx. Where the outbox cannot be written,
 * capture sends directly through `useCapture`, which is why `useCommand` is
 * replaced as well.
 */
const held = vi.hoisted(() => ({
  mutate: vi.fn(),
  /**
   * The types the account holds, which another tab can delete one of. Three
   * things that are not each other: a list, `null` for an answer still in
   * flight, and `PREDATES_TYPES` for a stored copy written before the snapshot
   * carried the field at all.
   */
  types: [] as unknown[] | null | 'the copy predates the field',
  /** The workspaces the account holds, which another tab can delete one of. */
  workspaces: [] as unknown[],
  items: [] as unknown[],
  /** What a capture is refused with, if it is. */
  refuses: null as Error | null,
  /**
   * The account's types asked for as a resource of their own, which this page
   * must not do - so it is a spy that never answers rather than a fixture.
   */
  asksForTypesOnTheirOwn: vi.fn(),
  /**
   * Held rather than answered on the spot, for a test that needs the request
   * still in flight - `isPending` follows this, and `settle()` answers it
   * with whatever `refuses` says at the time.
   */
  pending: false,
  settle: () => {},
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, isPending: held.pending }),
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
  },
  // Still exported, because the window that manages types reads it - and still
  // answering nothing, so a page that went back to reading it would draw no
  // chips rather than quietly pass on a second copy of the same list.
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () => {
      held.asksForTypesOnTheirOwn();
      return new Promise(() => {});
    },
  },
  /**
   * The one read the page makes, carrying the account's types as well as the
   * items they are ordered by - which is the snapshot's own shape, not this
   * harness being convenient (packages/shared/src/api/snapshot.ts).
   *
   * Never settling is how "the answer has not arrived" is arranged, and a
   * snapshot without the field is how a copy older than the field is: the page
   * has to tell both apart from an account with no types.
   */
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => {
      if (held.types === null) return new Promise(() => {});
      if (held.types === PREDATES_TYPES) return Promise.resolve({ items: held.items });
      return Promise.resolve({ items: held.items, itemTypes: held.types });
    },
  }),
}));

/** A stored snapshot from before it carried the account's types. */
const PREDATES_TYPES = 'the copy predates the field';

const WORK = { id: 'ws-work', tenantId: 'tenant', name: 'Work', color: '#6f62b5' };
const HOME = { id: 'ws-home', tenantId: 'tenant', name: 'Home', color: '#3f8f78' };

function aType(name: string, at: number, color: string): ItemType {
  return {
    id: `11111111-1111-7111-8111-${String(at).padStart(12, '0')}`,
    tenantId: 'tenant',
    name,
    color,
    position: at,
    createdAt: '2026-09-01T08:00:00.000Z',
  } as ItemType;
}

const ACTION = aType('Action', 0, '#6f62b5');
const THOUGHT = aType('Thought', 1, '#3a72c8');
const READ_LATER = aType('Read later', 2, '#b58a2f');

/**
 * The page, with the account's types and with a workspace already remembered as
 * the one you came from - which is what a capture that names no workspace is
 * recorded against (`lastVisited.ts`).
 */
async function thePage({
  types = [ACTION, THOUGHT, READ_LATER],
  items = [] as Item[],
  cameFrom = 'ws-home',
  startsIn = null,
  heldMutation = false,
  store = browserOutboxStore(),
  dictating,
  language,
}: {
  /**
   * Null for an account that has not answered what types it has, and
   * `PREDATES_TYPES` for a stored copy from before the field.
   */
  types?: ItemType[] | null | typeof PREDATES_TYPES;
  items?: Item[];
  cameFrom?: string;
  /** The workspace Where starts on, or null for *Any workspace*. */
  startsIn?: string | null;
  /**
   * True for a test that needs a capture still in flight - `busy` (and
   * `held.pending`) stays true until the test calls `held.settle()`, which
   * answers with whatever `held.refuses` says at that moment.
   */
  heldMutation?: boolean;
  /** Where the outbox is kept: the fake IndexedDB, unless a case says storage is unavailable. */
  store?: OutboxStore;
  /** What the browser offers to dictate with, and where the language is kept; none, as in a browser without speech recognition. */
  dictating?: { engine?: EngineFactory | null; store?: Storage | undefined };
  /** The language stored on this device before the page opens. */
  language?: string;
} = {}) {
  held.types = types;
  held.items = items;
  held.workspaces = [WORK, HOME];
  held.refuses = null;
  held.pending = false;
  held.settle = () => {};
  localStorage.clear();
  localStorage.setItem('cockpit.last-visited.workspace', cameFrom);
  if (language) localStorage.setItem('cockpit.dictation-language', language);

  // The real mutation calls back: `onSuccess` is what lists what was captured,
  // and `onError` is what puts the note back and says why.
  held.mutate = vi.fn(
    (_args, options?: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      const answer = () => {
        held.pending = false;
        if (held.refuses) options?.onError?.(held.refuses);
        else options?.onSuccess?.();
      };
      if (heldMutation) {
        held.pending = true;
        held.settle = answer;
      } else {
        answer();
      }
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const outbox = new CaptureOutbox({
    store,
    sender: serverSender,
    lock: inTabLock(),
    online: () => true,
    timeoutMs: 500,
  });
  outbox.signedInAs('user-michael');
  const page = render(
    <QueryClientProvider client={client}>
      <OutboxProvider value={outbox}>
        <CaptureNote startsIn={startsIn} dictating={dictating} />
      </OutboxProvider>
    </QueryClientProvider>,
  );
  // Nothing to choose from until the account's types and workspaces arrive -
  // or, where it has none, until the row says so. Where the answer never comes,
  // or comes without the field, there is nothing to wait for and the box the
  // note is typed into is what says the page is drawn.
  if (types === null || types === PREDATES_TYPES) {
    await screen.findByLabelText('What is on your mind?');
  } else if (types.length > 0) await screen.findByRole('button', { name: types[0]!.name });
  else await screen.findByText(NO_TYPES);
  return Object.assign(userEvent.setup(), { client, outbox, unmount: page.unmount });
}

/** Storage that refuses everything: a private window, or a full disk. */
const UNAVAILABLE: OutboxStore = {
  all: () => Promise.reject(new Error('unavailable')),
  put: () => Promise.reject(new Error('unavailable')),
  remove: () => Promise.reject(new Error('unavailable')),
};

/** The page drawn again over what the last one kept: a reload. */
async function reloaded(page: { unmount: () => void }, options: Parameters<typeof thePage>[0] = {}) {
  page.unmount();
  return thePage(options);
}

const mic = () => screen.getByRole('button', { name: 'Dictate' });
const tag = () => screen.getByRole('button', { name: /^Dictation language/ });

const box = () => screen.getByLabelText('What is on your mind?');
const chip = (name: string) => screen.getByRole('button', { name });
/** Every capture sent, through the outbox or directly. */
const capturedCalls = () => [
  ...vi
    .mocked(sendCommand)
    .mock.calls.filter(([name]) => name === 'capture_item')
    .map(([name, payload]) => ({ name, payload: payload as Record<string, unknown> })),
  ...held.mutate.mock.calls.map(([args]) => args).filter((args) => args.name === 'capture_item'),
];
/** The first capture sent, once it has been. */
const captured = async () => {
  await waitFor(() => expect(capturedCalls().length).toBeGreaterThan(0));
  return capturedCalls()[0]!;
};
/** Lets the outbox finish whatever it started, so "nothing was sent" is an answer. */
const settled = async () => {
  await act(async () => {
    for (let i = 0; i < 100; i++) await new Promise((resolve) => setImmediate(resolve));
  });
};
const everythingAsked = () => [
  ...vi.mocked(sendCommand).mock.calls.map(([name]) => name),
  ...held.mutate.mock.calls.map(([args]) => args.name),
];
const justCaptured = () => screen.queryAllByRole('listitem');
/** The row of Just captured holding this note. */
const rowOf = (note: string) => {
  const row = justCaptured().find((one) => within(one).queryByText(note));
  if (!row) throw new Error(`no row for "${note}"`);
  return within(row);
};

const aPhoto = () => new File(['bytes'], 'photo.png', { type: 'image/png' });
/** Matches that file by name, since two `File`s compare equal whatever they hold. */
const aPhotoFile = expect.objectContaining({ name: 'photo.png' });
function aFile(name: string, type: string, size?: number): File {
  const file = new File(['bytes'], name, { type });
  if (size !== undefined) Object.defineProperty(file, 'size', { value: size });
  return file;
}
const carrying = (...files: File[]) => ({ dataTransfer: { types: ['Files'], files } });

describe('Capture', () => {
  beforeEach(() => {
    // A browser of its own for every case: nothing kept by the last one.
    globalThis.indexedDB = new IDBFactory();
    held.mutate.mockClear();
    held.asksForTypesOnTheirOwn.mockClear();
    vi.mocked(sendCommand).mockReset();
    vi.mocked(sendCommand).mockResolvedValue({ ok: true as const, applied: true });
    vi.mocked(uploadAttachment).mockReset();
    vi.mocked(uploadAttachment).mockResolvedValue({ ok: true as const, applied: true });
  });

  describe('the capture page writes down a note, what kind of thing it is, and where it goes', () => {
    it('captures against the workspace you came from, saying where it belongs is undecided', async () => {
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('Ask Ada about the backup window');
      // The workspace it was captured from is still recorded: it is an honest
      // fact, and it is what the foreign key needs.
      expect((await captured()).payload.workspaceId).toBe('ws-home');
      expect((await captured()).payload.workspaceDecided).toBe(false);
    });

    it('opens on the type used last, and captures whichever chip is lit', async () => {
      const user = await thePage();

      // Lit before anything is pressed: the type you want is nearly always the
      // one you just used.
      expect(chip('Action')).toHaveAttribute('aria-pressed', 'true');
      await user.click(chip('Thought'));
      await user.type(box(), 'Maybe the onboarding is two screens');
      await user.click(chip('Capture'));

      expect((await captured()).payload.typeId).toBe(THOUGHT.id);
    });

    it('captures into a workspace once one is chosen, and says that is where it belongs', async () => {
      const user = await thePage();

      await user.click(chip('Work'));
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect((await captured()).payload.workspaceId).toBe('ws-work');
      expect((await captured()).payload.workspaceDecided).toBeUndefined();
    });

    it('starts Where on the workspace it was opened in, and captures into it as decided', async () => {
      const user = await thePage({ startsIn: 'ws-work' });

      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'false');
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect((await captured()).payload.workspaceId).toBe('ws-work');
      expect((await captured()).payload.workspaceDecided).toBeUndefined();
    });

    it('holds a different workspace, once chosen, for every note captured after it', async () => {
      const user = await thePage({ startsIn: 'ws-work' });

      await user.click(chip('Home'));
      await user.type(box(), 'First for the customer');
      await user.click(chip('Capture'));
      await user.type(box(), 'Second for the customer');
      await user.click(chip('Capture'));

      await waitFor(() => expect(capturedCalls()).toHaveLength(2));
      expect(capturedCalls().map(({ payload }) => payload.workspaceId)).toEqual(['ws-home', 'ws-home']);
    });

    it('falls back to the type used last when the one chosen is deleted in another tab', async () => {
      const user = await thePage();
      await user.click(chip('Read later'));

      held.types = [ACTION, THOUGHT];
      // Through the snapshot, which is what a deleted type really goes out
      // through: changing the types invalidates every workspace's snapshot,
      // because types are drawn on every row of every list (api/queries.ts).
      await user.client.invalidateQueries({ queryKey: ['snapshot'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Read later' })).toBeNull());

      // Which is what the row now says, rather than nothing being chosen - and
      // what it captures against, rather than a type the account would refuse.
      // To the type used last rather than to none, because there is no none.
      expect(chip('Action')).toHaveAttribute('aria-pressed', 'true');
      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect((await captured()).payload.typeId).toBe(ACTION.id);
    });

    it('falls back to Any workspace when the one chosen is deleted in another tab', async () => {
      const user = await thePage();
      await user.click(chip('Work'));

      // Deleted elsewhere, and this page finds out the way every screen does -
      // the list it is drawn from comes back without it.
      held.workspaces = [HOME];
      await user.client.invalidateQueries({ queryKey: ['workspaces'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Work' })).toBeNull());

      // Which is what the row now says, rather than nothing being chosen.
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'true');
      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect((await captured()).payload.workspaceId).toBe('ws-home');
      expect((await captured()).payload.workspaceDecided).toBe(false);
    });

    /**
     * The one *chosen* is the case above; this is the one it is captured
     * **from**, which nobody chose and which the page falls back for in the
     * same way (`workspaceToCaptureFrom`).
     *
     * Reachable while you sit on this page: deleting a workspace that is
     * neither the last nor the screen behind you leaves you here on purpose
     * (components/ManageWorkspaces.tsx), and the list comes back without it.
     * A page holding the deleted one would read a snapshot that is a 404 for
     * good, so there would be no type to give and the note would go in silence
     * - which is what this whole change exists to stop.
     */
    it('captures against a workspace that is still there when the one it came from is deleted', async () => {
      const user = await thePage({ cameFrom: 'ws-home' });

      held.workspaces = [WORK];
      await user.client.invalidateQueries({ queryKey: ['workspaces'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Home' })).toBeNull());

      await user.type(box(), 'Where does this go');
      await user.keyboard('{Control>}{Enter}{/Control}');

      expect((await captured()).payload.workspaceId).toBe('ws-work');
      expect((await captured()).payload.workspaceDecided).toBe(false);
    });

    it('captures nothing at all for an empty note', async () => {
      const user = await thePage();

      await user.click(chip('Capture'));

      await settled();
      expect(capturedCalls()).toEqual([]);
    });

    it('captures on the key under the hand, without reaching for the button', async () => {
      const user = await thePage();

      await user.type(box(), 'Two lines{Shift>}{Enter}{/Shift}and a second');
      await user.keyboard('{Control>}{Enter}{/Control}');

      expect((await captured()).payload.message).toBe('Two lines\nand a second');
    });
  });

  /**
   * The page invites a capture the moment it is on screen - the box is focused
   * for it - so anything it needs to honour one has to be there by then. The
   * types were the thing that was not: they were read as a resource of their
   * own, which nothing ahead of this page fetches, so it arrived after the
   * page did. The shortcut reaches the form past the disabled button, and
   * captured nothing while saying nothing ("Find out why the
   * capture-into-a-named-workspace walk fails intermittently", issue 219).
   *
   * That the *route* holds the page back until that snapshot is in hand is
   * apps/web/tests/unit/router.test.tsx, under the same words.
   */
  describe('the capture page is drawn only once it can capture', () => {
    // The separate read never answers in this file, so a page that went back to
    // wanting it would have no chips to press and nothing to capture with.
    it('captures on the first press, without a second answer having arrived', async () => {
      const user = await thePage();

      expect(held.asksForTypesOnTheirOwn).not.toHaveBeenCalled();
      await user.type(box(), 'Book the venue deposit');
      await user.keyboard('{Control>}{Enter}{/Control}');

      expect((await captured()).payload.message).toBe('Book the venue deposit');
      expect((await captured()).payload.typeId).toBe(ACTION.id);
    });

    /**
     * A stored copy written before the snapshot carried types is *not known
     * yet*, which is the one thing "No types yet" must not be said about - the
     * same distinction the Inbox's row makes of the same field
     * .
     */
    it('says nothing about an account whose stored copy predates the types', async () => {
      await thePage({ types: PREDATES_TYPES });

      const row = within(screen.getByRole('group', { name: 'Type' }));
      expect(row.queryAllByRole('button')).toEqual([]);
      expect(screen.queryByText(NO_TYPES)).toBeNull();
      expect(chip('Capture')).toBeDisabled();
    });
  });

  /**
   * "Keep a capture made offline, and send it once a connection gets
   * through" (issue 610). Capture never waits on the network: the box empties
   * once the note is kept on this device, and nothing the server or the
   * connection does afterwards puts it in danger.
   */
  describe('a capture is kept from the moment Capture is pressed until it lands, or until you confirm signing out', () => {
    it('empties the box once the note is kept', async () => {
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      await waitFor(() => expect(box()).toHaveValue(''));
    });

    it.each([
      { situation: 'captured with no connection', answer: () => Promise.reject(new TypeError('Failed to fetch')) },
      { situation: 'the send times out', answer: () => new Promise<never>(() => {}) },
      {
        situation: 'a server error',
        answer: () => Promise.reject(new CommandRefused(503, 'capture_item failed: 503')),
      },
    ])('empties the box and reads Waiting to send when $situation', async ({ answer }) => {
      vi.mocked(sendCommand).mockImplementation(answer);
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      await waitFor(() => expect(box()).toHaveValue(''));
      await waitFor(() =>
        expect(rowOf('Ask Ada about the backup window').getByText('Waiting to send')).toBeVisible(),
      );
      expect(screen.queryByRole('alert')).toBeNull();
    });

    it('is still waiting after the page is reloaded before it sends', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new TypeError('Failed to fetch'));
      const user = await thePage();
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      await screen.findByText('Waiting to send');

      await reloaded(user);

      expect(
        await screen.findByText('Ask Ada about the backup window', {}, { timeout: 2_000 }),
      ).toBeVisible();
      expect(rowOf('Ask Ada about the backup window').getByText('Waiting to send')).toBeVisible();
    });

    /**
     * An expired sign-in sends you to the logon page, which empties the
     * browser of everything the last visit held (`session/forget.ts`) - and a
     * waiting capture is not the visit's, it is the person's.
     */
    it('is still waiting after the sign-in expired and the logon page emptied the browser', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(401, 'not signed in'));
      const user = await thePage();
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      await screen.findByText('Waiting to send');

      await forgetEverything(user.client);
      await reloaded(user);

      expect(await screen.findByText('Waiting to send', {}, { timeout: 2_000 })).toBeVisible();
      expect(rowOf('Ask Ada about the backup window').getByText('Waiting to send')).toBeVisible();
    });

    it('takes a second capture at once while the first is still sending, and both wait', async () => {
      vi.mocked(sendCommand).mockImplementation(() => new Promise(() => {}));
      const user = await thePage();

      await user.type(box(), 'The first one');
      await user.click(chip('Capture'));
      await waitFor(() => expect(box()).toHaveValue(''));
      await user.type(box(), 'The second one');
      await user.click(chip('Capture'));

      await waitFor(() => expect(box()).toHaveValue(''));
      await waitFor(() => expect(screen.getAllByText('Waiting to send')).toHaveLength(2));
    });

    /** Inferred: a private window, or storage refused, still captures - the old way. */
    it.each([
      { situation: 'the server takes it', refuses: null, box: '', alert: null },
      {
        situation: 'there is no connection',
        refuses: new TypeError('Failed to fetch'),
        box: 'Ask Ada about the backup window',
        alert: 'That did not reach the server. Try again.',
      },
    ])('sends directly where nothing can be kept on this device, and $situation', async ({ refuses, box: left, alert }) => {
      const user = await thePage({ store: UNAVAILABLE });
      held.refuses = refuses;

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('Ask Ada about the backup window');
      await waitFor(() => expect(box()).toHaveValue(left));
      if (alert) expect(screen.getByRole('alert')).toHaveTextContent(alert);
      else expect(await screen.findByText('now')).toBeVisible();
    });
  });

  /**
   * The server refusing a capture is the one thing that stops it, and the
   * row says why rather than the note going quietly: its workspace or its type
   * deleted elsewhere while it waited.
   */
  describe('a waiting capture the server refuses says why and can be put back', () => {
    it.each([
      { situation: 'its workspace was deleted meanwhile', because: 'workspace ws-work not found' },
      { situation: 'its type was deleted meanwhile', because: `item type ${THOUGHT.id} not found` },
    ])('reads Not sent with the reason when $situation, and Put back returns the note and its file', async ({ because }) => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, because));
      const user = await thePage();
      await user.click(chip('Thought'));
      await user.click(chip('Work'));
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect(await screen.findByText(`Not sent: ${because}`)).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
      // Chosen afresh before putting it back, so what comes back is visibly the capture's.
      await user.click(chip('Action'));
      await user.click(chip('Any workspace'));
      await user.click(rowOf('Ask Ada about the backup window').getByRole('button', { name: 'Put back' }));

      expect(box()).toHaveValue('Ask Ada about the backup window');
      expect(screen.getByText('photo.png')).toBeVisible();
      expect(chip('Thought')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
      await waitFor(() => expect(screen.queryByText('Just captured')).toBeNull());
      expect(user.outbox.getShown()).toEqual([]);
    });

    it('puts a note back once only, even where it cannot then be taken off the list', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, 'workspace ws-home not found'));
      const kept = browserOutboxStore();
      const user = await thePage({
        store: { ...kept, remove: () => Promise.reject(new Error('storage refused')) },
      });
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      const putBack = await screen.findByRole('button', { name: 'Put back' });

      await user.click(putBack);

      expect(box()).toHaveValue('Ask Ada about the backup window');
      expect(await screen.findByRole('alert')).toHaveTextContent(STILL_LISTED);
      // Still listed, and with nothing left to press that would put it back twice.
      expect(rowOf('Ask Ada about the backup window').getByText(/^Not sent:/)).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Put back' })).toBeNull();
    });
  });

  /**
   * The Capture page's half of the rule ("Make a type where types are managed,
   * not while capturing", issue 203). The window that does make one owns the
   * other half, in tests/unit/components/ManageTypes.test.tsx.
   */
  describe('a type is made where types are managed, and nowhere else', () => {
    it('answers what kind of thing this is with chips alone', async () => {
      await thePage();

      // Nothing in the row is typed into: the dashed box that named a type has
      // gone, and every answer left is one of the chips.
      // And no chip for none either: every Item is some kind of thing, so
      // where *No type* stood there is now only the account's own types.
      const row = within(screen.getByRole('group', { name: 'Type' }));
      expect(row.queryAllByRole('textbox')).toEqual([]);
      expect(row.getAllByRole('button').map((one) => one.textContent)).toEqual([
        'Action',
        'Thought',
        'Read later',
      ]);
    });

    it('asks to capture, and never to make a type', async () => {
      const user = await thePage();

      await user.click(chip('Thought'));
      await user.type(box(), 'Maybe the onboarding is two screens');
      await user.click(chip('Capture'));

      await captured();
      await settled();
      expect(everythingAsked()).toEqual(['capture_item']);
    });
  });

  /**
   * The one thing that stops this page capturing, and it is reachable: deleting
   * every type of the account leaves the question with no answers, and a
   * capture with no type is refused ("every Item has a Type"). The Panel's own
   * *Add an item* row says the same sentence, in
   * tests/unit/components/PanelAddItemForm.test.tsx.
   */
  describe('with no types to give it, capture says so instead of capturing', () => {
    it('shows no chips, says where a type is made, and asks for nothing', async () => {
      const user = await thePage({ types: [] });

      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      const row = within(screen.getByRole('group', { name: 'Type' }));
      expect(row.queryAllByRole('button')).toEqual([]);
      expect(screen.getByText(NO_TYPES)).toBeVisible();
      expect(chip('Capture')).toBeDisabled();
      await settled();
      expect(capturedCalls()).toEqual([]);
    });

    /**
     * "No types yet" is a claim about what the account holds, so it waits for
     * the account to have said - the same guard the window that manages them
     * carries (components/ManageTypes.tsx).
     */
    it('says nothing at all while the account has not answered', async () => {
      await thePage({ types: null });

      const row = within(screen.getByRole('group', { name: 'Type' }));
      expect(row.queryAllByRole('button')).toEqual([]);
      expect(screen.queryByText(NO_TYPES)).toBeNull();
      expect(chip('Capture')).toBeDisabled();
    });

    /**
     * The button is disabled through every one of these, so the shortcut is the
     * way in that arrives - and it used to return having done nothing and said
     * nothing, which is "Find out why the capture-into-a-named-workspace walk
     * fails intermittently" (issue 219) itself. Said out loud rather than
     * swallowed, whichever reason it is.
     */
    it.each([
      { situation: 'the account has none', types: [] as ItemType[], says: NO_TYPES },
      { situation: 'the workspace is still being read', types: null, says: STILL_READING },
    ])('says why on the shortcut when $situation, and keeps the note', async ({ types, says }) => {
      const user = await thePage({ types });

      await user.type(box(), 'Book the venue deposit');
      await user.keyboard('{Control>}{Enter}{/Control}');

      await settled();
      expect(capturedCalls()).toEqual([]);
      expect(screen.getByRole('alert')).toHaveTextContent(says);
      // Still there to try again with, which is what the words promise.
      expect(box()).toHaveValue('Book the venue deposit');
    });

    /**
     * A different answer, not a slower one: with the last workspace gone there
     * is nowhere to capture *into*, and nothing is being read that could change
     * that - so "try that again" would be a promise nothing can keep. Reached
     * by deleting your last workspace elsewhere, since this client is only told
     * the list changed (`api/useServerEvents.ts`) and nothing sends it anywhere.
     */
    it('says there is nowhere to capture into once the last workspace is gone', async () => {
      const user = await thePage();

      held.workspaces = [];
      await user.client.invalidateQueries({ queryKey: ['workspaces'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Work' })).toBeNull());

      await user.type(box(), 'Book the venue deposit');
      await user.keyboard('{Control>}{Enter}{/Control}');

      await settled();
      expect(capturedCalls()).toEqual([]);
      expect(screen.getByRole('alert')).toHaveTextContent(NO_WORKSPACE);
      expect(box()).toHaveValue('Book the venue deposit');
    });
  });

  describe('what you have just captured is listed under the box, newest first', () => {
    it('says nothing at all until something has been captured', async () => {
      await thePage();

      expect(screen.queryByText('Just captured')).toBeNull();
    });

    it('lists the note with what kind of thing it is, where it went and how long ago', async () => {
      const user = await thePage();

      await user.click(chip('Work'));
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      const row = await waitFor(() => rowOf('Book the venue deposit'));
      expect(row.getByText('Action')).toBeInTheDocument();
      expect(row.getByText('Work')).toBeInTheDocument();
      expect(await row.findByText('now')).toBeInTheDocument();
    });

    it('says a note left for later belongs to no workspace yet', async () => {
      const user = await thePage();

      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect(await waitFor(() => rowOf('Where does this go').getByText('Any workspace'))).toBeInTheDocument();
    });

    it('puts the note just captured above the one before it', async () => {
      const user = await thePage();

      await user.type(box(), 'The first one');
      await user.click(chip('Capture'));
      await waitFor(() => expect(box()).toHaveValue(''));
      await user.type(box(), 'The second one');
      await user.click(chip('Capture'));

      await waitFor(() => expect(justCaptured()).toHaveLength(2));
      const rows = justCaptured();
      expect(within(rows[0]!).getByText('The second one')).toBeInTheDocument();
      expect(within(rows[1]!).getByText('The first one')).toBeInTheDocument();
    });

    it.each([
      { situation: 'landed', answer: () => Promise.resolve({ ok: true as const, applied: true }), reads: 'now' },
      { situation: 'waiting', answer: () => Promise.reject(new TypeError('Failed to fetch')), reads: 'Waiting to send' },
    ])('says how a capture stands once it is $situation', async ({ answer, reads }) => {
      vi.mocked(sendCommand).mockImplementation(answer);
      const user = await thePage();

      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect(await waitFor(() => rowOf('Book the venue deposit').getByText(reads))).toBeVisible();
    });

    it('lists only what is waiting or refused after a reload, the landed ones dropping off', async () => {
      vi.mocked(sendCommand).mockImplementation((_name, payload) =>
        (payload as { message: string }).message === 'Landed'
          ? Promise.resolve({ ok: true as const, applied: true })
          : (payload as { message: string }).message === 'Refused'
            ? Promise.reject(new CommandRefused(404, 'workspace ws-home not found'))
            : Promise.reject(new TypeError('Failed to fetch')),
      );
      const user = await thePage();
      for (const note of ['Landed', 'Refused', 'Waiting']) {
        await user.type(box(), note);
        await user.click(chip('Capture'));
        await waitFor(() => expect(box()).toHaveValue(''));
      }
      await waitFor(() => expect(justCaptured()).toHaveLength(3));

      await reloaded(user);

      await waitFor(() => expect(justCaptured()).toHaveLength(2));
      expect(rowOf('Waiting').getByText('Waiting to send')).toBeVisible();
      expect(rowOf('Refused').getByText('Not sent: workspace ws-home not found')).toBeVisible();
      expect(screen.queryByText('Landed')).toBeNull();
    });
  });

  /**
   * "Drop files and paste images while capturing a message", issue 557. There
   * is no Item yet to attach to, so a file dropped or pasted waits as a chip
   * in the box until Capture makes one; what actually lands in R2 is proved
   * through the real interface in apps/api/tests/integration/http/attachments.test.ts.
   */
  describe('a file dropped or pasted anywhere on the form queues as an attachment, never as text', () => {
    it.each([
      { situation: 'the message box', target: () => box() },
      { situation: 'empty space on the form', target: () => chip('Any workspace') },
    ])('queues one dropped on $situation, highlighting the form while it is dragged over', async ({ target }) => {
      await thePage();

      fireEvent.dragOver(target(), carrying(aPhoto()));
      expect(box().closest('form')).toHaveClass('ring-accent');
      fireEvent.drop(target(), carrying(aPhoto()));

      expect(box().closest('form')).not.toHaveClass('ring-accent');
      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it('queues several files dropped at once, all of them', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aPhoto(), aFile('doc.pdf', 'application/pdf')));

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByText('doc.pdf')).toBeVisible();
    });

    it('queues a file pasted with the cursor in the message box, and writes nothing into it', async () => {
      const user = await thePage();
      await user.type(box(), 'Ask Ada');

      fireEvent.paste(box(), { clipboardData: { files: [aPhoto()], types: ['Files'], getData: () => '' } });

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(box()).toHaveValue('Ask Ada');
    });

    it('queues a file pasted with the cursor on no field', async () => {
      await thePage();

      fireEvent.paste(chip('Action'), {
        clipboardData: { files: [aPhoto()], types: ['Files'], getData: () => '' },
      });

      expect(await screen.findByText('photo.png')).toBeVisible();
    });

    it('lets a queued chip be removed before Capture is pressed', async () => {
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');

      await user.click(screen.getByRole('button', { name: 'Remove photo.png' }));

      expect(screen.queryByText('photo.png')).toBeNull();
    });
  });

  /**
   * Found after shipping: the form gave no sign that dropping or pasting a
   * file was possible at all. Mirrors the Item form's own Attachments box -
   * a "Drag a file here, or" hint and an Add button, both shown whether or
   * not anything is queued yet.
   */
  describe('an Add button and a drag hint say a file can be attached, before anyone has tried', () => {
    it('always shows the drag hint and the Add button, even with nothing queued', async () => {
      await thePage();

      expect(screen.getByText('Drag a file here, or')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add' })).toBeVisible();
    });

    it('replaces the drag hint with the chip once something is queued', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aPhoto()));

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.queryByText('Drag a file here, or')).toBeNull();
    });

    it('queues a file chosen through the picker the same way a dropped one queues', async () => {
      const user = await thePage();

      await user.upload(screen.getByLabelText('Files to attach'), aPhoto());

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    it('queues several files chosen at once, all of them', async () => {
      const user = await thePage();

      await user.upload(screen.getByLabelText('Files to attach'), [
        aPhoto(),
        aFile('doc.pdf', 'application/pdf'),
      ]);

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByText('doc.pdf')).toBeVisible();
    });

    it('refuses a disallowed file chosen through the picker, the same as a dropped one', async () => {
      const user = await thePage();

      await user.upload(screen.getByLabelText('Files to attach'), aFile('notes.txt', 'text/plain'));

      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
      expect(screen.queryByText('notes.txt')).toBeNull();
    });
  });

  describe('a queued file is checked against the allowlist and the 25MB cap before it queues', () => {
    it('refuses an oversized file by name, and does not queue it', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aFile('huge.png', 'image/png', MAX_ATTACHMENT_SIZE + 1)));

      expect(screen.getByRole('alert')).toHaveTextContent('"huge.png" is over the 25 MB limit.');
      expect(screen.queryByText('huge.png')).toBeNull();
    });

    it('refuses a disallowed type by name, and does not queue it', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aFile('notes.txt', 'text/plain')));

      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
      expect(screen.queryByText('notes.txt')).toBeNull();
    });

    it('queues the valid files in a multi-file drop even where one is refused', async () => {
      await thePage();

      fireEvent.drop(box(), carrying(aFile('notes.txt', 'text/plain'), aPhoto()));

      expect(await screen.findByText('photo.png')).toBeVisible();
      expect(screen.getByRole('alert')).toHaveTextContent('"notes.txt" is not a kind of file Cockpit accepts.');
    });
  });

  describe('queued files upload to the item only once Capture has made it', () => {
    it('clears the chip queue once Capture is pressed, before any upload resolves', async () => {
      vi.mocked(uploadAttachment).mockImplementation(() => new Promise(() => {}));
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      await waitFor(() => expect(screen.queryByText('photo.png')).toBeNull());
    });

    it('sends each queued file as an attachment against the item Capture just made', async () => {
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      const { payload } = await captured();
      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenCalledWith(
          expect.objectContaining({ itemId: payload.itemId, workspaceId: 'ws-home', file: aPhotoFile }),
        ),
      );
    });

    it('attaches each note’s files to its own item when a second is captured while the first is still uploading', async () => {
      let resolveFirst: (value: { ok: true; applied: true }) => void = () => {};
      vi.mocked(uploadAttachment).mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      );
      const user = await thePage();

      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'First note');
      await user.click(chip('Capture'));
      await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(1));

      fireEvent.drop(box(), carrying(aFile('second.pdf', 'application/pdf')));
      await screen.findByText('second.pdf');
      await user.type(box(), 'Second note');
      await user.click(chip('Capture'));
      // Made at once, though the first is still out.
      await waitFor(() => expect(box()).toHaveValue(''));

      await act(async () => resolveFirst({ ok: true, applied: true }));
      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            itemId: capturedCalls()[1]!.payload.itemId,
            file: expect.objectContaining({ name: 'second.pdf' }),
          }),
        ),
      );
    });
  });

  describe('a refused file is named as not sent, without undoing the capture', () => {
    it('names every refused file, still attaches the others, and leaves the item captured', async () => {
      vi.mocked(uploadAttachment).mockImplementation((args) =>
        args.file.name === 'photo.png'
          ? Promise.resolve({ ok: true as const, applied: true })
          : Promise.reject(new CommandRefused(415, `"${args.file.name}" could not be attached.`)),
      );
      const user = await thePage();
      fireEvent.drop(
        box(),
        carrying(aPhoto(), aFile('one.pdf', 'application/pdf'), aFile('two.pdf', 'application/pdf')),
      );
      await screen.findByText('one.pdf');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      await captured();
      const notSent = await screen.findByText(/^Not sent:/);
      expect(notSent).toHaveTextContent('"one.pdf" could not be attached.');
      expect(notSent).toHaveTextContent('"two.pdf" could not be attached.');
      expect(uploadAttachment).toHaveBeenCalledTimes(3);
      expect(capturedCalls()).toHaveLength(1);
    });

    it('puts back only the refused file, the note having landed', async () => {
      vi.mocked(uploadAttachment).mockRejectedValue(new CommandRefused(415, '"doc.pdf" could not be attached.'));
      const user = await thePage();
      fireEvent.drop(box(), carrying(aFile('doc.pdf', 'application/pdf')));
      await screen.findByText('doc.pdf');
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      await user.click(await screen.findByRole('button', { name: 'Put back' }));

      expect(box()).toHaveValue('');
      expect(await screen.findByText('doc.pdf')).toBeVisible();
    });
  });

  /**
   * "Set a priority and a due date while capturing" (issue 611). The clock is
   * a Wednesday, the last day of September, so *Tmrw* crosses into October.
   */
  describe('one click sets a priority or a due date, and pressing the lit one again clears it', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 30, 12) });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const pressed = (name: string) => chip(name).getAttribute('aria-pressed') === 'true';
    const aDate = (day: string) =>
      fireEvent.change(screen.getByLabelText('Due date'), { target: { value: day } });
    const captureANote = async (user: Awaited<ReturnType<typeof thePage>>) => {
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));
    };

    it('lights one priority at a time and captures it', async () => {
      const user = await thePage();

      await user.click(chip('High priority'));
      expect([pressed('Low priority'), pressed('Normal priority'), pressed('High priority')]).toEqual([
        false,
        false,
        true,
      ]);
      await user.click(chip('Low priority'));
      expect([pressed('Low priority'), pressed('High priority')]).toEqual([true, false]);
      await captureANote(user);

      expect((await captured()).payload.priority).toBe('low');
    });

    it('clears a priority pressed while lit, and captures none', async () => {
      const user = await thePage();

      await user.click(chip('High priority'));
      await user.click(chip('High priority'));

      expect(pressed('High priority')).toBe(false);
      await captureANote(user);
      expect((await captured()).payload).not.toHaveProperty('priority');
    });

    it('lights one due shortcut at a time, sending the day it names', async () => {
      const user = await thePage();

      await user.click(chip('Tmrw'));
      expect(pressed('Tmrw')).toBe(true);
      await user.click(chip('Today'));
      expect([pressed('Today'), pressed('Tmrw')]).toEqual([true, false]);
      await user.click(chip('Tmrw'));
      await captureANote(user);

      expect((await captured()).payload.dueDate).toBe('2026-10-01');
    });

    it('offers exactly Today, Tmrw and +7d, in that order', async () => {
      await thePage();

      const offered = within(screen.getByRole('group', { name: 'Due' }))
        .getAllByRole('button', { name: /^(Today|Tmrw|Fri|\+7d)$/ })
        .map((button) => button.textContent);

      expect(offered).toEqual(['Today', 'Tmrw', '+7d']);
    });

    it('clears a due shortcut pressed while lit, and captures no due date', async () => {
      const user = await thePage();

      await user.click(chip('Tmrw'));
      await user.click(chip('Tmrw'));

      expect(pressed('Tmrw')).toBe(false);
      await captureANote(user);
      expect((await captured()).payload).not.toHaveProperty('dueDate');
    });

    it('shows a picked day that is no shortcut on the date button with a ✕, and the ✕ clears it', async () => {
      const user = await thePage();

      // The coming Friday, which *Fri* used to light.
      aDate('2026-10-02');

      expect(chip(`Due ${dueDateLabel('2026-10-02')}`)).toBeVisible();
      expect([pressed('Today'), pressed('Tmrw'), pressed('+7d')]).toEqual([false, false, false]);
      await user.click(chip('Clear the due date'));
      expect(chip('Pick a due date')).toBeVisible();
      await captureANote(user);
      expect((await captured()).payload).not.toHaveProperty('dueDate');
    });

    it('lights the shortcut a picked day happens to be', async () => {
      await thePage();

      aDate('2026-10-07');

      expect(pressed('+7d')).toBe(true);
    });

    it('lights Tmrw when tomorrow is picked in the date picker', async () => {
      await thePage();

      aDate('2026-10-01');

      expect(pressed('Tmrw')).toBe(true);
    });
  });

  describe('priority and due date start empty for each note, and a refused capture keeps them', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'], now: new Date(2026, 8, 30, 12) });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it('resets both once a capture lands, while Type and Where keep their choice', async () => {
      const user = await thePage();
      await user.click(chip('Thought'));
      await user.click(chip('Work'));
      await user.click(chip('High priority'));
      await user.click(chip('Today'));

      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      expect((await captured()).payload).toMatchObject({ priority: 'high', dueDate: '2026-09-30' });
      await waitFor(() => expect(chip('High priority')).toHaveAttribute('aria-pressed', 'false'));
      expect(chip('Today')).toHaveAttribute('aria-pressed', 'false');
      expect(chip('Thought')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
    });

    it('keeps the note, the priority and the due date when a direct capture is refused', async () => {
      const user = await thePage({ store: UNAVAILABLE });
      held.refuses = new CommandRefused(404, 'That workspace is gone.');
      await user.click(chip('Normal priority'));
      await user.click(chip('+7d'));

      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      await screen.findByRole('alert');
      expect(box()).toHaveValue('Send the invoice');
      expect(chip('Normal priority')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('+7d')).toHaveAttribute('aria-pressed', 'true');
    });

    it('sends them with a capture the outbox kept, and Put back returns them with the note', async () => {
      vi.mocked(sendCommand).mockRejectedValue(new CommandRefused(404, 'workspace ws-home not found'));
      const user = await thePage();
      await user.click(chip('Low priority'));
      await user.click(chip('Tmrw'));
      await user.type(box(), 'Send the invoice');
      await user.click(chip('Capture'));

      expect((await captured()).payload).toMatchObject({ priority: 'low', dueDate: '2026-10-01' });
      await screen.findByText(/^Not sent:/);
      expect(chip('Low priority')).toHaveAttribute('aria-pressed', 'false');
      await user.click(rowOf('Send the invoice').getByRole('button', { name: 'Put back' }));

      expect(box()).toHaveValue('Send the invoice');
      expect(chip('Low priority')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Tmrw')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  describe('dictation is offered only where the browser can recognise speech', () => {
    it('draws the mic and its language tag where there is an engine, and neither where there is none', async () => {
      const { engine } = anEngine();
      const withOne = await thePage({ dictating: { engine } });
      expect(mic()).toBeInTheDocument();
      expect(tag()).toHaveTextContent('EN');
      withOne.unmount();

      await thePage({ dictating: { engine: null } });
      expect(screen.queryByRole('button', { name: 'Dictate' })).toBeNull();
      expect(screen.queryByRole('button', { name: /^Dictation language/ })).toBeNull();
      // The strip is otherwise as it was.
      expect(chip('Normal priority')).toBeInTheDocument();
      expect(chip('Pick a due date')).toBeInTheDocument();
    });
  });

  describe('what is said is added to the note, stays editable, and is kept only when Capture is pressed', () => {
    it.each([
      ['an empty note', '', 'buy oat milk', 'buy oat milk'],
      ['typed text', 'Remember to', 'buy oat milk', 'Remember to buy oat milk'],
    ])('adds a phrase to %s', async (_situation, typed, said, expected) => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      if (typed) await user.type(box(), typed);
      await user.click(mic());
      current().begins();

      current().says(said);

      expect(box()).toHaveValue(expected);
    });

    it('adds each phrase across pauses in order, none lost and none repeated', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();

      current().says('first thing');
      current().says('second thing');
      // A pause and a restart, after which the engine counts from the start again.
      current().endsOnItsOwn();
      current().begins();
      current().says('third thing');

      expect(box()).toHaveValue('first thing second thing third thing');
    });

    it('shows a phrase still being recognised, then replaces it with its final reading', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();

      current().says('send the inv', false);
      expect(box()).toHaveValue('send the inv');
      current().says('send the invoice', false, true);
      expect(box()).toHaveValue('send the invoice');
      current().says('Send the invoice.', true, true);

      expect(box()).toHaveValue('Send the invoice.');
    });

    it('captures the note as edited after it was dictated', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().says('send the invoice to Ada');
      await user.click(mic());

      await user.clear(box());
      await user.type(box(), 'Send the invoice to Bea');
      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('Send the invoice to Bea');
    });

    it('captures nothing when it is dictated, stopped, and closed without pressing Capture', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().says('this is never captured');
      await user.click(mic());

      user.unmount();
      await settled();

      expect(everythingAsked()).not.toContain('capture_item');
    });

    it('keeps what was still being recognised when Capture is pressed', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().says('almost finished', false);

      await user.click(chip('Capture'));

      expect((await captured()).payload.message).toBe('almost finished');
    });

    it('does not add a phrase twice when it was typed over while still being recognised', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().says('buy milk', false);
      const heardIt = current();

      await user.type(box(), '!');
      // The engine's late final reading of the phrase belongs to a session that was let go.
      heardIt.says('buy milk', true, true);
      await user.click(mic());

      expect(box()).toHaveValue('buy milk!');
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
    });
  });

  describe('what one listening session heard lands in the note once, as the engine’s latest reading of it, whichever way the engine reports it', () => {
    it.each([
      ['a reading that grows, as on an Android phone', ['at', 'at a', 'at a dark mode option'], 'at a dark mode option'],
      ['a reading that corrects an earlier word', ['at a', 'add a dark mode'], 'add a dark mode'],
      ['phrases that are separate, as at a desk', ['add a', 'dark mode'], 'add a dark mode'],
    ])('reads once for %s', async (_situation, readings, expected) => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();

      current().saysSoFar(...readings);

      expect(box()).toHaveValue(expected);
    });

    it('never replaces what an earlier listening session heard with a later session’s reading', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().saysSoFar('add', 'add a note');
      current().endsOnItsOwn();
      current().begins();

      current().saysSoFar('and', 'and another');

      expect(box()).toHaveValue('add a note and another');
    });

    it('never replaces text that was typed before dictating', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.type(box(), 'Idea:');
      await user.click(mic());
      current().begins();

      current().saysSoFar('add', 'add a', 'add a dark mode option');

      expect(box()).toHaveValue('Idea: add a dark mode option');
    });

    it('does not add the words again when they were typed over while the engine still reported them', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().saysSoFar('buy', 'buy milk');
      const heardIt = current();

      await user.type(box(), '!');
      // The engine's longer reading of those words belongs to a session that was let go.
      heardIt.saysSoFar('buy milk and eggs');

      expect(box()).toHaveValue('buy milk!');
    });

    it('keeps the latest reading once when the engine fails part way', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();
      current().saysSoFar('call', 'call the', 'call the dentist');

      current().fails('network');

      expect(box()).toHaveValue('call the dentist');
    });
  });

  describe('the mic shows as listening only once the engine has started, and keeps going until it is tapped off', () => {
    it('is not listening until the engine reports it started, and then is', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });

      await user.click(mic());
      expect(current().asked).toBe(true);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');

      current().begins();
      expect(mic()).toHaveAttribute('aria-pressed', 'true');
    });

    it('starts a new session when the engine ends on its own, and still shows as listening', async () => {
      const { engine, current, sessions } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();

      current().endsOnItsOwn();
      expect(sessions()).toHaveLength(2);
      current().begins();

      expect(mic()).toHaveAttribute('aria-pressed', 'true');
    });

    it('stops when the mic is tapped, and starts no new session', async () => {
      const { engine, current, sessions } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      const listening = current();
      listening.begins();

      await user.click(mic());
      listening.endsOnItsOwn();

      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect(listening.aborted).toBe(true);
      expect(sessions()).toHaveLength(1);
    });

    it('stops listening when Capture is pressed', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      const listening = current();
      listening.begins();
      listening.says('buy oat milk');

      await user.click(chip('Capture'));

      expect(listening.aborted).toBe(true);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
      expect((await captured()).payload.message).toBe('buy oat milk');
    });

    it('stops the engine when Capture is closed while listening', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      const listening = current();
      listening.begins();

      user.unmount();

      expect(listening.aborted).toBe(true);
    });
  });

  describe('dictation is in one language at a time, English to start with, and remembers the last choice on this device', () => {
    afterEach(() => vi.restoreAllMocks());

    it.each(['nl', 'nl-BE', 'fr-FR'])('starts on English when the browser is set to %s', async (browser) => {
      vi.spyOn(navigator, 'language', 'get').mockReturnValue(browser);
      const { engine } = anEngine();
      await thePage({ dictating: { engine } });

      expect(tag()).toHaveTextContent('EN');
    });

    it('starts on Dutch where Dutch was chosen before', async () => {
      const { engine } = anEngine();
      await thePage({ dictating: { engine }, language: 'nl' });

      expect(tag()).toHaveTextContent('NL');
    });

    it('switches with the tag, listens in the new language next, and remembers it', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });

      await user.click(tag());
      expect(tag()).toHaveTextContent('NL');
      await user.click(mic());

      expect(current().lang).toBe('nl-NL');
      expect(localStorage.getItem('cockpit.dictation-language')).toBe('nl');
    });

    it('listens in English until the tag is pressed', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());

      expect(current().lang).toBe('en-US');
    });

    it('starts on English without an error where storage is unavailable', async () => {
      const { engine } = anEngine();
      const refusing = {
        getItem: () => {
          throw new Error('refused');
        },
        setItem: () => {
          throw new Error('refused');
        },
      } as unknown as Storage;
      const user = await thePage({ dictating: { engine, store: refusing } });

      expect(tag()).toHaveTextContent('EN');
      await user.click(tag());
      expect(tag()).toHaveTextContent('NL');
    });

    it('cannot be switched while listening', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().begins();

      expect(tag()).toBeDisabled();
      await user.click(mic());
      expect(tag()).toBeEnabled();
    });
  });

  describe('when dictation cannot run, one line under the strip says why and the mic goes back to off', () => {
    it.each([
      ['the microphone is blocked', 'not-allowed', DICTATION_BLOCKED],
      ['there is no microphone', 'audio-capture', DICTATION_NO_MICROPHONE],
      ['there is no connection', 'network', DICTATION_OFFLINE],
    ])('says so when %s', async (_situation, code, line) => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());

      current().fails(code);

      expect(screen.getByRole('alert')).toHaveTextContent(line);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
    });

    it('keeps the words dictated before an error and does not start again', async () => {
      const { engine, current, sessions } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      const listening = current();
      listening.begins();
      listening.says('already said');

      listening.fails('network');
      listening.endsOnItsOwn();

      expect(box()).toHaveValue('already said');
      expect(sessions()).toHaveLength(1);
      expect(mic()).toHaveAttribute('aria-pressed', 'false');
    });

    it('clears the line once the next start succeeds', async () => {
      const { engine, current } = anEngine();
      const user = await thePage({ dictating: { engine } });
      await user.click(mic());
      current().fails('network');
      expect(screen.getByRole('alert')).toBeInTheDocument();

      await user.click(mic());
      current().begins();

      expect(screen.queryByRole('alert')).toBeNull();
    });
  });

  describe('the attachment line names paste with this keyboard\'s key', () => {
    it.each([
      ['a Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15', '⌘V'],
      ['an iPad', 'Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)', '⌘V'],
      ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0', 'Ctrl V'],
      ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) Firefox/131.0', 'Ctrl V'],
    ])('on %s it says %s', (_keyboard, userAgent, key) => {
      expect(pasteKeyFor(userAgent)).toBe(key);
    });
  });
});

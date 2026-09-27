import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MAX_ATTACHMENT_SIZE, type Item, type ItemType } from '@cockpit/shared';
import { CommandRefused, uploadAttachment } from '../../../src/api/client';
import { CaptureNote, NO_WORKSPACE, STILL_READING } from '../../../src/components/CaptureNote';
import { NO_TYPES } from '../../../src/itemTypes';

vi.mock('../../../src/api/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/api/client')>()),
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
 * The API client is the only thing replaced, so what capturing does is the real
 * `useCapture`.
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
} = {}) {
  held.types = types;
  held.items = items;
  held.workspaces = [WORK, HOME];
  held.refuses = null;
  held.pending = false;
  held.settle = () => {};
  localStorage.clear();
  localStorage.setItem('cockpit.last-visited.workspace', cameFrom);

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
  render(
    <QueryClientProvider client={client}>
      <CaptureNote startsIn={startsIn} />
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
  return Object.assign(userEvent.setup(), { client });
}

const box = () => screen.getByLabelText('What is on your mind?');
const chip = (name: string) => screen.getByRole('button', { name });
const capturedCalls = () =>
  held.mutate.mock.calls.map(([args]) => args).filter((args) => args.name === 'capture_item');
const captured = () => capturedCalls()[0];
const everythingAsked = () => held.mutate.mock.calls.map(([args]) => args.name);
const justCaptured = () => screen.queryAllByRole('listitem');

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
    held.mutate.mockClear();
    held.asksForTypesOnTheirOwn.mockClear();
    vi.mocked(uploadAttachment).mockClear();
    vi.mocked(uploadAttachment).mockResolvedValue({ ok: true as const, applied: true });
  });

  describe('the capture page writes down a note, what kind of thing it is, and where it goes', () => {
    it('captures against the workspace you came from, saying where it belongs is undecided', async () => {
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect(captured().payload.message).toBe('Ask Ada about the backup window');
      // The workspace it was captured from is still recorded: it is an honest
      // fact, and it is what the foreign key needs.
      expect(captured().payload.workspaceId).toBe('ws-home');
      expect(captured().payload.workspaceDecided).toBe(false);
    });

    it('opens on the type used last, and captures whichever chip is lit', async () => {
      const user = await thePage();

      // Lit before anything is pressed: the type you want is nearly always the
      // one you just used.
      expect(chip('Action')).toHaveAttribute('aria-pressed', 'true');
      await user.click(chip('Thought'));
      await user.type(box(), 'Maybe the onboarding is two screens');
      await user.click(chip('Capture'));

      expect(captured().payload.typeId).toBe(THOUGHT.id);
    });

    it('captures into a workspace once one is chosen, and says that is where it belongs', async () => {
      const user = await thePage();

      await user.click(chip('Work'));
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect(captured().payload.workspaceId).toBe('ws-work');
      expect(captured().payload.workspaceDecided).toBeUndefined();
    });

    it('starts Where on the workspace it was opened in, and captures into it as decided', async () => {
      const user = await thePage({ startsIn: 'ws-work' });

      expect(chip('Work')).toHaveAttribute('aria-pressed', 'true');
      expect(chip('Any workspace')).toHaveAttribute('aria-pressed', 'false');
      await user.type(box(), 'Book the venue deposit');
      await user.click(chip('Capture'));

      expect(captured().payload.workspaceId).toBe('ws-work');
      expect(captured().payload.workspaceDecided).toBeUndefined();
    });

    it('holds a different workspace, once chosen, for every note captured after it', async () => {
      const user = await thePage({ startsIn: 'ws-work' });

      await user.click(chip('Home'));
      await user.type(box(), 'First for the customer');
      await user.click(chip('Capture'));
      await user.type(box(), 'Second for the customer');
      await user.click(chip('Capture'));

      const asked = held.mutate.mock.calls.map(([args]) => args.payload.workspaceId);
      expect(asked).toEqual(['ws-home', 'ws-home']);
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

      expect(captured().payload.typeId).toBe(ACTION.id);
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

      expect(captured().payload.workspaceId).toBe('ws-home');
      expect(captured().payload.workspaceDecided).toBe(false);
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

      expect(captured().payload.workspaceId).toBe('ws-work');
      expect(captured().payload.workspaceDecided).toBe(false);
    });

    it('captures nothing at all for an empty note', async () => {
      const user = await thePage();

      await user.click(chip('Capture'));

      expect(captured()).toBeUndefined();
    });

    it('captures on the key under the hand, without reaching for the button', async () => {
      const user = await thePage();

      await user.type(box(), 'Two lines{Shift>}{Enter}{/Shift}and a second');
      await user.keyboard('{Control>}{Enter}{/Control}');

      expect(captured().payload.message).toBe('Two lines\nand a second');
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

      expect(captured().payload.message).toBe('Book the venue deposit');
      expect(captured().payload.typeId).toBe(ACTION.id);
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

  describe('the box empties for the next note, and a note that could not be captured comes back', () => {
    it('empties once the capture has been asked for', async () => {
      const user = await thePage();

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect(box()).toHaveValue('');
    });

    it('puts the note back and says why when the capture is refused', async () => {
      const user = await thePage();
      held.refuses = new CommandRefused(404, 'workspace ws-home not found');

      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));

      expect(screen.getByRole('alert')).toHaveTextContent('workspace ws-home not found');
      expect(box()).toHaveValue('Ask Ada about the backup window');
      expect(justCaptured()).toHaveLength(0);
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
      expect(captured()).toBeUndefined();
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

      expect(captured()).toBeUndefined();
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

      expect(captured()).toBeUndefined();
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

      const row = within(justCaptured()[0]!);
      expect(row.getByText('Book the venue deposit')).toBeInTheDocument();
      expect(row.getByText('Action')).toBeInTheDocument();
      expect(row.getByText('Work')).toBeInTheDocument();
      expect(row.getByText('now')).toBeInTheDocument();
    });

    it('says a note left for later belongs to no workspace yet', async () => {
      const user = await thePage();

      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect(within(justCaptured()[0]!).getByText('Any workspace')).toBeInTheDocument();
    });

    it('puts the note just captured above the one before it', async () => {
      const user = await thePage();

      await user.type(box(), 'The first one');
      await user.click(chip('Capture'));
      await user.type(box(), 'The second one');
      await user.click(chip('Capture'));

      const rows = justCaptured();
      expect(rows).toHaveLength(2);
      expect(within(rows[0]!).getByText('The second one')).toBeInTheDocument();
      expect(within(rows[1]!).getByText('The first one')).toBeInTheDocument();
    });

    it('lists nothing for a capture that was refused', async () => {
      const user = await thePage();
      held.refuses = new CommandRefused(404, 'workspace ws-home not found');

      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect(screen.queryByText('Just captured')).toBeNull();
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
    it('clears the chip queue the moment Capture is pressed, before any upload resolves', async () => {
      let resolveUpload: (value: { ok: true; applied: true }) => void = () => {};
      vi.mocked(uploadAttachment).mockImplementationOnce(
        () => new Promise((resolve) => (resolveUpload = resolve)),
      );
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      expect(screen.queryByText('photo.png')).toBeNull();
      await act(async () => resolveUpload({ ok: true, applied: true }));
    });

    it('sends each queued file as an attachment against the item Capture just made', async () => {
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenCalledWith(
          expect.objectContaining({
            itemId: captured().payload.itemId,
            workspaceId: 'ws-home',
            file: aPhotoFile,
          }),
        ),
      );
    });

    it('does not block or cross-attach when a second note is captured while the first note’s file is still uploading', async () => {
      let resolveFirst: (value: { ok: true; applied: true }) => void = () => {};
      vi.mocked(uploadAttachment).mockImplementationOnce(
        () => new Promise((resolve) => (resolveFirst = resolve)),
      );
      const user = await thePage();

      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'First note');
      await user.click(chip('Capture'));

      fireEvent.drop(box(), carrying(aFile('second.pdf', 'application/pdf')));
      await screen.findByText('second.pdf');
      await user.type(box(), 'Second note');
      await user.click(chip('Capture'));

      await waitFor(() =>
        expect(uploadAttachment).toHaveBeenNthCalledWith(
          2,
          expect.objectContaining({
            itemId: capturedCalls()[1]!.payload.itemId,
            file: expect.objectContaining({ name: 'second.pdf' }),
          }),
        ),
      );
      await act(async () => resolveFirst({ ok: true, applied: true }));
    });
  });

  describe('a refused capture puts the queued files back, not just the message', () => {
    it('puts the note text and the queued files back in the box', async () => {
      const user = await thePage();
      held.refuses = new CommandRefused(404, 'workspace ws-home not found');
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      expect(screen.getByRole('alert')).toHaveTextContent('workspace ws-home not found');
      expect(box()).toHaveValue('Ask Ada about the backup window');
      expect(screen.getByText('photo.png')).toBeVisible();
      expect(uploadAttachment).not.toHaveBeenCalled();
    });

    /**
     * Found in review: a file dropped while the previous capture is still
     * waiting on an answer used to queue anyway, and a refusal then replaced
     * it with the older snapshot - losing it with no error and no way to
     * revoke its object URL. Refused so it stays in hand for the next try,
     * instead of being taken and then quietly dropped.
     */
    it('refuses a file dropped while a capture is still in flight, rather than losing it to a later refusal', async () => {
      const user = await thePage({ heldMutation: true });
      fireEvent.drop(box(), carrying(aPhoto()));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');
      await user.click(chip('Capture'));
      expect(screen.queryByText('photo.png')).toBeNull();

      fireEvent.drop(box(), carrying(aFile('backup.pdf', 'application/pdf')));

      expect(screen.queryByText('backup.pdf')).toBeNull();
      held.refuses = new CommandRefused(404, 'workspace ws-home not found');
      await act(async () => held.settle());
      expect(screen.getByText('photo.png')).toBeVisible();
      expect(screen.queryByText('backup.pdf')).toBeNull();
    });
  });

  describe('a file that fails to upload after a successful capture says so, without undoing the capture', () => {
    it('names the failed file, still attaches the others, and leaves the item captured', async () => {
      vi.mocked(uploadAttachment).mockImplementation((args) =>
        args.file.name === 'bad.pdf'
          ? Promise.reject(new CommandRefused(413, '"bad.pdf" could not be attached.'))
          : Promise.resolve({ ok: true as const, applied: true }),
      );
      const user = await thePage();
      fireEvent.drop(box(), carrying(aPhoto(), aFile('bad.pdf', 'application/pdf')));
      await screen.findByText('photo.png');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      expect(captured()).toBeDefined();
      expect(justCaptured()).toHaveLength(1);
      await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
      expect(await screen.findByRole('alert')).toHaveTextContent('"bad.pdf" could not be attached.');
    });

    /**
     * Found in review: each failure inside the upload loop replaced
     * `queueError` instead of joining it, so only the last of several
     * failures was ever shown.
     */
    it('names every file that fails, not just the last one', async () => {
      vi.mocked(uploadAttachment).mockImplementation((args) =>
        Promise.reject(new CommandRefused(413, `"${args.file.name}" could not be attached.`)),
      );
      const user = await thePage();
      fireEvent.drop(box(), carrying(aFile('one.pdf', 'application/pdf'), aFile('two.pdf', 'application/pdf')));
      await screen.findByText('one.pdf');
      await user.type(box(), 'Ask Ada about the backup window');

      await user.click(chip('Capture'));

      await waitFor(() => expect(uploadAttachment).toHaveBeenCalledTimes(2));
      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('"one.pdf" could not be attached.');
      expect(alert).toHaveTextContent('"two.pdf" could not be attached.');
    });
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, ItemType } from '@cockpit/shared';
import { CommandRefused } from '../../../src/api/client';
import { CapturePage } from '../../../src/pages/CapturePage';

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
  /** The types the account holds, which another tab can delete one of. */
  types: [] as unknown[],
  /** The workspaces the account holds, which another tab can delete one of. */
  workspaces: [] as unknown[],
  items: [] as unknown[],
  /** What a capture is refused with, if it is. */
  refuses: null as Error | null,
}));

vi.mock('../../../src/api/queries', () => ({
  useCommand: () => ({ mutate: held.mutate, isPending: false }),
  itemTypesQuery: {
    queryKey: ['itemTypes'],
    queryFn: () => Promise.resolve({ itemTypes: held.types }),
  },
  workspacesQuery: {
    queryKey: ['workspaces'],
    queryFn: () => Promise.resolve({ workspaces: held.workspaces }),
  },
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: () => Promise.resolve({ items: held.items }),
  }),
}));

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
}: {
  types?: ItemType[];
  items?: Item[];
  cameFrom?: string | null;
} = {}) {
  held.types = types;
  held.items = items;
  held.workspaces = [WORK, HOME];
  held.refuses = null;
  localStorage.clear();
  if (cameFrom) localStorage.setItem('cockpit.last-visited.workspace', cameFrom);

  // The real mutation calls back: `onSuccess` is what lists what was captured,
  // and `onError` is what puts the note back and says why.
  held.mutate = vi.fn(
    (_args, options?: { onSuccess?: () => void; onError?: (e: Error) => void }) => {
      if (held.refuses) options?.onError?.(held.refuses);
      else options?.onSuccess?.();
    },
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CapturePage />
    </QueryClientProvider>,
  );
  // Nothing to choose from until the account's types and workspaces arrive.
  await screen.findByRole('button', { name: 'Action' });
  return Object.assign(userEvent.setup(), { client });
}

const box = () => screen.getByLabelText('What is on your mind?');
const chip = (name: string) => screen.getByRole('button', { name });
const captured = () =>
  held.mutate.mock.calls.map(([args]) => args).find((args) => args.name === 'capture_item');
const everythingAsked = () => held.mutate.mock.calls.map(([args]) => args.name);
const justCaptured = () => screen.queryAllByRole('listitem');

describe('Capture', () => {
  beforeEach(() => {
    held.mutate.mockClear();
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

    it('captures with no type when No type is chosen', async () => {
      const user = await thePage();

      // Lit to start with is the type used last, so this is the way back to
      // having said nothing - which is what the box that made a type used to
      // be, by taking the light off every chip.
      await user.click(chip('No type'));
      await user.type(box(), 'Something I have not decided about');
      await user.click(chip('Capture'));

      expect(captured().payload.typeId).toBeUndefined();
    });

    it('falls back to No type when the one chosen is deleted in another tab', async () => {
      const user = await thePage();
      await user.click(chip('Read later'));

      held.types = [ACTION, THOUGHT];
      await user.client.invalidateQueries({ queryKey: ['itemTypes'] });
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Read later' })).toBeNull());

      // Which is what the row now says, rather than nothing being chosen - and
      // what it captures against, rather than a type the account would refuse.
      expect(chip('No type')).toHaveAttribute('aria-pressed', 'true');
      await user.type(box(), 'Where does this go');
      await user.click(chip('Capture'));

      expect(captured().payload.typeId).toBeUndefined();
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
      const row = within(screen.getByRole('group', { name: 'Type' }));
      expect(row.queryAllByRole('textbox')).toEqual([]);
      expect(row.getAllByRole('button').map((one) => one.textContent)).toEqual([
        'No type',
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
});

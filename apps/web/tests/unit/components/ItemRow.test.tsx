import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, ItemStatus } from '@cockpit/shared';
import { ItemRow } from '../../../src/components/ItemRow';
import { UndoWhatJustHappened } from '../../../src/undo';
import { useCommand, useSendCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/queries', () => ({ useCommand: vi.fn(), useSendCommand: vi.fn() }));

const mockUseCommand = vi.mocked(useCommand);
const mockUseSendCommand = vi.mocked(useSendCommand);

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    tenantId: 'tenant-default',
    workspaceId: 'ws-work',
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    title: 'Make appointment with Novy',
    preview: null,
    sourceResolvedAt: null,
    status: 'to_process',
    nextAction: null,
    focusHorizon: null,
    priority: null,
    dueDate: null,
    snoozedUntil: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-08-12T10:00:00.000Z',
    updatedAt: '2026-08-12T10:00:00.000Z',
    ...overrides,
  };
}

/**
 * Renders one row and hands back the changes it asks for.
 *
 * `settles` runs the caller's `onSuccess`, which is what a change that really
 * landed does - and what the offer of an undo waits for.
 */
function aRow({ settles = false, item = anItem() }: { settles?: boolean; item?: Item } = {}) {
  const mutate = vi.fn((_args, options?: { onSuccess?: () => void }) => {
    if (settles) options?.onSuccess?.();
  });
  const send = vi.fn(() => Promise.resolve());
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  mockUseSendCommand.mockReturnValue(send);
  render(
    <UndoWhatJustHappened>
      <ItemRow item={item} workspaceId="ws-work" />
    </UndoWhatJustHappened>,
  );
  return { mutate, send };
}

async function choose(user: ReturnType<typeof userEvent.setup>, option: string) {
  await user.click(screen.getByLabelText('Item actions'));
  await user.click(await screen.findByText(option));
}

describe('Triage', () => {
  describe("a status picked on a row is sent for that row's own item", () => {
    it.each<{ option: string; status: ItemStatus }>([
      { option: 'Mark done', status: 'done' },
      { option: 'Make it a task', status: 'task' },
      { option: 'Waiting on someone', status: 'waiting' },
      { option: 'Dismiss', status: 'dismissed' },
    ])('$option', async ({ option, status }) => {
      const user = userEvent.setup();
      const { mutate } = aRow();

      await choose(user, option);

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('set_status');
      expect(asked.payload.status).toBe(status);
      expect(asked.payload.itemId).toBe('item-1');
    });
  });

  describe('what just happened can be put back, until the offer runs out', () => {
    it('offers a dismissal back, and takes the status the row had', async () => {
      const user = userEvent.setup();
      const { send } = aRow({ settles: true });

      await choose(user, 'Dismiss');
      expect(screen.getByRole('status')).toHaveTextContent(
        '“Make appointment with Novy” dismissed',
      );
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      // The status it had before, read off the row rather than guessed: an
      // item dismissed while it was Waiting comes back Waiting.
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'set_status',
          payload: expect.objectContaining({ itemId: 'item-1', status: 'to_process' }),
        }),
      );
    });

    it('offers a snoozed item back with the date it was waiting for', async () => {
      // Leaving the snoozed state clears the wake date, which dismissing does -
      // so putting only the status back would return a snoozed item with
      // nothing to wake it, and the date would be gone for good.
      const user = userEvent.setup();
      const { send } = aRow({
        settles: true,
        item: anItem({ status: 'snoozed', snoozedUntil: '2026-09-08T08:00:00.000Z' }),
      });

      await choose(user, 'Dismiss');
      await user.click(screen.getByRole('button', { name: 'Undo' }));

      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'snooze_until',
          payload: expect.objectContaining({
            itemId: 'item-1',
            until: '2026-09-08T08:00:00.000Z',
          }),
        }),
      );
    });

    it('offers nothing back while the dismissal is still in flight', async () => {
      const user = userEvent.setup();
      aRow({ settles: false });

      await choose(user, 'Dismiss');

      expect(screen.queryByRole('status')).toBeNull();
    });
  });

  describe('snoozing a row asks for it back one week later', () => {
    it('sets the wake date a week on from when it was asked', async () => {
      const user = userEvent.setup();
      const { mutate } = aRow();

      await choose(user, 'Snooze a week');

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('snooze_until');
      expect(asked.payload.itemId).toBe('item-1');
      // The wake date and the request time are both sampled from the clock a
      // moment apart, so they are compared to each other - the test reads no
      // clock of its own, which an F1 test may not do.
      const week = 7 * 24 * 60 * 60 * 1000;
      const gap = Date.parse(asked.payload.until) - Date.parse(asked.payload.issuedAt);
      expect(gap).toBeLessThanOrEqual(week);
      expect(gap).toBeGreaterThan(week - 5_000);
    });
  });

  describe("a row can be made a goal for today", () => {
    it("sets the focus horizon on that row's own item", async () => {
      const user = userEvent.setup();
      const { mutate } = aRow();

      await choose(user, 'Goal for today');

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('set_focus');
      expect(asked.payload.horizon).toBe('today');
      expect(asked.payload.itemId).toBe('item-1');
    });
  });
});

describe('Triage', () => {
  describe('an Inbox row says how it is being handled in a color and in a word, and how long it has waited', () => {
    /** One row, rendered on its own, with the mark at its head. */
    function markOn(item: Partial<Item>): string {
      mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
      mockUseSendCommand.mockReturnValue(vi.fn(() => Promise.resolve()));
      const { container, unmount } = render(
        <ItemRow item={anItem(item)} workspaceId="ws-work" />,
      );
      const mark = container.querySelector('li > span[aria-hidden="true"]');
      const className = mark?.className ?? '';
      unmount();
      return className;
    }

    // Every status an item can be in while it is still yours to deal with;
    // done and dismissed never reach a list this renders.
    const open: ItemStatus[] = [
      'to_process',
      'task',
      'waiting',
      'snoozed',
      'delegated',
      'reference',
    ];

    it('gives no two of them the same mark, so the list can be read without being read', () => {
      const marks = open.map((status) => markOn({ status }));

      expect(marks.every((mark) => mark !== '')).toBe(true);
      expect(new Set(marks).size).toBe(open.length);
    });

    it('says the status in words too, so the color is never the only thing carrying it', () => {
      mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
      render(<ItemRow item={anItem({ status: 'waiting' })} workspaceId="ws-work" />);

      expect(screen.getByText('Waiting')).toBeInTheDocument();
    });

    it.each([
      { situation: 'has been sitting for days', createdAt: '2026-08-12T10:00:00.000Z', shows: '14d' },
      { situation: 'was captured this morning', createdAt: '2026-08-26T08:00:00.000Z', shows: null },
    ])('an item that $situation', ({ createdAt, shows }) => {
      // The row reads the clock, so the clock is what the test replaces - the
      // arithmetic itself is proved without one in tests/unit/waited.test.ts.
      vi.useFakeTimers();
      vi.setSystemTime(Date.parse('2026-08-26T10:00:00.000Z'));
      try {
        mockUseCommand.mockReturnValue({ mutate: vi.fn(), isPending: false } as never);
        render(<ItemRow item={anItem({ createdAt })} workspaceId="ws-work" />);

        if (shows) expect(screen.getByText(shows)).toBeInTheDocument();
        else expect(screen.queryByTitle(/^Waiting /)).not.toBeInTheDocument();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});

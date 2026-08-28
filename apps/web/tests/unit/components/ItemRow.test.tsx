import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, ItemStatus } from '@cockpit/shared';
import { ItemRow } from '../../../src/components/ItemRow';
import { useCommand } from '../../../src/api/queries';

vi.mock('../../../src/api/queries', () => ({ useCommand: vi.fn() }));

const mockUseCommand = vi.mocked(useCommand);

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

/** Renders one row and hands back the changes it asks for. */
function aRow() {
  const mutate = vi.fn();
  mockUseCommand.mockReturnValue({ mutate, isPending: false } as never);
  render(<ItemRow item={anItem()} workspaceId="ws-work" />);
  return mutate;
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
      const mutate = aRow();

      await choose(user, option);

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('set_status');
      expect(asked.payload.status).toBe(status);
      expect(asked.payload.itemId).toBe('item-1');
    });
  });

  describe('snoozing a row asks for it back one week later', () => {
    it('sets the wake date a week on from when it was asked', async () => {
      const user = userEvent.setup();
      const mutate = aRow();

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
      const mutate = aRow();

      await choose(user, 'Goal for today');

      expect(mutate).toHaveBeenCalledTimes(1);
      const [asked] = mutate.mock.calls[0]!;
      expect(asked.name).toBe('set_focus');
      expect(asked.payload.horizon).toBe('today');
      expect(asked.payload.itemId).toBe('item-1');
    });
  });
});

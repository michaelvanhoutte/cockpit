import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Item, WorkspaceSnapshot } from '@cockpit/shared';
import MarkedDoneWindow from '../../../src/components/MarkedDoneWindow';

/**
 * F1/C: what the window draws from a snapshot - the page of fifty, the empty
 * words, and the ways in and out ("See the items you have marked done, from
 * the header menu", issue 637). Which items it lists and how a row reads is
 * tests/unit/markedDone.test.ts; that the form really stacks over it is the
 * browser pass.
 */
const held = vi.hoisted(() => ({ items: [] as Item[], opened: [] as string[] }));

vi.mock('../../../src/itemForm', () => ({
  useOpenItem: () => (itemId: string) => {
    held.opened.push(itemId);
  },
}));

vi.mock('../../../src/api/queries', () => ({
  snapshotQuery: (workspaceId: string) => ({
    queryKey: ['snapshot', workspaceId],
    queryFn: (): Promise<WorkspaceSnapshot> =>
      Promise.resolve({
        items: held.items,
        dashboards: [],
        panels: [],
        filings: [],
        itemTypes: [],
      } as unknown as WorkspaceSnapshot),
  }),
}));

let next = 0;
function aFinished(title: string, completedAt = new Date().toISOString()): Item {
  next += 1;
  return {
    id: `item-${next}`,
    title,
    description: null,
    nextAction: null,
    typeId: null,
    completedAt,
  } as Item;
}

function many(count: number, titlePrefix = 'Finished'): Item[] {
  return Array.from({ length: count }, (_, i) => aFinished(`${titlePrefix} ${i + 1}`));
}

function Harness({ onClose, returnFocusTo }: { onClose: () => void; returnFocusTo?: HTMLElement | undefined }) {
  const [open, setOpen] = useState(true);
  return (
    <MarkedDoneWindow
      workspaceId="ws-work"
      open={open}
      onClose={() => {
        setOpen(false);
        onClose();
      }}
      returnFocusTo={returnFocusTo}
    />
  );
}

function show(items: Item[], extra: { onClose?: () => void; returnFocusTo?: HTMLElement } = {}) {
  held.items = items;
  held.opened = [];
  render(
    <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
      <Harness onClose={extra.onClose ?? (() => {})} returnFocusTo={extra.returnFocusTo} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}

const rowsDrawn = () => screen.queryAllByRole('listitem').length;

describe('Triage', () => {
  describe('only 50 are drawn until Show more, and a new search starts back at 50', () => {
    it.each([
      { count: 49, drawn: 49, more: false },
      { count: 50, drawn: 50, more: false },
      { count: 51, drawn: 50, more: true },
    ])('$count finished items', async ({ count, drawn, more }) => {
      show(many(count));

      await waitFor(() => expect(rowsDrawn()).toBe(drawn));
      expect(!!screen.queryByRole('button', { name: 'Show more' })).toBe(more);
    });

    it('draws fifty more each time, and starts back at fifty on a new search', async () => {
      const user = show(many(120));
      await waitFor(() => expect(rowsDrawn()).toBe(50));

      await user.click(screen.getByRole('button', { name: 'Show more' }));
      await user.click(screen.getByRole('button', { name: 'Show more' }));
      expect(rowsDrawn()).toBe(120);
      expect(screen.queryByRole('button', { name: 'Show more' })).toBeNull();

      await user.type(screen.getByRole('searchbox'), 'Finished');

      expect(rowsDrawn()).toBe(50);
      expect(screen.getByRole('button', { name: 'Show more' })).toBeVisible();
    });
  });

  describe('opening a row opens that item’s form', () => {
    it('on a click', async () => {
      const item = aFinished('Pay the invoice');
      const user = show([item]);

      await user.click(await screen.findByRole('button', { name: /Pay the invoice/ }));

      expect(held.opened).toEqual([item.id]);
    });

    it('on Enter', async () => {
      const item = aFinished('Pay the invoice');
      const user = show([item]);

      (await screen.findByRole('button', { name: /Pay the invoice/ })).focus();
      await user.keyboard('{Enter}');

      expect(held.opened).toEqual([item.id]);
    });
  });

  describe('closing returns the focus to the entry that opened it', () => {
    it.each([
      {
        way: 'Close',
        close: (user: ReturnType<typeof userEvent.setup>) =>
          user.click(screen.getByRole('button', { name: 'Close' })),
      },
      { way: 'Escape', close: (user: ReturnType<typeof userEvent.setup>) => user.keyboard('{Escape}') },
      {
        way: 'pressing outside',
        close: (user: ReturnType<typeof userEvent.setup>) =>
          user.click(document.querySelector('.bg-black\\/30')!),
      },
    ])('by $way', async ({ close }) => {
      const entry = document.body.appendChild(document.createElement('button'));
      const onClose = vi.fn();
      const user = show(many(1), { onClose, returnFocusTo: entry });
      await screen.findByRole('dialog', { name: 'Marked done' });

      await close(user);

      expect(onClose).toHaveBeenCalled();
      await waitFor(() => expect(document.activeElement).toBe(entry));
    });
  });

  describe('a workspace with nothing finished says so', () => {
    it('when none has been finished, or all were reopened', async () => {
      show([{ ...aFinished('Reopened'), completedAt: null }]);

      expect(await screen.findByText('Nothing has been marked done.')).toBeVisible();
    });

    it('when a search matches nothing', async () => {
      const user = show(many(2));
      await waitFor(() => expect(rowsDrawn()).toBe(2));

      await user.type(screen.getByRole('searchbox'), 'zebra');

      expect(screen.getByText('Nothing finished matches.')).toBeVisible();
    });
  });
});

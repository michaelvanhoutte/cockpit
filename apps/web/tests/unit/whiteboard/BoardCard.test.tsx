import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import type { Item } from '@cockpit/shared';
import { BoardCard } from '../../../src/whiteboard/BoardCard';
import { DEADLINE_PILLS } from '../../../src/dueDate';

/**
 * F1: a card on a whiteboard ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829). Where it sits and what moving it sends
 * are the board's own walk (`tests/e2e/whiteboard.test.ts`); what it draws is
 * here, against the fields its row draws from.
 */
const NOW = Date.parse('2026-11-20T09:00:00.000Z');

function anItem(over: Partial<Item> = {}): Item {
  return {
    id: 'item-1',
    tenantId: 'tenant',
    workspaceId: 'ws',
    workspaceDecided: true,
    source: 'internal',
    sourceId: null,
    sourceLink: null,
    sender: null,
    sourceTimestamp: null,
    capturedMessage: null,
    textsSettledAt: null,
    textsProposedAt: null,
    readings: null,
    proposedPanelId: null,
    proposedPanelReason: null,
    proposedPanelFit: null,
    claudeProposals: null,
    seriesId: null,
    waitingSince: null,
    sourceResolvedAt: null,
    title: 'Ferry scene',
    description: null,
    nextAction: null,
    completedAt: null,
    startedAt: null,
    priority: null,
    prioritySetAt: null,
    dueDateChosenAt: null,
    capturedTimeZone: null,
    dueDate: null,
    dueDateSetAt: null,
    unseen: false,
    deletedAt: null,
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    ...over,
  } as Item;
}

const card = () => screen.getByText('Ferry scene').closest('[data-card]') as HTMLElement;

describe('Whiteboard', () => {
  describe('a card shows what its row shows', () => {
    it('draws the flag, title, status, Next:, due pill and source line from the row’s own fields', () => {
      render(
        <BoardCard
          item={anItem({ priority: 'high', startedAt: '2026-11-19T10:00:00.000Z', nextAction: 'Ring the harbour', dueDate: '2026-11-21', source: 'gmail', sender: 'Bart' })}
          sourceNames={{ gmail: 'Gmail' }}
          now={NOW}
        />,
      );
      const drawn = within(card());
      expect(drawn.getByRole('img', { name: 'High priority' })).toBeVisible();
      expect(drawn.getByText('In progress')).toBeVisible();
      expect(card()).toHaveTextContent('Next: Ring the harbour');
      expect(drawn.getByText('Due tomorrow')).toHaveClass(...DEADLINE_PILLS.near.split(' '));
      expect(drawn.getByText('Gmail · Bart')).toBeVisible();
    });

    it('draws a finished Item done, with no due pill', () => {
      render(<BoardCard item={anItem({ completedAt: '2026-10-10T10:00:00.000Z', dueDate: '2026-11-21' })} sourceNames={{}} now={NOW} />);
      expect(card()).toHaveAttribute('data-done');
      expect(within(card()).getByText('Done')).toBeVisible();
      expect(within(card()).queryByText('Due tomorrow')).toBeNull();
    });

    it('offers the Item’s menu from ⋮', async () => {
      const pressed: { x: number; y: number }[] = [];
      render(<BoardCard item={anItem()} sourceNames={{}} now={NOW} onMenu={(at) => pressed.push(at)} />);
      await userEvent.click(screen.getByRole('button', { name: 'Actions for Ferry scene' }));
      expect(pressed).toHaveLength(1);
    });
  });

  describe('renaming in place draws a field where the title was, and hands the title its clicks', () => {
    it('draws the field in the title’s place while it is renamed, and the title otherwise', () => {
      const { rerender, container } = render(<BoardCard item={anItem()} sourceNames={{}} now={NOW} renaming={<input aria-label="Title" defaultValue="Ferry scene" />} />);
      const drawn = () => within(container.querySelector<HTMLElement>('[data-card]')!);
      expect(drawn().getByRole('textbox', { name: 'Title' })).toHaveValue('Ferry scene');
      expect(drawn().queryByText('Ferry scene')).toBeNull();
      rerender(<BoardCard item={anItem()} sourceNames={{}} now={NOW} />);
      expect(drawn().getByText('Ferry scene')).toBeVisible();
    });

    it('tells the board of a press and a click on the title, and of none elsewhere on the card', async () => {
      const heard: string[] = [];
      render(
        <BoardCard
          item={anItem({ nextAction: 'Ring the harbour' })}
          sourceNames={{}}
          now={NOW}
          titleProps={{ onPointerDownCapture: () => heard.push('press'), onClick: () => heard.push('click') }}
        />,
      );
      await userEvent.click(screen.getByText('Ring the harbour'));
      expect(heard).toEqual([]);
      await userEvent.click(screen.getByText('Ferry scene'));
      expect(heard).toEqual(['press', 'click']);
    });
  });

  describe('a parent’s card unfolds to its children in a grid, in their own order, without placing them', () => {
    const parent = anItem({ id: 'parent', title: 'Ferry scene', childrenCount: 3, childrenDone: 2 });
    const children = ['Harbour', 'Storm', 'Arrival'].map((title, n) => anItem({ id: `child-${n}`, title, ...(n < 2 ? { completedAt: '2026-11-19T10:00:00.000Z' } : {}) }));
    function Parent() {
      const [unfolded, setUnfolded] = useState(false);
      return <BoardCard item={parent} children={children} sourceNames={{}} now={NOW} unfolded={unfolded} onUnfold={() => setUnfolded((was) => !was)} />;
    }

    it.each([
      { situation: 'folded', unfold: false, reads: [] },
      { situation: 'unfolded', unfold: true, reads: ['Harbour', 'Storm', 'Arrival'] },
    ])('$situation', async ({ unfold, reads }) => {
      render(<Parent />);
      expect(within(card()).getByText('2 of 3 done')).toBeVisible();
      if (unfold) await userEvent.click(screen.getByRole('button', { name: 'Unfold Ferry scene' }));
      const inside = screen.queryByRole('list', { name: 'Inside Ferry scene' });
      expect(inside ? within(inside).getAllByRole('listitem').map((one) => one.querySelector('[data-card]')?.getAttribute('data-card')) : []).toEqual(reads);
    });
  });
});

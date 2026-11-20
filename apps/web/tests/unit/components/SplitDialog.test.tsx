import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, createEvent, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Item, SplitProposal, WorkspaceSnapshot } from '@cockpit/shared';
import type { Undoable } from '../../../src/undo';
import SplitDialog from '../../../src/components/SplitDialog';

/**
 * F1: *Split* ("Brainstorming: a note holding several ideas can't be taken
 * apart", issue 1828): the dialog draws the blocks before the proposal arrives,
 * keeps their order, tags each with its card, moves one between cards, and sends
 * one change naming blocks. What the change does to the rows is
 * apps/api/tests/integration/http/split.test.ts; the drag in a real browser, and
 * the layout at desk and phone width, are the F3 walk's.
 */

const held = vi.hoisted(() => ({
  snapshot: null as unknown,
  send: vi.fn(),
  offered: [] as unknown[],
  proposal: null as null | { resolve: (value: unknown) => void; reject: (reason: unknown) => void },
}));

vi.mock('../../../src/api/useSnapshot', () => ({ useSnapshot: () => ({ data: held.snapshot }) }));
vi.mock('../../../src/api/queries', () => ({ useSendCommand: () => held.send }));
vi.mock('../../../src/api/client', () => ({ attachmentUrl: (id: string) => `/files/${id}` }));
vi.mock('../../../src/undo', () => ({ useUndo: () => (change: unknown) => void held.offered.push(change) }));
vi.mock('../../../src/api/split', () => ({
  proposeASplit: () =>
    new Promise((resolve, reject) => {
      held.proposal = { resolve, reject };
    }),
}));

const ITEM = '018f0000-0000-7000-8000-000000000001';
const ADDITION = '018f0000-0000-7000-8000-000000000002';
const FILE = '018f0000-0000-7000-8000-000000000003';

function theNote(over: Partial<Item> = {}): Item {
  return {
    id: ITEM,
    title: 'Weekend',
    description: 'Pay the rent before Friday.\n\nBook the ferry to Texel.\n\nAsk Sam about the quote.',
    workspaceId: 'w1',
    workspaceDecided: true,
    ...over,
  } as Item;
}

beforeEach(() => {
  held.send = vi.fn().mockResolvedValue({ ok: true, applied: true });
  held.offered = [];
  held.proposal = null;
  held.snapshot = {
    items: [theNote()],
    additions: [{ id: ADDITION, itemId: ITEM, message: 'The ferry is 12 euro.', createdAt: '2026-11-01T10:00:00.000Z', tenantId: 't' }],
    attachments: [{ id: FILE, itemId: ITEM, filename: 'quote.pdf', contentType: 'application/pdf', size: 1, createdAt: '2026-11-01T10:00:00.000Z', tenantId: 't' }],
  } as unknown as WorkspaceSnapshot;
});

afterEach(cleanup);

const blocksDrawn = () =>
  [...document.querySelectorAll<HTMLElement>('[data-block]')].map((block) => block.dataset.block);

const answer = (cards: SplitProposal['cards']) => held.proposal!.resolve({ cards });

function open() {
  const onClose = vi.fn();
  render(<SplitDialog workspaceId="w1" itemId={ITEM} onClose={onClose} />);
  return onClose;
}

describe('Triage', () => {
  describe('the dialog draws blocks before the proposal arrives, keeps their order, and moves a block between cards', () => {
    it('draws every block in its own order at once, with no card and Split not yet possible', async () => {
      open();

      await waitFor(() => expect(blocksDrawn()).toEqual(['p0', 'p1', 'p2', `a-${ADDITION}`, `f-${FILE}`]));
      expect(screen.getByRole('status')).toHaveTextContent('Claude is reading it');
      expect(document.querySelector('[data-proposal]')).toBeNull();
      expect(screen.getByRole('button', { name: 'Split' })).toBeDisabled();
    });

    it('fills in the cards when the proposal arrives, tagging each block with its card’s name, and keeps the blocks where they were', async () => {
      open();
      await waitFor(() => expect(held.proposal).not.toBeNull());

      answer([
        { title: 'Pay the rent', blockIds: ['p0'] },
        { title: 'Book the ferry', blockIds: ['p1', `a-${ADDITION}`] },
      ]);

      await screen.findByText(/Claude proposes 2 new Items/);
      expect(blocksDrawn()).toEqual(['p0', 'p1', 'p2', `a-${ADDITION}`, `f-${FILE}`]);
      const tagOf = (block: string) => within(document.querySelector<HTMLElement>(`[data-block="${block}"]`)!).getByRole('combobox');
      expect(tagOf('p0')).toHaveDisplayValue('Pay the rent');
      expect(tagOf(`a-${ADDITION}`)).toHaveDisplayValue('Book the ferry');
      expect(tagOf('p2')).toHaveDisplayValue('Stays here');
      expect(screen.getByText(/Makes 2 Items/)).toBeInTheDocument();
    });

    it('draws one card holding every block where Claude could not be asked, and says so', async () => {
      open();
      await waitFor(() => expect(held.proposal).not.toBeNull());

      answer(null);

      await screen.findByText(/Claude could not propose a split/);
      expect(document.querySelectorAll('[data-proposal]')).toHaveLength(1);
      for (const block of blocksDrawn()) {
        expect(within(document.querySelector<HTMLElement>(`[data-block="${block}"]`)!).getByRole('combobox')).toHaveDisplayValue('Pay the rent before Friday');
      }
    });

    it('draws that one card where the request itself fails', async () => {
      open();
      await waitFor(() => expect(held.proposal).not.toBeNull());

      held.proposal!.reject(new Error('offline'));

      await screen.findByText(/Claude could not propose a split/);
      expect(document.querySelectorAll('[data-proposal]')).toHaveLength(1);
    });

    it('moves a block onto another card by dropping it there, and by the tag on it', async () => {
      const user = userEvent.setup();
      open();
      await waitFor(() => expect(held.proposal).not.toBeNull());
      answer([
        { title: 'Pay the rent', blockIds: ['p0'] },
        { title: 'Book the ferry', blockIds: ['p1'] },
      ]);
      await screen.findByText(/Claude proposes 2 new Items/);
      const data = new Map<string, string>();
      const dataTransfer = { setData: (type: string, value: string) => data.set(type, value), getData: (type: string) => data.get(type) ?? '', effectAllowed: '' };

      fireEvent(document.querySelector('[data-block="p0"]')!, Object.assign(createEvent.dragStart(document.querySelector('[data-block="p0"]')!), { dataTransfer }));
      fireEvent(document.querySelector('[data-proposal="2"]')!, Object.assign(createEvent.drop(document.querySelector('[data-proposal="2"]')!), { dataTransfer }));

      const tag = (block: string) => within(document.querySelector<HTMLElement>(`[data-block="${block}"]`)!).getByRole('combobox');
      expect(tag('p0')).toHaveDisplayValue('Book the ferry');
      expect(blocksDrawn().slice(0, 2)).toEqual(['p0', 'p1']);

      await user.selectOptions(tag('p1'), 'Stays here');
      expect(tag('p1')).toHaveDisplayValue('Stays here');
    });
  });

  describe('pressing Split sends one change naming blocks, and offers Undo', () => {
    it('names each ticked card’s blocks, leaves an unticked card’s and the rest in the original, and closes', async () => {
      const user = userEvent.setup();
      const onClose = open();
      await waitFor(() => expect(held.proposal).not.toBeNull());
      answer([
        { title: 'Pay the rent', blockIds: ['p0'] },
        { title: 'Book the ferry', blockIds: ['p1', `a-${ADDITION}`, `f-${FILE}`] },
        { title: 'Ask Sam', blockIds: ['p2'] },
      ]);
      await screen.findByText(/Claude proposes 3 new Items/);
      await user.click(screen.getByRole('checkbox', { name: 'Make Item 3' }));
      await user.clear(screen.getByRole('textbox', { name: 'Title of Item 1' }));
      await user.type(screen.getByRole('textbox', { name: 'Title of Item 1' }), 'Rent');

      await user.click(screen.getByRole('button', { name: 'Split' }));

      expect(held.send).toHaveBeenCalledTimes(1);
      const sent = held.send.mock.calls[0]![0] as { name: string; payload: { itemId: string; was: string; children: { title: string; blockIds: string[] }[] } };
      expect(sent.name).toBe('split_item');
      expect(sent.payload.itemId).toBe(ITEM);
      expect(sent.payload.was).toBe('Pay the rent before Friday.\n\nBook the ferry to Texel.\n\nAsk Sam about the quote.');
      expect(sent.payload.children.map((child) => [child.title, child.blockIds])).toEqual([
        ['Rent', ['p0']],
        ['Book the ferry', ['p1', `a-${ADDITION}`, `f-${FILE}`]],
      ]);
      expect(onClose).toHaveBeenCalled();
      expect(held.offered).toHaveLength(1);
    });

    it('offers an Undo that sends what comes apart: the words as they were, as the Split left them, and what moved', async () => {
      const user = userEvent.setup();
      open();
      await waitFor(() => expect(held.proposal).not.toBeNull());
      answer([
        { title: 'Pay the rent', blockIds: ['p0'] },
        { title: 'Book the ferry', blockIds: ['p1', `a-${ADDITION}`, `f-${FILE}`] },
      ]);
      await screen.findByText(/Claude proposes 2 new Items/);
      await user.click(screen.getByRole('button', { name: 'Split' }));
      const offer = held.offered[0] as Undoable;
      held.send.mockClear();

      await offer.undo!();

      const sent = held.send.mock.calls[0]![0] as {
        name: string;
        payload: { itemId: string; description: string; kept: string; children: { itemId: string; additionIds: string[]; attachmentIds: string[] }[] };
      };
      expect(sent.name).toBe('unsplit_item');
      expect(sent.payload).toMatchObject({
        itemId: ITEM,
        description: 'Pay the rent before Friday.\n\nBook the ferry to Texel.\n\nAsk Sam about the quote.',
        kept: 'Ask Sam about the quote.',
      });
      expect(sent.payload.children.map((child) => [child.additionIds, child.attachmentIds])).toEqual([
        [[], []],
        [[ADDITION], [FILE]],
      ]);
    });

    it('offers no Undo for an Item no Workspace owned yet, since a Split settles it in this one', async () => {
      held.snapshot = { ...(held.snapshot as object), items: [theNote({ workspaceDecided: false })] };
      const user = userEvent.setup();
      open();
      await waitFor(() => expect(held.proposal).not.toBeNull());
      answer(null);
      await screen.findByText(/Claude could not propose a split/);

      await user.click(screen.getByRole('button', { name: 'Split' }));

      expect((held.offered[0] as Undoable).undo).toBeUndefined();
    });

    it('says nothing is written in an Item with no words, Addition or file, and asks Claude nothing', async () => {
      held.snapshot = { items: [theNote({ description: null })], additions: [], attachments: [] } as unknown as WorkspaceSnapshot;
      open();

      await screen.findByText('Nothing written in it to split.');
      await screen.findByText(/Claude could not propose a split/);
      expect(held.proposal).toBeNull();
    });
  });
});

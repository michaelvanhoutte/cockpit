import { describe, expect, it } from 'vitest';
import type { Attachment, FinishedItems, Item, WorkspaceSnapshot } from '@cockpit/shared';
import { withFinishedItems } from '../../src/finishedItems';

/**
 * L1: a Workspace's read and its finished Items drawn as one ("Fetch a
 * Workspace's finished Items the first time All items opens", issue 1434). That
 * the two are read, and when, is tests/unit/components/FinishedItemsRead.test.tsx.
 */

const item = (id: string, over: Partial<Item> = {}): Item =>
  ({ id, title: id, completedAt: null, updatedAt: '2026-10-01T08:00:00.000Z', ...over }) as Item;
const done = (id: string, over: Partial<Item> = {}): Item => item(id, { completedAt: '2026-09-01T09:00:00.000Z', ...over });
const file = (id: string, itemId: string) => ({ id, itemId }) as Attachment;

const workspace = (over: Partial<WorkspaceSnapshot> = {}): WorkspaceSnapshot =>
  ({ items: [], filings: [], attachments: [], ...over }) as unknown as WorkspaceSnapshot;
const finished = (over: Partial<FinishedItems> = {}): FinishedItems => ({ items: [], filings: [], attachments: [], ...over });

const idsOf = (snapshot: WorkspaceSnapshot) => snapshot.items.map((one) => one.id);

describe('Dashboards', () => {
  describe('the Workspace’s read and its finished Items are drawn as one, an Item in both being the copy changed last', () => {
    it('draws the Workspace’s read as it is until the finished Items have arrived', () => {
      const held = workspace({ items: [item('open')] });

      expect(withFinishedItems(held, undefined)).toBe(held);
      expect(withFinishedItems(held, finished())).toBe(held);
    });

    it('adds a finished Item the Workspace’s read does not hold, with its filings and files, after the Items it holds', () => {
      const held = workspace({ items: [item('open')], filings: [{ itemId: 'open', panelId: 'p', position: 0 }], attachments: [file('f-open', 'open')] });

      const drawn = withFinishedItems(
        held,
        finished({ items: [done('old')], filings: [{ itemId: 'old', panelId: 'p', position: 1 }], attachments: [file('f-old', 'old')] }),
      );

      expect(idsOf(drawn)).toEqual(['open', 'old']);
      expect(drawn.filings.map((filing) => filing.itemId)).toEqual(['open', 'old']);
      expect(drawn.attachments.map((one) => one.id)).toEqual(['f-open', 'f-old']);
    });

    it.each([
      {
        situation: 'the finished read made before the Item was reopened elsewhere',
        workspaceCopy: item('x', { updatedAt: '2026-10-02T00:00:00.000Z' }),
        finishedCopy: done('x', { updatedAt: '2026-09-01T09:00:00.000Z' }),
        status: 'open',
      },
      {
        situation: 'the Workspace’s read made before the Item was marked Done elsewhere',
        workspaceCopy: item('x', { updatedAt: '2026-09-01T00:00:00.000Z' }),
        finishedCopy: done('x', { updatedAt: '2026-09-01T09:00:00.000Z' }),
        status: 'done',
      },
      {
        situation: 'both reads holding the Item as it is now',
        workspaceCopy: done('x', { updatedAt: '2026-09-01T09:00:00.000Z' }),
        finishedCopy: done('x', { updatedAt: '2026-09-01T09:00:00.000Z' }),
        status: 'done',
      },
    ])('draws the copy changed last of an Item in both, $situation', ({ workspaceCopy, finishedCopy, status }) => {
      const drawn = withFinishedItems(workspace({ items: [workspaceCopy] }), finished({ items: [finishedCopy] }));

      expect(idsOf(drawn)).toEqual(['x']);
      expect(drawn.items[0]?.completedAt === null ? 'open' : 'done').toBe(status);
    });

    it('draws an Item’s filings and files from the read its copy came from, never a mixture of both', () => {
      const held = workspace({
        items: [done('x', { updatedAt: '2026-09-01T00:00:00.000Z' })],
        filings: [{ itemId: 'x', panelId: 'was-here', position: 0 }],
        attachments: [file('f-before', 'x')],
      });

      const drawn = withFinishedItems(
        held,
        finished({
          items: [done('x', { updatedAt: '2026-09-02T00:00:00.000Z' })],
          filings: [{ itemId: 'x', panelId: 'moved-here', position: 0 }],
          attachments: [file('f-after', 'x')],
        }),
      );

      expect(drawn.filings.map((filing) => filing.panelId)).toEqual(['moved-here']);
      expect(drawn.attachments.map((one) => one.id)).toEqual(['f-after']);
    });

    it('leaves the Workspace’s read untouched', () => {
      const held = workspace({ items: [item('open')] });

      withFinishedItems(held, finished({ items: [done('old')] }));

      expect(idsOf(held)).toEqual(['open']);
    });
  });
});

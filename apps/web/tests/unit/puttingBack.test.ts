import { describe, expect, it } from 'vitest';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import type { CommandArgs } from '../../src/api/queries';
import { putBackFromARowDrop, type RowDropWas } from '../../src/puttingBack';

/**
 * F1: what Undo sends for a drop onto a row, which puts back both halves
 * ("Drag to nest in Panels and the Inbox", issue 1857).
 */

const [CHAPTER_3, CHAPTER_4, STORM, FERRY] = ['i-chapter-3', 'i-chapter-4', 'i-storm', 'i-ferry'];
const SCENES = 'p-scenes';

/** Undo run against the Workspace as the drop left it, answering every change. */
async function undo(was: RowDropWas, now: Partial<WorkspaceSnapshot>): Promise<CommandArgs[]> {
  const sent: CommandArgs[] = [];
  await putBackFromARowDrop(
    {
      workspaceId: 'ws-work',
      send: (change) => {
        sent.push(change);
        return Promise.resolve({ ok: true, applied: true });
      },
      latest: () => Promise.resolve({ items: [], filings: [], panels: [], children: [], ...now } as unknown as WorkspaceSnapshot),
    },
    was,
  );
  return sent;
}

describe('Panels', () => {
  describe('Undo of a drop onto a row puts back both halves', () => {
    it('puts an Item that left a parent back in it at its old place, leaving the new one, in one change', async () => {
      const sent = await undo(
        { target: CHAPTER_4, arrived: [STORM], parents: [{ parentId: CHAPTER_3, itemIds: [STORM], was: [FERRY, STORM] }], panels: [] },
        { children: [{ parentId: CHAPTER_3, childId: FERRY, position: 0 }, { parentId: CHAPTER_4, childId: STORM, position: 0 }] },
      );

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({
        name: 'put_inside',
        payload: {
          parentId: CHAPTER_3,
          childIds: [STORM],
          order: [FERRY, STORM],
          leaves: [{ itemId: STORM, parentId: CHAPTER_4 }],
        },
      });
    });

    it('files an Item that left a Panel on it again at its old place, and takes it out of the new parent', async () => {
      const sent = await undo(
        { target: CHAPTER_4, arrived: [STORM], parents: [], panels: [{ panelId: SCENES, itemIds: [STORM], was: [STORM, FERRY] }] },
        { filings: [{ panelId: SCENES, itemId: FERRY, position: 0 }] as never },
      );

      expect(sent.map((change) => change.name)).toEqual(['add_item_to_panel', 'remove_child']);
      expect(sent[0]).toMatchObject({ payload: { itemId: STORM, panelId: SCENES, order: [STORM, FERRY] } });
      expect(sent[1]).toMatchObject({ payload: { parentId: CHAPTER_4, childId: STORM } });
    });

    it('takes an Item that was added, leaving nothing, out of the new parent only', async () => {
      const sent = await undo({ target: CHAPTER_4, arrived: [STORM], parents: [], panels: [] }, {});

      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatchObject({ name: 'remove_child', payload: { parentId: CHAPTER_4, childId: STORM } });
    });

    it('takes nothing out of the new parent for an Item that was inside it already', async () => {
      const sent = await undo(
        { target: CHAPTER_4, arrived: [], parents: [], panels: [{ panelId: SCENES, itemIds: [STORM], was: [STORM] }] },
        {},
      );

      expect(sent.map((change) => change.name)).toEqual(['add_item_to_panel']);
    });
  });
});

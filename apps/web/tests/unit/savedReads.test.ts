import { describe, expect, it } from 'vitest';
import {
  itemSchema,
  panelSchema,
  rewriteHistoryResponseSchema,
  workspaceSnapshotSchema,
} from '@cockpit/shared';
import { checkSavedRead, checkSavedWorkspace, convertsReliably } from '../../src/savedReads';
import {
  aHistoryEntry,
  aHistoryEntrySavedBeforePanelsFiledOn,
  aPanel,
  aWorkspace,
  anItem,
  itemId,
  without,
} from './support/savedReads';

/**
 * L1: what a saved read has to be for this version to draw it offline, over
 * the shared schemas the server's answers are parsed with. Reading it back out
 * of IndexedDB and drawing it is tests/unit/persistence.test.tsx.
 */

describe('Offline', () => {
  describe('a saved read is drawn only where it converts reliably to the current shape', () => {
    it.each([
      {
        situation: 'it has the current shape',
        schema: itemSchema,
        saved: anItem(1),
        drawn: anItem(1),
      },
      {
        situation: 'it holds a property this version no longer has',
        schema: rewriteHistoryResponseSchema,
        saved: { entries: [aHistoryEntry()], nextPage: 2 },
        drawn: undefined,
      },
      {
        situation: 'an Item inside it holds a property this version no longer has',
        schema: workspaceSnapshotSchema,
        saved: aWorkspace([{ ...anItem(1), preview: 'old text' }]),
        drawn: undefined,
      },
      {
        situation: 'it holds a property this version does not know, named like one every object inherits',
        schema: itemSchema,
        saved: JSON.parse(JSON.stringify(anItem(1)).replace('{', '{"__proto__":{},')) as unknown,
        drawn: undefined,
      },
      {
        situation: 'a value does not parse',
        schema: itemSchema,
        saved: anItem(1, { createdAt: 'yesterday' }),
        drawn: undefined,
      },
      {
        situation: 'a value is one this version would quietly replace',
        schema: panelSchema,
        saved: { ...aPanel(), kind: 'chart' },
        drawn: undefined,
      },
      {
        situation: 'an Item’s history entry lacks the Panels it filed on, which has no default',
        schema: rewriteHistoryResponseSchema,
        saved: { entries: [aHistoryEntrySavedBeforePanelsFiledOn()] },
        drawn: undefined,
      },
      {
        situation: 'it lacks an optional property',
        schema: workspaceSnapshotSchema,
        saved: without(aWorkspace(), 'sourceNames'),
        drawn: without(aWorkspace(), 'sourceNames'),
      },
      {
        situation: 'it lacks a property with a default',
        schema: workspaceSnapshotSchema,
        saved: without(aWorkspace(), 'attachments'),
        drawn: aWorkspace(),
      },
    ])('$situation', ({ schema, saved, drawn }) => {
      expect(convertsReliably(schema as typeof itemSchema, saved)).toEqual(drawn);
    });

    it('never draws a read no schema is named for', () => {
      expect(checkSavedRead(['usage', 30], { days: [] })).toBe('unchecked');
    });
  });

  describe('a Workspace’s read loses only the Items that fail, and counts them', () => {
    const older = { ...anItem(2), preview: 'old text' };

    it.each([
      {
        situation: 'every Item converts',
        saved: aWorkspace([anItem(1), anItem(2), anItem(3)]),
        drawn: [itemId(1), itemId(2), itemId(3)],
        leftOut: 0,
      },
      {
        situation: 'one of three Items fails',
        saved: aWorkspace([anItem(1), older, anItem(3)]),
        drawn: [itemId(1), itemId(3)],
        leftOut: 1,
      },
      {
        situation: 'a Panel fails',
        saved: aWorkspace([anItem(1)], { panels: [{ ...aPanel(), retiredSetting: 3 }] }),
        drawn: undefined,
        leftOut: undefined,
      },
      // A Dashboard failing is the same check as a Panel failing: one schema
      // checks every part but the Items together, so it has no path of its own.
    ])('$situation', ({ saved, drawn, leftOut }) => {
      const checked = checkSavedWorkspace(saved);

      expect(checked && (checked.data as { items: { id: string }[] }).items.map((item) => item.id)).toEqual(drawn);
      expect(checked?.itemsLeftOut).toBe(leftOut);
    });

    it('leaves out what named a left-out Item, so nothing points at a row that is not there', () => {
      const saved = aWorkspace([anItem(1), older], {
        filings: [
          { panelId: 'panel-today', itemId: itemId(1), position: 0 },
          { panelId: 'panel-today', itemId: itemId(2), position: 1 },
        ],
        duplicates: [{ itemId: itemId(1), otherItemId: itemId(2) }],
      });

      const data = checkSavedWorkspace(saved)?.data as { filings: unknown[]; duplicates: unknown[] };

      expect(data.filings).toEqual([{ panelId: 'panel-today', itemId: itemId(1), position: 0 }]);
      expect(data.duplicates).toEqual([]);
    });
  });
});

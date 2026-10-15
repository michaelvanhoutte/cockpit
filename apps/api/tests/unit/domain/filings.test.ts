import { describe, expect, it } from 'vitest';
import type { AddItemToPanelCommand, Filing, Item, MoveItemToPanelCommand } from '@cockpit/shared';
import {
  decideAddToPanel,
  decideFilingWhereSaid,
  decideMoveToPanel,
  filingRows,
  orderIsNotOfThePanel,
  type FilingDecided,
  type FilingFacts,
  type FilingRefusal,
} from '../../../src/domain/filings.js';
import { captureItem } from '../../../src/domain/items.js';

/**
 * Unit level: both are pure decisions about a list, with no store in them. What
 * scope they are applied in, and what ends up written, is
 * apps/api/tests/integration/http/panel-items.test.ts.
 */

const AT = '2026-09-01T10:00:00.000Z';

function moving(
  itemId: string,
  panelId: string | null,
  order: string[],
): MoveItemToPanelCommand {
  return {
    commandId: '018f0000-0000-7000-8000-000000000001',
    issuedAt: AT,
    workspaceId: 'ws-work',
    itemId,
    panelId,
    order,
  };
}

function held(panelId: string, itemIds: string[]): Filing[] {
  return itemIds.map((itemId, position) => ({ panelId, itemId, position }));
}

describe('Panels', () => {
  describe('a panel keeps its items in the order the last move put them in', () => {
    it('numbers them from the front, in the order the move named them', () => {
      expect(filingRows('tenant-default', moving('b', 'falcon', ['a', 'b', 'c']))).toEqual([
        { tenantId: 'tenant-default', panelId: 'falcon', itemId: 'a', position: 0, createdAt: AT },
        { tenantId: 'tenant-default', panelId: 'falcon', itemId: 'b', position: 1, createdAt: AT },
        { tenantId: 'tenant-default', panelId: 'falcon', itemId: 'c', position: 2, createdAt: AT },
      ]);
    });

    it('files nothing when the item is going back to the Inbox, which has no order', () => {
      expect(filingRows('tenant-default', moving('b', null, []))).toEqual([]);
    });
  });

  describe('an order that is not the panel’s arrangement is refused', () => {
    it.each([
      {
        situation: 'the panel’s items with the arriving one among them',
        onThePanel: ['a', 'c'],
        order: ['a', 'b', 'c'],
        refused: false,
      },
      {
        situation: 'an empty panel taking its first item',
        onThePanel: [],
        order: ['b'],
        refused: false,
      },
      {
        situation: 'a reorder of a panel the item is already on',
        onThePanel: ['a', 'b', 'c'],
        order: ['b', 'a', 'c'],
        refused: false,
      },
      {
        situation: 'an order leaving out an item the panel holds',
        onThePanel: ['a', 'c'],
        order: ['a', 'b'],
        refused: true,
      },
      {
        situation: 'an order naming an item that is not on the panel',
        onThePanel: ['a'],
        order: ['a', 'b', 'somebody else’s'],
        refused: true,
      },
      {
        situation: 'an order of a panel the item has just been moved off',
        onThePanel: ['a', 'b'],
        order: ['a'],
        refused: true,
      },
    ])('$situation', ({ onThePanel, order, refused }) => {
      const why = orderIsNotOfThePanel(held('falcon', onThePanel), moving('b', 'falcon', order));

      expect(why === null).toBe(!refused);
    });

    it('asks nothing of a move to the Inbox, which is not a panel and has no order', () => {
      expect(orderIsNotOfThePanel(held('falcon', ['a', 'b']), moving('b', null, []))).toBeNull();
    });
  });
});

/**
 * What a filing decides is pure once the store has been read: the facts are
 * handed in, so every refusal and every record is a row of a table. That the
 * facts are read right, and what is written from the decision, is
 * apps/api/tests/integration/http/panel-items.test.ts.
 */
const MADE = '2026-08-12T10:00:00.000Z';

function anItem(overrides: Partial<Item> = {}): Item {
  return {
    ...captureItem(
      {
        commandId: '018f0000-0000-7000-8000-000000000001',
        workspaceId: 'ws-work',
        issuedAt: MADE,
        itemId: 'b',
        message: 'Reply to Bart',
      },
      'tenant-default',
    ),
    ...overrides,
  };
}

const FALCON = { id: 'falcon', name: 'Falcon', kind: 'items' as const };

function facts(overrides: Partial<FilingFacts> = {}): FilingFacts {
  return {
    item: anItem(),
    workspaceExists: true,
    panel: FALCON,
    held: [],
    alreadyFiled: false,
    proposedPanelNeverPropose: false,
    sources: [],
    ...overrides,
  };
}

function adding(itemId: string, panelId: string, order: string[]): AddItemToPanelCommand {
  const { commandId, issuedAt, workspaceId } = moving(itemId, panelId, order);
  return { commandId, issuedAt, workspaceId, itemId, panelId, order };
}

function decided(outcome: FilingRefusal | FilingDecided): FilingDecided {
  if (outcome.refusal !== null) throw new Error(`refused: ${outcome.refusal}`);
  return outcome;
}

describe('Panels', () => {
  describe('a filing is refused for exactly the reasons it is refused today', () => {
    it.each([
      {
        situation: 'onto a panel of text',
        facts: facts({ panel: { ...FALCON, kind: 'text' } }),
        refusal: 'panel-holds-something-else',
      },
      {
        situation: 'onto a panel that gathers what it shows',
        facts: facts({ panel: { ...FALCON, kind: 'filter' } }),
        refusal: 'panel-holds-something-else',
      },
      {
        situation: 'an order leaving out an item the panel holds',
        facts: facts({ held: held('falcon', ['x']) }),
        refusal: 'order-stale',
      },
      {
        situation: 'an item that does not exist',
        facts: facts({ item: null }),
        refusal: 'item-not-found',
      },
      {
        situation: 'an item another workspace has settled',
        facts: facts({ item: anItem({ workspaceId: 'ws-other', workspaceDecided: true }) }),
        refusal: 'item-not-found',
      },
      {
        situation: 'a panel that no panel of the workspace has',
        facts: facts({ panel: null }),
        refusal: 'panel-not-found',
      },
      {
        situation: 'a workspace that does not exist',
        facts: facts({ workspaceExists: false }),
        refusal: 'workspace-not-found',
      },
    ])('$situation, moved or added', ({ facts: loaded, refusal }) => {
      expect(decideMoveToPanel(moving('b', 'falcon', ['b']), loaded).refusal).toBe(refusal);
      expect(decideAddToPanel(adding('b', 'falcon', ['b']), loaded).refusal).toBe(refusal);
    });

    it('says which panel holds text, in the words the person is shown', () => {
      const refused = decideMoveToPanel(
        moving('b', 'falcon', ['b']),
        facts({ panel: { ...FALCON, kind: 'text' } }),
      );

      expect(refused).toEqual({
        refusal: 'panel-holds-something-else',
        why: 'Falcon holds text, so nothing is filed on it',
      });
    });

    it('refuses a move to the Inbox of a workspace that does not exist', () => {
      expect(
        decideMoveToPanel(moving('b', null, []), facts({ panel: null, workspaceExists: false })).refusal,
      ).toBe('workspace-not-found');
    });

    it('lets a move to the Inbox through, which is not a panel and has none to refuse', () => {
      expect(decideMoveToPanel(moving('b', null, []), facts({ panel: null })).refusal).toBeNull();
    });

    it('lets an item that belongs to no workspace be filed from any of them', () => {
      expect(
        decideMoveToPanel(moving('b', 'falcon', ['b']), facts({ item: anItem({ workspaceDecided: false }) }))
          .refusal,
      ).toBeNull();
    });

    it('refuses a panel to take the item off that belongs to another workspace, and ignores one that is gone', () => {
      const cmd = { ...moving('b', 'falcon', ['b']), fromPanelIds: ['gone', 'theirs'] };
      const sources = (theirs: boolean) => [
        { id: 'gone', exists: false, ofTheWorkspace: false },
        { id: 'theirs', exists: true, ofTheWorkspace: theirs },
      ];

      expect(decideMoveToPanel(cmd, facts({ sources: sources(false) }))).toEqual({
        refusal: 'panel-not-found',
        id: 'theirs',
      });
      expect(decided(decideMoveToPanel(cmd, facts({ sources: sources(true) }))).fromPanelIds).toEqual([
        'theirs',
      ]);
    });
  });

  describe('a move takes the item off the panels it names, and an add takes it off none', () => {
    it.each([
      {
        situation: 'a move naming no panel',
        named: undefined,
        sources: [],
        takesOff: true,
        from: undefined,
      },
      {
        situation: 'a move naming a panel',
        named: ['a'],
        sources: [{ id: 'a', exists: true, ofTheWorkspace: true }],
        takesOff: true,
        from: ['a'],
      },
      {
        situation: 'a move naming only panels deleted since',
        named: ['a'],
        sources: [{ id: 'a', exists: false, ofTheWorkspace: false }],
        takesOff: false,
        from: [],
      },
    ])('$situation', ({ named, sources, takesOff, from }) => {
      const outcome = decided(
        decideMoveToPanel({ ...moving('b', 'falcon', ['b']), fromPanelIds: named }, facts({ sources })),
      );

      expect([outcome.takesItOffPanels, outcome.fromPanelIds]).toEqual([takesOff, from]);
    });

    it('takes an add off no panel', () => {
      expect(decided(decideAddToPanel(adding('b', 'falcon', ['b']), facts())).takesItOffPanels).toBe(false);
    });

    it('takes a move to the Inbox off every panel, whatever it names', () => {
      const outcome = decided(
        decideMoveToPanel(
          { ...moving('b', null, []), fromPanelIds: ['a'] },
          facts({ panel: null, sources: [{ id: 'a', exists: true, ofTheWorkspace: true }] }),
        ),
      );

      expect([outcome.takesItOffPanels, outcome.fromPanelIds, outcome.rows]).toEqual([true, undefined, []]);
    });
  });
});

describe('Triage', () => {
  describe('a filing records what it settles exactly once', () => {
    const proposed = anItem({ proposedPanelId: 'reading', proposedPanelReason: 'it is a book' });

    it.each([
      { situation: 'an item’s first filing out of the Inbox', alreadyFiled: false, recorded: true },
      { situation: 'a later move between panels', alreadyFiled: true, recorded: false },
    ])('$situation', ({ alreadyFiled, recorded }) => {
      const outcome = decided(
        decideMoveToPanel(moving('b', 'falcon', ['b']), facts({ item: proposed, alreadyFiled })),
      );

      expect(outcome.decision).toEqual(
        recorded
          ? expect.objectContaining({
              itemId: 'b',
              proposedPanelId: 'reading',
              proposedPanelReason: 'it is a book',
              chosenPanelId: 'falcon',
            })
          : null,
      );
    });

    it('records the same for an add as for a move', () => {
      const outcome = decided(decideAddToPanel(adding('b', 'falcon', ['b']), facts({ item: proposed })));

      expect(outcome.decision).toEqual(expect.objectContaining({ chosenPanelId: 'falcon' }));
    });

    it('records nothing for a move to the Inbox', () => {
      expect(decided(decideMoveToPanel(moving('b', null, []), facts({ panel: null }))).decision).toBeNull();
    });

    it('records no proposal where the panel it named is flagged Never propose, whose chip was not drawn', () => {
      const outcome = decided(
        decideMoveToPanel(moving('b', 'falcon', ['b']), facts({ item: proposed, proposedPanelNeverPropose: true })),
      );

      expect(outcome.decision).toEqual(
        expect.objectContaining({ proposedPanelId: null, proposedPanelReason: null, chosenPanelId: 'falcon' }),
      );
    });

    it.each([
      { situation: 'an item with no workspace yet', item: anItem({ workspaceDecided: false }), settled: true },
      { situation: 'an item that already belongs to one', item: anItem(), settled: false },
    ])('decides the workspace of $situation by where it is filed', ({ item, settled }) => {
      const outcome = decided(decideMoveToPanel(moving('b', 'falcon', ['b']), facts({ item })));

      expect(outcome.workspaceSettled?.workspaceId ?? null).toBe(settled ? 'ws-work' : null);
    });
  });
});

describe('Capture', () => {
  /**
   * "File a capture on the panels you name, read from the spoken path" (issue
   * 1116). Pure over the Item and the Panels as loaded; what the store reads
   * and writes around it - a Panel gone, Never propose, two Panels, the
   * proposal withdrawn - is apps/api/tests/integration/http/note-cleanup-path.test.ts.
   */
  describe('a note is filed where it said, at the top, only if nobody has dealt with it first', () => {
    const SAID = { commandId: '018f0000-0000-7000-8000-000000000009', issuedAt: AT };
    const named = (kind: 'items' | 'text' | 'filter' = 'items') => ({ ...FALCON, kind, held: held('falcon', ['a', 'c']) });

    it.each([
      { situation: 'a note waiting in the Inbox', item: anItem(), panel: named(), filed: true },
      { situation: 'a note you dismissed first', item: anItem({ deletedAt: AT }), panel: named(), filed: false },
      { situation: 'a note you finished with first', item: anItem({ completedAt: AT }), panel: named(), filed: false },
      { situation: 'a note in no workspace yet', item: anItem({ workspaceDecided: false }), panel: named(), filed: false },
      { situation: 'a Panel of text', item: anItem(), panel: named('text'), filed: false },
      { situation: 'a Filter', item: anItem(), panel: named('filter'), filed: false },
    ])('for $situation', ({ item, panel, filed }) => {
      const outcome = decideFilingWhereSaid(item, SAID, [panel], false);

      expect(outcome === null ? null : outcome.panels[0]!.rows.map((row) => row.itemId)).toEqual(
        filed ? ['b', 'a', 'c'] : null,
      );
    });

    it('records the one routing it settles with no proposal, whatever was proposed', () => {
      const item = anItem({ proposedPanelId: 'heron', proposedPanelReason: 'looked like one' });

      expect(decideFilingWhereSaid(item, SAID, [named(), null], false)?.decision).toEqual(
        expect.objectContaining({ workspaceId: 'ws-work', chosenPanelId: 'falcon', proposedPanelId: null, proposedPanelReason: null }),
      );
    });
  });
});
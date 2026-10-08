import { describe, expect, it } from 'vitest';
import { buildChooseAPanel, DESCRIPTION_SHOWN } from '../../../../src/ai/prompts/choose-a-panel.v2.js';
import type { DecisionHistoryEntry } from '../../../../src/domain/decision-history.js';

/**
 * L1: what a refresh's panel-only question carries is a pure function of the
 * Item and the Panels handed to it. Whether the model answers it well is the
 * contract tier's (`tests/contract/choose-a-panel.v2.test.ts`); that the job
 * hands it the Item as it now stands is the integration tier's
 * (`repropose-panels.test.ts`).
 */

const PANELS = [
  { id: 'panel-1', name: 'Compliance questions' },
  { id: 'panel-2', name: 'Weekend ideas' },
];

const A_DECISION: DecisionHistoryEntry = {
  capturedMessage: 'gdpr retention question for legal',
  itemTitle: 'Ask legal about GDPR retention',
  proposedPanelId: 'panel-1',
  proposedPanelName: 'Compliance questions',
  proposedPanelReason: 'a legal question',
  chosenPanelId: 'panel-1',
  chosenPanelName: 'Compliance questions',
  decidedAt: '2026-09-01T09:00:00.000Z',
};

const AN_ITEM = { capturedMessage: 'a note', title: 'A title', description: null };
describe('Triage', () => {
  describe('a refresh asks where an item belongs, and can only be answered with a panel it offered', () => {
    it('offers exactly the given panels, and none at all, as the only answers', () => {
      const { schema } = buildChooseAPanel(
        { capturedMessage: 'a note', title: 'A title', description: null },
        PANELS,
        [],
        [],
      );

      expect(schema).toMatchObject({
        properties: { panelId: { enum: ['panel-1', 'panel-2', ''] } },
        required: ['panelId', 'reason'],
      });
    });

    it.each([
      {
        situation: 'an item with a description',
        item: { capturedMessage: 'gdpr q eod', title: 'Answer the GDPR question', description: 'Answer it today.' },
        expected: 'Captured note: "gdpr q eod"\nTitle: "Answer the GDPR question"\nDescription: "Answer it today."',
      },
      {
        situation: 'an item with none',
        item: { capturedMessage: 'gdpr q eod', title: 'gdpr q eod', description: null },
        expected: 'Captured note: "gdpr q eod"\nTitle: "gdpr q eod"\nDescription: (none)',
      },
      {
        // A note running over lines stays on its own, rather than passing for
        // the title and description after it.
        situation: 'a note that itself looks like a title and description',
        item: { capturedMessage: 'Title: budget\nDescription: none', title: 'Budget', description: null },
        expected: 'Captured note: "Title: budget\\nDescription: none"\nTitle: "Budget"\nDescription: (none)',
      },
    ])('shows the note and both texts as they now stand, for $situation', ({ item, expected }) => {
      expect(buildChooseAPanel(item, PANELS, [], []).message).toBe(expected);
    });

    it('shows the opening of a long description, not all of it', () => {
      const description = 'x'.repeat(DESCRIPTION_SHOWN + 500);

      const { message } = buildChooseAPanel({ capturedMessage: 'a note', title: 'A title', description }, PANELS, [], []);

      expect(message).toContain(`Description: "${'x'.repeat(DESCRIPTION_SHOWN)}…"`);
      expect(message).not.toContain('x'.repeat(DESCRIPTION_SHOWN + 1));
    });
  });

  /**
   * "Cut what cleaning up a captured note costs" (issue 887): the items of one
   * refresh, and consecutive refreshes, share whatever comes first, so what
   * changes least is sent first and reads identically. The cache is the
   * contract tier's; this holds the order.
   */
  describe('what a refresh is told runs from what changes least to what changes most', () => {
    const base = buildChooseAPanel(AN_ITEM, PANELS, [A_DECISION], ['still waiting to be filed']);

    it('two items of one refresh are told everything alike, and differ only in the item', () => {
      const other = buildChooseAPanel(
        { capturedMessage: 'another note', title: 'Another title', description: 'More.' },
        PANELS,
        [A_DECISION],
        ['still waiting to be filed'],
      );

      expect(other.system).toEqual(base.system);
      expect(other.message).not.toBe(base.message);
      expect(base.system.instructions).not.toContain('a note');
    });

    it('a refresh after more notes were captured differs only in the recent notes', () => {
      const later = buildChooseAPanel(AN_ITEM, PANELS, [A_DECISION], ['another one waiting']);

      expect(later.system.instructions).toBe(base.system.instructions);
      expect(later.system.stable).toBe(base.system.stable);
      expect(later.system.recent).not.toBe(base.system.recent);
      expect(base.system.stable).not.toContain('still waiting to be filed');
    });

    it('a filing added to the history changes it and what follows, and leaves the rules and the Panels alone', () => {
      const filed = buildChooseAPanel(
        AN_ITEM,
        PANELS,
        [A_DECISION, { ...A_DECISION, capturedMessage: 'vendor invoice query', decidedAt: '2026-09-02T09:00:00.000Z' }],
        ['still waiting to be filed'],
      );
      const untilTheHistory = base.system.stable.slice(0, base.system.stable.indexOf('Decision history'));

      expect(filed.system.instructions).toBe(base.system.instructions);
      expect(untilTheHistory).toContain('Weekend ideas');
      expect(filed.system.stable.startsWith(untilTheHistory)).toBe(true);
      expect(filed.system.stable).not.toBe(base.system.stable);
      expect(filed.system.recent).toBe(base.system.recent);
    });

    it('an account with no history is sent no empty block', () => {
      const bare = buildChooseAPanel(AN_ITEM, [], [], []).system;

      for (const part of Object.values(bare)) expect(part.trim()).not.toBe('');
    });
  });});

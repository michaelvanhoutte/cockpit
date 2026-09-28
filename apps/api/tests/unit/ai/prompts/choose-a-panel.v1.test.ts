import { describe, expect, it } from 'vitest';
import { buildChooseAPanel } from '../../../../src/ai/prompts/choose-a-panel.v1.js';

/**
 * L1: what a refresh's panel-only question carries is a pure function of the
 * Item and the Panels handed to it. Whether the model answers it well is the
 * contract tier's (`tests/contract/choose-a-panel.v1.test.ts`); that the job
 * hands it the Item as it now stands is the integration tier's
 * (`repropose-panels.test.ts`).
 */

const PANELS = [
  { id: 'panel-1', name: 'Compliance questions' },
  { id: 'panel-2', name: 'Weekend ideas' },
];

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
        expected: 'Captured note: gdpr q eod\nTitle: Answer the GDPR question\nDescription: Answer it today.',
      },
      {
        situation: 'an item with none',
        item: { capturedMessage: 'gdpr q eod', title: 'gdpr q eod', description: null },
        expected: 'Captured note: gdpr q eod\nTitle: gdpr q eod\nDescription: (none)',
      },
    ])('shows the note and both texts as they now stand, for $situation', ({ item, expected }) => {
      expect(buildChooseAPanel(item, PANELS, [], []).message).toBe(expected);
    });
  });
});

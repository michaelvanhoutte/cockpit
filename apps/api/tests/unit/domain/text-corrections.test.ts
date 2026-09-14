import { describe, expect, it } from 'vitest';
import {
  correctionStillVisible,
  deriveWhatStood,
  textCorrectionFor,
  type JudgeableItem,
  type TextCorrectionEntry,
} from '../../../src/domain/text-corrections.js';

const AN_ITEM = {
  id: 'item-1',
  tenantId: 'tenant-default',
  capturedMessage: 'Reply to Bart',
  title: 'Reply to Bart with the numbers',
  description: 'The message Cockpit wrote.',
};

const AT = '2026-09-09T10:00:01.000Z';

describe('Triage', () => {
  describe('The row an edit to a still-proposed text writes', () => {
    it('carries the note, what was proposed, and what was settled on', () => {
      const row = textCorrectionFor(
        AN_ITEM,
        { title: 'Mail Bart the numbers', description: AN_ITEM.description },
        AT,
      );

      expect(row).toMatchObject({
        itemId: 'item-1',
        tenantId: 'tenant-default',
        capturedMessage: 'Reply to Bart',
        proposedTitle: 'Reply to Bart with the numbers',
        proposedDescription: 'The message Cockpit wrote.',
        settledTitle: 'Mail Bart the numbers',
        settledDescription: 'The message Cockpit wrote.',
        recordedAt: AT,
        updatedAt: AT,
      });
    });

    it('is null when the resulting title is empty', () => {
      expect(textCorrectionFor(AN_ITEM, { title: '', description: AN_ITEM.description }, AT)).toBeNull();
    });

    it('is null when the resulting title is only whitespace', () => {
      expect(textCorrectionFor(AN_ITEM, { title: '   ', description: AN_ITEM.description }, AT)).toBeNull();
    });

    it('is null when neither text actually changed', () => {
      expect(textCorrectionFor(AN_ITEM, { title: AN_ITEM.title, description: AN_ITEM.description }, AT)).toBeNull();
    });

    /**
     * The empty-title guard checks only the title *this edit* is changing,
     * not whatever the title happens to read right now - otherwise an Item
     * whose title was cleared once would refuse every later, unrelated
     * description correction forever, since `set_description` never touches
     * `title` and so never clears the emptiness the guard would otherwise
     * keep tripping on.
     */
    it('records a description correction even though the title already reads empty', () => {
      const clearedTitle = { ...AN_ITEM, title: '' };

      const row = textCorrectionFor(clearedTitle, { title: '', description: 'A better message.' }, AT);

      expect(row).toMatchObject({ settledTitle: '', settledDescription: 'A better message.' });
    });
  });
});

describe('Capture', () => {
  describe('What a proposal reads about the texts nobody corrected', () => {
    function judgeable(overrides: Partial<JudgeableItem> = {}): JudgeableItem {
      return {
        id: 'item-1',
        title: 'a title',
        textsProposedAt: '2026-09-09T10:00:00.000Z',
        actedOn: true,
        textsSettledAt: null,
        ...overrides,
      };
    }

    it('counts what stood and what was corrected, out of what was proposed', () => {
      const items = Array.from({ length: 10 }, (_, i) => judgeable({ id: `item-${i}` }));
      const corrected = new Set(['item-0', 'item-1']);

      const stood = deriveWhatStood(items, corrected);

      expect(stood.proposedTotal).toBe(10);
      expect(stood.correctedTotal).toBe(2);
    });

    it('counts an Item nobody has acted on yet in neither direction', () => {
      const items = [judgeable({ actedOn: false })];

      const stood = deriveWhatStood(items, new Set());

      expect(stood.proposedTotal).toBe(0);
      expect(stood.correctedTotal).toBe(0);
    });

    /**
     * Editing a proposed text is itself the act of having looked at it, the
     * same reasoning `actedOn`'s own filed-or-dismissed proxy rests on -
     * without this, a correction on an Item still sitting unfiled would be
     * excluded here while `renderCorrections` (the prompt) lists it anyway,
     * reading as two sections that disagree about the same Item.
     */
    it('counts a corrected Item even though nothing else has acted on it', () => {
      const items = [judgeable({ actedOn: false })];

      const stood = deriveWhatStood(items, new Set(['item-1']));

      expect(stood.proposedTotal).toBe(1);
      expect(stood.correctedTotal).toBe(1);
    });

    it('counts an Item whose texts were never proposed in neither direction', () => {
      const items = [judgeable({ textsProposedAt: null })];

      const stood = deriveWhatStood(items, new Set());

      expect(stood.proposedTotal).toBe(0);
      expect(stood.correctedTotal).toBe(0);
    });

    /**
     * Clearing a title settles both texts without leaving a row behind
     * (`textCorrectionFor`'s own empty-title guard), and no later edit on
     * that Item can create one either (`command-service.ts`). Once filed,
     * dismissed or completed, such an Item has no row and `actedOn` alone
     * would default it into "stood" - the opposite of what happened, since
     * it was genuinely edited.
     */
    it('excludes an Item that was edited but left no correction row, even once acted on', () => {
      const items = [judgeable({ textsSettledAt: '2026-09-09T10:00:01.000Z', actedOn: true })];

      const stood = deriveWhatStood(items, new Set());

      expect(stood.proposedTotal).toBe(0);
      expect(stood.correctedTotal).toBe(0);
    });

    it('keeps the sample bounded, however many texts stood', () => {
      const items = Array.from({ length: 2000 }, (_, i) => judgeable({ id: `item-${i}`, title: `title ${i}` }));
      const corrected = new Set(Array.from({ length: 500 }, (_, i) => `item-${i}`));

      const stood = deriveWhatStood(items, corrected);

      expect(stood.proposedTotal).toBe(2000);
      expect(stood.correctedTotal).toBe(500);
      expect(stood.sample.length).toBeLessThanOrEqual(10);
    });
  });

  describe('Whether a correction row still shows a real difference from what was proposed', () => {
    const A_CORRECTION: TextCorrectionEntry = {
      itemId: 'item-1',
      capturedMessage: 'Reply to Bart',
      proposedTitle: 'Reply to Bart with the numbers',
      proposedDescription: 'The message Cockpit wrote.',
      settledTitle: 'Mail Bart the numbers',
      settledDescription: 'The message Cockpit wrote.',
      recordedAt: '2026-09-09T10:00:00.000Z',
    };

    it('is true where the title differs from what was proposed', () => {
      expect(correctionStillVisible(A_CORRECTION)).toBe(true);
    });

    /**
     * A later edit can settle a text back to exactly what Cockpit proposed -
     * reverting a detour, say - and `command-service.ts`'s `UPDATE` branch
     * rewrites the settled half without deleting or resetting the row. Such
     * a row teaches nothing any more, and both `renderOneTextCorrection`
     * (`clean-up-a-note.v7.ts`) and the corrected-item set (`store.ts`) read
     * this same function to agree that it counts nowhere.
     */
    it('is false where the settled half was edited back to exactly what was proposed', () => {
      const reverted: TextCorrectionEntry = {
        ...A_CORRECTION,
        settledTitle: A_CORRECTION.proposedTitle,
        settledDescription: A_CORRECTION.proposedDescription,
      };

      expect(correctionStillVisible(reverted)).toBe(false);
    });
  });
});

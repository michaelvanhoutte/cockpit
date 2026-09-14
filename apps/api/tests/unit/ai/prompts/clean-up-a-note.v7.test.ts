import { describe, expect, it } from 'vitest';
import { buildCleanUpANote } from '../../../../src/ai/prompts/clean-up-a-note.v7.js';
import type { TextCorrectionEntry, WhatStood } from '../../../../src/domain/text-corrections.js';

/**
 * L1: rendering the two new sections is a pure decision over already-derived
 * values - the derivation itself is `deriveWhatStood`
 * (tests/unit/domain/text-corrections.test.ts), and what the store reads and
 * hands to this prompt is proved against a real store in
 * apps/api/tests/integration/http/note-cleanup.test.ts ("Learn how you write
 * from the titles you correct", issue 394).
 */

const NO_STOOD: WhatStood = { proposedTotal: 0, correctedTotal: 0, sample: [] };

function systemFor(corrections: readonly TextCorrectionEntry[], stood: WhatStood): string {
  return buildCleanUpANote([], [], [], null, corrections, stood).system;
}

describe('Capture', () => {
  describe('What a proposal reads about how this account writes', () => {
    it('says so, rather than being empty, when the account has no corrections yet', () => {
      expect(systemFor([], NO_STOOD)).toContain('nothing corrected yet');
    });

    it('renders a correction naming both what was proposed and what was settled on', () => {
      const correction: TextCorrectionEntry = {
        itemId: 'item-1',
        capturedMessage: 'bel novy',
        proposedTitle: 'Call Novy',
        proposedDescription: null,
        settledTitle: 'Novy bellen',
        settledDescription: null,
        recordedAt: '2026-09-09T10:00:00.000Z',
      };

      const system = systemFor([correction], NO_STOOD);

      expect(system).toContain('bel novy');
      expect(system).toContain('Call Novy');
      expect(system).toContain('Novy bellen');
    });

    /**
     * `CORRECTIONS_LIMIT` caps the window a prompt renders - filtered before
     * it is capped, not after, so a reverted row inside the trailing window
     * cannot take a slot from an older, still-visible correction. Capping
     * first could otherwise empty the whole section while `store.ts`'s
     * corrected count (built from the full, uncapped list) still reports a
     * nonzero total - the exact "two sections disagree" failure the shared
     * `correctionStillVisible` check exists to prevent.
     */
    it('lets an older, still-visible correction through a trailing window of reverted ones', () => {
      const visible: TextCorrectionEntry = {
        itemId: 'item-old',
        capturedMessage: 'an older note',
        proposedTitle: 'Old proposal',
        proposedDescription: null,
        settledTitle: 'Corrected long ago',
        settledDescription: null,
        recordedAt: '2026-01-01T00:00:00.000Z',
      };
      const reverted = (i: number): TextCorrectionEntry => ({
        itemId: `item-${i}`,
        capturedMessage: `note ${i}`,
        proposedTitle: 'Same as settled',
        proposedDescription: null,
        settledTitle: 'Same as settled',
        settledDescription: null,
        recordedAt: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      });
      const corrections = [visible, ...Array.from({ length: 60 }, (_, i) => reverted(i))];

      const system = systemFor(corrections, NO_STOOD);

      expect(system).toContain('Corrected long ago');
    });

    it('says nothing proposed and seen yet, when nothing has been judged', () => {
      expect(systemFor([], NO_STOOD)).toContain('nothing proposed and seen yet');
    });

    it('renders the ratio and a sample of what stood', () => {
      const stood: WhatStood = { proposedTotal: 10, correctedTotal: 2, sample: ['A title that stood'] };

      const system = systemFor([], stood);

      expect(system).toContain('2 of 10 proposed texts were corrected');
      expect(system).toContain('A title that stood');
    });
  });
});

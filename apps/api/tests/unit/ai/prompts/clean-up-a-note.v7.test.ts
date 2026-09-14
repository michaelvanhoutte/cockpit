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

    it('says nothing proposed and seen yet, when nothing has been judged', () => {
      expect(systemFor([], NO_STOOD)).toContain('nothing proposed and seen yet');
    });

    it('renders the ratio and a sample of what stood', () => {
      const stood: WhatStood = { proposedTotal: 10, correctedTotal: 2, sample: ['A title that stood'] };

      const system = systemFor([], stood);

      expect(system).toContain('2 of 10 proposed titles were corrected');
      expect(system).toContain('A title that stood');
    });
  });
});

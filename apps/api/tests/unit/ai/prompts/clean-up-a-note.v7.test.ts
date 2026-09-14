import { TEXT_LEARNING_GUIDANCE } from '@cockpit/shared';
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

function systemFor(
  corrections: readonly TextCorrectionEntry[],
  stood: WhatStood,
  rules: string | null = null,
): string {
  return buildCleanUpANote([], [], [], null, corrections, stood, rules).system;
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

  /**
   * "Show what Cockpit is told, and say how you want it changed" (issue
   * 398): the account's own rules box, rendered ahead of every example and
   * every piece of corrections/stood evidence.
   */
  describe("What Cockpit reads as this account's own rules", () => {
    it('says none have been written, rather than being empty, when the box is empty', () => {
      expect(systemFor([], NO_STOOD, null)).toContain('has not written any rules');
    });

    it('renders a rule the account wrote', () => {
      const system = systemFor([], NO_STOOD, 'Never end a title with a question mark.');
      expect(system).toContain('Never end a title with a question mark.');
    });

    /**
     * Render order, not model behaviour - the model actually honouring a
     * rule is the contract tier's to prove
     * (tests/contract/clean-up-a-note.v7.test.ts). The built-in guidance is
     * never removed for a rule existing - only read after it, so a
     * disagreement reads as the rule overriding it rather than as the
     * guidance having been deleted.
     */
    it('renders above the built-in guidance, the corrections evidence and what stood', () => {
      const correction: TextCorrectionEntry = {
        itemId: 'item-1',
        capturedMessage: 'bel novy',
        proposedTitle: 'Call Novy',
        proposedDescription: null,
        settledTitle: 'Novy bellen',
        settledDescription: null,
        recordedAt: '2026-09-09T10:00:00.000Z',
      };
      const stood: WhatStood = { proposedTotal: 5, correctedTotal: 1, sample: ['A title that stood'] };
      const rule = 'Titles are never a question.';

      const system = systemFor([correction], stood, rule);

      const ruleAt = system.indexOf(rule);
      const guidanceAt = system.indexOf(TEXT_LEARNING_GUIDANCE[0]!);
      const correctionsHeadingAt = system.indexOf('Corrections, oldest first');
      const stoodAt = system.indexOf('A title that stood');

      expect(ruleAt).toBeGreaterThan(-1);
      expect(guidanceAt).toBeGreaterThan(-1);
      expect(correctionsHeadingAt).toBeGreaterThan(-1);
      expect(stoodAt).toBeGreaterThan(-1);
      expect(ruleAt).toBeLessThan(guidanceAt);
      expect(ruleAt).toBeLessThan(correctionsHeadingAt);
      expect(ruleAt).toBeLessThan(stoodAt);
      // Not removed, only read after: every guidance line is still there.
      for (const line of TEXT_LEARNING_GUIDANCE) expect(system).toContain(line);
    });
  });

  /**
   * "the guidance and the prompt: the lines shown are the ones the prompt
   * actually carries" - `TEXT_LEARNING_GUIDANCE` (`packages/shared`) is what
   * the window reads back verbatim, so this is what proves the two can never
   * read differently.
   */
  describe('What Cockpit is told', () => {
    it('carries every line of the built-in guidance, verbatim, in the system prompt', () => {
      const system = systemFor([], NO_STOOD);
      for (const line of TEXT_LEARNING_GUIDANCE) {
        expect(system).toContain(line);
      }
    });
  });
});

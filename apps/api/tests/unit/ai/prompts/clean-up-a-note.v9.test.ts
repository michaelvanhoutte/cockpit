import { describe, expect, it } from 'vitest';
import { buildCleanUpANote } from '../../../../src/ai/prompts/clean-up-a-note.v9.js';
import type { DecisionHistoryEntry } from '../../../../src/domain/decision-history.js';
import type { TextCorrectionEntry, WhatStood } from '../../../../src/domain/text-corrections.js';

/**
 * L1: rendering the two sections is a pure decision over already-derived,
 * already-windowed values - the derivation itself is `deriveWhatStood`/
 * `deriveWhatStoodForPrompt` (tests/unit/domain/text-corrections.test.ts),
 * and what the store reads and hands to this prompt is proved against a real
 * store in apps/api/tests/integration/http/note-cleanup.test.ts ("Cap the
 * text-learning prompt to the last 30 days, and drop rules and pinned
 * examples as inputs", issue 451).
 */

const A_STOOD_SAMPLE: WhatStood = { proposedTotal: 10, correctedTotal: 2, sample: ['A title that stood'] };

function systemFor(corrections: readonly TextCorrectionEntry[], stood: WhatStood | null): string {
  const { system } = buildCleanUpANote([], [], [], corrections, stood);
  return `${system.instructions}\n\n${system.context}`;
}

const A_CORRECTION: TextCorrectionEntry = {
  itemId: 'item-1',
  capturedMessage: 'novi bellen over de levering',
  proposedTitle: 'Novi bellen over de levering',
  proposedDescription: null,
  settledTitle: 'Novy bellen over de levering',
  settledDescription: null,
  recordedAt: '2026-09-09T10:00:00.000Z',
};

const A_DECISION: DecisionHistoryEntry = {
  capturedMessage: 'gdpr retention question for legal',
  itemTitle: 'Ask legal about GDPR retention',
  proposedPanelId: 'panel-2',
  proposedPanelName: 'Contracts',
  proposedPanelReason: 'a legal question',
  chosenPanelId: 'panel-2',
  chosenPanelName: 'Contracts',
  decidedAt: '2026-09-01T09:00:00.000Z',
};

describe('Capture', () => {
  /**
   * Issue 584: the part of what a proposal is told that no account and no
   * note changes has to come first and read identically every time, or no two
   * calls can share it at the cache rate. Checked across an account with
   * nothing and one with something in every input, since any one input
   * leaking into it would be enough to split it.
   */
  describe('what a proposal is told reads the same for every account, until its own record begins', () => {
    const built = [
      // An account with nothing yet.
      buildCleanUpANote([], [], [], [], null),
      // An account with something in every input.
      buildCleanUpANote(
        [{ id: 'panel-2', name: 'Legal questions' }],
        [A_DECISION],
        ['still waiting to be filed'],
        [A_CORRECTION],
        A_STOOD_SAMPLE,
      ),
    ];

    it('opens with the same rules and worked examples, whatever the account has', () => {
      expect(built[1]!.system.instructions).toBe(built[0]!.system.instructions);
      expect(built[0]!.system.instructions).toContain('Examples.');
      expect(built[0]!.system.instructions).toContain('Note: call jan');
    });

    it("carries each of the account's own panels, history, captures and corrections after the rules", () => {
      const { context } = built[1]!.system;
      for (const own of ['Legal questions', 'gdpr retention question', 'still waiting to be filed', 'Novy bellen', 'A title that stood']) {
        expect(context).toContain(own);
      }
    });
  });

  describe('What a proposal reads about how this account writes', () => {
    it('carries nothing at all, rather than a placeholder, when the account has neither corrections nor what stood', () => {
      const system = systemFor([], null);
      expect(system).not.toContain('Corrections');
      expect(system).not.toContain('What stood');
      // Never claims evidence exists with nothing following it - neither in
      // the section's own intro nor in the fixed rules ahead of it.
      expect(system).not.toContain('you have proposed in the last 30 days');
      expect(system).not.toContain('were received');
    });

    it('introduces the evidence it carries, only once it actually carries some', () => {
      const correction: TextCorrectionEntry = {
        itemId: 'item-1',
        capturedMessage: 'bel novy',
        proposedTitle: 'Call Novy',
        proposedDescription: null,
        settledTitle: 'Novy bellen',
        settledDescription: null,
        recordedAt: '2026-09-09T10:00:00.000Z',
      };
      expect(systemFor([correction], null)).toContain('you have proposed in the last 30 days');
      expect(systemFor([], A_STOOD_SAMPLE)).toContain('you have proposed in the last 30 days');
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

      const system = systemFor([correction], null);

      expect(system).toContain('bel novy');
      expect(system).toContain('Call Novy');
      expect(system).toContain('Novy bellen');
    });

    it('renders every correction handed to it, with no cap of its own - the caller already windowed them', () => {
      const corrections = Array.from({ length: 60 }, (_, i) => ({
        itemId: `item-${i}`,
        capturedMessage: `correction ${i}`,
        proposedTitle: 'Proposed',
        proposedDescription: null,
        settledTitle: `Settled ${i}`,
        settledDescription: null,
        recordedAt: `2026-02-${String((i % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
      }));

      const system = systemFor(corrections, null);

      for (const correction of corrections) expect(system).toContain(correction.settledTitle);
    });

    it('renders the ratio and a sample of what stood, when the caller hands one in', () => {
      const system = systemFor([], A_STOOD_SAMPLE);

      expect(system).toContain('2 of 10 proposed texts were corrected');
      expect(system).toContain('A title that stood');
    });
  });
});

import { describe, expect, it } from 'vitest';
import { buildCleanUpANote } from '../../../../src/ai/prompts/clean-up-a-note.v11.js';
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
  return whole(buildCleanUpANote({ panels: [], history: [], recentlyCaptured: [] }, corrections, stood));
}

/** The system prompt as the model reads it, its three parts in order. */
function whole(prompt: ReturnType<typeof buildCleanUpANote>): string {
  return [prompt.system.instructions, prompt.system.stable, prompt.system.recent].join('\n\n');
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
      buildCleanUpANote({ panels: [], history: [], recentlyCaptured: [] }, [], null),
      // An account with something in every input.
      buildCleanUpANote(
        { panels: [{ id: 'panel-2', name: 'Legal questions' }], history: [A_DECISION], recentlyCaptured: ['still waiting to be filed'] },
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
      const { instructions, stable, recent } = built[1]!.system;
      for (const own of ['Legal questions', 'gdpr retention question', 'Novy bellen over de levering', 'A title that stood']) {
        expect(stable).toContain(own);
        expect(instructions).not.toContain(own);
      }
      expect(recent).toContain('still waiting to be filed');
      expect(instructions).not.toContain('still waiting to be filed');
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

  /**
   * The note is Markdown, and the message keeps what it uses ("Keep a note's
   * formatting when Cockpit rewrites it", issue 756). Whether the model
   * obeys is the contract tier's; this holds that the prompt says it.
   */
  describe("every reading is told to keep the note's formatting", () => {
    it('says so, without allowing headings or bullets the note lacks', () => {
      const { instructions } = buildCleanUpANote({ panels: [], history: [], recentlyCaptured: [] }, [], null).system;

      expect(instructions).toContain('keep them on the same words in the message');
      expect(instructions).toContain('no headings and no bullet points unless the note itself was a list');
      expect(instructions).toContain('keep its items as that list, one to a line');
    });
  });

  /**
   * "Cut what cleaning up a captured note costs" (issue 887): consecutive
   * captures read back at the cache rate whatever they share from the start,
   * so what changes least has to come first and read identically. The cache
   * itself is the contract tier's; this holds the order the prompt is built in.
   */
  describe('what a reading is told runs from what changes least to what changes most', () => {
    const ROUTING = {
      panels: [{ id: 'panel-2', name: 'Legal questions' }],
      history: [A_DECISION],
      recentlyCaptured: ['still waiting to be filed'],
    };
    const ANOTHER_DECISION: DecisionHistoryEntry = {
      ...A_DECISION,
      capturedMessage: 'vendor invoice query',
      decidedAt: '2026-09-02T09:00:00.000Z',
    };
    const ANOTHER_CORRECTION: TextCorrectionEntry = { ...A_CORRECTION, itemId: 'item-2', capturedMessage: 'mail priya' };
    const base = buildCleanUpANote(ROUTING, [A_CORRECTION], A_STOOD_SAMPLE).system;

    it('two captures with the same history and corrections and different recent notes are identical up to the recent notes', () => {
      const later = buildCleanUpANote({ ...ROUTING, recentlyCaptured: ['another one waiting'] }, [A_CORRECTION], A_STOOD_SAMPLE).system;

      expect(later.instructions).toBe(base.instructions);
      expect(later.stable).toBe(base.stable);
      expect(later.recent).not.toBe(base.recent);
      expect(base.stable).not.toContain('still waiting to be filed');
    });

    it('a filing added to the history changes it and what follows, and leaves the rules and the Panels alone', () => {
      const filed = buildCleanUpANote({ ...ROUTING, history: [A_DECISION, ANOTHER_DECISION] }, [A_CORRECTION], A_STOOD_SAMPLE).system;
      const untilTheHistory = base.stable.slice(0, base.stable.indexOf('Decision history'));

      expect(filed.instructions).toBe(base.instructions);
      expect(untilTheHistory).toContain('Legal questions');
      expect(filed.stable.startsWith(untilTheHistory)).toBe(true);
      expect(filed.stable).not.toBe(base.stable);
      expect(filed.stable).toContain('vendor invoice query');
    });

    it('a correction added changes the corrections and what follows, and leaves the rules and the history alone', () => {
      const corrected = buildCleanUpANote(ROUTING, [A_CORRECTION, ANOTHER_CORRECTION], A_STOOD_SAMPLE).system;
      const untilTheCorrections = base.stable.slice(0, base.stable.indexOf('You are also given this account'));

      expect(corrected.instructions).toBe(base.instructions);
      expect(untilTheCorrections).toContain('gdpr retention question');
      expect(corrected.stable.startsWith(untilTheCorrections)).toBe(true);
      expect(corrected.stable).not.toBe(base.stable);
      expect(corrected.stable).toContain('mail priya');
      expect(corrected.recent).toBe(base.recent);
    });

    it('an account with no history and no corrections is sent no empty block, and no heading over nothing', () => {
      const bare = buildCleanUpANote({ panels: [], history: [], recentlyCaptured: [] }, [], null).system;

      for (const part of Object.values(bare)) expect(part.trim()).not.toBe('');
      expect(bare.stable).not.toContain('Corrections');
      expect(bare.stable).not.toContain('What stood');
    });
  });
});
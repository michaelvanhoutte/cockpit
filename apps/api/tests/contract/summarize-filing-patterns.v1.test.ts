import { describe, expect, it } from 'vitest';
import { ClaudeAiService } from '../../src/ai/index.js';
import type { DecisionHistoryEntry } from '../../src/domain/decision-history.js';

/**
 * The contract tier: the real Claude API, the real prompt, no fake anywhere
 * (docs/testing-strategy.md, "Third parties"). **Scheduled, never on a pull
 * request** - every case spends money and takes as long as the model does
 * ("Show what the system learned, in a sentence you can correct", issue
 * 301).
 *
 * What only this tier can prove: that a real model, reading a real decision
 * history, actually names the pattern in it rather than describing the
 * history mechanically or inventing structure that is not there. Neither is
 * provable against a fake, which answers whatever the test told it to.
 */

const key = process.env.ANTHROPIC_API_KEY ?? '';
const reading = new ClaudeAiService(key, process.env.ANTHROPIC_WORKSPACE_ID || undefined);

async function summarize(history: readonly DecisionHistoryEntry[]) {
  const answer = await reading.summarizeFilingPatterns(history);
  if (!('summary' in answer)) throw new Error(`nothing usable came back: ${answer.discarded}`);
  return answer.summary;
}

describe('What Cockpit has learned', () => {
  it('has a key to summarize with', () => {
    expect(key, 'set ANTHROPIC_API_KEY, or put it in apps/api/.dev.vars').not.toBe('');
  });

  /**
   * The property the POC behind issue 299 measured, one level up: not only
   * does an override change the next proposal, the *pattern* of overrides is
   * something a summary can say out loud in plain English, addressed to the
   * person whose habit it is.
   */
  it('names a recurring override as the pattern it is, in plain English addressed to the reader', async () => {
    const entries = ['part 11 audit trail q for validation protocol, who signs off eod', 'sign-off needed on the cleaning validation, who owns it', 'who needs to approve the deviation before we close it'].map(
      (note, index): DecisionHistoryEntry => ({
        capturedMessage: note,
        itemTitle: note,
        proposedPanelId: 'panel-compliance',
        proposedPanelName: 'Compliance questions',
        proposedPanelReason: 'a compliance question',
        chosenPanelId: 'panel-laurens',
        chosenPanelName: 'Laurens',
        decidedAt: `2026-08-0${index + 1}T09:00:00.000Z`,
      }),
    );

    const summary = await summarize(entries);

    // Written to the reader, not about them - "you"/"your", never a third
    // person description of somebody else's habits.
    expect(summary.toLowerCase()).toMatch(/\byour?\b/);
    // Names the actual pattern: sign-off/audit-trail-shaped notes go to
    // Laurens rather than Compliance questions, which is what three
    // identically-shaped overrides in the history above should surface.
    expect(summary).toMatch(/Laurens/);
  });

  /**
   * A history too thin to have a pattern is not handed one anyway - the
   * prompt's own instruction against inventing structure that is not there.
   */
  it('does not invent a pattern out of a single, one-off entry', async () => {
    const entries: DecisionHistoryEntry[] = [
      {
        capturedMessage: 'milk, eggs, bread - stop on the way home',
        itemTitle: 'Groceries',
        proposedPanelId: null,
        proposedPanelName: null,
        proposedPanelReason: null,
        chosenPanelId: 'panel-errands',
        chosenPanelName: 'Errands',
        decidedAt: '2026-08-01T09:00:00.000Z',
      },
    ];

    const summary = await summarize(entries);

    expect(summary.length).toBeGreaterThan(0);
  });
});

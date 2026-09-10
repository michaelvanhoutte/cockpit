import { describe, expect, it } from 'vitest';
import { readSummary } from '../../../src/ai/routing-summary.js';

/**
 * L1: reading a summary answer back is a pure decision over a string, the
 * same reasoning `note-texts.test.ts` beside this file carries for
 * `readProposal` ("Show what the system learned, in a sentence you can
 * correct", issue 301). What is *done* about a discarded answer - the job
 * leaving the Workspace's summary as it was - is one level up, in
 * apps/api/tests/integration/http/routing-summary-job.test.ts.
 */

const usable = JSON.stringify({
  summary:
    'You file sign-off and audit-trail questions to Compliance questions, even when they name a person.',
});

describe('What Cockpit has learned', () => {
  describe('an answer Cockpit cannot use is thrown away rather than tidied up', () => {
    it.each([
      { situation: 'the answer carried no text at all', answer: undefined },
      { situation: 'the answer was prose rather than an answer', answer: 'You file things a certain way.' },
      { situation: 'the answer was JSON but not an answer', answer: '{"headline":"Pattern"}' },
      { situation: 'the summary said nothing', answer: JSON.stringify({ summary: '   ' }) },
    ])('says why it was thrown away when $situation', ({ answer }) => {
      const read = readSummary(answer);

      expect(read).not.toHaveProperty('summary');
      expect('discarded' in read && read.discarded.length > 0).toBe(true);
    });
  });

  it('keeps a usable summary exactly as it came, trimmed', () => {
    const padded = JSON.stringify({ summary: `  ${JSON.parse(usable).summary}  ` });

    expect(readSummary(padded)).toEqual({
      summary: JSON.parse(usable).summary,
    });
  });
});

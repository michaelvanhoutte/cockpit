import { describe, expect, it } from 'vitest';
import { enrichmentJobSchema } from '../../../src/jobs/enrichment.js';

/**
 * L1: which queued clean-ups this release takes is the job's schema alone. A
 * connector's captures name it by its id, so no source has a trigger of its
 * own ("Store every connector Item under its connector id, old Gmail Items
 * included", issue 993); one this release does not know is refused at parse
 * and logged by the consumer, never run.
 */
describe('Capture', () => {
  describe('a note’s clean-up names what started it: the app, an app connection, or a connector by its id', () => {
    it.each([
      { situation: 'a capture in the app', triggeredBy: 'captured-in-app', taken: true },
      { situation: 'an app connection’s capture', triggeredBy: 'mcp', taken: true },
      { situation: 'a connector’s capture, by its id', triggeredBy: 'connector:gmail', taken: true },
      { situation: 'Gmail’s old check, by a name of its own', triggeredBy: 'gmail-check', taken: false },
    ])('started by $situation is taken: $taken', ({ triggeredBy, taken }) => {
      const job = {
        kind: 'clean-up-a-note',
        accountName: 'acct-1',
        itemId: '018f0000-0000-7000-8000-000000000001',
        triggeredBy,
      };

      expect(enrichmentJobSchema.safeParse(job).success).toBe(taken);
    });
  });
});

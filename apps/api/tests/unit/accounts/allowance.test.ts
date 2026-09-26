import { describe, expect, it } from 'vitest';
import { allowanceSpent } from '../../../src/accounts/allowance.js';
import { ChangeFailedError } from '../../../src/accounts/up-to-date.js';

/**
 * Unit level: what tells "the free tier is spent" from "a change will not
 * apply" is a decision on an error's message, and nothing else.
 */

const QUOTA = 'Exceeded allowed rows read in Durable Objects free tier';

describe('Accounts', () => {
  describe('a spent daily allowance is told apart from any other failure', () => {
    it.each([
      { situation: 'the reads ran out', error: new Error(QUOTA) },
      { situation: 'the writes ran out', error: new Error(QUOTA.replace('read', 'written')) },
      { situation: 'another daily limit ran out', error: new Error('Exceeded allowed duration in Durable Objects free tier.') },
      {
        situation: 'it happened inside a change, which wraps the cause',
        error: new ChangeFailedError('tenant-default', '0012-standard-types', new Error(QUOTA)),
      },
    ])('recognises it when $situation', ({ error }) => {
      expect(allowanceSpent(error)).toBe(true);
    });

    it.each([
      { situation: 'a change that fails to apply', error: new Error('table commands already exists') },
      { situation: 'something thrown that is not an error', error: 'boom' },
    ])('does not mistake $situation for it', ({ error }) => {
      expect(allowanceSpent(error)).toBe(false);
    });
  });
});

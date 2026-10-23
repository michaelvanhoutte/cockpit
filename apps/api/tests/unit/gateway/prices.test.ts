import { describe, expect, it } from 'vitest';
import type { AttemptRecord, PaidBy } from '../../../src/gateway/attempts.js';
import { costOf } from '../../../src/gateway/prices.js';

/**
 * Unit level: a cost is arithmetic over the price list and the four counts.
 * That the record written for a real capture carries it is the integration
 * tier's (tests/integration/http/ai-usage.test.ts).
 */

const OUR_KEY: PaidBy = { kind: 'cockpit-anthropic-key', account: null, keyEnding: 'WXYZ' };
const SPENT = { tokensIn: 1200, cacheRead: 3400, cacheWrite: 560, tokensOut: 78 };
const NOTHING_REPORTED = { tokensIn: null, cacheRead: null, cacheWrite: null, tokensOut: null };

type Priced = Parameters<typeof costOf>[0];
const call = (over: Partial<Priced> = {}): Priced => ({ model: 'claude-sonnet-5-5', paidBy: OUR_KEY, ...SPENT, ...over });

describe('AI usage', () => {
  describe('a recorded call carries what it cost, from its model’s prices and its four token counts', () => {
    it.each([
      {
        situation: 'a Sonnet 5.5 call with input, cache read, cache write and output',
        // 1200 × $2 + 3400 × $0.20 + 560 × $2.50 + 78 × $10, per million
        record: call(),
        cost: 0.00526,
      },
      {
        situation: 'a Haiku 4.5 call',
        // 1200 × $1 + 3400 × $0.10 + 560 × $1.25 + 78 × $5, per million
        record: call({ model: 'claude-haiku-4-5' }),
        cost: 0.00263,
      },
      {
        situation: 'a Haiku 5.5 call',
        // 1200 × $0.10 + 3400 × $0.01 + 560 × $0.125 + 78 × $0.50, per million
        record: call({ model: 'claude-haiku-5-5' }),
        cost: 0.000263,
      },
      {
        situation: 'a call that read and wrote no cache',
        record: call({ cacheRead: null, cacheWrite: null }),
        // 1200 × $2 + 78 × $10, per million
        cost: 0.00318,
      },
    ])('prices $situation at its own rates', ({ record, cost }) => {
      expect(costOf(record)).toBe(cost);
    });

    it.each([
      { situation: 'a model the list has no price for', record: call({ model: 'claude-opus-5' }) },
      { situation: 'a failed attempt, which reports no tokens', record: call(NOTHING_REPORTED) },
      {
        situation: 'a Workers AI reading',
        record: call({
          model: '@cf/baai/bge-m3',
          paidBy: { kind: 'cloudflare-workers-ai', account: null, keyEnding: null },
          ...NOTHING_REPORTED,
        }),
      },
      {
        situation: 'a routine fired on the person’s own Claude plan',
        record: call({ paidBy: { kind: 'claude-plan', account: 'trig_01', keyEnding: null } }),
      },
      {
        situation: 'a Haiku 5.5 prompt longer than its published rates cover',
        record: call({ model: 'claude-haiku-5-5', tokensIn: 100_001, cacheRead: 0, cacheWrite: 0 }),
      },
    ] satisfies { situation: string; record: Pick<AttemptRecord, keyof Priced> }[])(
      'leaves the cost blank, rather than zero, for $situation',
      ({ record }) => {
        expect(costOf(record)).toBeNull();
      },
    );
  });
});

import { describe, expect, it } from 'vitest';
import { checkCallsPage } from '../../src/claude-call-shape';
import recorded from '../integration/fixtures/cockpit-claude-calls.json';

/** A call as production's route sent it, recorded (tests/integration/fixtures), with some of its fields replaced. */
const call = (over: Record<string, unknown> = {}) => ({ ...structuredClone(recorded.calls[0]!), ...over });

const refusal = (calls: unknown[]) => {
  const checked = checkCallsPage({ calls, more: false }, 0);
  if (checked.ok) throw new Error('expected a refusal');
  return checked.error;
};

describe('Harness Monitor', () => {
  describe("a page of Cockpit's Claude calls is accepted only in the route's shape", () => {
    it("accepts the page the route answered, with production's cost in millionths of a dollar", () => {
      const checked = checkCallsPage(recorded, 0);

      expect(checked.ok).toBe(true);
      if (!checked.ok) return;
      expect(checked.calls.map((c) => c.id)).toEqual(recorded.calls.map((c) => c.id));
      expect(checked.calls.map((c) => c.costMicros)).toEqual(recorded.calls.map((c) => (c.costUsd === null ? null : Math.round(c.costUsd * 1e6))));
    });

    it.each([
      { situation: 'a call without its row number', over: { id: undefined }, named: 'has no row number' },
      { situation: 'a call without its time', over: { at: undefined }, named: 'has no time' },
      { situation: 'a call with a time that is no timestamp', over: { at: 'yesterday' }, named: 'has no time' },
      { situation: 'a call without its environment', over: { environment: undefined }, named: 'has no environment' },
      { situation: 'a call with an empty environment', over: { environment: '' }, named: 'has no environment' },
    ])('$situation is refused', ({ over, named }) => {
      expect(refusal([call(over)])).toContain(named);
    });

    it.each([
      { situation: 'a negative token count', over: { tokensIn: -1 }, named: 'tokensIn' },
      { situation: 'a token count that is not a number', over: { tokensOut: '12' }, named: 'tokensOut' },
      { situation: 'a token count that is not whole', over: { cacheRead: 1.5 }, named: 'cacheRead' },
      { situation: 'a negative cost', over: { costUsd: -0.01 }, named: 'costUsd' },
      { situation: 'a cost that is not a number', over: { costUsd: '0.01' }, named: 'costUsd' },
    ])('$situation is refused', ({ over, named }) => {
      expect(refusal([call(over)])).toContain(named);
    });

    it.each([
      { situation: 'an empty prompt version', over: { promptVersion: '' } },
      { situation: 'an empty started-by', over: { startedBy: '' } },
      { situation: 'an empty branch', over: { branch: '' } },
      { situation: 'a feature of only a space', over: { feature: ' ' } },
    ])('a call with $situation, which production accepts from a sender, is accepted, so the import never stops at it', ({ over }) => {
      expect(checkCallsPage({ calls: [call(over)], more: false }, 0).ok).toBe(true);
    });

    it.each([
      { situation: 'an outcome', over: { outcome: 'anna@example.com' } },
      { situation: 'a token count', over: { tokensIn: 'anna@example.com' } },
      { situation: 'a cost', over: { costUsd: 'anna@example.com' } },
      { situation: 'a pull request', over: { pullRequest: 'anna@example.com' } },
    ])('a refusal of $situation names what is wrong, never what production sent in it', ({ over }) => {
      expect(refusal([call(over)])).not.toContain('anna');
    });

    it.each([
      { situation: 'a call carrying a user', calls: [call({ userId: 'user-anna' })], named: '"userId"' },
      { situation: 'a call carrying an account', calls: [call({ accountName: 'anna' })], named: '"accountName"' },
      { situation: 'a page carrying more than its calls', page: { calls: [call()], more: false, users: [] }, named: '"users"' },
    ])('$situation is refused, so nothing of it is stored', ({ calls, page, named }) => {
      const checked = checkCallsPage(page ?? { calls, more: false }, 0);
      expect(checked).toEqual({ ok: false, error: expect.stringContaining(named) });
    });

    it.each([
      { situation: 'a call numbered at or before the place read after', page: { calls: [call({ id: 5 })], more: false }, after: 5 },
      { situation: 'calls out of order', page: { calls: [call({ id: 7 }), call({ id: 6 })], more: false }, after: 0 },
      { situation: 'a page saying there is more with no call to continue after', page: { calls: [], more: true }, after: 0 },
    ])('$situation is refused, since the next page could not continue from it', ({ page, after }) => {
      expect(checkCallsPage(page, after).ok).toBe(false);
    });
  });
});

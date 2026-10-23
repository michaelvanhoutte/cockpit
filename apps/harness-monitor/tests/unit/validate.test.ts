import { describe, expect, it } from 'vitest';
import { CATEGORIES, MAX_BATCH, validateBatch } from '../../src/validate';

const row = (over: Record<string, unknown> = {}) => ({
  requestId: 'req_1',
  sessionId: 'session_1',
  time: '2026-10-01T10:00:00Z',
  branch: 'claude/build-1',
  category: 'building',
  model: 'claude-sonnet-5-5',
  speed: 'standard',
  inputTokens: 10,
  outputTokens: 20,
  cacheCreationTokens: 30,
  cacheReadTokens: 40,
  subagent: false,
  ranWhere: 'local',
  source: 'hook',
  ...over,
});

const refusal = (rows: unknown[]) => {
  const result = validateBatch({ rows });
  if (result.ok) throw new Error('expected a refusal');
  return result.error;
};

describe('Harness Monitor', () => {
  describe('a batch with an invalid row is refused whole', () => {
    it.each([
      { situation: 'a row without a request id', field: 'requestId', named: 'has no requestId' },
      { situation: 'a row without a session', field: 'sessionId', named: 'has no sessionId' },
      { situation: 'a row without a time', field: 'time', named: 'has no time' },
    ])('$situation is refused, naming the row', ({ field, named }) => {
      const error = refusal([row({ requestId: 'req_ok' }), row({ requestId: 'req_2', [field]: undefined })]);
      expect(error).toContain('Row 1');
      expect(error).toContain(named);
    });

    it.each([
      { situation: 'a negative token count', value: -1 },
      { situation: 'a fractional token count', value: 1.5 },
      { situation: 'a token count written as text', value: '12' },
    ])('$situation is refused', ({ value }) => {
      for (const field of ['inputTokens', 'outputTokens', 'cacheCreationTokens', 'cacheReadTokens']) {
        expect(refusal([row({ [field]: value })])).toContain(field);
      }
    });

    it.each([
      { situation: 'a bare number', time: '1' },
      { situation: 'a year alone', time: '2026' },
      { situation: 'a time with no zone', time: '2026-10-01T10:00:00' },
      { situation: 'a year past 9999', time: '+010000-01-01T00:00:00Z' },
    ])('a time that is $situation is refused', ({ time }) => {
      expect(refusal([row({ time })])).toContain('ISO 8601');
    });

    it('a time with an offset is accepted and its day is the UTC day', () => {
      const result = validateBatch({ rows: [row({ time: '2026-10-01T23:30:00-02:00' })] });
      expect(result.ok && result.rows[0]!.day).toBe('2026-10-02');
    });

    it('a category outside the seven is refused', () => {
      expect(refusal([row({ category: 'lunch' })])).toContain('category "lunch"');
    });

    it.each(CATEGORIES.map((category) => ({ category })))('the category $category is accepted', ({ category }) => {
      expect(validateBatch({ rows: [row({ category })] }).ok).toBe(true);
    });

    it('a review level is accepted only on a local code review', () => {
      expect(validateBatch({ rows: [row({ category: 'local-code-review', reviewLevel: 'xhigh' })] }).ok).toBe(true);
      expect(refusal([row({ category: 'building', reviewLevel: 'xhigh' })])).toContain('reviewLevel');
      expect(refusal([row({ category: 'local-code-review', reviewLevel: 'ultra' })])).toContain('reviewLevel');
    });

    it('a subagent type and id are optional, kept on a subagent request, and nothing else', () => {
      const accepted = validateBatch({
        rows: [row(), row({ requestId: 'r2', subagent: true }), row({ requestId: 'r3', subagent: true, subagentType: 'Explore', subagentId: 'agent-1' })],
      });
      expect(accepted.ok && accepted.rows.map((r) => [r.subagentType, r.subagentId])).toEqual([
        [null, null],
        [null, null],
        ['Explore', 'agent-1'],
      ]);
    });

    it.each([
      { situation: 'a type that is not a string', over: { subagent: true, subagentType: 3 }, field: 'subagentType' },
      { situation: 'an empty id', over: { subagent: true, subagentId: '' }, field: 'subagentId' },
      { situation: 'a type that is not short', over: { subagent: true, subagentType: 'x'.repeat(101) }, field: 'subagentType' },
      { situation: 'a type on a main-agent request', over: { subagentType: 'Explore' }, field: 'subagentType' },
      { situation: 'an id on a main-agent request', over: { subagentId: 'agent-1' }, field: 'subagentId' },
    ])('$situation is refused, naming the field', ({ over, field }) => {
      expect(refusal([row(over)])).toContain(field);
    });

    it('the 1-hour part of a cache write is optional, and never more than the cache write itself', () => {
      const accepted = validateBatch({ rows: [row(), row({ requestId: 'r2', cacheCreation1hTokens: 30 })] });
      expect(accepted.ok && accepted.rows.map((r) => r.cacheCreation1hTokens)).toEqual([0, 30]);
      expect(refusal([row({ cacheCreation1hTokens: 31 })])).toContain('cacheCreation1hTokens');
      expect(refusal([row({ cacheCreation1hTokens: -1 })])).toContain('cacheCreation1hTokens');
    });

    it('a batch over the size limit is refused', () => {
      const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => row({ requestId: `req_${i}` }));
      expect(refusal(many)).toContain(String(MAX_BATCH));
      expect(validateBatch({ rows: many.slice(0, MAX_BATCH) }).ok).toBe(true);
    });

    it('a request belongs to the Belgian day it was made on, not the UTC day', () => {
      const result = validateBatch({
        rows: [
          row({ requestId: 'a', time: '2026-10-21T21:59:59Z' }),
          row({ requestId: 'b', time: '2026-10-21T22:00:01Z' }),
          row({ requestId: 'c', time: '2026-10-22T01:30:00+02:00' }),
        ],
      });
      expect(result.ok && result.rows.map((r) => r.day)).toEqual(['2026-10-21', '2026-10-22', '2026-10-22']);
    });
  });
});

import { describe, expect, it } from 'vitest';
import { CATEGORIES, MAX_BATCH, validateBatch } from '../../src/validate';

const row = (over: Record<string, unknown> = {}) => ({
  requestId: 'req_1',
  sessionId: 'session_1',
  time: '2026-03-01T10:00:00Z',
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

    it('a category outside the six is refused', () => {
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

    it('a batch over the size limit is refused', () => {
      const many = Array.from({ length: MAX_BATCH + 1 }, (_, i) => row({ requestId: `req_${i}` }));
      expect(refusal(many)).toContain(String(MAX_BATCH));
      expect(validateBatch({ rows: many.slice(0, MAX_BATCH) }).ok).toBe(true);
    });

    it('a request just after midnight UTC belongs to the new day', () => {
      const result = validateBatch({
        rows: [row({ requestId: 'a', time: '2026-03-01T23:59:59Z' }), row({ requestId: 'b', time: '2026-03-02T00:00:01Z' })],
      });
      expect(result.ok && result.rows.map((r) => r.day)).toEqual(['2026-03-01', '2026-03-02']);
    });
  });
});

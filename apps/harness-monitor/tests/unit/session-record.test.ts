import { describe, expect, it } from 'vitest';
import { reviewCounts } from '../../src/session-record';

const record = (...lines: string[]) =>
  ['## Summary', '', '<!-- session-record:start -->', '### Session record', '', ...lines.map((l) => `- 2026-10-01T10:00:00.000Z ${l}`), '<!-- session-record:end -->', ''].join('\n');

describe('Harness Monitor', () => {
  describe("a pull request's local review rounds and findings are read from its body's session record", () => {
    it('counts a round for each review start, and sums the counts the review ends carry', () => {
      const body = record('start', 'review-start code-review high', 'review-end code-review high:2', 'review-start code-review high', 'review-end code-review high:0', 'review-start security-review high', 'review-end security-review high:1');

      expect(reviewCounts(body)).toEqual({ rounds: 3, findings: 3 });
    });

    it('counts the rounds but leaves findings unknown where a review end has no count', () => {
      const body = record('review-start code-review high', 'review-end code-review high:2', 'review-start security-review high', 'review-end security-review high');

      expect(reviewCounts(body)).toEqual({ rounds: 2, findings: null });
    });

    it('leaves findings unknown for a review that has begun and not ended', () => {
      expect(reviewCounts(record('review-start code-review high'))).toEqual({ rounds: 1, findings: null });
    });

    it('is unknown, not zero, where the body has no record', () => {
      expect(reviewCounts('## Summary\n\nDid a thing.\n')).toEqual({ rounds: null, findings: null });
      expect(reviewCounts('')).toEqual({ rounds: null, findings: null });
      expect(reviewCounts(null)).toEqual({ rounds: null, findings: null });
      expect(reviewCounts(undefined)).toEqual({ rounds: null, findings: null });
    });

    it('has no rounds, and no findings to report, for a record of a session that ran no review', () => {
      expect(reviewCounts(record('start', 'pushed'))).toEqual({ rounds: 0, findings: null });
    });

    it('reads the record whatever line endings the body has', () => {
      const body = record('review-start code-review high', 'review-end code-review high:4').replaceAll('\n', '\r\n');

      expect(reviewCounts(body)).toEqual({ rounds: 1, findings: 4 });
    });

    it('reads the same rounds and findings with outcome and CI lines in the record', () => {
      const lines = ['start', 'review-start code-review high', 'review-end code-review high:5', 'review-outcome code-review high:3/2', 'ci-start', 'ci-end failure', 'review-start code-review high', 'review-end code-review high:1'];
      const plain = record(...lines.filter((l) => !/^(review-outcome|ci-)/.test(l)));

      expect(reviewCounts(record(...lines))).toEqual({ rounds: 2, findings: 6 });
      expect(reviewCounts(record(...lines))).toEqual(reviewCounts(plain));
    });

    it('does not guess from half a block', () => {
      expect(reviewCounts('<!-- session-record:start -->\n- 2026-10-01T10:00:00.000Z review-start code-review high\n')).toEqual({ rounds: null, findings: null });
    });
  });
});

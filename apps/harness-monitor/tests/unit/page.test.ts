import { describe, expect, it } from 'vitest';
import { tokenCount } from '../../src/page';

describe('Harness Monitor', () => {
  describe('a token count reads as people say one', () => {
    it.each([
      { tokens: 9_946, reads: '9,946' },
      { tokens: 11_000, reads: '11k' },
      { tokens: 3_100_000, reads: '3.1M' },
      { tokens: 1_310_000_000, reads: '1.31B' },
    ])('$tokens reads $reads', ({ tokens, reads }) => {
      expect(tokenCount(tokens)).toBe(reads);
    });
  });
});

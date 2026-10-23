import { describe, expect, it } from 'vitest';
import { saysHowItIsSorted } from '../../src/sorting';

/**
 * F1: how the sort mark reads a Panel's sort back is the client's own wording,
 * with nothing to prove against a store. The order the sort puts rows in is
 * packages/shared/tests/unit/domain/sorting.test.ts.
 */

describe('Panels', () => {
  describe('the sort mark reads the sort back as a sentence', () => {
    it('names each criterion and its direction, in order', () => {
      expect(
        saysHowItIsSorted([
          { field: 'dueDate', direction: 'asc' },
          { field: 'priority', direction: 'desc' },
        ]),
      ).toBe('Sorted: Due date ascending, then Priority descending');
    });
  });
});

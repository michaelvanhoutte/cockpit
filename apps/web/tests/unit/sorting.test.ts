import { describe, expect, it } from 'vitest';
import { saysHowItIsSorted } from '../../src/sorting';

/**
 * F1: how a sorted Panel's sort is read back as a sentence. The order the sort
 * puts rows in is packages/shared/tests/unit/domain/sorting.test.ts's, now that
 * the Worker orders Filters too.
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

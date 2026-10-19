import { describe, expect, it } from 'vitest';
import { saysHowItIsSorted } from '../../src/sorting';

/**
 * F1: what the sort mark says. The order a sort puts rows in is the shared
 * package's (packages/shared/tests/unit/domain/sorting.test.ts).
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

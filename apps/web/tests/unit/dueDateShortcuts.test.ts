import { describe, expect, it } from 'vitest';
import { dueSevenDaysOut, dueToday, dueTomorrow } from '../../src/dueDateShortcuts';

/**
 * F1: pure calendar arithmetic, measured from a fixed clock - nothing here
 * needs a browser or a real one. What the due date field does with a chosen
 * shortcut, including that typing over it still wins, is
 * tests/unit/components/ItemForm.test.tsx's own claim.
 */
describe('Item editing', () => {
  describe('setting a due date has one-click shortcuts alongside typing one directly', () => {
    it('Today always sets today', () => {
      expect(dueToday(new Date('2026-09-18T09:00:00.000Z'))).toBe('2026-09-18');
    });

    it('+7d is always seven days from today', () => {
      expect(dueSevenDaysOut(new Date('2026-09-18T09:00:00.000Z'))).toBe('2026-09-25');
    });

    describe('Tmrw sets the day after today, measured when it is pressed', () => {
      it.each([
        { situation: 'a midweek day', now: '2026-09-16T09:00:00.000Z', expected: '2026-09-17' },
        { situation: 'the last day of a month', now: '2026-09-30T09:00:00.000Z', expected: '2026-10-01' },
      ])('$situation sets $expected', ({ now, expected }) => {
        expect(dueTomorrow(new Date(now))).toBe(expected);
      });
    });
  });
});

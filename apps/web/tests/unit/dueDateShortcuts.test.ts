import { describe, expect, it } from 'vitest';
import { dueComingFriday, dueSevenDaysOut, dueToday } from '../../src/dueDateShortcuts';

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

    describe('Fri sets the coming Friday, never a past one', () => {
      it.each([
        { situation: 'Monday', now: '2026-09-14T09:00:00.000Z', expected: '2026-09-18' },
        { situation: 'Tuesday', now: '2026-09-15T09:00:00.000Z', expected: '2026-09-18' },
        { situation: 'Wednesday', now: '2026-09-16T09:00:00.000Z', expected: '2026-09-18' },
        { situation: 'Thursday', now: '2026-09-17T09:00:00.000Z', expected: '2026-09-18' },
        // Friday itself is not a past Friday - it sets today.
        { situation: 'Friday', now: '2026-09-18T09:00:00.000Z', expected: '2026-09-18' },
        // The weekend jumps to next week's Friday rather than the one just gone.
        { situation: 'Saturday', now: '2026-09-19T09:00:00.000Z', expected: '2026-09-25' },
        { situation: 'Sunday', now: '2026-09-20T09:00:00.000Z', expected: '2026-09-25' },
      ])('a $situation sets $expected', ({ now, expected }) => {
        expect(dueComingFriday(new Date(now))).toBe(expected);
      });
    });
  });
});

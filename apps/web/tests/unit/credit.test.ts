import { describe, expect, it } from 'vitest';
import { creditLine } from '../../src/credit';

/** F1: the years are a pure function of the date, which is injected. */
describe('Across the app', () => {
  describe('the credit’s years run from 2026 to the current year', () => {
    it.each([
      { situation: 'the first year', now: new Date(2026, 5, 1), says: '© 2026 Conselit · conselit.be' },
      { situation: 'the second year', now: new Date(2027, 0, 1), says: '© 2026–2027 Conselit · conselit.be' },
      { situation: 'a later year', now: new Date(2031, 11, 31), says: '© 2026–2031 Conselit · conselit.be' },
    ])('reads as $says in $situation', ({ now, says }) => {
      expect(creditLine(now)).toBe(says);
    });
  });
});

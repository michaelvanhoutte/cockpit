import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LANDING_WAIT_MS, askToLand, forgetLanding, landOn, useLanding } from '../../src/landOnItem';

/**
 * F1: the request to land on an Item's row, which outlives the column that made
 * it. That a real router and layout keep focus on the row through a Dashboard
 * switch is the browser walk in tests/e2e/dashboards.test.ts.
 */
const inTheInbox = (itemId: string, focus = true) => ({ itemId, place: { kind: 'inbox' } as const, focus });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  act(() => forgetLanding());
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('Dashboards', () => {
  describe('Enter lands keyboard focus on the row and leaves the form closed', () => {
    it('expires after about a second, so a row never drawn is never focused later', () => {
      const { result } = renderHook(() => useLanding());
      act(() => askToLand(inTheInbox('a')));
      expect(result.current?.itemId).toBe('a');

      vi.advanceTimersByTime(LANDING_WAIT_MS + 1);
      const again = renderHook(() => useLanding());
      expect(again.result.current).toBeNull();
    });

    it('lets only the second of two Enters land', () => {
      const { result } = renderHook(() => useLanding());
      act(() => askToLand(inTheInbox('first')));
      act(() => askToLand(inTheInbox('second')));
      expect(result.current?.itemId).toBe('second');
    });

    it('focuses the row outlined, and takes the outline off when focus leaves it', () => {
      const row = document.body.appendChild(document.createElement('li'));
      const elsewhere = document.body.appendChild(document.createElement('button'));

      landOn(row, true);
      expect(row).toHaveFocus();
      expect(row).toHaveAttribute('data-shown');

      elsewhere.focus();
      expect(row).not.toHaveAttribute('data-shown');
    });

    it('outlines a row for a moment without focusing it', () => {
      const row = document.body.appendChild(document.createElement('li'));

      landOn(row, false);
      expect(row).toHaveAttribute('data-shown');
      expect(row).not.toHaveFocus();

      vi.advanceTimersByTime(5000);
      expect(row).not.toHaveAttribute('data-shown');
    });
  });
});

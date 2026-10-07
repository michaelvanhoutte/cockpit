import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { FOCUS_WAIT_MS, askForTheContainingField, useContainingFieldFocus } from '../../src/filterKey';

describe('Dashboards', () => {
  describe('a request for the cursor in Containing…', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    const draw = (filterId: string) => {
      const input = document.createElement('input');
      document.body.append(input);
      renderHook(() => useContainingFieldFocus(filterId, { current: input }));
      return input;
    };

    it('is taken by the bar of that filter when it is drawn in time', () => {
      askForTheContainingField('d1');
      vi.advanceTimersByTime(FOCUS_WAIT_MS - 1);
      expect(draw('d1')).toBe(document.activeElement);
    });

    it('is gone once its bar takes too long to appear, so a late bar leaves the cursor where it is', () => {
      askForTheContainingField('d2');
      vi.advanceTimersByTime(FOCUS_WAIT_MS + 1);
      expect(draw('d2')).not.toBe(document.activeElement);
    });
  });
});

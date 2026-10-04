import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { TIP_ATTRIBUTE, TIP_MS, tipForClick, useShortcutTip } from '../../src/shortcutTip';
import { opensCapture } from '../../src/captureShortcut';

/**
 * F1: which control gets which tip, and how a tip comes and goes, are
 * view-model logic. That the shell really shows it, and still opens Capture,
 * is the browser walk in tests/e2e/capture.test.ts.
 */
const control = (tip?: string) => {
  const el = document.createElement('button');
  if (tip) el.setAttribute(TIP_ATTRIBUTE, tip);
  const inner = document.createElement('span');
  el.append(inner);
  return inner;
};
const mouse = (target: EventTarget | null) => ({ detail: 1, target });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('Shortcuts', () => {
  describe('a mouse click on a control that has a shortcut names its key', () => {
    it.each([
      { situation: 'the Capture tab', tip: 'capture', says: 'Tip: press C to capture from anywhere' },
      { situation: 'the Inbox\u2019s collapse control', tip: 'inbox', says: 'Tip: press I to collapse or open the Inbox' },
      { situation: 'the collapsed Inbox\u2019s handle', tip: 'inbox', says: 'Tip: press I to collapse or open the Inbox' },
      { situation: 'the dock\u2019s hide control', tip: 'dock', says: 'Tip: press A to hide or show the agents\u2019 dock' },
      { situation: 'the dock\u2019s show strip', tip: 'dock', says: 'Tip: press A to hide or show the agents\u2019 dock' },
      { situation: 'anything else', tip: undefined, says: null },
    ])('$situation', ({ tip, says }) => {
      expect(tipForClick(mouse(control(tip)))).toBe(says);
    });
  });

  describe('a key press never shows a tip', () => {
    it('a control activated from the keyboard shows none', () => {
      expect(tipForClick({ detail: 0, target: control('capture') })).toBeNull();
    });
  });

  describe('a tip goes away, and never gets in the way', () => {
    const click = (result: { current: ReturnType<typeof useShortcutTip> }, tip: string) =>
      act(() => result.current.clicked(mouse(control(tip))));

    it('is gone 5 seconds after it appears', () => {
      const { result } = renderHook(() => useShortcutTip(true));
      click(result, 'capture');
      expect(result.current.tip).toContain('press C');
      act(() => vi.advanceTimersByTime(TIP_MS - 1));
      expect(result.current.tip).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(result.current.tip).toBeNull();
    });

    it('is gone at once when dismissed', () => {
      const { result } = renderHook(() => useShortcutTip(true));
      click(result, 'capture');
      act(() => result.current.dismiss());
      expect(result.current.tip).toBeNull();
    });

    it('is replaced by a second tip, which restarts the 5 seconds', () => {
      const { result } = renderHook(() => useShortcutTip(true));
      click(result, 'capture');
      act(() => vi.advanceTimersByTime(3000));
      click(result, 'inbox');
      expect(result.current.tip).toContain('press I');
      act(() => vi.advanceTimersByTime(3000));
      expect(result.current.tip).toContain('press I');
      act(() => vi.advanceTimersByTime(2000));
      expect(result.current.tip).toBeNull();
    });

    it('leaves C, I and A working while it shows', () => {
      const { result } = renderHook(() => useShortcutTip(true));
      click(result, 'capture');
      expect(result.current.tip).not.toBeNull();
      // The tip is no menu or window, so the keys' own guard finds nothing open.
      for (const key of ['c', 'C']) {
        expect(opensCapture(new KeyboardEvent('keydown', { key }))).toBe(true);
      }
    });
  });

  describe('no tip where there is no room for the Inbox', () => {
    it.each([
      { situation: 'without room, a click on Capture shows none', room: false, shown: false },
      { situation: 'with room, a click on Capture shows its tip', room: true, shown: true },
    ])('$situation', ({ room, shown }) => {
      const { result } = renderHook(() => useShortcutTip(room));
      act(() => result.current.clicked(mouse(control('capture'))));
      expect(result.current.tip !== null).toBe(shown);
    });
  });
});

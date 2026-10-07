import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  forgetPanelListCollapsed,
  readPanelListCollapsed,
  togglesThePanelList,
  usePanelListCollapsed,
  writePanelListCollapsed,
} from '../../src/panelList';
import type { KeyPress } from '../../src/inboxCollapsed';

/**
 * F1: which key presses show or hide Go to panel and what is remembered of the
 * choice are decisions over values handed in, and the hook that joins them is
 * given its store. That the column hears the key is components/PanelList.test.tsx,
 * and that the shell draws it is tests/unit/pages/Layout.test.tsx.
 */
const PLAIN: KeyPress = {
  key: 'g',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  defaultPrevented: false,
  typing: false,
};

function aStore(): Storage {
  const held = new Map<string, string>();
  return {
    getItem: (k: string) => held.get(k) ?? null,
    setItem: (k: string, v: string) => void held.set(k, v),
    removeItem: (k: string) => void held.delete(k),
  } as Storage;
}

describe('Dashboards', () => {
  describe('G shows and hides Go to panel, and only when nothing else has the keys', () => {
    it.each([
      { situation: 'a plain g', press: {}, covered: false, toggles: true },
      { situation: 'a capital G', press: { key: 'G' }, covered: false, toggles: true },
      { situation: 'the old key, P', press: { key: 'p' }, covered: false, toggles: false },
      { situation: 'the Inbox’s key', press: { key: 'i' }, covered: false, toggles: false },
      { situation: 'typing in a field', press: { typing: true }, covered: false, toggles: false },
      { situation: 'Ctrl held', press: { ctrlKey: true }, covered: false, toggles: false },
      { situation: 'Alt held', press: { altKey: true }, covered: false, toggles: false },
      { situation: '⌘ held', press: { metaKey: true }, covered: false, toggles: false },
      { situation: 'a key held down', press: { repeat: true }, covered: false, toggles: false },
      { situation: 'a press something already took', press: { defaultPrevented: true }, covered: false, toggles: false },
      { situation: 'a menu or window open', press: {}, covered: true, toggles: false },
    ])('$situation', ({ press, covered, toggles }) => {
      expect(togglesThePanelList({ ...PLAIN, ...press }, covered)).toBe(toggles);
    });
  });

  describe('Go to panel is hidden until first shown, and that choice is this browser’s until sign-out', () => {
    it('is hidden on a first visit, is shown and hidden again, and is as it was left on the next visit', () => {
      const store = aStore();
      const first = renderHook(() => usePanelListCollapsed(store));
      expect(first.result.current[0]).toBe(true);

      act(() => first.result.current[1](false));
      expect(first.result.current[0]).toBe(false);
      first.unmount();

      const second = renderHook(() => usePanelListCollapsed(store));
      expect(second.result.current[0]).toBe(false);

      act(() => second.result.current[1](true));
      second.unmount();
      expect(renderHook(() => usePanelListCollapsed(store)).result.current[0]).toBe(true);
    });

    it('is hidden again once signed out', () => {
      const store = aStore();
      writePanelListCollapsed(store, false);
      expect(readPanelListCollapsed(store)).toBe(false);

      forgetPanelListCollapsed(store);

      expect(readPanelListCollapsed(store)).toBe(true);
    });

    it('is hidden, and throws nothing, where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = { getItem: refuse, setItem: refuse, removeItem: refuse } as unknown as Storage;
      expect(() => writePanelListCollapsed(refusing, false)).not.toThrow();
      expect(() => forgetPanelListCollapsed(refusing)).not.toThrow();
      expect(readPanelListCollapsed(refusing)).toBe(true);
      expect(readPanelListCollapsed(undefined)).toBe(true);
    });
  });
});

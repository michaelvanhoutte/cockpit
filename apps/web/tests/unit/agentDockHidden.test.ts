import { describe, expect, it } from 'vitest';
import {
  readAgentDockHidden,
  togglesTheAgentDock,
  writeAgentDockHidden,
  type KeyPress,
} from '../../src/agentDockHidden';

/**
 * F1, and pure: which key presses toggle the dock, and what is remembered of
 * the choice, are decisions over values handed in - the same split
 * `inboxCollapsed.test.ts` makes for the Inbox. That the shell wires this to
 * the dock is tests/unit/pages/Layout.test.tsx.
 */
const PLAIN: KeyPress = {
  key: 'a',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  defaultPrevented: false,
  typing: false,
};

describe('Agents', () => {
  describe('A toggles the dock, and only when nothing else has the keys', () => {
    it.each([
      { situation: 'a plain a', press: {}, covered: false, toggles: true },
      { situation: 'a capital A', press: { key: 'A' }, covered: false, toggles: true },
      { situation: 'another key', press: { key: 'j' }, covered: false, toggles: false },
      { situation: 'typing in a field', press: { typing: true }, covered: false, toggles: false },
      { situation: 'Ctrl held', press: { ctrlKey: true }, covered: false, toggles: false },
      { situation: 'Alt held', press: { altKey: true }, covered: false, toggles: false },
      { situation: '⌘ held', press: { metaKey: true }, covered: false, toggles: false },
      { situation: 'a key held down', press: { repeat: true }, covered: false, toggles: false },
      {
        situation: 'a press something already took',
        press: { defaultPrevented: true },
        covered: false,
        toggles: false,
      },
      { situation: 'a menu or window open', press: {}, covered: true, toggles: false },
    ])('$situation', ({ press, covered, toggles }) => {
      expect(togglesTheAgentDock({ ...PLAIN, ...press }, covered)).toBe(toggles);
    });
  });

  describe('the choice to hide the dock is remembered in this browser', () => {
    function aStore(): Storage {
      const held = new Map<string, string>();
      return {
        getItem: (k: string) => held.get(k) ?? null,
        setItem: (k: string, v: string) => void held.set(k, v),
        removeItem: (k: string) => void held.delete(k),
      } as Storage;
    }

    it('reads back what was written, and shown where nothing was', () => {
      const store = aStore();
      expect(readAgentDockHidden(store)).toBe(false);
      writeAgentDockHidden(store, true);
      expect(readAgentDockHidden(store)).toBe(true);
      writeAgentDockHidden(store, false);
      expect(readAgentDockHidden(store)).toBe(false);
    });

    it('is shown, and throws nothing, where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = { getItem: refuse, setItem: refuse, removeItem: refuse } as unknown as Storage;
      expect(() => writeAgentDockHidden(refusing, true)).not.toThrow();
      expect(readAgentDockHidden(refusing)).toBe(false);
      expect(readAgentDockHidden(undefined)).toBe(false);
    });
  });
});

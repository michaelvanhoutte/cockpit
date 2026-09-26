import { describe, expect, it } from 'vitest';
import { restedLongEnough, DWELL_MS } from '../../src/switchWhileDragging';
import {
  readInboxCollapsed,
  togglesTheInbox,
  writeInboxCollapsed,
  type KeyPress,
} from '../../src/inboxCollapsed';

/**
 * F1, and pure: which key presses toggle the Inbox, and what is remembered of
 * the choice, are decisions over values handed in. That the shell wires them to
 * the column is tests/unit/router.test.tsx.
 */
const PLAIN: KeyPress = {
  key: 'i',
  ctrlKey: false,
  altKey: false,
  metaKey: false,
  repeat: false,
  defaultPrevented: false,
  typing: false,
};

describe('Triage', () => {
  describe('I toggles the Inbox, and only when nothing else has the keys', () => {
    it.each([
      { situation: 'a plain i', press: {}, covered: false, toggles: true },
      { situation: 'a capital I', press: { key: 'I' }, covered: false, toggles: true },
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
      expect(togglesTheInbox({ ...PLAIN, ...press }, covered)).toBe(toggles);
    });
  });

  describe('the choice to collapse the Inbox is remembered in this browser', () => {
    function aStore(): Storage {
      const held = new Map<string, string>();
      return {
        getItem: (k: string) => held.get(k) ?? null,
        setItem: (k: string, v: string) => void held.set(k, v),
        removeItem: (k: string) => void held.delete(k),
      } as Storage;
    }

    it('reads back what was written, and open where nothing was', () => {
      const store = aStore();
      expect(readInboxCollapsed(store)).toBe(false);
      writeInboxCollapsed(store, true);
      expect(readInboxCollapsed(store)).toBe(true);
      writeInboxCollapsed(store, false);
      expect(readInboxCollapsed(store)).toBe(false);
    });

    it('is open, and throws nothing, where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = { getItem: refuse, setItem: refuse, removeItem: refuse } as unknown as Storage;
      expect(() => writeInboxCollapsed(refusing, true)).not.toThrow();
      expect(readInboxCollapsed(refusing)).toBe(false);
      expect(readInboxCollapsed(undefined)).toBe(false);
    });
  });

  describe('a row held on the collapsed Inbox chip opens the Inbox after the dwell', () => {
    it.each([
      { situation: 'rested the full dwell', held: DWELL_MS, opens: true },
      { situation: 'not for long enough', held: DWELL_MS - 1, opens: false },
    ])('$situation', ({ held, opens }) => {
      expect(restedLongEnough(1_000, 1_000 + held)).toBe(opens);
    });
  });
});

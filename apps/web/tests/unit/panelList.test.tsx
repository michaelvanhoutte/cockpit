import { describe, expect, it } from 'vitest';
import { act, render, renderHook, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  forgetPanelListCollapsed,
  readPanelListCollapsed,
  togglesThePanelList,
  usePanelListCollapsed,
  writePanelListCollapsed,
} from '../../src/panelList';
import type { KeyPress } from '../../src/inboxCollapsed';

/**
 * F1: which key presses toggle the Panel list and what is remembered of the
 * choice are decisions over values handed in, and the hook that joins them is
 * given its store. That the shell draws the list and wires the hook to it is
 * tests/unit/pages/Layout.test.tsx.
 */
const PLAIN: KeyPress = {
  key: 'p',
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
  describe('P toggles the Panel list, and only when nothing else has the keys', () => {
    it.each([
      { situation: 'a plain p', press: {}, covered: false, toggles: true },
      { situation: 'a capital P', press: { key: 'P' }, covered: false, toggles: true },
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

  describe('the Panel list is open, until it is collapsed, and that choice is this browser’s until sign-out', () => {
    it('is open on a first visit, collapses and opens, and is as it was left on the next visit', () => {
      const store = aStore();
      const first = renderHook(() => usePanelListCollapsed(store, true));
      expect(first.result.current[0]).toBe(false);

      act(() => first.result.current[1](true));
      expect(first.result.current[0]).toBe(true);
      first.unmount();

      const second = renderHook(() => usePanelListCollapsed(store, true));
      expect(second.result.current[0]).toBe(true);

      act(() => second.result.current[1](false));
      second.unmount();
      expect(renderHook(() => usePanelListCollapsed(store, true)).result.current[0]).toBe(false);
    });

    it('is open again once signed out', () => {
      const store = aStore();
      writePanelListCollapsed(store, true);
      expect(readPanelListCollapsed(store)).toBe(true);

      forgetPanelListCollapsed(store);

      expect(readPanelListCollapsed(store)).toBe(false);
    });

    it('is open, and throws nothing, where the browser refuses storage', () => {
      const refuse = () => {
        throw new Error('refused');
      };
      const refusing = { getItem: refuse, setItem: refuse, removeItem: refuse } as unknown as Storage;
      expect(() => writePanelListCollapsed(refusing, true)).not.toThrow();
      expect(readPanelListCollapsed(refusing)).toBe(false);
      expect(readPanelListCollapsed(undefined)).toBe(false);
    });
  });

  describe('P collapses and opens the Panel list from the keyboard', () => {
    function Probe({ store, listening = true }: { store: Storage; listening?: boolean }) {
      const [collapsed] = usePanelListCollapsed(store, listening);
      return (
        <>
          <input aria-label="A box" />
          <output>{collapsed ? 'collapsed' : 'open'}</output>
        </>
      );
    }

    it('collapses on P, and opens again on p', async () => {
      const user = userEvent.setup();
      render(<Probe store={aStore()} />);

      await user.keyboard('P');
      expect(screen.getByRole('status')).toHaveTextContent('collapsed');

      await user.keyboard('p');
      expect(screen.getByRole('status')).toHaveTextContent('open');
    });

    it('types the letter into a box and does nothing else', async () => {
      const user = userEvent.setup();
      render(<Probe store={aStore()} />);

      await user.type(screen.getByRole('textbox', { name: 'A box' }), 'p');

      expect(screen.getByRole('status')).toHaveTextContent('open');
    });

    it('does nothing under a menu or a window, or with a modifier, or when the list is not on screen', async () => {
      const user = userEvent.setup();
      const { rerender } = render(<Probe store={aStore()} />);

      const dialog = document.body.appendChild(document.createElement('div'));
      dialog.setAttribute('role', 'dialog');
      await user.keyboard('p');
      dialog.remove();
      await user.keyboard('{Control>}p{/Control}');
      expect(screen.getByRole('status')).toHaveTextContent('open');

      rerender(<Probe store={aStore()} listening={false} />);
      await user.keyboard('p');
      expect(screen.getByRole('status')).toHaveTextContent('open');
    });
  });
});

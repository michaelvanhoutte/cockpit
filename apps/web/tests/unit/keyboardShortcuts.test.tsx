import { afterEach, describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { opensCapture } from '../../src/captureShortcut';
import { STEPS } from '../../src/inboxKeys';
import { opensTheShortcuts } from '../../src/keyboardShortcuts';
import { SHORTCUT_GROUPS, SHORTCUTS_FOOTER } from '../../src/shortcutList';
import { KeyboardShortcutsWindow } from '../../src/components/KeyboardShortcutsWindow';

/**
 * F1: which element has focus and what is open is a decision over the page that
 * jsdom can render, and the list is drawn from the same code the keys are. That
 * the running app hears these keys with a form docked is
 * tests/e2e/keyboard-shortcuts.test.ts; the shell's own listeners (I, `?`, the
 * profile menu entry) are tests/unit/pages/Layout.test.tsx and G and F's
 * tests/unit/components/PanelList.test.tsx.
 */

/** What a case put on the page itself, taken off after it: the renderer cleans up only its own. */
const putOnThePage: Node[] = [];
afterEach(() => {
  for (const node of putOnThePage.splice(0)) node.parentNode?.removeChild(node);
});
const putUp = (...nodes: Node[]) => {
  putOnThePage.push(...nodes);
  document.body.append(...nodes);
};

const element = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attributes: Record<string, string> = {},
  ...children: Node[]
): HTMLElementTagNameMap[K] => {
  const made = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) made.setAttribute(name, value);
  made.append(...children);
  return made;
};

/** The Item form docked beside the page: a non-modal dialog wearing the mark (`ItemForm.tsx`). */
const dockedForm = () =>
  element(
    'div',
    { role: 'dialog', 'data-docked-form': '' },
    element('button', { 'aria-label': 'Close' }),
    element('input', { 'aria-label': 'Title' }),
    element('textarea', { 'aria-label': 'Notes' }),
  );

type Press = { key: string } & KeyboardEventInit;

/** What a listener on the window decides about a key pressed on `target`. */
function decidedFor(target: Element, press: Press, decide: (event: KeyboardEvent) => boolean): boolean {
  let decided = false;
  const listener = (event: KeyboardEvent) => {
    decided = decide(event);
  };
  window.addEventListener('keydown', listener);
  target.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, ...press }));
  window.removeEventListener('keydown', listener);
  return decided;
}

describe('Shortcuts', () => {
  describe('the docked Item form never holds back a page key; a field, a menu, a modal form or a dialog does', () => {
    // C stands for the page keys: C, I, G and F all ask the one guard
    // (`somethingIsOpenOverThePage`), and I, G and F's listeners each have
    // their own case where they are mounted.
    it.each([
      { situation: 'form docked, keyboard on the page', open: [dockedForm()], on: () => document.body, acts: true },
      {
        situation: 'form docked, keyboard on a button inside it',
        open: [dockedForm()],
        on: () => document.querySelector('button')!,
        acts: true,
      },
      {
        situation: 'form docked, keyboard in its title',
        open: [dockedForm()],
        on: () => document.querySelector('input')!,
        acts: false,
      },
      {
        situation: 'form docked, keyboard in another text field of it',
        open: [dockedForm()],
        on: () => document.querySelector('textarea')!,
        acts: false,
      },
      {
        situation: 'form open as a modal',
        open: [element('div', { role: 'dialog' }, element('button'))],
        on: () => document.querySelector('button')!,
        acts: false,
      },
      {
        situation: 'form docked with a row menu open',
        open: [dockedForm(), element('div', { role: 'menu' })],
        on: () => document.body,
        acts: false,
      },
      {
        situation: 'form docked with Move to… open over it',
        open: [dockedForm(), element('div', { role: 'dialog' })],
        on: () => document.body,
        acts: false,
      },
      {
        situation: 'form docked with a question open over it',
        open: [dockedForm(), element('div', { role: 'alertdialog' })],
        on: () => document.body,
        acts: false,
      },
    ])('$situation: C acts: $acts', ({ open, on, acts }) => {
      putUp(...open);

      expect(decidedFor(on(), { key: 'c' }, (event) => opensCapture(event))).toBe(acts);
    });
  });

  describe('? opens the Keyboard shortcuts window under the same guards as I', () => {
    it.each([
      { situation: 'from the page', open: [], press: { key: '?' }, opens: true },
      { situation: 'with a form docked', open: [dockedForm()], press: { key: '?' }, opens: true },
      { situation: 'typed with Shift held, as most layouts do', open: [], press: { key: '?', shiftKey: true }, opens: true },
      { situation: 'under a menu', open: [element('div', { role: 'menu' })], press: { key: '?' }, opens: false },
      { situation: 'under a dialog', open: [element('div', { role: 'dialog' })], press: { key: '?' }, opens: false },
      { situation: 'with Ctrl held', open: [], press: { key: '?', ctrlKey: true }, opens: false },
      { situation: 'with Alt held', open: [], press: { key: '?', altKey: true }, opens: false },
      { situation: 'with ⌘ held', open: [], press: { key: '?', metaKey: true }, opens: false },
      { situation: 'held down as a repeat', open: [], press: { key: '?', repeat: true }, opens: false },
      { situation: 'when another key is pressed', open: [], press: { key: '/' }, opens: false },
    ])('$situation: opens: $opens', ({ open, press, opens }) => {
      putUp(...open);

      expect(decidedFor(document.body, press, (event) => opensTheShortcuts(event))).toBe(opens);
    });

    it('does nothing typed in a field', () => {
      putUp(element('input', { 'aria-label': 'A box' }), element('textarea'));

      for (const field of document.querySelectorAll('input, textarea')) {
        expect(decidedFor(field, { key: '?' }, (event) => opensTheShortcuts(event))).toBe(false);
      }
    });
  });

  describe('the window lists every key Cockpit handles, grouped and worded as its chosen design', () => {
    it('names its groups in order, and says none of the keys act while typing in a field', () => {
      expect(SHORTCUT_GROUPS.map((group) => group.place)).toEqual([
        'Anywhere',
        'On an Inbox row',
        'Picking several Inbox rows',
        'Docked Item form',
        'On a Panel’s row',
        'Capture',
      ]);
      render(<KeyboardShortcutsWindow onClose={() => undefined} />);
      const window = screen.getByRole('dialog', { name: 'Keyboard shortcuts' });

      expect(within(window).getAllByRole('heading', { level: 3 }).map((heading) => heading.textContent)).toEqual([
        // Down the left, then down the right, as the design lays them out.
        'Anywhere',
        'Picking several Inbox rows',
        'Docked Item form',
        'On an Inbox row',
        'On a Panel’s row',
        'Capture',
      ]);
      expect(SHORTCUTS_FOOTER).toBe('None of these act while you type in a field. Esc closes this list.');
      expect(within(window).getByText(SHORTCUTS_FOOTER)).toBeVisible();
    });

    it('shows each row as what it does against its key caps', () => {
      render(<KeyboardShortcutsWindow onClose={() => undefined} />);
      const group = (place: string) => within(screen.getByRole('region', { name: place }));
      const rowOf = (place: string, does: string) => group(place).getByText(does).parentElement!;

      expect(rowOf('Anywhere', 'Go to a Panel · this Workspace')).toHaveTextContent('G⇧G');
      expect(rowOf('On an Inbox row', 'Next / previous row')).toHaveTextContent('JKor↓↑');
      expect(rowOf('On an Inbox row', 'File its whole group')).toHaveTextContent('⇧Enter');
      expect(rowOf('Capture', 'Capture the note')).toHaveTextContent('Ctrl Enter');
      expect(within(rowOf('Anywhere', 'This list')).getByText('?').tagName).toBe('KBD');
    });

    // Reads the code itself: a listener that gains a letter key without a row
    // in the list fails here. The patterns are the ways the app spells one - a
    // named single-letter key, and the row keys' regular expressions - and the
    // expectations below keep the scan from going blind if a spelling moves.
    it('has a row for every key the listeners handle, so adding a key without one fails', () => {
      const sources = import.meta.glob('../../src/**/*.{ts,tsx}', {
        query: '?raw',
        import: 'default',
        eager: true,
      }) as Record<string, string>;
      const found = new Set<string>();
      for (const source of Object.values(sources)) {
        for (const [, key] of source.matchAll(/export const \w*_KEY = '(.)'/g)) found.add(key!);
        for (const [, key] of source.matchAll(/\/\^([a-z])\$\/i\.test\(event\.key\)/g)) found.add(key!);
        for (const [, keys] of source.matchAll(/\/\^\(Enter\|\[([a-z]+)\]\)\$\/i\.test\(event\.key\)/g)) {
          for (const key of keys!) found.add(key);
        }
      }
      for (const key of Object.keys(STEPS)) if (key.length === 1) found.add(key);

      expect([...found].sort()).toEqual(['?', 'c', 'd', 'f', 'g', 'i', 'j', 'k', 'm', 'o', 'x', 'z']);

      const listed = new Set(
        SHORTCUT_GROUPS.flatMap((group) => group.rows.flatMap((row) => [...row.keys, ...(row.or ?? [])])).map((cap) =>
          cap.replace('⇧', '').toLowerCase(),
        ),
      );
      expect([...found].filter((key) => !listed.has(key))).toEqual([]);
    });
  });
});

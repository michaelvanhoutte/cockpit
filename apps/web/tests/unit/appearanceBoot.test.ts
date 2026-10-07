import { describe, expect, it } from 'vitest';
import boot from '../../src/appearanceBoot.js?raw';

/**
 * A window with only what the script reads: the document's flag, the device's
 * colour-scheme query, storage, and the listeners it adds. Storage is replaced
 * by the test, and `switchDevice` / `otherTabStores` are the two things that
 * happen while the page is open.
 */
function pageOpenedWith({ stored, device }: { stored?: string | undefined; device: 'dark' | 'light' }) {
  const flags = new Set<string>();
  let onDeviceChange: (() => void) | undefined;
  const windowListeners: Record<string, (event: { key?: string | null; detail?: string | null }) => void> = {};
  const query = {
    matches: device === 'dark',
    addEventListener: (_: string, listener: () => void) => (onDeviceChange = listener),
  };
  let value: string | null = stored && stored !== 'unavailable' ? stored : null;
  const fakeWindow = {
    document: {
      documentElement: {
        setAttribute: (name: string) => flags.add(name),
        removeAttribute: (name: string) => flags.delete(name),
      },
    },
    matchMedia: () => query,
    localStorage: {
      getItem: () => {
        if (stored === 'unavailable') throw new Error('storage is blocked');
        return value;
      },
    },
    addEventListener: (type: string, listener: (event: { key?: string | null; detail?: string | null }) => void) => (windowListeners[type] = listener),
  };
  new Function('window', boot)(fakeWindow);
  return {
    dark: () => flags.has('data-app-dark'),
    switchDevice: (to: 'dark' | 'light') => {
      query.matches = to === 'dark';
      onDeviceChange?.();
    },
    otherTabStores: (next: string | null) => {
      value = next;
      windowListeners['storage']?.({ key: 'cockpit.appearance' });
    },
    thisTabChooses: (choice: 'light' | 'dark' | null) => windowListeners['cockpit:appearance']?.({ detail: choice }),
  };
}

describe('Appearance', () => {
  describe('the app is dark from its first frame when the stored choice says so, or when nothing is stored and the device is dark', () => {
    it.each([
      { situation: 'nothing stored, device dark', stored: undefined, device: 'dark', dark: true },
      { situation: 'nothing stored, device light', stored: undefined, device: 'light', dark: false },
      { situation: 'Dark stored, device light', stored: 'dark', device: 'light', dark: true },
      { situation: 'Light stored, device dark', stored: 'light', device: 'dark', dark: false },
      { situation: 'something unrecognised stored, device dark', stored: 'sepia', device: 'dark', dark: true },
      { situation: 'storage unavailable, device dark', stored: 'unavailable', device: 'dark', dark: true },
    ] as const)('$situation', ({ stored, device, dark }) => {
      expect(pageOpenedWith({ stored, device }).dark()).toBe(dark);
    });
  });

  describe('while the app is open, it follows the device’s changes and a choice changed in another tab', () => {
    it('follows the device when nothing is stored', () => {
      const page = pageOpenedWith({ device: 'light' });

      page.switchDevice('dark');
      expect(page.dark()).toBe(true);
      page.switchDevice('light');
      expect(page.dark()).toBe(false);
    });

    it('stays light when Light is stored and the device switches to dark', () => {
      const page = pageOpenedWith({ stored: 'light', device: 'light' });

      page.switchDevice('dark');
      expect(page.dark()).toBe(false);
    });

    it.each([
      { situation: 'another tab stores Dark', next: 'dark', dark: true },
      { situation: 'another tab clears the stored choice, device light', next: null, dark: false },
    ])('$situation', ({ next, dark }) => {
      const page = pageOpenedWith({ stored: next === 'dark' ? 'light' : 'dark', device: 'light' });

      page.otherTabStores(next);
      expect(page.dark()).toBe(dark);
    });

    it.each([
      { situation: 'this tab chooses Dark on a light device', device: 'light', choice: 'dark', dark: true },
      { situation: 'this tab chooses Light on a dark device', device: 'dark', choice: 'light', dark: false },
      { situation: 'this tab chooses Match device on a dark device', device: 'dark', choice: null, dark: true },
    ] as const)('$situation, even where storage refuses', ({ device, choice, dark }) => {
      const page = pageOpenedWith({ stored: 'unavailable', device });

      page.thisTabChooses(choice);
      expect(page.dark()).toBe(dark);
    });

    it('goes back to what storage says once another tab stores a choice', () => {
      const page = pageOpenedWith({ device: 'light' });

      page.thisTabChooses('dark');
      page.otherTabStores('light');
      expect(page.dark()).toBe(false);
    });
  });
});

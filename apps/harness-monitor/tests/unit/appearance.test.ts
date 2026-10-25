import { describe, expect, it } from 'vitest';
import { APPEARANCE_BOOT } from '../../src/appearance';

type Scheme = 'dark' | 'light';
type StorageEvent = { key: string | null };

/**
 * A window with only what the script reads and writes: the document's
 * `data-appearance`, the select it sets, storage (which may refuse), and the one
 * listener it adds. `drawn` is the stylesheet's own rule: a choice on the
 * document wins, with none the device's scheme does. `switchDevice` and
 * `otherTabStores` are the two things that happen while the page is open.
 */
function pageOpenedWith({ remembered, device, refuses }: { remembered?: string | undefined; device: Scheme; refuses?: 'reading' | 'writing' }) {
  const attributes = new Map<string, string>();
  const select = { value: '' };
  let stored: string | null = remembered ?? null;
  let scheme = device;
  let onStorage: ((event: StorageEvent) => void) | undefined;
  const fakeWindow = {
    document: {
      documentElement: {
        setAttribute: (name: string, value: string) => attributes.set(name, value),
        removeAttribute: (name: string) => attributes.delete(name),
        getAttribute: (name: string) => attributes.get(name) ?? null,
      },
      getElementById: (id: string) => (id === 'appearance' ? select : null),
    },
    localStorage: {
      getItem: () => {
        if (refuses === 'reading') throw new Error('storage is blocked');
        return stored;
      },
      setItem: (_: string, value: string) => {
        if (refuses === 'writing') throw new Error('storage is blocked');
        stored = value;
      },
      removeItem: () => {
        if (refuses === 'writing') throw new Error('storage is blocked');
        stored = null;
      },
    },
    addEventListener: (_: string, listener: (event: StorageEvent) => void) => (onStorage = listener),
    monitorAppearance: undefined as { show: () => void; choose: (value: string) => void } | undefined,
  };
  new Function('window', APPEARANCE_BOOT)(fakeWindow);
  // The page runs this right after the select, before anything is drawn.
  fakeWindow.monitorAppearance!.show();
  return {
    drawn: () => attributes.get('data-appearance') ?? scheme,
    shows: () => select.value,
    remembered: () => stored,
    switchDevice: (to: Scheme) => {
      scheme = to;
    },
    otherTabStores: (next: string | null) => {
      stored = next;
      onStorage?.({ key: 'monitor.appearance' });
    },
    choose: (value: string) => fakeWindow.monitorAppearance!.choose(value),
  };
}

describe('Harness Monitor', () => {
  describe('a choice remembered in this browser wins over the device; with none, or none that can be read, the device decides', () => {
    it.each([
      { situation: 'Light chosen, device dark', remembered: 'light', device: 'dark', drawn: 'light', shows: 'light' },
      { situation: 'Dark chosen, device light', remembered: 'dark', device: 'light', drawn: 'dark', shows: 'dark' },
      { situation: 'nothing chosen, device dark', remembered: undefined, device: 'dark', drawn: 'dark', shows: '' },
      { situation: 'nothing chosen, device light', remembered: undefined, device: 'light', drawn: 'light', shows: '' },
      { situation: 'something other than Light or Dark remembered, device dark', remembered: 'sepia', device: 'dark', drawn: 'dark', shows: '' },
    ] as const)('$situation: drawn $drawn, the select showing $shows', ({ remembered, device, drawn, shows }) => {
      const page = pageOpenedWith({ remembered, device });

      expect(page.drawn()).toBe(drawn);
      expect(page.shows()).toBe(shows);
    });

    it('the browser refuses to read what is remembered, device dark: drawn dark', () => {
      const page = pageOpenedWith({ remembered: 'light', device: 'dark', refuses: 'reading' });

      expect(page.drawn()).toBe('dark');
      expect(page.shows()).toBe('');
    });

    it('the browser refuses to remember a choice, device dark, then Light chosen: drawn light, and nothing remembered', () => {
      const page = pageOpenedWith({ device: 'dark', refuses: 'writing' });

      page.choose('light');

      expect(page.drawn()).toBe('light');
      expect(page.shows()).toBe('light');
      expect(page.remembered()).toBe(null);
    });
  });

  describe('a change while a page is open is followed without a reload', () => {
    it.each([
      { situation: 'the device switches to light, nothing chosen', remembered: undefined, device: 'dark', then: 'light', drawn: 'light' },
      { situation: 'the device switches to dark, nothing chosen', remembered: undefined, device: 'light', then: 'dark', drawn: 'dark' },
      { situation: 'the device switches to dark, Light chosen', remembered: 'light', device: 'light', then: 'dark', drawn: 'light' },
    ] as const)('$situation: drawn $drawn', ({ remembered, device, then, drawn }) => {
      const page = pageOpenedWith({ remembered, device });

      page.switchDevice(then);

      expect(page.drawn()).toBe(drawn);
    });

    it.each([
      { situation: 'another tab chooses Light, device dark', remembered: undefined, next: 'light', device: 'dark', drawn: 'light', shows: 'light' },
      { situation: 'another tab clears what is remembered, device light', remembered: 'dark', next: null, device: 'light', drawn: 'light', shows: '' },
    ] as const)('$situation: drawn $drawn, the select showing $shows', ({ remembered, next, device, drawn, shows }) => {
      const page = pageOpenedWith({ remembered, device });

      page.otherTabStores(next);

      expect(page.drawn()).toBe(drawn);
      expect(page.shows()).toBe(shows);
    });

    it('this tab chooses Match device after Light, device dark: drawn dark, and nothing remembered', () => {
      const page = pageOpenedWith({ remembered: 'light', device: 'dark' });

      page.choose('');

      expect(page.drawn()).toBe('dark');
      expect(page.shows()).toBe('');
      expect(page.remembered()).toBe(null);
    });
  });
});

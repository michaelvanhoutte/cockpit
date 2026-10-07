import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import boot from '../../../src/appearanceBoot.js?raw';
import ManageAppearance, { APPEARANCE_KEY } from '../../../src/components/ManageAppearance';

/**
 * F1: Settings' Appearance, with the document's own boot script running as it
 * does in the page - the section reuses its decision rather than making one -
 * and the device and storage as the test sets them.
 */
let deviceIsDark = false;

beforeAll(() => {
  vi.stubGlobal('matchMedia', () => ({
    get matches() {
      return deviceIsDark;
    },
    addEventListener: () => undefined,
  }));
  new Function('window', boot)(window);
});

afterEach(() => {
  vi.restoreAllMocks();
  window.localStorage.clear();
  deviceIsDark = false;
  // Back to what the page would hold with nothing stored, for the next case.
  window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY }));
});

const dark = () => document.documentElement.hasAttribute('data-app-dark');
const radio = (name: string) => screen.getByRole('radio', { name: new RegExp(`^${name}`) });

describe('Appearance', () => {
  describe('Settings shows the current choice, applies a new one at once, and remembers it on this device', () => {
    it('has Match device selected when nothing is stored', () => {
      render(<ManageAppearance />);

      expect(radio('Match device')).toBeChecked();
    });

    it('has the stored choice selected', () => {
      window.localStorage.setItem(APPEARANCE_KEY, 'dark');
      render(<ManageAppearance />);

      expect(radio('Dark')).toBeChecked();
    });

    it('flags the document dark at once and stores Dark when Dark is chosen', async () => {
      render(<ManageAppearance />);

      await userEvent.click(radio('Dark'));

      expect(dark()).toBe(true);
      expect(window.localStorage.getItem(APPEARANCE_KEY)).toBe('dark');
    });

    it('goes light and stores nothing when Match device is chosen over Dark, the device being light', async () => {
      window.localStorage.setItem(APPEARANCE_KEY, 'dark');
      window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY }));
      render(<ManageAppearance />);
      expect(dark()).toBe(true);

      await userEvent.click(radio('Match device'));

      expect(dark()).toBe(false);
      expect(window.localStorage.getItem(APPEARANCE_KEY)).toBeNull();
    });

    it('applies Light over a dark device', async () => {
      deviceIsDark = true;
      window.dispatchEvent(new StorageEvent('storage', { key: APPEARANCE_KEY }));
      render(<ManageAppearance />);
      expect(dark()).toBe(true);

      await userEvent.click(radio('Light'));

      expect(dark()).toBe(false);
      expect(window.localStorage.getItem(APPEARANCE_KEY)).toBe('light');
    });

    it('still flags the document dark, with no error, and remembers nothing where storage refuses', async () => {
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('storage is blocked');
      });
      vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('storage is blocked');
      });
      render(<ManageAppearance />);

      await userEvent.click(radio('Dark'));

      expect(dark()).toBe(true);
      expect(radio('Dark')).toBeChecked();
      vi.restoreAllMocks();
      expect(window.localStorage.getItem(APPEARANCE_KEY)).toBeNull();
    });
  });
});

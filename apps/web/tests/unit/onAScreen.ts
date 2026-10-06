import { vi } from 'vitest';

/**
 * Answers the one question the app puts about the screen - whether it is 768px
 * or wider (`roomForTheInbox.ts`) - as a screen of this width would. jsdom has
 * no `matchMedia`, which the app reads as a phone, so a test about either shape
 * says which it is on. Undo with `vi.unstubAllGlobals()`.
 *
 * Returns the screen, so a test can resize it: `screen.resize(1280)` tells
 * every listener, as a window being widened does.
 */
export function onAScreen(width: number) {
  let current = width;
  const listeners = new Set<() => void>();
  vi.stubGlobal('matchMedia', (query: string) => ({
    get matches() {
      return current >= Number(/min-width: (\d+)px/.exec(query)?.[1]);
    },
    media: query,
    addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
    removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener),
  }));
  return {
    resize(next: number) {
      current = next;
      for (const listener of listeners) listener();
    },
  };
}

export const A_PHONE = 390;
export const A_DESK = 1280;

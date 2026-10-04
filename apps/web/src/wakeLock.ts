import { useEffect, useState } from 'react';

/**
 * Keeping the screen on while the Car view is shown ("Capture by voice in the
 * car", issue 730), through the browser's Screen Wake Lock.
 *
 * **Held for exactly as long as the view is mounted and the page visible.** The
 * browser lets go of it whenever the page is hidden, so it is taken again on
 * coming back, and let go of on unmounting. It cannot unlock a phone that is
 * already locked, or survive the power button.
 *
 * Imported only by the Car view, which is fetched behind the shell
 * (`captureForm.ts`), so none of it is in the first bundle.
 */

/** The part of a wake lock this uses, which is also all a test's fake has to offer. */
export interface WakeLock {
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
}

/** Asks for one, or is missing where the browser has none. */
export interface WakeLockApi {
  request(type: 'screen'): Promise<WakeLock>;
}

/** The browser's own, read on each call: absent in an older browser and outside a secure page. */
export const browserWakeLock = (): WakeLockApi | undefined =>
  typeof navigator === 'undefined'
    ? undefined
    : (navigator as unknown as { wakeLock?: WakeLockApi }).wakeLock;

/**
 * - `held`: the screen is being kept on.
 * - `asking`: not yet answered, or the page is hidden and it will be taken again.
 * - `unavailable`: the browser has none, or refused (battery saver): the screen may lock.
 */
export type WakeLockState = 'asking' | 'held' | 'unavailable';

export function useScreenWakeLock(api: () => WakeLockApi | undefined = browserWakeLock): WakeLockState {
  const [state, setState] = useState<WakeLockState>('asking');

  useEffect(() => {
    const wakeLock = api();
    if (!wakeLock) {
      setState('unavailable');
      return;
    }
    let lock: WakeLock | null = null;
    let asking = false;
    let gone = false;

    const take = async () => {
      if (gone || asking || lock || document.visibilityState !== 'visible') return;
      asking = true;
      try {
        const taken = await wakeLock.request('screen');
        if (gone) {
          void taken.release().catch(() => {});
          return;
        }
        lock = taken;
        taken.addEventListener('release', () => {
          // The browser let go (the page was hidden): taken again on becoming visible.
          if (lock === taken) lock = null;
          if (!gone) setState('asking');
        });
        setState('held');
      } catch {
        if (!gone) setState('unavailable');
      } finally {
        asking = false;
      }
    };

    const comesBack = () => void take();
    document.addEventListener('visibilitychange', comesBack);
    void take();
    return () => {
      gone = true;
      document.removeEventListener('visibilitychange', comesBack);
      const held = lock;
      lock = null;
      void held?.release().catch(() => {});
    };
  }, [api]);

  return state;
}

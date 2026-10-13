import { vi } from 'vitest';

const real = Intl.DateTimeFormat.prototype.resolvedOptions;

/**
 * Puts this device in a time zone, as the browser reports it - the one thing
 * a capture reads to say which calendar it was made on ("Read a due date you
 * say when you capture, on your own calendar", issue 1077). Undone by
 * `vi.restoreAllMocks()`.
 */
export function deviceIsIn(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}

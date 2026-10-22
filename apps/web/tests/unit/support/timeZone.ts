import { vi } from 'vitest';

const real = Intl.DateTimeFormat.prototype.resolvedOptions;

/**
 * Puts this device in a time zone, as the browser reports it - what a capture
 * reads to say which calendar it was made on ("Read a due date you say when
 * you capture, on your own calendar", issue 1077), and what every date the app
 * shows is written in ("Show every date the app shows in your own time zone
 * and region", issue 1427). Undone by `vi.restoreAllMocks()`.
 */
export function deviceIsIn(timeZone: string): void {
  vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockImplementation(function (this: Intl.DateTimeFormat) {
    return { ...real.call(this), timeZone };
  });
}

/**
 * Gives this device's browser these languages, in order, as `navigator.languages`
 * lists them: the region every date is written in comes from the first that
 * names one. Undone by `vi.restoreAllMocks()`.
 */
export function deviceSpeaks(...languages: string[]): void {
  vi.spyOn(navigator, 'languages', 'get').mockReturnValue(languages);
}

import { captureTimeZoneSchema } from '@cockpit/shared';

/**
 * The time zone this device is in now, as a capture carries it ("Read a due
 * date you say when you capture, on your own calendar", issue 1077) - or
 * undefined where the browser names none the server would take, so the
 * capture goes without one rather than being refused for it.
 *
 * Read at the moment Capture is pressed and kept with the capture, never at
 * the moment it is sent.
 */
export function deviceTimeZone(): string | undefined {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return captureTimeZoneSchema.safeParse(zone).success ? zone : undefined;
  } catch {
    return undefined;
  }
}

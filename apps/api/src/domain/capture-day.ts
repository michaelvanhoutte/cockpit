/**
 * The day a note was captured on, on the calendar of the person who captured
 * it ("Read a due date you say when you capture, on your own calendar", issue
 * 1077): what "tomorrow" and "Friday" count from.
 *
 * Read off the instant of the capture and the zone the device was in then -
 * never the moment the note was sent or read - so a note kept offline on
 * Monday and sent on Tuesday still says Monday.
 */
export interface CaptureDay {
  /** `YYYY-MM-DD`. */
  date: string;
  /** In English, as the model is told it: `Monday`. */
  weekday: string;
}

/**
 * The capture's day, or null where there is no zone to read it on - none
 * given, or a name this runtime does not know, which reads as none rather
 * than as UTC: a day guessed on the wrong calendar is a due date a day off.
 */
export function captureDay(capturedAt: string, timeZone: string | null): CaptureDay | null {
  if (timeZone === null) return null;
  const instant = new Date(capturedAt);
  if (Number.isNaN(instant.getTime())) return null;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
    }).formatToParts(instant);
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((one) => one.type === type)?.value ?? '';
  return { date: `${part('year')}-${part('month')}-${part('day')}`, weekday: part('weekday') };
}

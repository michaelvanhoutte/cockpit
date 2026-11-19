import type { ServerEvent } from '@cockpit/shared';

/**
 * Who hears of a connection's check ending ("Inbox: mail you just labelled waits for the five-minute check, or a Check now per connection in Settings: add a ↻ to the Inbox heading that checks them all now", issue 1835): the Inbox's ↻ while it waits, fed by the live stream. Its own module, since the stream is in the first bundle and the ↻'s waiting is not.
 */
export type HistoryAnnounced = Extract<ServerEvent, { type: 'connection_history_changed' }>;

type Listener = (event: HistoryAnnounced) => void;
const listeners = new Set<Listener>();

/** The stream announced a check's end (`useServerEvents`). */
export function announceCheckEnded(event: HistoryAnnounced): void {
  listeners.forEach((listener) => listener(event));
}

/** Hears every announcement until the returned function is called. */
export function hearCheckEnds(listener: Listener): () => void {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

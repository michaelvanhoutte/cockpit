import type { Conversation } from '@cockpit/shared';
import { whereALinkOpens } from './itemSource';

/**
 * What a row says of the conversation its Item follows ("A Gmail starred
 * conversation is one Item whose status follows who wrote last", issue 1705),
 * in the words the row was agreed on: the source, who wrote last and how long
 * ago - *Gmail · Steven replied yesterday*, *Gmail · You wrote 2 days ago* -
 * with the latest message's first lines on hover. It replaces the row's
 * *Gmail · sender*; the title stays the purpose.
 */

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** How long ago, as the line says it: *just now*, *12 min ago*, *today*, *yesterday*, *3 days ago*. */
export function agoLabel(at: string, now: number): string {
  const since = now - Date.parse(at);
  const days = Math.floor(since / DAY_MS);
  if (days <= 0) {
    const minutes = Math.floor(since / MINUTE_MS);
    return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes} min ago` : 'today';
  }
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Who wrote last, by first name: *You*, or the first word of whom the source names. */
function whoWroteLast(conversation: Conversation): string {
  if (conversation.lastBy === 'you') return 'You';
  const name = (conversation.lastFrom ?? conversation.withWhom ?? '').trim();
  return name.split(/\s+/)[0] || 'They';
}

/**
 * The row's line: *wrote* for the first message and for yours, *replied* for
 * theirs after it.
 */
export function conversationLine(conversation: Conversation, sourceName: string, now: number): string {
  const verb = conversation.messageCount === 1 || conversation.lastBy === 'you' ? 'wrote' : 'replied';
  return `${sourceName} · ${whoWroteLast(conversation)} ${verb} ${agoLabel(conversation.lastAt, now)}`;
}

/** The line's hover: who wrote the latest message, and its first lines. */
export function latestText(conversation: Conversation): string {
  const who = conversation.lastBy === 'you' ? 'You' : (conversation.lastFrom ?? conversation.withWhom ?? '');
  return who ? `${who}: ${conversation.lastExcerpt}` : conversation.lastExcerpt;
}

/** What *Open ↗* says it does. */
export function openLabel(sourceName: string): string {
  return `Open the latest email in ${sourceName}`;
}

/**
 * Where *Open ↗* goes: the conversation at its source, only ever a web address
 * (`openableAtSource` says why), or nowhere.
 */
export function conversationOpensAt(conversation: Conversation): string | null {
  if (!/^https?:\/\//i.test(conversation.link)) return null;
  return whereALinkOpens(conversation.link);
}

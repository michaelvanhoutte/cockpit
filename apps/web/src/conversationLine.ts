import type { Conversation } from '@cockpit/shared';
import { momentDayMonthLabel } from './dateFormat';
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

/**
 * How long ago, as the line says it: *just now* and *12 min ago* within the
 * hour, then by calendar day on this device - *today*, *yesterday*, *3 days ago*.
 */
export function agoLabel(at: string, now: number): string {
  const sent = Date.parse(at);
  const minutes = Math.floor((now - sent) / MINUTE_MS);
  if (minutes < 60) return minutes < 1 ? 'just now' : `${minutes} min ago`;
  const days = Math.round((startOfDay(now) - startOfDay(sent)) / DAY_MS);
  if (days <= 0) return 'today';
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** Midnight of a moment's local calendar day. */
function startOfDay(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
}

/**
 * Who wrote last, by first name: *You*, or the first word of whom the source
 * names - the word after the comma of a *Last, First* name.
 */
function whoWroteLast(conversation: Conversation): string {
  if (conversation.lastBy === 'you') return 'You';
  const name = (conversation.lastFrom ?? conversation.withWhom ?? '').trim();
  const lastFirst = /^[^\s,]+,\s*(\S+)/.exec(name);
  return lastFirst?.[1] ?? (name.split(/\s+/)[0] || 'They');
}

/**
 * The row's line: *wrote* for the first message and for yours, *replied* for
 * theirs after it.
 */
export function conversationLine(conversation: Conversation, sourceName: string, now: number): string {
  return `${sourceName} · ${whoWroteWhen(conversation, now)}`;
}

/** The line without its source: *Steven replied yesterday*. */
export function whoWroteWhen(conversation: Conversation, now: number): string {
  const verb = conversation.messageCount === 1 || conversation.lastBy === 'you' ? 'wrote' : 'replied';
  return `${whoWroteLast(conversation)} ${verb} ${agoLabel(conversation.lastAt, now)}`;
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

/**
 * The form's *Conversation* section under the description ("Show the
 * conversation an Item follows in its form", issue 1706): who it is with, and
 * how many messages since when - *With steven@noels.be · 4 emails since 4 Nov*.
 * Without a name to give, only the count; a conversation of one is dated by
 * its message, not "since" it.
 */
export function conversationCountLine(conversation: Conversation, now: number): string {
  const started = momentDayMonthLabel(conversation.startedAt, new Date(now));
  const count =
    conversation.messageCount === 1 ? `1 email on ${started}` : `${conversation.messageCount} emails since ${started}`;
  return conversation.withWhom ? `With ${conversation.withWhom} · ${count}` : count;
}

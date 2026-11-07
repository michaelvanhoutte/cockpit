import type { Conversation } from '@cockpit/shared';
import { conversationCountLine, conversationLine, conversationOpensAt, openLabel } from '../conversationLine';

/**
 * The conversation an Item follows, under its description ("Show the
 * conversation an Item follows in its form", issue 1706): who wrote last and
 * when, *Open ↗* to the conversation at its source, the latest message's first
 * lines, and who it is with and how many messages since when. Drawn from the
 * conversation row the Workspace read already carries, so opening the form
 * waits on nothing. An Item that follows none has no section: the caller draws
 * nothing. *Reply…* is not drawn yet; the unit that builds Email… adds it.
 */
export function ConversationSection({
  conversation,
  sourceName,
  now,
}: {
  conversation: Conversation;
  /** What the source is called, by its connector's name for it (*Gmail*), never its id. */
  sourceName: string;
  now: number;
}) {
  const opensAt = conversationOpensAt(conversation);
  const afterSource = conversationLine(conversation, sourceName, now).slice(sourceName.length + 3);
  return (
    <section aria-label="Conversation" className="flex flex-col gap-1.5">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Conversation</h3>
      <div className="flex flex-col gap-2 rounded-md border border-shade/10 bg-field p-3">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 text-sm text-ink">
            <span className="font-semibold">{sourceName}</span> · {afterSource}
          </p>
          {opensAt && (
            <a
              href={opensAt}
              target="_blank"
              rel="noopener noreferrer"
              title={openLabel(sourceName)}
              aria-label={openLabel(sourceName)}
              className="shrink-0 whitespace-nowrap text-sm text-accent-deep underline hover:text-accent"
            >
              Open ↗
            </a>
          )}
        </div>
        {conversation.lastExcerpt && (
          <p className="line-clamp-3 text-sm leading-snug text-ink-soft">“{conversation.lastExcerpt}”</p>
        )}
        <p className="text-xs text-ink-faint">{conversationCountLine(conversation, now)}</p>
      </div>
    </section>
  );
}

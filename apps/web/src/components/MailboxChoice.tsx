import type { Mailbox } from '@cockpit/shared';
import { sourceNamed, type SourceNames } from '../itemSource';

/**
 * The choice of mailbox *Email…* and *Reply…* ask for where a Workspace has
 * several ("Email…'s mailbox menu says it is the From", issue 1723), on the
 * row's menu and on the Item form alike: a **From** heading over each
 * connection's name with its source under it, as the Connections list shows a
 * connection.
 */

/** Its width: the longest choice's, from 12rem to 20rem; a longer name ends in "…" inside it. */
export const mailboxMenuClass = 'z-floating w-max min-w-48 max-w-80 rounded-md border border-shade/10 bg-surface p-1 shadow-lg';

/** The heading: small and grey, never an entry. */
export const fromHeadingClass = 'px-2 py-1 text-xs text-ink-faint';

/** What one mailbox reads as inside its menu entry: its name over its source. */
export function MailboxChoice({ mailbox, names }: { mailbox: Mailbox; names: SourceNames | undefined }) {
  return (
    <>
      <div className="truncate" title={mailbox.name}>
        {mailbox.name}
      </div>
      <div className="truncate text-xs text-ink-faint">{sourceNamed(names, mailbox.connectorId)}</div>
    </>
  );
}

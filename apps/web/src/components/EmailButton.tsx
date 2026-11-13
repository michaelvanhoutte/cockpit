import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import type { Mailbox } from '@cockpit/shared';
import type { EmailEntry } from '../emailDraft';
import type { SourceNames } from '../itemSource';
import { menuItemClass } from './Menu';
import { fromHeadingClass, MailboxChoice, mailboxMenuClass } from './MailboxChoice';

/**
 * *Email…* or *Reply…* on the Item's form ("Email… makes a Gmail draft the
 * Item then follows", issue 1708): one mailbox is used at the press; several
 * are asked between in a small menu, the last used first - the press that
 * chooses is the one the draft's tab opens from. The menu heads them **From**
 * and gives each its source under its name (issue 1723).
 */
export function EmailButton({
  entry,
  onEmail,
  sourceNames,
}: {
  entry: EmailEntry;
  onEmail: (mailbox: Mailbox) => void;
  sourceNames?: SourceNames | undefined;
}) {
  const className = 'shrink-0 whitespace-nowrap text-sm text-accent-deep underline hover:text-accent';
  if (entry.mailboxes.length === 1) {
    return (
      <button type="button" className={className} onClick={() => onEmail(entry.mailboxes[0]!)}>
        {entry.label}
      </button>
    );
  }
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className={className}>{entry.label}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="end" sideOffset={4} className={mailboxMenuClass}>
          <div className={fromHeadingClass}>From</div>
          {entry.mailboxes.map((mailbox) => (
            <DropdownMenu.Item key={mailbox.sourceAccountId} className={menuItemClass} onSelect={() => onEmail(mailbox)}>
              <MailboxChoice mailbox={mailbox} names={sourceNames} />
            </DropdownMenu.Item>
          ))}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

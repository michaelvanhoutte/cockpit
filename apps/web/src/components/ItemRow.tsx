import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { uuidv7, type Item, type ItemStatus } from '@cockpit/shared';
import { useCommand } from '../api/queries';
import { MenuContent, MenuTrigger, menuItemClass } from './Menu';

const STATUS_LABEL: Record<ItemStatus, string> = {
  to_process: 'To process',
  task: 'Task',
  waiting: 'Waiting',
  snoozed: 'Snoozed',
  delegated: 'Delegated',
  reference: 'Reference',
  done: 'Done',
  dismissed: 'Dismissed',
};

export function ItemRow({ item, workspaceId }: { item: Item; workspaceId: string }) {
  const command = useCommand();

  const envelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    itemId: item.id,
  });

  const setStatus = (status: ItemStatus) =>
    command.mutate({ name: 'set_status', payload: { ...envelope(), status } });

  const snoozeOneWeek = () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    command.mutate({ name: 'snooze_until', payload: { ...envelope(), until } });
  };

  const focusToday = () =>
    command.mutate({ name: 'set_focus', payload: { ...envelope(), horizon: 'today' } });

  return (
    <li className="flex items-center gap-2 border-b border-black/5 px-4 py-2.5 last:border-b-0 hover:bg-accent-tint/40">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.nextAction ?? item.title}</span>
        {/* Where it came from and what it is now, on one line under the title.
            The status used to be a pill of its own out to the right, which is
            about seventy pixels a row cannot spare once the Inbox is a column
            a fifth of the screen wide ("Show the Inbox beside the dashboards
            instead of as a tab", issue 117). Its own element, still, so it is
            a thing on the row rather than part of a sentence. */}
        <span className="flex min-w-0 gap-1 text-xs text-ink-faint">
          <span className="shrink-0 text-accent-deep">{STATUS_LABEL[item.status]}</span>
          <span className="truncate">
            {'· '}
            {item.source === 'internal' ? 'Own' : item.source}
            {item.sender ? ` · ${item.sender}` : ''}
            {item.snoozedUntil ? ` · until ${item.snoozedUntil.slice(0, 10)}` : ''}
          </span>
        </span>
      </span>

      {item.focusHorizon && (
        <span className="shrink-0 rounded bg-accent-deep px-1.5 text-xs font-semibold uppercase text-white">
          {item.focusHorizon[0]}
        </span>
      )}

      <DropdownMenu.Root>
        <MenuTrigger label="Item actions" />
        <MenuContent>
          <DropdownMenu.Item className={menuItemClass} onSelect={() => setStatus('done')}>
            Mark done
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={() => setStatus('task')}>
            Make it a task
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={() => setStatus('waiting')}>
            Waiting on someone
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={snoozeOneWeek}>
            Snooze a week
          </DropdownMenu.Item>
          <DropdownMenu.Item className={menuItemClass} onSelect={focusToday}>
            Goal for today
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-black/10" />
          <DropdownMenu.Item
            className={`${menuItemClass} text-over data-[highlighted]:bg-over/10 data-[highlighted]:text-over`}
            onSelect={() => setStatus('dismissed')}
          >
            Dismiss
          </DropdownMenu.Item>
        </MenuContent>
      </DropdownMenu.Root>
    </li>
  );
}

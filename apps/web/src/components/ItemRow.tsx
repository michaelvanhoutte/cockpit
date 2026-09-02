import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { uuidv7, type Item, type ItemStatus } from '@cockpit/shared';
import { useCommand, useSendCommand, type CommandArgs } from '../api/queries';
import { howFarItHasGone, SWIPE_THRESHOLD_PX, whatTheSwipeMeant } from '../swipe';
import { useUndo } from '../undo';
import { waitedSince } from '../waited';
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

/**
 * The same status as a color, for the dot at the head of the row.
 *
 * **The dot does not replace the word, it goes beside it.** Six statuses are
 * more than color can separate reliably, and a color cannot be read out at all,
 * so the dot is what makes the list scannable and the word is what makes it
 * legible. Either alone would be the wrong half.
 *
 * `done` and `dismissed` are here because the record is total, not because they
 * are ever drawn: neither reaches a list this renders.
 */
const STATUS_DOT: Record<ItemStatus, string> = {
  to_process: 'bg-status-to-process',
  task: 'bg-status-task',
  waiting: 'bg-status-waiting',
  snoozed: 'bg-status-snoozed',
  delegated: 'bg-status-delegated',
  reference: 'bg-status-reference',
  done: 'bg-status-task',
  dismissed: 'bg-status-snoozed',
};

export function ItemRow({
  item,
  workspaceId,
  onMoveTo,
}: {
  item: Item;
  workspaceId: string;
  /**
   * Asked to move this item somewhere, and handed the control the menu was
   * opened from so whatever opens can put the focus back there.
   *
   * The picker itself belongs to the list rather than to the row (ItemList),
   * because one dialog per row would be a dozen dialogs in an Inbox of a dozen.
   */
  onMoveTo?: (openedFrom: HTMLElement | null) => void;
}) {
  const command = useCommand();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const waited = waitedSince(item.createdAt, Date.now());
  const trigger = useRef<HTMLButtonElement>(null);
  /** True while the entry just chosen is opening something that wants the focus. */
  const opening = useRef(false);

  const envelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    itemId: item.id,
  });

  const setStatus = (status: ItemStatus) =>
    command.mutate({ name: 'set_status', payload: { ...envelope(), status } });

  /**
   * Dismissing, with the way back offered for as long as the bar lasts ("Undo
   * what just happened", issue 144).
   *
   * It is the one gesture here that takes an item off every list at once, and
   * on a phone it is a swipe ("Swipe an inbox row right to file it, left to
   * dismiss it", issue 145) - the easiest thing to do by accident and the
   * hardest to see the result of. The inverse is the state it was in, which is
   * read from the row rather than from the server, because the row is what was
   * on screen when the choice was made.
   *
   * **A snoozed item goes back with its date**, and that is why the inverse is
   * not always a status. Leaving the snoozed state clears the wake date, which
   * dismissing does - so putting the status back alone would return a snoozed
   * item with nothing to wake it, and the date it was waiting for would be gone
   * for good. `snooze_until` sets both, which is exactly what undoing it means.
   */
  const dismiss = () => {
    const wasSnoozedUntil = item.status === 'snoozed' ? item.snoozedUntil : null;
    const was = item.status;
    const putItBack = (): CommandArgs => {
      const envelopeBack = {
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        itemId: item.id,
      };
      return wasSnoozedUntil
        ? { name: 'snooze_until', payload: { ...envelopeBack, until: wasSnoozedUntil } }
        : { name: 'set_status', payload: { ...envelopeBack, status: was } };
    };
    command.mutate(
      { name: 'set_status', payload: { ...envelope(), status: 'dismissed' } },
      {
        onSuccess: () =>
          offerToUndo({
            what: `“${item.nextAction ?? item.title}” dismissed`,
            undo: () => send(putItBack()),
          }),
      },
    );
  };

  const snoozeOneWeek = () => {
    const until = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
    command.mutate({ name: 'snooze_until', payload: { ...envelope(), until } });
  };

  const focusToday = () =>
    command.mutate({ name: 'set_focus', payload: { ...envelope(), horizon: 'today' } });

  /**
   * Which finger is swiping, where it started, and how far it has come.
   *
   * The start is a ref because nothing on screen depends on it; the distance is
   * state because the row is drawn at it. Null start means no gesture is
   * running, which is what a mouse and a released finger both leave behind.
   *
   * **The pointer id is what makes a second finger harmless.** Without it a
   * finger resting on the row mid-swipe overwrote where the gesture began, and
   * the first finger's release was then measured from the second one's
   * position - so a swipe that had barely moved reported the gap between the
   * two fingers and, past the threshold, dismissed an item nobody swiped.
   */
  const from = useRef<{ pointer: number; x: number; y: number } | null>(null);
  const [gone, setGone] = useState(0);

  /**
   * The swipes ("Swipe an inbox row right to file it, left to dismiss it",
   * issue 145). Touch only, and `pointerType` is the whole of that check: a
   * desktop row is dragged into a panel instead, and a mouse drag that both
   * selected text and dismissed an item would be two gestures wearing one
   * movement.
   *
   * `touch-action: pan-y` below is what makes the two coexist. The browser
   * keeps vertical panning - the list still scrolls under the same finger - and
   * hands the horizontal component here, so neither has to be guessed at from
   * coordinates alone.
   */
  const swipe = {
    onPointerDown: (event: React.PointerEvent) => {
      if (event.pointerType !== 'touch') return;
      // One finger swipes; a second one landing on the row is ignored rather
      // than taken for the first.
      if (from.current) return;
      from.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      setGone(0);
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = from.current;
      if (!start || event.pointerId !== start.pointer) return;
      setGone(howFarItHasGone(event.clientX - start.x, event.clientY - start.y));
    },
    onPointerUp: (event: React.PointerEvent) => {
      const start = from.current;
      if (!start || event.pointerId !== start.pointer) return;
      from.current = null;
      setGone(0);
      const meant = whatTheSwipeMeant(event.clientX - start.x, event.clientY - start.y);
      if (meant === 'dismiss') dismiss();
      // The same picker the menu's Move to… opens, so filing is one gesture on
      // a phone and the same question either way.
      if (meant === 'file') onMoveTo?.(null);
    },
    // A gesture the browser took over - a scroll it decided was a scroll after
    // all - is not a swipe that stopped short, it is no swipe at all.
    onPointerCancel: (event: React.PointerEvent) => {
      if (from.current && event.pointerId !== from.current.pointer) return;
      from.current = null;
      setGone(0);
    },
  };

  /** Past the point where letting go would do something. */
  const wouldAct = Math.abs(gone) >= SWIPE_THRESHOLD_PX;

  return (
    // `gap-1.5` rather than `gap-2`: the row gained a mark at its head and an
    // age at its tail, and the Inbox column is a fifth of the screen, so the
    // space between them is space the title does not get.
    <li
      {...swipe}
      style={gone === 0 ? undefined : { transform: `translateX(${gone}px)` }}
      // `touch-action: pan-y` leaves vertical scrolling to the browser and
      // gives this the horizontal component; `select-none` stops a long press
      // turning the row into selected text mid-swipe. Both only matter while a
      // finger is on it, and neither costs a mouse anything.
      className={`flex touch-pan-y select-none items-center gap-1.5 border-b border-black/5 px-4 py-2 last:border-b-0 hover:bg-accent-tint/40 ${
        wouldAct ? (gone > 0 ? 'bg-accent-tint' : 'bg-over/15') : ''
      }`}
    >
      {/* What the row is doing, before anything is read. Decorative on purpose:
          the word it stands for is on the line below, so announcing the color
          as well would say the status twice. */}
      <span
        aria-hidden="true"
        className={`mt-0.5 size-2 shrink-0 self-start rounded-full ${STATUS_DOT[item.status]}`}
      />
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

      {/* How long it has waited. Tabular figures so the column does not shuffle
          sideways as the numbers change under it, and `title` because `14d` is
          short enough to be worth spelling out on hover. */}
      {waited && (
        <span className="shrink-0 text-xs tabular-nums text-ink-faint" title={`Waiting ${waited}`}>
          {waited}
        </span>
      )}

      <DropdownMenu.Root>
        <MenuTrigger label="Item actions" ref={trigger} />
        <MenuContent
          onCloseAutoFocus={(event) => {
            // Choosing Move to… opens the picker, which takes the focus itself;
            // Radix would put it back on this control as the menu closes and
            // take it straight off the dialog. Every other entry here opens
            // nothing, so the focus belongs back on the control.
            if (!opening.current) return;
            opening.current = false;
            event.preventDefault();
          }}
        >
          {onMoveTo && (
            <DropdownMenu.Item
              className={menuItemClass}
              onSelect={() => {
                opening.current = true;
                onMoveTo(trigger.current);
              }}
            >
              Move to…
            </DropdownMenu.Item>
          )}
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
            onSelect={dismiss}
          >
            Dismiss
          </DropdownMenu.Item>
        </MenuContent>
      </DropdownMenu.Root>
    </li>
  );
}

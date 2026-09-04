import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { uuidv7, workspaceIsDecided, type Item, type ItemType } from '@cockpit/shared';
import { useCommand, useSendCommand } from '../api/queries';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { howFarItHasGone, SWIPE_THRESHOLD_PX, whatTheSwipeMeant } from '../swipe';
import { useUndo } from '../undo';
import { waitedSince } from '../waited';
import { MenuContent, MenuTrigger, menuItemClass } from './Menu';

export function ItemRow({
  item,
  itemType,
  workspaceId,
  onMoveTo,
  ordering,
  onAddTo,
  onRemoveFromHere,
  onMoveHere,
  selecting,
}: {
  item: Item;
  /**
   * What kind of thing this is ("Capture a thought or an action, and see which
   * it is", issue 155), already looked up: the row is drawn once per item and
   * the list has the types in hand, so searching them again per row would be
   * the same search a dozen times.
   *
   * Undefined is a real state and is drawn as one - an item captured before
   * types existed, and one whose type was deleted, both have none.
   */
  itemType?: ItemType | undefined;
  workspaceId: string;
  /**
   * Asked to move this item somewhere, and handed the control the menu was
   * opened from so whatever opens can put the focus back there.
   *
   * The picker itself belongs to the list rather than to the row (ItemList),
   * because one dialog per row would be a dozen dialogs in an Inbox of a dozen.
   */
  onMoveTo?: (openedFrom: HTMLElement | null) => void;
  /**
   * Where this row sits in a list that has an order, and how to move it a step
   * ("Drag an item into a panel, and drop it where you want it", issue 141).
   *
   * Absent in the Inbox, which is by age and has no order to change. Present
   * on a panel, where it is what a keyboard and a phone have instead of the
   * drag - the Ordering rule the Glossary binds: dragging one and moving it a
   * step from its own menu are the same move.
   */
  ordering?: { at: number; of: number; onMove: (places: number) => void };
  /**
   * Asked to show this item on a second panel as well, and to stop showing it
   * on this one ("Ask whether to move an item to a panel or add it to one",
   * issue 142).
   *
   * Both absent in the Inbox: there is no panel to add alongside, and none to
   * remove it from.
   */
  onAddTo?: (openedFrom: HTMLElement | null) => void;
  onRemoveFromHere?: () => void;
  /**
   * Asked to make this the item's workspace ("Capture something before you know
   * which workspace it belongs to", issue 165) - the one you are looking at.
   *
   * Offered only where the row belongs to no workspace yet, which the row works
   * out for itself from the item rather than being told twice.
   */
  onMoveHere?: () => void;
  /**
   * Picking this row out to be acted on with others ("Select several items, and
   * file them all in one go", issue 169), and whether it is picked.
   *
   * `revealed` is the list saying it already has a selection, which is what
   * puts a tick on every row rather than only on the one under the pointer.
   * Hovering does the same thing in CSS, because a hover is not a state this
   * row is in - it is where the pointer happens to be.
   */
  selecting?: {
    picked: boolean;
    revealed: boolean;
    onPick: (withShift: boolean) => void;
  };
}) {
  const command = useCommand();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const waited = waitedSince(item.createdAt, Date.now());
  /** Belongs to no workspace yet, so it is in every workspace's Inbox at once. */
  const undecided = !workspaceIsDecided(item);
  const trigger = useRef<HTMLButtonElement>(null);
  /** True while the entry just chosen is opening something that wants the focus. */
  const opening = useRef(false);

  const envelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    itemId: item.id,
  });

  /**
   * Finishing with it, and the way back offered for as long as the bar lasts
   * ("Undo what just happened", issue 144).
   *
   * It needs the offer more than dismissing does, not less: it takes the item
   * off the Inbox and off every panel it was filed on at once, and there is no
   * list left that it can be found in to be put back by hand.
   */
  const markDone = () => {
    command.mutate(
      { name: 'set_done', payload: { ...envelope(), done: true } },
      {
        onSuccess: () =>
          offerToUndo({
            what: `“${item.nextAction ?? item.title}” marked done`,
            undo: () =>
              send({
                name: 'set_done',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId: item.id,
                  done: false,
                },
              }),
          }),
      },
    );
  };

  /**
   * Dismissing, with the way back offered for as long as the bar lasts ("Undo
   * what just happened", issue 144).
   *
   * It is the one gesture here that takes an item off every list at once, and
   * on a phone it is a swipe ("Swipe an inbox row right to file it, left to
   * dismiss it", issue 145) - the easiest thing to do by accident and the
   * hardest to see the result of.
   *
   * **Undoing it is the same change with the flag turned round**, which is what
   * being finished with an item and being rid of it becoming two flags bought
   * ("An item is either yours to deal with or finished with", issue 154): there
   * is no previous state to read off the row and hand back, so a dismissal
   * cannot put back the wrong one.
   */
  const dismiss = () => {
    command.mutate(
      { name: 'set_dismissed', payload: { ...envelope(), dismissed: true } },
      {
        onSuccess: () =>
          offerToUndo({
            what: `“${item.nextAction ?? item.title}” dismissed`,
            undo: () =>
              send({
                name: 'set_dismissed',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId: item.id,
                  dismissed: false,
                },
              }),
          }),
      },
    );
  };

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
      // A touch that starts on a control belongs to that control. The menu
      // opens on pointerdown and the same event bubbles up here, so without
      // this, tapping the three dots both opened the menu and began a swipe -
      // and the release then landed on a menu entry in a portal outside this
      // row, so no pointerup ever arrived to end it and the row stayed shifted
      // sideways. The tick is a control for the same reason: picking a row out
      // is not a gesture across it.
      if ((event.target as Element).closest('button, input')) return;
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
      // What a list measures when it works out where a dragged row would land,
      // so the line drawn between rows is not counted as one of them.
      data-item-row=""
      {...swipe}
      // The whole row, rather than a grip on it: a row is a card, and what a
      // person aims at when moving one is the card. It is what makes a mouse
      // drag across the text a move rather than a selection, which is the trade
      // this gesture is - and the reason there is no drag on touch at all,
      // where the same movement is a swipe.
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(ITEM_BEING_DRAGGED, item.id);
        // Its own type *and* text, because Firefox starts no drag at all
        // without something it recognises on the transfer.
        event.dataTransfer.setData('text/plain', item.nextAction ?? item.title);
        event.dataTransfer.effectAllowed = 'move';
      }}
      style={gone === 0 ? undefined : { transform: `translateX(${gone}px)` }}
      // `touch-action: pan-y` leaves vertical scrolling to the browser and
      // gives this the horizontal component. `select-none` stops a long press
      // turning the row into selected text mid-swipe, and is
      // `pointer-coarse:` rather than plain: a mouse never swipes, and taking
      // selection off a row for everyone would mean a title that cannot be
      // copied to pay for a gesture only a finger makes.
      className={`group flex touch-pan-y items-center gap-1.5 border-b border-black/5 px-4 py-2 last:border-b-0 pointer-coarse:select-none hover:bg-accent-tint/40 ${
        wouldAct ? (gone > 0 ? 'bg-accent-tint' : 'bg-over/15') : selecting?.picked ? 'bg-accent-tint' : ''
      }`}
    >
      {/* Picking the row out to be acted on with others. Always in the markup
          and hidden by CSS rather than drawn only on hover: a tick that is not
          there cannot be reached by Tab, and the keyboard is the one way in
          that neither a pointer nor a finger provides. Shown for good once the
          list has a selection, because a column of ticks with one filled and
          the rest invisible reads as a row that is somehow different. */}
      {selecting && (
        <input
          type="checkbox"
          checked={selecting.picked}
          aria-label={`Select “${item.nextAction ?? item.title}”`}
          // `onClick` rather than `onChange`, because whether shift was held is
          // what tells a range from a single pick and only the click carries it.
          onClick={(event) => {
            event.stopPropagation();
            selecting.onPick(event.shiftKey);
          }}
          // React wants one on a checked box; the click above is what acts.
          onChange={() => {}}
          // **Invisible means untouchable, not merely unseen.** An opacity of
          // zero still takes its place in the row and still catches what lands
          // on it, so a tick nobody can see was eating the start of a swipe in
          // the leading sixteen pixels of every row - on a device that could
          // not select anything anyway. It goes back to being a target when it
          // is drawn: hovered, focused, or once the list has a selection. Tab
          // still reaches it either way, because focus is not a pointer.
          className={`size-4 shrink-0 accent-accent ${
            selecting.picked || selecting.revealed
              ? ''
              : 'pointer-events-none opacity-0 focus-visible:pointer-events-auto focus-visible:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100'
          }`}
        />
      )}
      {/* What kind of thing it is, before anything is read. Decorative on
          purpose: the word it stands for is on the line below, so announcing
          the colour as well would say the type twice. An item with no type has
          no dot rather than a grey one - absent reads as absent, where a
          neutral colour reads as a type you cannot name. */}
      {itemType && (
        <span
          aria-hidden="true"
          className="mt-0.5 size-2 shrink-0 self-start rounded-full"
          style={{ backgroundColor: itemType.color }}
        />
      )}
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm">{item.nextAction ?? item.title}</span>
        {/* What it is and where it came from, on one line under the title. The
            two marks the status used to hold - the dot at the head of the row
            and the first word here - are what the type took ("Capture a thought
            or an action, and see which it is", issue 155). Its own element, so
            it is a thing on the row rather than part of a sentence. */}
        <span className="flex min-w-0 gap-1 text-xs text-ink-faint">
          {itemType && <span className="shrink-0 text-accent-deep">{itemType.name}</span>}
          <span className="truncate">
            {itemType ? '· ' : ''}
            {item.source === 'internal' ? 'Own' : item.source}
            {item.sender ? ` · ${item.sender}` : ''}
          </span>
          {/* That this row is not this workspace's own ("Capture something
              before you know which workspace it belongs to", issue 165). Said
              in words rather than as a colour or an icon, because it is the one
              thing about the row a reader cannot infer from where they are
              looking: every other row in this Inbox belongs here and this one
              is in every Inbox at once. */}
          {undecided && (
            <span className="shrink-0 rounded-full bg-accent-tint px-1.5 text-accent-deep">
              Any workspace
            </span>
          )}
        </span>
      </span>

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
          {/* The common case in one press ("Capture something before you know
              which workspace it belongs to", issue 165): a row read in Work is
              usually Work's, and saying so should not cost a dialog listing
              every alternative. Above Move to…, which is the same answer with
              the other workspaces in it.

              Only on a row that belongs to no workspace: on any other it would
              be an entry that does nothing. */}
          {undecided && onMoveHere && (
            <DropdownMenu.Item className={menuItemClass} onSelect={onMoveHere}>
              Move to this workspace
            </DropdownMenu.Item>
          )}
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
          {onAddTo && (
            <DropdownMenu.Item
              className={menuItemClass}
              onSelect={() => {
                opening.current = true;
                onAddTo(trigger.current);
              }}
            >
              Add to…
            </DropdownMenu.Item>
          )}
          {onRemoveFromHere && (
            <DropdownMenu.Item className={menuItemClass} onSelect={onRemoveFromHere}>
              Remove from this panel
            </DropdownMenu.Item>
          )}
          {ordering && (
            <>
              <MoveAStep
                label="Move up"
                unavailable={ordering.at === 0 ? 'This is already the first' : undefined}
                onMove={() => ordering.onMove(-1)}
              />
              <MoveAStep
                label="Move down"
                unavailable={ordering.at === ordering.of - 1 ? 'This is already the last' : undefined}
                onMove={() => ordering.onMove(1)}
              />
            </>
          )}
          <DropdownMenu.Item className={menuItemClass} onSelect={markDone}>
            Mark done
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

/**
 * One step up or down the list it is in.
 *
 * The ends are said out loud rather than silently doing nothing, exactly as a
 * panel's moves are: an entry that can be chosen and changes nothing is
 * indistinguishable from one that is broken. `aria-disabled` rather than
 * `disabled` for the reason `RowMenu` carries - Radix takes a disabled entry
 * out of the roving focus, so a keyboard never reaches it at all.
 */
function MoveAStep({
  label,
  unavailable,
  onMove,
}: {
  label: string;
  unavailable?: string | undefined;
  onMove: () => void;
}) {
  return (
    <DropdownMenu.Item
      {...(unavailable ? { 'aria-disabled': true, 'aria-label': `${label}: ${unavailable}` } : {})}
      className={
        unavailable
          ? `${menuItemClass} text-ink-faint data-[highlighted]:bg-black/5 data-[highlighted]:text-ink-faint`
          : menuItemClass
      }
      onSelect={(event) => {
        if (unavailable) {
          event.preventDefault();
          return;
        }
        onMove();
      }}
    >
      {label}
      {unavailable && <span className="block text-xs">{unavailable}</span>}
    </DropdownMenu.Item>
  );
}

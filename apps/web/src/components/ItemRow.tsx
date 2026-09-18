import { useEffect, useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import {
  itemHasOpenReadings,
  itemLabel,
  uuidv7,
  workspaceIsDecided,
  type Item,
  type ItemType,
  type Priority,
} from '@cockpit/shared';
import { useCommand, useSendCommand } from '../api/queries';
import { isCutOff } from '../cutOff';
import { dueColorOf, dueDateLabel } from '../dueDate';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { HOLD_MS, stillHolding } from '../hold';
import { howFarItHasGone, whatTheSwipeIsPromising, whatTheSwipeMeant } from '../swipe';
import { useUndo } from '../undo';
import { waitedSince } from '../waited';
import { MenuContent, MenuTrigger, menuItemClass } from './Menu';
import { RewriteHistoryWindow } from './RewriteHistoryWindow';

/**
 * The flag's label at each level ("Show and edit an item's priority", issue
 * 433). The colour is `--color-priority-*` (styles.css), which explains the
 * choice of it.
 */
const PRIORITY_MARKS: Record<Priority, { label: string; className: string }> = {
  low: { label: 'Low priority', className: 'bg-priority-low' },
  normal: { label: 'Normal priority', className: 'bg-priority-normal' },
  high: { label: 'High priority', className: 'bg-priority-high' },
};

/**
 * No other Panel or Filter to name - the common case, so a row with nothing
 * to say allocates nothing for it rather than a fresh empty array every
 * render.
 */
const EMPTY_ALSO_IN: readonly string[] = [];

export function ItemRow({
  item,
  itemType,
  workspaceId,
  onMoveTo,
  onAddTo,
  onOpen,
  onRemoveFromHere,
  onMoveHere,
  routingProposal,
  onAcceptRouting,
  mayBeADuplicate,
  onSettleNotADuplicate,
  selecting,
  alsoIn = EMPTY_ALSO_IN,
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
   * Asked to show this item on a second panel as well, and to stop showing it
   * on this one ("Ask whether to move an item to a panel or add it to one",
   * issue 142).
   *
   * Both absent in the Inbox: there is no panel to add alongside, and none to
   * remove it from.
   */
  onAddTo?: (openedFrom: HTMLElement | null) => void;
  /**
   * Asked to open this Item's form ("Edit an item's title and description on a
   * form of its own", issue 159). Two ways in, neither the lesser: a
   * double-click on the row, and **Open** in its menu - which is the only way a
   * keyboard has and the comfortable way on a phone, where a double-tap is a
   * gesture the browser has already spent on zooming.
   */
  onOpen?: () => void;
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
   * Which Panel Cockpit thinks this Item belongs on, and why - offered rather
   * than filed ("Propose where a captured note belongs, without filing it
   * there", issue 298).
   *
   * Resolved by the list rather than read off the Item directly: the Item
   * carries a Panel id, and drawing a name from it needs the Panels the
   * snapshot already holds, which the row is not given wholesale.
   *
   * Absent once this row is not in the Inbox, whichever of the two reasons
   * that is - nothing was proposed, or the Item has since been filed and so
   * left the Inbox this chip only ever draws in.
   */
  routingProposal?: { panelName: string; reason: string } | undefined;
  /**
   * Taking the proposal above - the same filing the picker's own "Move to"
   * makes, by being the same call (`ItemList`'s `move`), so accepting a chip
   * and choosing the same Panel by hand land the Item in the same place in
   * its order and are undone by the same bar.
   */
  onAcceptRouting?: (() => void) | undefined;
  /**
   * That this note may be saying what another one already said ("Flag a
   * captured note that says what another one already said", issue 407) - and
   * nothing about which, which waits until the form is opened, exactly as the
   * readings mark above does.
   *
   * Worked out by the list rather than read off the Item: a pair is a fact
   * about two Items, and whether it is offered depends on what is filed, which
   * the row is not given.
   */
  mayBeADuplicate?: boolean | undefined;
  /**
   * Settles every pair this row is currently flagged in as not a duplicate
   * ("Say a flagged pair is not a duplicate", issue 408) - offered in the menu
   * only where `mayBeADuplicate` is, and undefined for the same reason
   * `onAcceptRouting` can be: the list already knows there is nothing to
   * settle.
   */
  onSettleNotADuplicate?: (() => void) | undefined;
  /**
   * Picking this row out to be acted on with others ("Select several items, and
   * file them all in one go", issue 169), and whether it is picked.
   *
   * `revealed` is the list saying it already has a selection - which is what a
   * plain click on a row ends, and what suspends this row's own menu and
   * swipe ("Pick a row by ctrl/shift-click instead of aiming for a checkbox,
   * and suspend single-row actions while a selection is held", issue 438).
   */
  selecting?: {
    picked: boolean;
    revealed: boolean;
    onPick: (withShift: boolean) => void;
    /** Everything a selection put on screen, gone - what ending one does. */
    onEndSelection: () => void;
  };
  /**
   * Every other live Panel or Filter this Item shows on, named - "also in
   * Today, Q3 goals" ("Say which other panels an item is also in, after its
   * title", issue 466). Empty in the Inbox, where an Item is on no Panel and
   * matches no Filter, and on a row that shows nowhere else.
   *
   * Resolved by the list rather than by the row itself, the same reason
   * `routingProposal` above is: naming every other Panel needs the whole
   * snapshot the row is not given wholesale.
   */
  alsoIn?: readonly string[];
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
  /** This item's own rewrite history, opened from its own menu ("See the history of what Cockpit proposed for the Inbox's items", issue 444). */
  const [historyOpen, setHistoryOpen] = useState(false);
  /**
   * Whether this row's own menu is open, controlled rather than left to Radix
   * ("Pick a row by ctrl/shift-click instead of aiming for a checkbox, and
   * suspend single-row actions while a selection is held", issue 438) -
   * disabling the trigger only keeps a *new* menu from opening, so a menu
   * already open when a selection starts elsewhere needs something to close
   * it, and the trigger's own `aria-disabled` says nothing about opening at
   * all (found in review).
   */
  const [menuOpen, setMenuOpen] = useState(false);
  // Synced rather than left to spring back: forcing `open` shut below closes
  // the menu on screen without this, but leaves `menuOpen` itself still true -
  // so the moment the selection that suspended it ends, `open` reads that
  // stale `true` again and the menu reopens on its own, having asked nobody.
  useEffect(() => {
    if (selecting?.revealed) setMenuOpen(false);
  }, [selecting?.revealed]);

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
            what: `“${itemLabel(item)}” marked done`,
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
            what: `“${itemLabel(item)}” dismissed`,
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
   * Whether the label is showing less than it holds (src/cutOff.ts).
   *
   * Answered when the pointer arrives and forgotten when it leaves, rather than
   * worked out when the row is drawn: what fits depends on how wide the panel
   * is, and a panel is widened by dragging the line beside it ("Drag a row
   * taller and a panel wider, on the dashboard itself", issue 255) without this
   * row being drawn again. Measuring at the one moment the answer is wanted is
   * the whole of the cost - no observer, nothing per render - and dropping it
   * on the way out leaves no answer to go stale behind a label that changes.
   */
  const [labelCutOff, setLabelCutOff] = useState(false);
  /** The same, for the "also in…" text beside the label - answered and forgotten the same way, on its own hover. */
  const [alsoInCutOff, setAlsoInCutOff] = useState(false);

  /** The best label this Item has, worked out once for the two places the row draws it. */
  const label = itemLabel(item);
  /** What "also in…" reads, whole - the same sentence the tooltip spells out when the row has cut it. */
  const alsoInText = alsoIn.length > 0 ? `also in ${alsoIn.join(', ')}` : null;

  /**
   * The priority mark's label and colour, or nothing for an unset priority -
   * and, the same as an item type nobody deleted-and-recreated the row's
   * lookup for (`itemTypes.ts`, `recentlyUsedTypes`), nothing rather than a
   * crash for a value this build does not recognise. Reachable from a tab
   * left open across a deploy that adds a level (functional definition,
   * "Deploy breaks open tabs' lazy chunks"), since a priority read out of the
   * cache is never re-validated against the schema the way a fresh fetch is.
   */
  const priorityMark = item.priority ? PRIORITY_MARKS[item.priority] : undefined;
  const dueDateText = dueDateLabel(item.dueDate);
  /**
   * How this row is tinted by its own due date ("Colour an action's own
   * deadline as it approaches, and mark it red once passed", issue 473) -
   * `Date.now()` the same way `waited` above reads the real clock, with the
   * ramp itself proved without one in `dueDate.test.ts`.
   *
   * `null` while picked, rather than whatever `dueColorOf` would otherwise
   * say: a row picked out reads as its own colour regardless of its due
   * date, even an overdue one, since being picked wins over it. Folded in
   * here rather than checked separately at each mark and line that colours
   * itself by `dueColor === -1` below - two of them once forced themselves
   * white over a picked row's own light background by checking that alone,
   * with nothing excluding a picked row the way the row's own background
   * just below already did (found in review, twice).
   */
  const dueColor = selecting?.picked
    ? null
    : dueColorOf(item.dueDate, item.dueDateSetAt, item.createdAt, Date.now());

  /**
   * The finger resting on this row, waiting to become a selection ("Start a
   * selection with a long press, so a phone can do it too", issue 170).
   *
   * Set while a touch is down and still; cleared the moment it moves too far,
   * lifts, or is taken away by the browser deciding it was a scroll after all.
   */
  const holding = useRef<ReturnType<typeof setTimeout> | null>(null);
  /**
   * That this gesture has already picked the row out, so it cannot go on to
   * mean something else as well.
   *
   * The finger is still down when a hold fires, and what it does next is still
   * measured from where it started - so without this, resting on a row and then
   * sliding away picked the row out *and* dismissed it: two changes from one
   * unbroken touch, which is the thing `swipe.ts` refuses to let a mouse do.
   */
  const held = useRef(false);
  /**
   * Which kind of pointer last pressed down on this row, read back when a
   * click follows - a click carries no `pointerType` of its own, and a plain
   * tap means something different from a plain click ("Pick a row by
   * ctrl/shift-click instead of aiming for a checkbox, and suspend
   * single-row actions while a selection is held", issue 438).
   */
  const lastPointerType = useRef<string>('mouse');
  const letGo = () => {
    if (holding.current) clearTimeout(holding.current);
    holding.current = null;
  };
  // A row can leave the list under a finger - filed from another device, or
  // dismissed in another tab - and a timer left running would pick out a row
  // that is not there.
  useEffect(() => letGo, []);

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
      lastPointerType.current = event.pointerType;
      if (event.pointerType !== 'touch') {
        // A mouse never holds, so nothing below is its concern - except this
        // reset, which the touch-only one further down never reaches for a
        // mouse press. Without it, a long-press's `held` stayed stuck, and a
        // later mouse click on the same row was silently swallowed until some
        // other touch happened to land on it (found in review).
        held.current = false;
        return;
      }
      // A touch that starts on a control belongs to that control. The menu
      // opens on pointerdown and the same event bubbles up here, so without
      // this, tapping the three dots both opened the menu and began a swipe -
      // and the release then landed on a menu entry in a portal outside this
      // row, so no pointerup ever arrived to end it and the row stayed shifted
      // sideways. The tick is a control for the same reason: picking a row out
      // is not a gesture across it.
      if ((event.target as Element).closest('button, input')) return;
      // One finger swipes; a second one landing on the row is ignored rather
      // than taken for the first - and must not reset `held` out from under
      // it: a second finger touching down after the first's hold has already
      // fired must not un-stick the click-suppression that hold just earned
      // (found in review, alongside the mouse case above).
      if (from.current) return;
      from.current = { pointer: event.pointerId, x: event.clientX, y: event.clientY };
      setGone(0);
      held.current = false;
      if (selecting) {
        holding.current = setTimeout(() => {
          holding.current = null;
          held.current = true;
          // Back where it started. A hold allows a little drift, so the row can
          // already be drawn a few pixels across when this fires - and nothing
          // moves it back afterwards, because a spent gesture stops drawing.
          setGone(0);
          selecting.onPick(false);
        }, HOLD_MS);
      }
    },
    onPointerMove: (event: React.PointerEvent) => {
      const start = from.current;
      if (!start || event.pointerId !== start.pointer) return;
      // A spent gesture draws nothing. The row slides under the finger and says
      // what letting go would do, and letting go will now do nothing at all -
      // so without this it promises a dismissal it has already refused to make.
      if (held.current) return;
      const dx = event.clientX - start.x;
      const dy = event.clientY - start.y;
      // Gone somewhere, so it is no longer resting - whether it went on to mean
      // a swipe or nothing at all.
      if (!stillHolding(dx, dy)) letGo();
      // A selection already held has no swipe to promise - the release below
      // will not file or dismiss it, only toggle it, so the row has nothing to
      // slide toward ("...suspend single-row actions while a selection is
      // held", issue 438).
      if (selecting?.revealed) return;
      setGone(howFarItHasGone(dx, dy));
    },
    onPointerUp: (event: React.PointerEvent) => {
      const start = from.current;
      if (!start || event.pointerId !== start.pointer) return;
      from.current = null;
      letGo();
      setGone(0);
      // A gesture that has already picked the row out is finished, whatever the
      // finger did afterwards.
      if (held.current) return;
      // The swipe is suspended while a selection is held ("Pick a row by
      // ctrl/shift-click instead of aiming for a checkbox, and suspend
      // single-row actions while a selection is held", issue 438). A plain tap
      // still toggles the row, but that is the `onClick` below's to decide,
      // once - deciding it here as well would toggle it twice, since a tap
      // this short also earns the row a click.
      if (selecting?.revealed) return;
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
      letGo();
      setGone(0);
    },
  };

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
      // Picks the row out, from anywhere on it, with ctrl/cmd or shift held;
      // a plain click only ends a selection already held, and opens nothing -
      // a double-click, or the menu's own **Open**, is what opens a row
      // ("Require a double-click to open a row again, now that a plain click
      // opens it", issue 456, reversing part of issue 438's own "Pick a row
      // by ctrl/shift-click instead of aiming for a checkbox" after it shipped
      // and read as too easy to trigger by accident).
      //
      // *A plain tap on touch* extends a selection already held instead,
      // since touch has no ctrl key of its own to pick with - unchanged from
      // issue 438.
      //
      // *Guarded exactly as the double-click below is*: a portal-rendered menu
      // entry reaches this through the React tree rather than the DOM one, and
      // the menu's own trigger and the routing chip are controls of the row's
      // own rather than the row itself.
      //
      // *Held, not merely clicked*: the finger that just picked this row out
      // with a long press is still the one the browser turns into this click,
      // and `held` is what tells that click apart from a fresh one - without
      // it, the row it had just picked out was toggled straight back off.
      onClick={(event) => {
        if (!selecting) return;
        const hit = event.target as Node;
        if (!event.currentTarget.contains(hit)) return;
        if ((hit as Element).closest?.('button')) return;
        if (held.current) return;
        if (event.shiftKey || event.ctrlKey || event.metaKey) {
          selecting.onPick(event.shiftKey);
          return;
        }
        // Touch has no ctrl key, so a plain tap is what it has instead, once a
        // selection is already held.
        if (lastPointerType.current === 'touch' && selecting.revealed) {
          selecting.onPick(false);
          return;
        }
        // A plain click only ends a selection; it opens nothing (issue 456).
        // A no-op where there was nothing to end.
        if (selecting.revealed) selecting.onEndSelection();
      }}
      // A double-click also opens the form, alongside the menu's own Open,
      // since a plain click no longer does (issue 456).
      //
      // **Only when the row itself was double-clicked**, which is two different
      // questions because a React event bubbles through the component tree
      // rather than the DOM one.
      //
      // *Inside this row at all*: the menu's entries are drawn in a portal on
      // the body, so a double press on one reaches this handler while sitting
      // nowhere near the `li` in the DOM. `contains` is what tells them apart.
      //
      // *And not on a control of the row's own*: the menu's three dots is a
      // button inside the `li`, so containment alone would let a double press
      // on it open the form as well as the menu.
      onDoubleClick={(event) => {
        const hit = event.target as Node;
        if (!event.currentTarget.contains(hit)) return;
        if ((hit as Element).closest?.('button')) return;
        onOpen?.();
      }}
      onDragStart={(event) => {
        event.dataTransfer.setData(ITEM_BEING_DRAGGED, item.id);
        // Its own type *and* text, because Firefox starts no drag at all
        // without something it recognises on the transfer.
        event.dataTransfer.setData('text/plain', itemLabel(item));
        event.dataTransfer.effectAllowed = 'move';
      }}
      // `touch-action: pan-y` leaves vertical scrolling to the browser and
      // gives this the horizontal component. `select-none` stops a long press
      // turning the row into selected text mid-swipe, and is
      // `pointer-coarse:` rather than plain: a mouse never swipes, and taking
      // selection off a row for everyone would mean a title that cannot be
      // copied to pay for a gesture only a finger makes.
      //
      // **The row's own colour, and nothing about the swipe.** It used to tint
      // itself past the threshold, in the same `accent-tint` a picked row
      // wears - so a row swiped far enough to file looked exactly like a row
      // somebody had ticked. What the swipe would do is the band below instead,
      // which can say it in words.
      //
      // **A row picked out wins over its own due colour**, overdue included:
      // being picked is a transient thing somebody is doing to the row right
      // now, and a due date is not - `picked` is checked first below, on
      // purpose, rather than folded into the `-1` comparison. `due-tint`
      // (styles.css) reads `--due` rather than carrying the
      // `color-mix` formula itself, written once there rather than once per
      // row per render - and is the default branch's own class even with no
      // due date, since its fallback to 0 where the custom property is unset
      // is already transparent, the same as no class at all.
      //
      // **`hover:bg-accent-tint/40` moved off the shared prefix and into the
      // two branches that want it.** As a `:hover` variant it outranks a
      // plain class regardless of source order, so left unconditional it
      // painted an overdue row's own dark red pale on hover while its text
      // stayed forced white underneath it - unreadable (found in review).
      className={`group relative touch-pan-y border-b border-black/5 last:border-b-0 pointer-coarse:select-none ${
        selecting?.picked
          ? 'bg-accent-tint hover:bg-accent-tint/40'
          : dueColor === -1
            ? 'bg-over-deep text-white'
            : 'due-tint hover:bg-accent-tint/40'
      }`}
      // Set regardless of which of the three classes above actually reads
      // it: `due-tint` is the only one that does, so `-1` on an overdue row
      // is as inert here as it is on the picked branch above.
      style={{ '--due': dueColor ?? 0 } as React.CSSProperties}
    >
      <WhatLettingGoWouldDo across={gone} />
      {/* The row itself, which is what moves: the band above has to stay where
          the finger uncovered it, so the transform cannot be on the `li` any
          more. Everything the row is made of - its padding, its spacing - came
          down here with it, and the `li` keeps what belongs to its place in the
          list. */}
      <div
        className="flex items-center gap-1.5 px-4 py-2"
        style={gone === 0 ? undefined : { transform: `translateX(${gone}px)` }}
      >
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
        {/* Priority, when it is set - nothing drawn for an item with none, the
            same convention the type dot above follows. Named rather than
            decorative: unlike the type dot, the level is not echoed in words
            anywhere else on the row. */}
        {priorityMark && (
          <span
            className={`mt-0.5 flex size-4 shrink-0 items-center justify-center self-start rounded-full text-[9px] leading-none text-white ${priorityMark.className}`}
            title={priorityMark.label}
            aria-label={priorityMark.label}
            role="img"
          >
            ⚑
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-1 text-sm">
            {/* A native `title`, as the two marks further along this row
                already use, spelling out the same label the row draws rather
                than the Item's stored title - so the hover cannot say something
                different from the text it is explaining. */}
            <span
              className="truncate"
              onPointerEnter={(event) =>
                setLabelCutOff(
                  isCutOff(event.currentTarget.scrollWidth, event.currentTarget.clientWidth),
                )
              }
              onPointerLeave={() => setLabelCutOff(false)}
              title={labelCutOff ? label : undefined}
            >
              {label}
            </span>
            {/* Every other live Panel or Filter this Item shows on, straight
                after its title ("Say which other panels an item is also in,
                after its title", issue 466) - absent wherever `alsoIn` is
                empty, an Inbox row included.

                `shrink-[99]` against the title's own default shrink is what
                makes this the one that gives way first as the row narrows:
                both are flex children of the same row, so without it the two
                would shrink in step and a long "also in…" would eat into the
                title exactly as fast as the title eats into it. */}
            {alsoInText && (
              <span
                className="shrink-[99] min-w-0 truncate italic text-ink-faint"
                onPointerEnter={(event) =>
                  setAlsoInCutOff(
                    isCutOff(event.currentTarget.scrollWidth, event.currentTarget.clientWidth),
                  )
                }
                onPointerLeave={() => setAlsoInCutOff(false)}
                title={alsoInCutOff ? alsoInText : undefined}
              >
                {alsoInText}
              </span>
            )}
            {/* That there is something written about this Item, not what it says
                - the description is paragraphs and this is a row. A mark rather
                than a snippet, so the row keeps the height "Create an item on a
                panel, edit it in place, and list every item plainly" (issue 140)
                settled, and
                titled rather than lettered because it has nothing to spell. */}
            {item.description && (
              <span
                className={`shrink-0 ${dueColor === -1 ? '' : 'text-ink-faint'}`}
                title="Has a description"
                aria-label="Has a description"
                role="img"
              >
                ¶
              </span>
            )}
            {/* That this note reads more than one way, and nothing about which
                - the readings themselves wait until the form is opened on
                purpose ("Offer the other readings when a captured note says
                two things", issue 297). `itemHasOpenReadings` is what pairs
                this with `textsSettledAt`: once you have taken the texts
                over there is nothing left for an alternate reading to be an
                alternative to, so the mark stops rather than pointing at a
                choice already made. */}
            {itemHasOpenReadings(item) && (
              <span
                className={`shrink-0 ${dueColor === -1 ? '' : 'text-ink-faint'}`}
                title="Reads more than one way"
                aria-label="Reads more than one way"
                role="img"
              >
                ⁇
              </span>
            )}
            {/* That this note may be saying what another one already said, and
                nothing about which - the other note waits until the form is
                opened, for the reason the readings mark above does: a row is a
                row, and what it might be repeating is a link rather than a
                word. */}
            {mayBeADuplicate && (
              <span
                className={`shrink-0 ${dueColor === -1 ? '' : 'text-ink-faint'}`}
                title="Possible duplicate"
                aria-label="Possible duplicate"
                role="img"
              >
                ⧉
              </span>
            )}
          </span>
          {/* What it is and where it came from, on one line under the title. The
              two marks the status used to hold - the dot at the head of the row
              and the first word here - are what the type took ("Capture a thought
              or an action, and see which it is", issue 155). Its own element, so
              it is a thing on the row rather than part of a sentence.

              This line sets its own muted colour normally, the same as the
              three marks above and the waited badge further on - so all of
              them drop it once the row has gone `over-deep text-white`
              (issue 473), reading the row's own white by inheriting it
              rather than fighting it. The type name nested inside restates
              `'text-white'` instead of also dropping to inherit it - the two
              read the same on screen, and only one of the two measured under
              the bundle budget. */}
          <span className={`flex min-w-0 gap-1 text-xs ${dueColor === -1 ? '' : 'text-ink-faint'}`}>
            {itemType && (
              <span className={`shrink-0 ${dueColor === -1 ? 'text-white' : 'text-accent-deep'}`}>{itemType.name}</span>
            )}
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
            {/* The due date, when one is set - nothing drawn for an item with
                none, the same convention priority's own mark follows. The
                text itself stays plain; it is the row around it that
                colours by proximity (issue 473). */}
            {dueDateText && <span className="shrink-0">Due {dueDateText}</span>}
            {/* Cockpit's own proposal, not yet taken - a click is the whole of
                accepting it, and `title` is where "in your own terms rather
                than the model's" lives, the reason written for this hover and
                nothing else. `stopPropagation` here is belt-and-suspenders:
                the row's own `closest('button')` guard already refuses any
                click landing inside a button, chip included. */}
            {routingProposal && onAcceptRouting && (
              <button
                type="button"
                className="shrink-0 rounded-full bg-accent-tint px-1.5 text-accent-deep hover:bg-accent hover:text-white"
                title={routingProposal.reason}
                onClick={(event) => {
                  event.stopPropagation();
                  onAcceptRouting();
                }}
              >
                → {routingProposal.panelName}
              </button>
            )}
          </span>
        </span>

        {/* How long it has waited. Tabular figures so the column does not shuffle
            sideways as the numbers change under it, and `title` because `14d` is
            short enough to be worth spelling out on hover. */}
        {waited && (
          <span className={`shrink-0 text-xs tabular-nums ${dueColor === -1 ? '' : 'text-ink-faint'}`} title={`Waiting ${waited}`}>
            {waited}
          </span>
        )}

        <DropdownMenu.Root
          // Closed outright while a selection is held, whether or not it was
          // already open - the trigger's own `disabled` only refuses a new
          // open, and a menu already open when a selection starts elsewhere
          // would otherwise stay fully actionable (found in review).
          open={selecting?.revealed ? false : menuOpen}
          onOpenChange={(next) => {
            if (selecting?.revealed) return;
            setMenuOpen(next);
          }}
        >
          <MenuTrigger label="Item actions" ref={trigger} disabled={selecting?.revealed} />
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
            {onOpen && (
              <DropdownMenu.Item
                className={menuItemClass}
                onSelect={() => {
                  // The form takes the focus itself, like the pickers below.
                  opening.current = true;
                  onOpen();
                }}
              >
                Open
              </DropdownMenu.Item>
            )}
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
            {mayBeADuplicate && onSettleNotADuplicate && (
              <DropdownMenu.Item className={menuItemClass} onSelect={onSettleNotADuplicate}>
                Not a duplicate
              </DropdownMenu.Item>
            )}
            <DropdownMenu.Item className={menuItemClass} onSelect={markDone}>
              Mark done
            </DropdownMenu.Item>
            <DropdownMenu.Item
              className={menuItemClass}
              onSelect={() => {
                opening.current = true;
                setHistoryOpen(true);
              }}
            >
              Rewrite history…
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
        {/* Mounted only once opened, unlike the account-wide window a shell
            keeps mounted between openings - a row is instantiated once per
            item in the list, and a `useQuery` on every one of them (even
            disabled) is a query registered per row for a feature few rows
            will ever open. */}
        {historyOpen && (
          <RewriteHistoryWindow
            open={historyOpen}
            onClose={() => setHistoryOpen(false)}
            returnFocusTo={trigger.current}
            workspaceId={workspaceId}
            itemId={item.id}
          />
        )}
      </div>
    </li>
  );
}

/**
 * The band a swipe uncovers, naming what letting go would do ("Show what a
 * swipe will do before the finger lifts").
 *
 * **Exactly as wide as the row has moved**, pinned to the edge it moved away
 * from, so it is the strip of floor the row has left bare rather than a layer
 * the row is drawn on top of. That is what lets the row go on being transparent
 * over the well it sits in: an opaque row would be a fourth surface colour to
 * keep in step with the Inbox's well, the panels' well and the sheet.
 *
 * **The word sits against the outer edge and stays there**, clipped by the band
 * rather than centred in it, so it slides into view as the gap widens instead
 * of drifting across the screen under the thumb.
 *
 * Nothing here is announced: a screen reader reaches these two actions by their
 * names in the row's own menu, and a band that appears and vanishes under a
 * finger has nothing to tell it.
 */
function WhatLettingGoWouldDo({ across }: { across: number }) {
  // Asked with no vertical component because `across` has already had that rule
  // applied to it - a thumb scrolling the list has left it at zero, and zero is
  // what promises nothing. Derived here rather than handed in beside the
  // distance, so a band's colour cannot be answering one gesture and its width
  // another.
  const promise = whatTheSwipeIsPromising(across, 0);
  if (!promise) return null;
  const filing = promise.action === 'file';
  return (
    <span
      aria-hidden="true"
      className={`absolute inset-y-0 flex items-center overflow-hidden whitespace-nowrap text-xs font-medium transition-colors ${
        filing ? 'left-0 justify-start pl-3' : 'right-0 justify-end pr-3'
      } ${
        promise.wouldAct
          ? filing
            ? 'bg-accent-deep text-white'
            : 'bg-over-deep text-white'
          : // Not `accent-tint`, which is the colour a picked row already
            // wears: a row ticked and then swiped uncovered a band exactly the
            // shade of itself, so nothing appeared until the threshold - the
            // stretch of the gesture this whole band exists to cover.
            filing
            ? 'bg-accent-soft/45 text-accent-deep'
            : 'bg-over/25 text-over-deep'
      }`}
      style={{ width: `${Math.abs(across)}px` }}
    >
      {/* Reversed on the dismissing side so the icon is the outermost thing
          either way: it sits against the screen edge the row is moving away
          from, which is where the band starts, so it is the first thing to
          come into view rather than the last. */}
      <span className={`flex shrink-0 items-center gap-1.5 ${filing ? '' : 'flex-row-reverse'}`}>
        {filing ? <IntoAPanel /> : <Gone />}
        {/* The menu's own words rather than new ones for the gesture, so the two
            ways to the same action are not two things to learn. Filing keeps its
            ellipsis because it opens the picker rather than making a move that
            has already been decided. */}
        {Math.abs(across) >= ROOM_FOR_THE_WORD && (filing ? 'Move to…' : 'Dismiss')}
      </span>
    </span>
  );
}

/**
 * How wide the band has to be before the word goes in it, in CSS pixels.
 *
 * **A word half off the edge is worse than no word**, which is what a band
 * narrower than this one holds: the band clips whatever will not fit, and on
 * the dismissing side it clips the front of the word, so a barely-swiped row
 * read "s ✕". Below this the icon says which way the gesture is going on its
 * own, and it is the icon rather than the word because an icon has no wrong
 * half to show.
 *
 * Measured in the browser rather than reasoned about: the wider of the two
 * groups - the icon, the gap and "Move to…" - comes to 79px, and the band's
 * padding to 12, so 91 is what it takes and this is that with a little room.
 * A swipe that acts passes it long before the finger stops, since the row
 * keeps moving under a thumb that has decided.
 */
const ROOM_FOR_THE_WORD = 96;

/** An item dropping into one of the boxes on a dashboard. */
function IntoAPanel() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path
        d="M2.5 9.5v3a1 1 0 001 1h9a1 1 0 001-1v-3M8 2v7.5M5 6.5L8 9.5l3-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** An item being got rid of. */
function Gone() {
  return (
    <svg viewBox="0 0 16 16" className="size-4 shrink-0" aria-hidden="true">
      <path
        d="M4.5 4.5l7 7M11.5 4.5l-7 7"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  );
}


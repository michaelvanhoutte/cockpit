import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_WIDE,
  DEFAULT_ITEM_FORM_PRESENTATION,
  MAX_ATTACHMENT_SIZE,
  TITLE_LENGTH,
  attachmentContentTypeSchema,
  itemHasOpenReadings,
  itemLabel,
  prioritySchema,
  uuidv7,
  type Attachment,
  type Item,
  type ItemFormPresentation,
  type Priority,
} from '@cockpit/shared';
import { attachmentUrl, uploadAttachment } from '../api/client';
import { snapshotQuery, useSendCommand, type CommandArgs } from '../api/queries';
import { DescriptionBox } from './DescriptionBox';
import { possibleDuplicatesOf } from '../duplicates';
import { dueComingFriday, dueSevenDaysOut, dueToday } from '../dueDateShortcuts';
import { filingsThatFile } from '../filing';
import { useItemForm, useOpenItem } from '../itemForm';
import { openableAtSource } from '../itemSource';
import { useUndo } from '../undo';
import { browserStore } from '../lastVisited';
import { rememberItemFormSize, rememberedItemFormSize, type Size } from '../itemFormSize';
import {
  clampItemFormDockedWidth,
  readItemFormDockedWidth,
  writeItemFormDockedWidth,
} from '../itemFormDockedWidth';
import { useScreenWidth } from '../panels/useScreenWidth';
import { PRIORITY_LABELS } from '../priority';

/** What the two boxes, the priority control and the due date hold, before anything is sent. */
interface Draft {
  title: string;
  description: string;
  priority: Priority | null;
  /** ISO calendar date (`2026-09-30`), or `null` for none - the empty string the date input shows for "unset" is never stored in the draft. */
  dueDate: string | null;
}

const DESCRIPTION_LIMIT = 60_000;

/** The due date field's one-click shortcuts, in the order they are offered (issue 480). */
const DUE_DATE_SHORTCUTS: { label: string; dueDate: (now: Date) => string }[] = [
  { label: 'Today', dueDate: dueToday },
  { label: 'Fri', dueDate: dueComingFriday },
  { label: '+7d', dueDate: dueSevenDaysOut },
];

/** A byte count as a person reads it - the units this product's own cap is stated in (issue 441). */
function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** A file chosen or dropped, still uploading - drawn as its own chip until it either lands or is refused. */
interface PendingAttachment {
  id: string;
  filename: string;
}

/**
 * A small button in the form's footer that reveals a panel of its own above
 * it, for what stays off the form until asked for - what was captured, the
 * item's own id ("Give the item's form more room, and put clutter out of the
 * way", issue 480). Floats over the form rather than growing the footer
 * inline, so opening one never moves Cancel and Save out from under a hand
 * about to press them.
 *
 * **A Radix `Popover`, not a hand-rolled one** (found in review, twice): the
 * panel used to be an in-flow `absolute` child of `Dialog.Content`, which is
 * `overflow-hidden` - a press anywhere else *inside* the dialog never counted
 * as "outside" for a listener scoped to it, and a captured message long
 * enough to need the room got its own top clipped off with no way to scroll
 * to it. `Popover.Portal` renders this outside that box entirely, so Radix's
 * own dismissable layer (a press anywhere outside this panel, `Escape`
 * closing only the innermost open layer rather than the form under it, both
 * for free) and its collision-aware positioning both actually hold.
 */
function FooterDisclosure({
  label,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange}>
      <Popover.Trigger className="rounded-md border border-black/10 px-2 py-1 text-xs font-medium text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink">
        {label}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          role="group"
          side="top"
          align="start"
          sideOffset={8}
          collisionPadding={16}
          className="z-10 max-h-64 w-72 max-w-[80vw] overflow-y-auto rounded-md border border-black/10 bg-surface p-3 shadow-raised"
        >
          {children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

/**
 * What Save has to send: the boxes that actually moved, and nothing else
 * (functional definition, "Editing more than one field at a time"). An
 * untouched box must send no change at all, or it would carry the value it was
 * opened with over an edit made somewhere else in the meantime - the whole
 * reason there are two commands rather than one save.
 *
 * **`was` is what the boxes were filled from, not what the item says now.**
 * Against the live item this rule inverts: a change arriving over the live
 * updates stream while the form is open moves the item and not the untouched
 * box, so the box reads as edited and Save writes the value it was opened with
 * back over the newer one. Which is precisely the revert the two commands
 * exist to prevent.
 *
 * Compared on the trimmed text, because that is what would be stored: adding a
 * space to the end of a title and pressing Save is not a change to the title.
 */
export function whatChanged(
  was: Draft,
  now: Draft,
): {
  title?: string;
  description?: string | null;
  priority?: Priority | null;
  dueDate?: string | null;
} {
  const changed: {
    title?: string;
    description?: string | null;
    priority?: Priority | null;
    dueDate?: string | null;
  } = {};
  const title = now.title.trim();
  const description = now.description.trim();

  if (title !== was.title.trim()) changed.title = title;
  if (description !== was.description.trim()) changed.description = description || null;
  // An enum, not text - nothing to trim, and no third state to collapse into.
  if (now.priority !== was.priority) changed.priority = now.priority;
  // A calendar date or null - nothing to trim either.
  if (now.dueDate !== was.dueDate) changed.dueDate = now.dueDate;
  return changed;
}

/**
 * The Item's form: a modal over whatever page the address resolves to, opened
 * and closed by that address ("Edit an item's title and description on a form
 * of its own", issue 159).
 *
 * Drawn by the Layout rather than by the lists, because there is one form open
 * at a time and it belongs to the shell the address hangs off, not to whichever
 * list the row was double-clicked in.
 */
export function ItemForm() {
  const { openItemId, close } = useItemForm();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };

  if (!openItemId || !workspaceId) return null;
  // Keyed on the item, so going from one item's form straight to another's -
  // a pasted link, a step through history - starts the boxes again from the
  // item now named. Without it the draft is kept across the change and Save
  // writes the first item's text onto the second.
  return (
    <TheForm key={openItemId} itemId={openItemId} workspaceId={workspaceId} onClose={close} />
  );
}

/** How far into the dialog's own corner a `mousedown` still counts as taking
 *  hold of the native resize handle, rather than pressing whatever else is
 *  drawn nearby - generous enough to find with a mouse, narrower than the
 *  padding around the buttons that sit closest to it. */
const RESIZE_CORNER = 16;

/** The dialog's own default size, unclamped - `56rem`/`46rem`
 *  (`--item-form-w`/`-h`, styles.css) at the browser default root size. The
 *  fallback of last resort for an axis a drag never touched and nothing was
 *  ever remembered for: the *current* render is not it, because on a screen
 *  short or narrow enough to be clamping that axis already, that measures
 *  the clamped-down size, not the size nobody chose - persisting that would
 *  follow the person to a bigger screen and keep it short there too, rather
 *  than leaving the live clamp below (`max-w-`/`max-h-`, now
 *  `--item-form-max-w`/`-h` - a real ceiling above this default, issue 480)
 *  to answer that question fresh on every open the way it already does for
 *  the axis that did move. */
const DEFAULT_SIZE: Size = { width: 896, height: 736 };

/** The narrowest a screen still counts as "a desk", the same breakpoint the
 *  centered dialog's own native resize handle is already gated on, below -
 *  no room to grow into and, for docking, no room to be worth pinning a
 *  panel to the side of at all. */
const DESKTOP_MIN_WIDTH = 640;

function TheForm({
  itemId,
  workspaceId,
  onClose,
}: {
  itemId: string;
  workspaceId: string;
  onClose: () => void;
}) {
  const { data, isLoading } = useQuery(snapshotQuery(workspaceId));
  const queryClient = useQueryClient();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const openItem = useOpenItem();
  const item = data?.items.find((candidate) => candidate.id === itemId);
  const atSource = item ? openableAtSource(item) : null;

  /**
   * Centered or docked to the side ("Let the item's form dock to the side of
   * the screen instead of opening as a dialog", issue 481) - an account-wide
   * choice, read from the same snapshot `item` above is.
   *
   * **Locked once read, the same reason the dragged size above is read into
   * `remembered` rather than applied live.** The account's own choice can
   * change while this form is open - from the control below, or from another
   * device entirely - and only the first of those two is supposed to move
   * this open form; the second must leave it exactly where it was until it is
   * closed and reopened. `fixedPresentation` is what tells those apart:
   * pressing the control sets it directly, so this render picks it up at
   * once, while a change arriving over `data` alone never touches it.
   */
  const [fixedPresentation, setFixedPresentation] = useState<ItemFormPresentation | null>(null);
  useEffect(() => {
    // `?? DEFAULT_ITEM_FORM_PRESENTATION` rather than trusting `data` to
    // always carry the field: a snapshot restored from a stored copy older
    // than this field (persistence.tsx's own `CACHE_BUSTER`) is read but
    // never re-validated, so it can answer `undefined` here - which must
    // still lock to a real value, not `undefined` itself, or the lock this
    // effect exists for falls through to `data` again on the next render
    // (found in review).
    if (fixedPresentation === null && data) {
      setFixedPresentation(data.itemFormPresentation ?? DEFAULT_ITEM_FORM_PRESENTATION);
    }
  }, [data, fixedPresentation]);
  const presentation = fixedPresentation ?? data?.itemFormPresentation ?? DEFAULT_ITEM_FORM_PRESENTATION;
  const chosenDocked = presentation === 'docked';
  const screenWidth = useScreenWidth();
  /**
   * What is actually drawn - the account's own choice, brought inside a
   * screen that has room for it. Docking is out of scope for a phone by the
   * issue's own text, but "out of scope" has to mean "falls back to
   * centered", not "renders anyway": without this, an account docked from a
   * desktop opened this form on a phone at the docked width's own floor -
   * 320px, non-modal, the page behind it still interactive - in place of
   * today's near-full-screen centered dialog (found in review).
   */
  const docked = chosenDocked && screenWidth >= DESKTOP_MIN_WIDTH;

  /**
   * Flips the account's own choice, and this open form along with it.
   *
   * **Reverted on refusal.** The flip is drawn before the round trip lands -
   * the same as everywhere else in this file that answers a press at once
   * rather than waiting on the network - so a request that fails must put
   * `fixedPresentation` back rather than leave this form showing a
   * presentation the account never actually adopted (found in review).
   */
  const togglePresentation = async () => {
    const was = presentation;
    // `chosenDocked`, not the viewport-gated `docked`: on a narrow screen
    // where an already-docked account renders centered, the control still
    // has to flip the account's real choice back to centered rather than
    // reading its own fallback rendering as "not docked yet" and asking to
    // dock what is already docked.
    const next: ItemFormPresentation = chosenDocked ? 'centered' : 'docked';
    setFixedPresentation(next);
    try {
      await send({
        name: 'set_item_form_presentation',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId: ACCOUNT_WIDE,
          presentation: next,
        },
      });
    } catch (failure) {
      setFixedPresentation(was);
      setRefusal(failure instanceof Error ? failure.message : 'That could not be saved');
    }
  };

  /** This Item's own files, out of the workspace's whole list ("Attach a file to an item", issue 441). */
  const attachments: Attachment[] =
    data?.attachments.filter((attachment) => attachment.itemId === itemId) ?? [];
  /**
   * The notes this one may be saying again ("Flag a captured note that says
   * what another one already said", issue 407) - worked out from the same
   * snapshot the row's own mark is, so the form and the row can never disagree
   * about whether there is anything to show.
   */
  const saidAgain = possibleDuplicatesOf(
    itemId,
    data?.items ?? [],
    // The reading the row's own mark is built from, which is what "the same
    // snapshot" above means: a filing onto a Filter leaves its Item in the
    // Inbox (`filingsThatFile`), and which Items are in the Inbox is half of
    // the rule a pair is offered by.
    filingsThatFile(data?.filings ?? [], data?.panels ?? []),
    data?.duplicates ?? [],
  );
  /**
   * The other ways this note could genuinely be read, or `null` where the
   * texts are already somebody's own ("Offer the other readings when a
   * captured note says two things", issue 297) - read once here rather than
   * inline in the banner below, which needs the same answer to decide
   * whether it is drawn at all.
   */
  const openReadings = item && itemHasOpenReadings(item) && item.readings ? item.readings : null;

  /**
   * Settles one pair as not a duplicate, or - from the bar the settling
   * offers - takes that back ("Say a flagged pair is not a duplicate", issue
   * 408). About the pair rather than about `itemId` alone, so it reads the
   * same whichever of the two Items' forms it was pressed from.
   */
  const settleNotADuplicate = async (otherId: string, other: Item) => {
    const envelope = () => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      itemId,
      otherItemId: otherId,
    });
    try {
      await send({ name: 'set_duplicate_settled', payload: { ...envelope(), settled: true } });
      offerToUndo({
        what: `"${itemLabel(other)}" is not a duplicate`,
        undo: () =>
          send({ name: 'set_duplicate_settled', payload: { ...envelope(), settled: false } }),
      });
    } catch (failure) {
      setRefusal(failure instanceof Error ? failure.message : 'That could not be settled');
    }
  };

  /**
   * Attaches files as they are chosen or dropped, one upload at a time and
   * each sent the moment it arrives - unlike the title, description and
   * priority above, an attachment is not batched into Save (issue 441's own
   * UI test case: "a second Save doesn't resurrect it").
   *
   * Checked against the allowlist and the size cap here too, before the
   * round trip - the server enforces both for real, this is only what
   * saves a person a wait for a refusal the file's own name already
   * predicts.
   */
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentsDragOver, setAttachmentsDragOver] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const attachFiles = async (files: Iterable<File>) => {
    // Checked whole, before anything uploads - a rejection two files back
    // in the same drop must not be a message the next, valid file's own
    // success quietly clears.
    const rejections: string[] = [];
    const accepted: File[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_SIZE) {
        rejections.push(`"${file.name}" is over the ${formatFileSize(MAX_ATTACHMENT_SIZE)} limit.`);
      } else if (!attachmentContentTypeSchema.safeParse(file.type).success) {
        rejections.push(`"${file.name}" is not a kind of file Cockpit accepts.`);
      } else {
        accepted.push(file);
      }
    }
    setAttachmentError(rejections.length > 0 ? rejections.join(' ') : null);

    for (const file of accepted) {
      const attachmentId = uuidv7();
      setPendingAttachments((was) => [...was, { id: attachmentId, filename: file.name }]);
      try {
        await uploadAttachment({ itemId, workspaceId, attachmentId, commandId: uuidv7(), file });
      } catch (failure) {
        setAttachmentError(
          failure instanceof Error ? failure.message : `"${file.name}" could not be attached`,
        );
      } finally {
        setPendingAttachments((was) => was.filter((pending) => pending.id !== attachmentId));
      }
    }
    // Once for the whole batch, not once per file - a drop of several files
    // has no reason to re-read the whole workspace that many times.
    if (accepted.length > 0) await queryClient.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
  };

  const removeAttachment = async (attachment: Attachment) => {
    try {
      await send({
        name: 'remove_attachment',
        payload: {
          commandId: uuidv7(),
          issuedAt: new Date().toISOString(),
          workspaceId,
          itemId,
          attachmentId: attachment.id,
        },
      });
    } catch (failure) {
      setAttachmentError(failure instanceof Error ? failure.message : 'That could not be removed');
    }
  };

  // A callback ref rather than an object one: Radix's `Content` mounts behind
  // its own exit-animation machinery (`Presence`), so the node an object ref
  // would carry is not necessarily there on the tick after this component's
  // own mount - which is exactly when the size it opened at needs measuring,
  // below. A callback ref has no such gap; React calls it exactly when the
  // node is attached, whenever that turns out to be.
  const [contentEl, setContentEl] = useState<HTMLDivElement | null>(null);
  /**
   * What the box opens at - `null` until read, then either what was
   * remembered or, if there was nothing to remember, confirmed as nothing by
   * staying `null`.
   *
   * **Read here, in a layout effect, rather than at render with a lazy
   * `useState` initializer.** A straight swap from one item's form to
   * another's (`ItemForm`, `key={openItemId}`) unmounts the outgoing
   * `TheForm` and mounts this one within a single React update - and the
   * write below runs from that outgoing instance's own layout-effect
   * cleanup, which fires during the commit React makes for that same
   * update, strictly after every component's *render* has already
   * happened. A lazy initializer runs at render, before any of that commit
   * has taken place, so it would read what was remembered *before* the item
   * being swapped away from had a chance to write what it was just dragged
   * to. A layout effect runs during the commit itself, after the outgoing
   * instance's cleanup - late enough to see it.
   */
  const [remembered, setRemembered] = useState<Size | null>(null);
  const appliedRemembered = useRef(false);
  /** The stored preference as it was found at mount, kept aside from
   *  `remembered` (React state, used only to size the box) so the fallback
   *  below always has the true original to hand rather than whatever
   *  `remembered` has since re-rendered with. */
  const original = useRef<Size | null>(null);
  useLayoutEffect(() => {
    if (!contentEl || appliedRemembered.current) return;
    appliedRemembered.current = true;
    const stored = rememberedItemFormSize(browserStore());
    original.current = stored;
    if (stored) setRemembered(stored);
  }, [contentEl]);
  /**
   * The box's own size as of the `mousedown` that began the drag currently
   * in progress, and `known` - the best current understanding of what
   * should be persisted, evolved from it once that drag's `mouseup` arrives.
   *
   * **Settled at `mouseup`, but only while `inProgress` says a drag is
   * actually the reason for it.** There is no `resizeend` event, so a
   * `mouseup` is what stands in for one - but a `mouseup` happens after
   * every ordinary click too (typing into Title, pressing Cancel), and
   * `checkpoint` alone cannot tell those apart from a real drag's end: once
   * anything has set it, a later *unrelated* `mouseup` would still find the
   * box measuring differently if a live viewport reclamp had moved it in
   * between, with no drag involved at all. `inProgress`, set only by a
   * qualifying `mousedown` and cleared the moment its own `mouseup` is
   * handled, is what a `mouseup` checks first - an unrelated one finds it
   * false and changes nothing. Settling at close instead of `mouseup` would
   * have the same gap: the box measured then reflects everything since the
   * drag ended, not only the drag itself.
   *
   * **`known` keeps only what a drag actually moved, per axis, across
   * possibly several drags in the same open.** The first time an axis is
   * seen to move, its fallback is the *original* stored preference, or
   * `DEFAULT_SIZE` where there was none - never the box's own current
   * render, which on a screen already clamping that axis is the
   * clamped-down size rather than one anybody chose. Every settlement after
   * that folds forward from whatever `known` already holds, so a second
   * drag that leaves one axis alone keeps what the *first* drag left it at,
   * not the original value from before either
   * of them.
   */
  const checkpoint = useRef<Size | null>(null);
  const known = useRef<Size | null>(null);
  const inProgress = useRef(false);
  useEffect(() => {
    // The native corner handle only exists on the centered presentation
    // (`sm:resize`, below) - docked is resized by its own edge handle
    // further down, which does not go through this at all.
    if (!contentEl || docked) return;
    const measure = (): Size | null => {
      const box = contentEl.getBoundingClientRect();
      return box.width > 0 && box.height > 0
        ? { width: Math.round(box.width), height: Math.round(box.height) }
        : null;
    };
    // A `mousedown` inside the handle's own corner, checked for the primary
    // button, and only that: the grip is drawn inside the box's own
    // padding, over nothing else, so a press landing there has this element
    // as its target and nowhere close to the target a press on Cancel or
    // Save would have. `sm:resize` (below) is the only thing that makes the
    // handle interactive at all, which is why the width check matches its
    // own breakpoint.
    const onDown = (e: MouseEvent) => {
      if (e.button !== 0 || e.target !== contentEl || window.innerWidth < DESKTOP_MIN_WIDTH) return;
      const box = contentEl.getBoundingClientRect();
      const inCorner =
        e.clientX >= box.right - RESIZE_CORNER &&
        e.clientX <= box.right &&
        e.clientY >= box.bottom - RESIZE_CORNER &&
        e.clientY <= box.bottom;
      const now = measure();
      if (!inCorner || !now) return;
      checkpoint.current = now;
      inProgress.current = true;
    };
    // Not corner-gated, unlike `mousedown`: a drag can be dragged past the
    // box's own edge before the button lifts. Gated on `inProgress` instead,
    // so a `mouseup` that is not this drag's own changes nothing.
    const onUp = () => {
      if (!inProgress.current) return;
      inProgress.current = false;
      const was = checkpoint.current;
      const now = measure();
      if (!was || !now || (now.width === was.width && now.height === was.height)) return;
      const base = known.current ?? original.current ?? DEFAULT_SIZE;
      known.current = {
        width: now.width === was.width ? base.width : now.width,
        height: now.height === was.height ? base.height : now.height,
      };
    };
    contentEl.addEventListener('mousedown', onDown);
    window.addEventListener('mouseup', onUp);
    return () => {
      contentEl.removeEventListener('mousedown', onDown);
      window.removeEventListener('mouseup', onUp);
    };
  }, [contentEl, docked]);
  /**
   * Remembers whatever a drag left `known` holding, on the way out.
   *
   * **A cleanup, not a call from Cancel or Save.** A cleanup runs regardless
   * of *why* the dialog goes - Cancel, Save, Escape, a press outside, or a
   * straight swap from one item's form to another's (`ItemForm`,
   * `key={openItemId}`) skips both of those and unmounts this component
   * directly, which is the one path a call hung off Cancel or Save would
   * have missed a drag on.
   *
   * **A layout effect, not a plain one - the same reason the read above
   * is one.** A layout effect's cleanup for an unmounting fiber runs
   * synchronously during the same commit, before layout effect *setup* runs
   * for a newly mounted sibling - which is what makes the read above see
   * this write on a same-commit swap. A plain effect's cleanup for that
   * fiber is not guaranteed to run until the passive phase, which normally
   * follows layout, and by no documented rule precedes a sibling's mount;
   * relying on that would be trusting an ordering nothing here actually
   * grants.
   */
  useLayoutEffect(() => {
    return () => {
      if (known.current) rememberItemFormSize(browserStore(), known.current);
    };
  }, []);

  /**
   * How wide the docked presentation is dragged to - a per-device preference,
   * the same as the centered presentation's own dragged size
   * (`itemFormDockedWidth.ts`'s own header says why it is per-device rather
   * than the account's). Read once, from a lazy initializer: an effect would
   * paint the default width first and jump to the stored one a frame later.
   *
   * **The drag itself follows the Inbox column's own edge-drag**
   * (`pages/Layout.tsx`, "Let the Inbox column be resized horizontally",
   * issue 331) rather than the centered presentation's native corner handle
   * above: docked has one edge to drag, not a corner, and stays non-modal
   * throughout, so a native `resize` (which the browser would still apply to
   * the whole box, corner included) is the wrong shape for it.
   */
  const [dockedWidth, setDockedWidth] = useState<number | null>(() =>
    readItemFormDockedWidth(browserStore()),
  );
  const [dockDragPreview, setDockDragPreview] = useState<number | null>(null);
  const dockResizingFrom = useRef<
    { startWidth: number; startX: number; latest: number; pointerId: number } | null
  >(null);
  /** Read by the drag's own `pointermove` handler, which is declared once per
   *  drag rather than once per render - the same reason the Inbox column's
   *  own `availableRowWidthRef` is a ref rather than a closed-over value. */
  const screenWidthRef = useRef(screenWidth);
  screenWidthRef.current = screenWidth;

  const clearDockDrag = useCallback(() => {
    dockResizingFrom.current = null;
    setDockDragPreview(null);
  }, []);

  const takeDockHandle = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0 || dockResizingFrom.current || !contentEl) return;
      event.preventDefault();
      const startWidth = contentEl.getBoundingClientRect().width;
      dockResizingFrom.current = {
        startWidth,
        startX: event.clientX,
        latest: startWidth,
        pointerId: event.pointerId,
      };
      setDockDragPreview(startWidth);
      try {
        event.currentTarget.setPointerCapture(event.pointerId);
      } catch {
        // Allowed to fail, as the Inbox column's own capture is: the moves
        // still arrive while the pointer is over the handle, nearly all of
        // the gesture.
      }
    },
    [contentEl],
  );

  const commitDockHandle = useCallback(() => {
    const held = dockResizingFrom.current;
    clearDockDrag();
    if (!held || held.latest === held.startWidth) return;
    setDockedWidth(held.latest);
    writeItemFormDockedWidth(browserStore(), held.latest);
  }, [clearDockDrag]);

  const draggingDock = dockDragPreview !== null;
  useEffect(() => {
    if (!draggingDock) return;
    // Centered has no way to reach this drag's own handle mid-gesture, but
    // the account-wide toggle does - pressing "Center" from another input
    // while this one is still captured by the handle (found in review, a
    // multi-pointer device only). Discarding rather than letting it run on
    // is the same call `Cancel` makes for the boxes above: a size dragged to
    // for a presentation just left is not one worth keeping.
    if (!docked) {
      clearDockDrag();
      return;
    }
    const pointerId = dockResizingFrom.current?.pointerId;
    const ownsPointer = (event: PointerEvent) => event.pointerId === pointerId;
    const onMove = (event: PointerEvent) => {
      if (!ownsPointer(event)) return;
      const held = dockResizingFrom.current;
      if (!held) return;
      // Docked to the *right* edge, so dragging its left edge left is what
      // widens it - the opposite sign the Inbox column's own left-edge
      // handle uses for a column that grows to the right instead.
      held.latest = clampItemFormDockedWidth(
        held.startWidth - (event.clientX - held.startX),
        screenWidthRef.current,
      );
      setDockDragPreview(held.latest);
    };
    const onUp = (event: PointerEvent) => {
      if (ownsPointer(event)) commitDockHandle();
    };
    const onCancel = (event: PointerEvent) => {
      if (ownsPointer(event)) clearDockDrag();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') clearDockDrag();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey);
    };
  }, [draggingDock, docked, commitDockHandle, clearDockDrag]);

  /** What the docked presentation is drawn at: the drag's own number while one is running, the stored preference otherwise, both brought inside the window's current bounds. */
  const dockedWidthPx = clampItemFormDockedWidth(
    dockDragPreview ?? dockedWidth ?? DEFAULT_SIZE.width,
    screenWidth,
  );

  /** What the boxes hold, and what they were filled from. */
  const [editing, setEditing] = useState<{ was: Draft; now: Draft } | null>(null);
  const draft = editing?.now ?? null;
  const setDraft = (now: Draft) => setEditing((held) => (held ? { ...held, now } : held));
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /**
   * Bumped every time a reading is chosen, and handed to `DescriptionBox` as
   * its `resetKey` below - the editor owns its document once it is made and
   * ignores a new `value` fed into the same instance, so replacing the
   * description wholesale (a reading, not a keystroke) needs the editor
   * rebuilt rather than a prop change ("Offer the other readings when a
   * captured note says two things", issue 297).
   */
  const [readingPicked, setReadingPicked] = useState(0);

  /**
   * Which of the two footer disclosures - what was captured, the item's own
   * id - is open, or neither. Both stay off the form until asked for and
   * share one slot rather than one flag each, so opening one closes the
   * other instead of stacking two panels over the same corner ("Give the
   * item's form more room, and put clutter out of the way", issue 480).
   */
  const [footerOpen, setFooterOpen] = useState<'captured' | 'id' | null>(null);

  /**
   * The boxes start from the Item and are then the person's own, and what they
   * started from is kept beside them. Filled once and never refilled, so a
   * change arriving over the live updates stream while the form is open does
   * not overwrite what is being typed - the last write wins on Save, not on
   * every push - and `was` is what Save compares against, so that same arriving
   * change is not mistaken for something typed here.
   */
  useEffect(() => {
    if (item && editing === null) {
      const from = {
        title: item.title,
        description: item.description ?? '',
        priority: item.priority,
        dueDate: item.dueDate,
      };
      setEditing({ was: from, now: { ...from } });
    }
  }, [item, editing]);

  /**
   * Over the cap in a box that is actually being sent, not in one that merely
   * holds too much.
   *
   * The read model is permissive on purpose - a title from before the cap
   * existed still opens - so measuring the whole draft would open such an item
   * with Save already disabled, and refuse a description-only edit for a title
   * nothing was going to send. What is refused is what would be written.
   */
  const changing = editing ? whatChanged(editing.was, editing.now) : {};
  const overCap =
    (changing.title !== undefined && changing.title.length > TITLE_LENGTH
      ? ('title' as const)
      : undefined) ??
    (changing.description != null && changing.description.length > DESCRIPTION_LIMIT
      ? ('description' as const)
      : undefined);
  const tooLong = overCap !== undefined;

  const save = async () => {
    if (!item || !editing || tooLong) return;
    const changed = changing;
    setSaving(true);
    setRefusal(null);
    const envelope = () => ({
      commandId: uuidv7(),
      issuedAt: new Date().toISOString(),
      workspaceId,
      itemId,
    });
    /**
     * Each text as it lands, and the baseline moved with it.
     *
     * **Moving the baseline is what makes a second Save mean something.** The
     * two are sent one after the other, so the first can land and the second
     * fail; without this the form would still believe neither had, and pressing
     * Save again would re-send a title that is already stored - bumping its
     * time and dropping a genuinely newer edit from somewhere else as stale.
     * Cancel would also be lying, since what it discards is by then only the
     * half that did not land.
     *
     * **`applied` is read, not just the absence of a throw.** A change made
     * against an older version of an item is answered `{ applied: false }` with
     * a 200 (`isStale`), so a form that took "it did not throw" for "it saved"
     * would close on it and take what was typed with it.
     */
    const landed = async (
      what: 'title' | 'description' | 'priority' | 'dueDate',
      change: CommandArgs,
    ): Promise<boolean> => {
      const answer = await send(change);
      if (!answer.applied) return false;
      setEditing((held) =>
        held ? { ...held, was: { ...held.was, [what]: editing.now[what] } } : held,
      );
      return true;
    };

    try {
      if (
        changed.title !== undefined &&
        !(await landed('title', {
          name: 'set_title',
          payload: { ...envelope(), title: changed.title },
        }))
      ) {
        setRefusal('That item changed somewhere else. Copy what you want to keep and reopen it.');
        return;
      }
      if (
        changed.description !== undefined &&
        !(await landed('description', {
          name: 'set_description',
          payload: { ...envelope(), description: changed.description },
        }))
      ) {
        setRefusal('That item changed somewhere else. Copy what you want to keep and reopen it.');
        return;
      }
      if (
        changed.priority !== undefined &&
        !(await landed('priority', {
          name: 'set_priority',
          payload: { ...envelope(), priority: changed.priority },
        }))
      ) {
        setRefusal('That item changed somewhere else. Copy what you want to keep and reopen it.');
        return;
      }
      if (
        changed.dueDate !== undefined &&
        !(await landed('dueDate', {
          name: 'set_due_date',
          payload: { ...envelope(), dueDate: changed.dueDate },
        }))
      ) {
        setRefusal('That item changed somewhere else. Copy what you want to keep and reopen it.');
        return;
      }
      onClose();
    } catch (failure) {
      // The form stays open and says why, so nothing typed is lost to a
      // refusal - the one case where closing would throw work away.
      setRefusal(failure instanceof Error ? failure.message : 'That could not be saved');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog.Root
      open
      // Non-modal only while docked: the whole point of that presentation is
      // that the page behind it stays usable, which Radix's own modal
      // behaviour (an inert background, a focus trap) would undo.
      modal={!docked}
      onOpenChange={(stillOpen) => {
        // Escape, the close control and a press outside all land here, and all
        // three discard: Cancel means cancel (functional definition, "Editing
        // more than one field at a time"). Save is what writes, and it is
        // sitting in the form unpressed.
        //
        // A footer disclosure's own Escape or outside-press never reaches
        // here at all - Radix's dismissable layers close only the innermost
        // open one, so a `Popover` open over this `Dialog` answers for
        // itself (`FooterDisclosure`).
        if (!stillOpen && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        {/* No scrim while docked - the page behind stays visible as well as
            clickable, which a dimming overlay over it would contradict. */}
        {!docked && <Dialog.Overlay className="fixed inset-0 bg-black/30" />}
        <Dialog.Content
          ref={setContentEl}
          aria-describedby={undefined}
          onInteractOutside={(event) => {
            // Non-modal already keeps a press on the page behind from
            // reaching it; this stops Radix reading that same press as a
            // request to close the *form*, which is the one part "non-modal"
            // does not already cover on its own.
            if (docked) event.preventDefault();
          }}
          onEscapeKeyDown={(event) => {
            // Radix's own Escape handling runs in the capture phase, ahead
            // of the drag effect's own `keydown` listener below - so without
            // this, Escape pressed mid-drag closes the whole form and
            // discards the draft instead of merely cancelling the resize
            // (found in review). The drag effect's listener still cancels
            // the drag itself once this stops it from also closing the form.
            if (draggingDock) event.preventDefault();
          }}
          // An explicit size rather than one that grows and shrinks with what
          // is inside it - the editor's async-loading placeholder is a fixed
          // 12 rows, usually taller than the real editor once it swaps in, so
          // sizing to content shrank the box the instant it arrived ("Fix the
          // item form's resize jank, and let it be resized", issue 295). A
          // remembered size starts the box here as `width`/`height`; with
          // nothing remembered it opens at `--item-form-w`/`-h` (styles.css).
          // The ceiling it can grow to - by a drag or by what was remembered
          // - is the taller `--item-form-max-w`/`-h`, a real limit above that
          // default rather than the default doubling as its own ceiling
          // ("Give the item's form more room, and put clutter out of the
          // way", issue 480) - still the tallest dialog in the app, so on a
          // phone it fills the screen.
          //
          // **`max-`/`min-` stay live for the life of the dialog, not just its
          // opening.** A remembered `width`/`height` only sets where the box
          // starts; the class list goes on tracking the screen the whole time
          // it is open, so the same formula that clamps an oversized
          // remembered size down to fit also reclamps it live if the window
          // or the device's own orientation changes under it - the reason a
          // size clamped down on a small screen is the full size again on a
          // big one, without ever rewriting what was remembered. The floor is
          // wrapped in the same `min(...)` as the ceiling for the reason
          // `--item-form-max-h`'s own comment gives: on a screen too short for
          // even `18rem`, an unclamped floor would win over the safe-area
          // formula and put the title back under the status bar.
          //
          // **Resizable at a desk and not on a phone**, the `sm:` breakpoint
          // the Capture box's own textarea already gates its resize handle on
          // (`pages/CapturePage.tsx`): there is no room to grow into and the
          // handle is one more thing under a thumb. Both axes rather than
          // that box's vertical-only, since a dialog can be usefully too wide
          // as well as too tall. `overflow` has to be something other than
          // `visible` for the handle to appear at all; the title and
          // description already scroll inside their own box below, so
          // nothing is lost by it.
          //
          // **`@container`, so the two-column split below can answer to this
          // box's own width rather than the viewport's.** The dialog resizes
          // and remembers a size independently of the window (above) - a
          // `sm:` viewport breakpoint would keep two columns forced onto a
          // dialog dragged down near its floor on an otherwise wide screen,
          // squeezing the description to almost nothing.
          //
          // **Docked keeps the same `@container` two-column body**, per the
          // issue this presentation shipped in: "everything else about the
          // docked presentation matches today's form exactly" - only the
          // positioning, the sizing and the modality below it are its own.
          className={
            docked
              ? '@container fixed right-0 top-0 flex h-full flex-col overflow-hidden rounded-l-lg border border-black/10 bg-surface p-5 shadow-lg'
              : '@container fixed left-1/2 top-1/2 flex h-[var(--item-form-h)] max-h-[var(--item-form-max-h)] min-h-[min(18rem,var(--item-form-max-h))] w-[var(--item-form-w)] max-w-[var(--item-form-max-w)] min-w-[min(20rem,var(--item-form-max-w))] -translate-x-1/2 -translate-y-1/2 flex-col resize-none overflow-hidden rounded-lg border border-black/10 bg-surface p-5 shadow-lg sm:resize'
          }
          style={
            docked
              ? { width: `${dockedWidthPx}px` }
              : remembered
                ? { width: `${remembered.width}px`, height: `${remembered.height}px` }
                : undefined
          }
        >
          {docked && (
            // Dragged to resize, the same idiom the Inbox column's own edge
            // uses (`pages/Layout.tsx`) rather than the centered
            // presentation's native corner handle above - docked has one
            // edge to drag, not a corner.
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the form"
              onPointerDown={takeDockHandle}
              className="absolute inset-y-0 left-0 z-10 w-2 cursor-col-resize touch-none"
            />
          )}
          {/* The account-wide choice between this presentation and the
              centered one, switched from the form itself ("Let the item's
              form dock to the side of the screen instead of opening as a
              dialog", issue 481). Its own row above the title rather than
              floated over a corner, which the title box below would
              otherwise run under - full width, like the row it sits above. */}
          <div className="flex shrink-0 justify-end">
            <button
              type="button"
              disabled={saving}
              onClick={() => void togglePresentation()}
              className="rounded-md border border-black/10 bg-surface px-2 py-1 text-xs text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink disabled:opacity-50"
            >
              {chosenDocked ? 'Center' : 'Dock'}
            </button>
          </div>

          {/* Said rather than shown. A dialog has to name itself, and this one
              is opened by a row whose label is now the title box directly under
              it - so drawing it would put the same words on the form twice,
              which is the duplicate capture writing the title removed. Read
              from the stored item rather than from the boxes, so it holds still
              while a new title is being typed under it. */}
          <Dialog.Title className="sr-only">{item ? itemLabel(item) : 'Item'}</Dialog.Title>

          {!item ? (
            <p role="alert" className="pt-3 text-sm text-ink-soft">
              {isLoading ? 'Opening…' : 'That item is not here any more.'}
            </p>
          ) : (
            draft && (
              // `overflow-y-auto` is the fallback the two-column body below
              // otherwise has none of: title and the banner both refuse to
              // shrink (`shrink-0`), so a short dialog with a tall banner (or
              // a stacked layout under `@lg` with a long attachments list)
              // could squeeze the two-column region to nothing with no way
              // to scroll it into view (found in review). `-mx-1 … px-1` is
              // the same trick the region it replaces already needed:
              // `overflow-y-auto` computes `overflow-x` as non-`visible` too,
              // which would otherwise clip a flush `w-full` child's own
              // `focus:ring-2`.
              <div className="-mx-1 mt-4 flex min-h-0 flex-1 flex-col overflow-y-auto px-1">
                <label className="block shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Title
                  <input
                    autoFocus
                    // Both boxes are closed while a save is in flight, for the
                    // reason Cancel and Save are: what is sent is worked out
                    // before the round trip, so a keystroke landing during it
                    // would be typed into a draft nobody is going to read and
                    // lost when the form closes.
                    disabled={saving}
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                  />
                </label>

                {/* Where this came from, and the way back to it ("Open an Item
                    at its source", issue 487). Only for an Item that has both a
                    source and a link to it, the same test the row and its menu
                    apply. A record with one link in it, so no more prominent
                    than the row's own. */}
                {atSource && (
                  <p className="mt-2 shrink-0 text-xs text-ink-faint">
                    From {atSource.name}
                    {item.sender ? ` - ${item.sender}` : ''}
                    {' · '}
                    <a
                      href={atSource.link}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-accent-deep underline"
                    >
                      Open in {atSource.name}
                    </a>
                  </p>
                )}

                {/* Readings and duplicates both need a decision, so both sit
                    in one banner directly under the title rather than being
                    buried below attachments ("Give the item's form more
                    room, and put clutter out of the way", issue 480). Drawn
                    only where there is a decision to make - neither shows no
                    banner at all. */}
                {(openReadings || saidAgain.length > 0) && (
                  <div className="mt-3 flex max-h-48 shrink-0 flex-col gap-3 overflow-y-auto rounded-md border border-accent-soft/40 bg-accent-tint/50 p-3">
                    {/* The other ways this note could genuinely be read,
                        offered beside the one already sitting in the two
                        boxes above ("Offer the other readings when a
                        captured note says two things", issue 297). Taking one
                        only fills the boxes - it still has to be saved, the
                        same as typing it in by hand would. */}
                    {openReadings && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Reads more than one way
                        </p>
                        <div className="mt-1 flex flex-col gap-1.5">
                          {openReadings.map((reading) => (
                            <button
                              key={reading.title}
                              type="button"
                              disabled={saving}
                              onClick={() => {
                                setDraft({
                                  ...draft,
                                  title: reading.title,
                                  description: reading.description,
                                });
                                setReadingPicked((was) => was + 1);
                              }}
                              className="rounded-md border border-black/10 bg-surface px-3 py-2 text-left text-sm hover:border-accent hover:bg-accent-tint disabled:opacity-50"
                            >
                              <span className="block font-medium text-ink">{reading.title}</span>
                              <span className="block text-xs text-ink-faint">{reading.meaning}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* The notes this one may be saying again, each opening
                        its own form ("Flag a captured note that says what
                        another one already said", issue 407). Offered rather
                        than acted on, the way a proposed Panel is: nothing
                        here merges, files or deletes anything, and the two
                        notes go on being two notes until somebody decides
                        otherwise. */}
                    {saidAgain.length > 0 && (
                      <div>
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Possible duplicate of
                        </p>
                        <div className="mt-1 flex flex-col gap-1.5">
                          {saidAgain.map((other) => (
                            <div key={other.id} className="flex items-stretch gap-1.5">
                              <button
                                type="button"
                                disabled={saving}
                                // Opening the other one is a change of address, so the
                                // back button comes back here (`useOpenItem`,
                                // src/itemForm.tsx) - which is what makes this a link
                                // between two notes rather than a jump out of one.
                                onClick={() => openItem(other.id)}
                                className="flex-1 rounded-md border border-black/10 bg-surface px-3 py-2 text-left text-sm hover:border-accent hover:bg-accent-tint disabled:opacity-50"
                              >
                                <span className="block font-medium text-ink">{itemLabel(other)}</span>
                              </button>
                              {/* About this pair, not about either note ("Say a
                                  flagged pair is not a duplicate", issue 408) - it
                                  is the settling that is offered undo, not a change
                                  to what is drawn here. */}
                              <button
                                type="button"
                                disabled={saving}
                                onClick={() => void settleNotADuplicate(other.id, other)}
                                title="Not a duplicate"
                                aria-label="Not a duplicate"
                                className="rounded-md border border-black/10 bg-surface px-2 text-sm text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink disabled:opacity-50"
                              >
                                ✕
                              </button>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Title/priority/due date/attachments beside the
                    description rather than stacked above it, so the
                    description gets whatever height the form has instead of
                    whatever is left over (issue 480). Stacks back into one
                    column below `@lg` of the dialog's own width (`@container`
                    above) - answering to the box actually being dragged and
                    remembered, not to the viewport, which can stay wide while
                    the box itself is dragged down to its own floor. */}
                <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 @lg:flex-row">
                  {/* Its own scroll, like the description column beside it -
                      the whole form used to scroll as one region, and this is
                      that region's half of splitting it in two: a full
                      Attachments list must still reach its own "Add" button
                      rather than being clipped by the dialog's own
                      `overflow-hidden` with nothing to scroll it into view.
                      `-mx-1 … px-1` for the same reason the wrapper around
                      this whole section now carries it too - `overflow-y-auto`
                      would otherwise clip the Priority/Due date fields' own
                      `focus:ring-2` at the edges they're flush against. */}
                  {/* **`contents` until the two columns exist.** Stacked, this
                      wrapper draws nothing of its own, so its two halves - the
                      short fields and the attachments - join the description
                      as siblings and are put in the order a person reads them
                      (fields, description, then files) with `order-*`, rather
                      than the files coming ahead of the text they are only
                      attached to. From `@lg` it is the sidebar again, and each
                      child's order is put back to the source order. */}
                  <div className="-mx-1 contents min-h-0 flex-col gap-4 overflow-y-auto px-1 @lg:flex @lg:w-72 @lg:shrink-0">
                    {/* Priority and due date share a row (issue 480). */}
                    <div className="order-1 flex gap-3 @lg:order-none">
                      {/* A width of its own rather than half the row: the
                          longest label, "Normal", was clipped to "Nor" at the
                          half a 240px sidebar left it. */}
                      <label className="block w-30 shrink-0 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                        Priority
                        <select
                          disabled={saving}
                          value={draft.priority ?? ''}
                          onChange={(e) =>
                            setDraft({
                              ...draft,
                              priority: (e.target.value || null) as Priority | null,
                            })
                          }
                          className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                        >
                          <option value="">None</option>
                          {prioritySchema.options.map((value) => (
                            <option key={value} value={value}>
                              {PRIORITY_LABELS[value]}
                            </option>
                          ))}
                        </select>
                      </label>

                      <div className="min-w-0 flex-1">
                        <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Due date
                          <input
                            type="date"
                            disabled={saving}
                            value={draft.dueDate ?? ''}
                            onChange={(e) => setDraft({ ...draft, dueDate: e.target.value || null })}
                            className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                          />
                        </label>
                        {/* One-click alongside typing one directly (issue
                            480): today, the coming Friday - never a past one
                            - and seven days out, each measured from the
                            moment the button is pressed and each overriding
                            whatever the field already holds, the same as
                            typing over it would. */}
                        <div className="mt-1.5 flex flex-wrap gap-1.5">
                          {DUE_DATE_SHORTCUTS.map(({ label, dueDate }) => (
                            <button
                              key={label}
                              type="button"
                              disabled={saving}
                              onClick={() => setDraft({ ...draft, dueDate: dueDate(new Date()) })}
                              className="rounded-md border border-black/10 px-2 py-0.5 text-xs text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink disabled:opacity-50"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                      </div>
                    </div>

                    {/* A screenshot, a scan or a clip the note is really about
                        ("Attach a file to an item", issue 441) - added by button
                        or drag-and-drop, drawn as a chip, opened or downloaded by
                        a click on it. */}
                    <div className="order-3 @lg:order-none">
                      <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                        Attachments
                      </p>
                      <div
                        onDragOver={(e) => {
                          e.preventDefault();
                          if (!saving) setAttachmentsDragOver(true);
                        }}
                        // `dragleave` fires on every child boundary crossed, not
                        // only on truly leaving the drop zone - checked against
                        // where the pointer actually went, so passing over a
                        // chip or the Add button mid-drag does not flicker the
                        // highlight off.
                        onDragLeave={(e) => {
                          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
                            setAttachmentsDragOver(false);
                          }
                        }}
                        onDrop={(e) => {
                          e.preventDefault();
                          setAttachmentsDragOver(false);
                          if (!saving && e.dataTransfer.files.length > 0) {
                            void attachFiles(e.dataTransfer.files);
                          }
                        }}
                        className={`mt-1 flex flex-col gap-1.5 rounded-md border border-dashed px-3 py-2 ${
                          attachmentsDragOver ? 'border-accent bg-accent-tint' : 'border-black/10'
                        }`}
                      >
                        {attachments.map((attachment) => (
                          <div
                            key={attachment.id}
                            className="flex items-center gap-2 rounded-md border border-black/10 bg-white px-3 py-2 text-sm"
                          >
                            <a
                              href={attachmentUrl(attachment.id)}
                              target="_blank"
                              rel="noreferrer"
                              className="flex min-w-0 flex-1 items-center gap-2"
                            >
                              {attachment.contentType.startsWith('image/') ? (
                                <img
                                  src={attachmentUrl(attachment.id)}
                                  alt={attachment.filename}
                                  className="h-8 w-8 shrink-0 rounded object-cover"
                                />
                              ) : (
                                <span className="shrink-0 text-lg" aria-hidden="true">
                                  📄
                                </span>
                              )}
                              <span className="min-w-0">
                                <span className="block truncate font-medium text-ink">
                                  {attachment.filename}
                                </span>
                                <span className="block text-xs text-ink-faint">
                                  {formatFileSize(attachment.size)}
                                </span>
                              </span>
                            </a>
                            <button
                              type="button"
                              disabled={saving}
                              onClick={() => void removeAttachment(attachment)}
                              title="Remove"
                              aria-label={`Remove ${attachment.filename}`}
                              className="shrink-0 rounded-md border border-black/10 px-2 text-sm text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink disabled:opacity-50"
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                        {pendingAttachments.map((pending) => (
                          <div
                            key={`pending-${pending.id}`}
                            className="flex items-center gap-2 rounded-md border border-black/10 px-3 py-2 text-sm text-ink-faint"
                          >
                            <span aria-hidden="true">⏳</span>
                            <span className="min-w-0 flex-1 truncate">{pending.filename}</span>
                            <span>Attaching…</span>
                          </div>
                        ))}
                        {attachments.length === 0 && pendingAttachments.length === 0 && (
                          <p className="text-sm text-ink-faint">Drag a file here, or</p>
                        )}
                        <button
                          type="button"
                          disabled={saving}
                          onClick={() => attachmentInputRef.current?.click()}
                          className="self-start rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:border-accent hover:bg-accent-tint disabled:opacity-50"
                        >
                          Add
                        </button>
                        <input
                          ref={attachmentInputRef}
                          type="file"
                          multiple
                          className="hidden"
                          onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0) {
                              void attachFiles(e.target.files);
                            }
                            e.target.value = '';
                          }}
                        />
                      </div>
                      {attachmentError && (
                        <p role="alert" className="mt-1 text-sm text-over">
                          {attachmentError}
                        </p>
                      )}
                    </div>
                  </div>

                  {/* Formatted, with the Markdown behind it one button away
                      ("Format a description, and edit its source", issue 160).
                      The editor is fetched behind this form rather than on the
                      cold-open path, which is why this is a component and not a
                      box: the states around that fetch are the bulk of it.
                      Fills whatever height the form has, rather than shrinking
                      to fit only what it holds (issue 480).
                      `min-h-40` rather than `min-h-0`: below `@lg`, this column
                      and the fields and files stacked around it (issue 480,
                      its own comment) compete for the same vertical space, and
                      a `flex-1 1 0%` column has nothing to shrink *from* - a
                      tall enough Attachments list took the sidebar down to its
                      own floor and left this at a genuine zero, rather than
                      merely short, with no way to reach the description at all
                      (found in review). A floor a couple of lines tall keeps
                      it visible; the wrapper above scrolls the rest into
                      view. */}
                  <div className="order-2 flex min-h-40 flex-1 flex-col @lg:order-none">
                    <DescriptionBox
                      resetKey={readingPicked}
                      value={draft.description}
                      onChange={(description) => setDraft({ ...draft, description })}
                      editable={!saving}
                    />
                  </div>
                </div>
              </div>
            )
          )}

          {tooLong && (
            <p role="alert" className="shrink-0 pt-3 text-sm text-over">
              {overCap === 'title'
                ? `A title is at most ${TITLE_LENGTH} characters.`
                : `A description is at most ${DESCRIPTION_LIMIT.toLocaleString()} characters.`}
            </p>
          )}
          {refusal && (
            <p role="alert" className="shrink-0 pt-3 text-sm text-over">
              {refusal}
            </p>
          )}

          <div className="flex shrink-0 items-center justify-between gap-2 pt-4">
            {/* What was captured and the item's own id, both out of the way
                until asked for, behind a footer button apiece rather than
                sitting inline on the form (issue 480). Gated on `draft`, not
                only on `item`: `item` reads from the snapshot the instant it
                arrives, a render before the boxes above are filled from it
                (`draft`'s own `useEffect`) - without this these two buttons
                would paint a beat before the rest of the form does (found in
                review). */}
            {/* Each `onOpenChange` reads `was` rather than assuming which one
                is open. A real press on the other one's trigger only closes
                this one - Radix answers that first press as a dismissal of
                whichever `Popover` is open rather than also that trigger's
                own open action, so switching takes two presses, not one -
                but a *programmatic* open and close (`fireEvent`, in
                `apps/web/tests/unit/components/ItemForm.test.tsx`'s own
                mutual-exclusion case) can still fire both from what looks
                like a single interaction, in either order. A plain
                `isOpen ? key : null` closes unconditionally and can stomp a
                same-tick open from the other one, leaving neither open
                (found in review, once written the naive way). */}
            <div className="flex items-center gap-1.5">
              {draft && item?.capturedMessage && (
                <FooterDisclosure
                  label="What was captured"
                  open={footerOpen === 'captured'}
                  onOpenChange={(isOpen) =>
                    setFooterOpen((was) => (isOpen ? 'captured' : was === 'captured' ? null : was))
                  }
                >
                  {/* A record, not a control: it can never be edited, so there
                      is no box to put a cursor in. */}
                  <p className="whitespace-pre-wrap text-sm text-ink-soft">{item.capturedMessage}</p>
                </FooterDisclosure>
              )}
              {draft && item && (
                // The item's own id, in full - what a rewrite-history row
                // identifies this item by, since its title is the very
                // thing a rewrite changes ("See the history of what Cockpit
                // proposed for the Inbox's items", issue 444).
                <FooterDisclosure
                  label="ID"
                  open={footerOpen === 'id'}
                  onOpenChange={(isOpen) =>
                    setFooterOpen((was) => (isOpen ? 'id' : was === 'id' ? null : was))
                  }
                >
                  <div className="flex items-center gap-2">
                    <code className="min-w-0 flex-1 truncate rounded bg-black/5 px-1.5 py-0.5 font-mono text-sm text-ink-soft">
                      {item.id}
                    </code>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(item.id).catch(() => {})}
                      className="shrink-0 rounded-md border border-black/10 px-2 py-1 text-sm text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-accent-deep"
                    >
                      Copy
                    </button>
                  </div>
                </FooterDisclosure>
              )}
            </div>

            <div className="flex gap-2">
              <Dialog.Close
                disabled={saving}
                className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
              >
                Cancel
              </Dialog.Close>
              <button
                type="button"
                disabled={!item || saving || tooLong}
                onClick={() => void save()}
                className="milled shrink-0 rounded-md bg-accent px-4 py-1.5 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

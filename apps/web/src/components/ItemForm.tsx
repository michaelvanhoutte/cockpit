import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useParams } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ACCOUNT_WIDE,
  DEFAULT_ITEM_FORM_PRESENTATION,
  MAX_ATTACHMENT_SIZE,
  TITLE_LENGTH,
  attachmentContentTypeSchema,
  connectorNamed,
  itemHasOpenReadings,
  itemLabel,
  prioritySchema,
  uuidv7,
  type Attachment,
  type Item,
  type ItemFormPresentation,
  type Priority,
} from '@cockpit/shared';
import { CommandRefused, attachmentUrl, uploadAttachment } from '../api/client';
import { snapshotQuery, useSendCommand, type CommandArgs } from '../api/queries';
import { DescriptionBox } from './DescriptionBox';
import { possibleDuplicatesOf } from '../duplicates';
import { dueComingFriday, dueSevenDaysOut, dueToday } from '../dueDateShortcuts';
import { filingsThatFile } from '../filing';
import { dayOf, shownOn } from '../filters';
import { typeOf, typesOffered } from '../itemTypes';
import {
  FIELDS,
  FIELD_NAMES,
  asStored,
  fieldCommand,
  type Draft,
  type Field,
} from '../itemFieldCommands';
import {
  useItemForm,
  useOpenItem,
  useQuietOpening,
  useReportDocked,
  useSettleQuietOpening,
} from '../itemForm';
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

const DESCRIPTION_LIMIT = 60_000;

/**
 * How long a typed due date sits still before it is committed, docked. A date
 * input announces every date the keystrokes so far happen to spell - typing a
 * year passes through 0002, 0020, 0202 - so committing on each change would
 * send, and offer an undo for, dates nobody meant. A picked date or a
 * shortcut is not typed and commits at once.
 */
export const DUE_DATE_SETTLES_MS = 600;

const CHANGED_ELSEWHERE = 'That item changed somewhere else. Copy what you want to keep and reopen it.';

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

/** Whether a paste landing here is a text box's to handle rather than the form's. */
function isATextBox(target: EventTarget | null): boolean {
  if (target instanceof HTMLTextAreaElement) return true;
  if (target instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'file', 'radio', 'reset', 'submit'].includes(target.type);
  }
  // Not `isContentEditable`, which jsdom leaves undefined.
  return target instanceof Element && target.closest('[contenteditable]:not([contenteditable="false"])') !== null;
}

/** A file chosen or dropped, still uploading - drawn as its own chip until it either lands or is refused. */
interface PendingAttachment {
  id: string;
  filename: string;
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
  typeId?: string | null;
  done?: boolean;
} {
  const changed: {
    title?: string;
    description?: string | null;
    priority?: Priority | null;
    dueDate?: string | null;
    typeId?: string | null;
    done?: boolean;
  } = {};
  const title = now.title.trim();
  const description = now.description.trim();

  if (title !== was.title.trim()) changed.title = title;
  if (description !== was.description.trim()) changed.description = description || null;
  // An enum, not text - nothing to trim, and no third state to collapse into.
  if (now.priority !== was.priority) changed.priority = now.priority;
  // A calendar date or null - nothing to trim either.
  if (now.dueDate !== was.dueDate) changed.dueDate = now.dueDate;
  // An id from the list the form offers, or the none it opened on - not text either.
  if (now.typeId !== was.typeId) changed.typeId = now.typeId;
  if (now.done !== was.done) changed.done = now.done;
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
  const { workspaceId } = useParams({ strict: false }) as {
    workspaceId?: string;
  };

  // Held here rather than in `TheForm`, so following a docked form to another
  // row (`key` below remounts it) keeps the presentation this open form was
  // locked to instead of re-reading a snapshot that may not yet carry a choice
  // just made - which drew the next item's form centered and modal. Forgotten
  // once no form is open, so the next one reads the account afresh.
  const [fixedPresentation, setFixedPresentation] = useState<ItemFormPresentation | null>(null);
  const open = Boolean(openItemId && workspaceId);
  useEffect(() => {
    if (!open) setFixedPresentation(null);
  }, [open]);
  // A write arriving after the form has closed - a refused Dock or Center
  // reverting itself - is dropped, as it was when this state died with the
  // form, rather than left to lock the next one to a stale choice.
  const stillOpen = useRef(open);
  stillOpen.current = open;
  const lockTo = useCallback((next: ItemFormPresentation | null) => {
    if (stillOpen.current) setFixedPresentation(next);
  }, []);

  if (!openItemId || !workspaceId) return null;
  // Keyed on the item, so going from one item's form straight to another's -
  // a pasted link, a step through history - starts the boxes again from the
  // item now named. Without it the draft is kept across the change and Save
  // writes the first item's text onto the second.
  return (
    <TheForm
      key={openItemId}
      itemId={openItemId}
      workspaceId={workspaceId}
      onClose={close}
      fixedPresentation={fixedPresentation}
      setFixedPresentation={lockTo}
    />
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
  fixedPresentation,
  setFixedPresentation,
}: {
  itemId: string;
  workspaceId: string;
  onClose: () => void;
  fixedPresentation: ItemFormPresentation | null;
  setFixedPresentation: (presentation: ItemFormPresentation | null) => void;
}) {
  const { data, isLoading, isFetching } = useQuery(snapshotQuery(workspaceId));
  const queryClient = useQueryClient();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const openItem = useOpenItem();
  const isQuietOpening = useQuietOpening();
  const [openedQuietly] = useState(() => isQuietOpening(itemId));
  /**
   * Whether this form was opened for a note captured a moment ago, and so is
   * expected to arrive with the re-read still in flight: the dock moves to a
   * capture the instant it lands, a beat before the snapshot carrying it. Held
   * only until that first read settles, so a later refetch of a note that
   * really is gone does not flicker back to "Opening…".
   */
  const [arriving, setArriving] = useState(openedQuietly);
  const settleQuietOpening = useSettleQuietOpening();
  useEffect(() => settleQuietOpening(), [settleQuietOpening]);
  const item = data?.items.find((candidate) => candidate.id === itemId);
  useEffect(() => {
    if (item || !isFetching) setArriving(false);
  }, [item, isFetching]);
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
  }, [data, fixedPresentation, setFixedPresentation]);
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
    // Docking is the moment "nothing is written until Save" stops being the
    // rule for this form, and there is no Save left to write what is already
    // typed. Only where it will really be docked - a screen too narrow for it
    // keeps Save and Cancel, and Cancel must still discard what it says it
    // does - and only once the choice has been accepted, so a refused one
    // leaves the centered form's typed text unwritten and its refusal standing.
    const dockedHere = next === 'docked' && screenWidth >= DESKTOP_MIN_WIDTH;
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
      if (dockedHere) void commitFields(FIELDS);
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
      await send({
        name: 'set_duplicate_settled',
        payload: { ...envelope(), settled: true },
      });
      offerToUndo({
        what: `"${itemLabel(other)}" is not a duplicate`,
        undo: () =>
          send({
            name: 'set_duplicate_settled',
            payload: { ...envelope(), settled: false },
          }),
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
  /** A file being dragged over the form anywhere a drop would attach it. */
  const [filesOver, setFilesOver] = useState(false);
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
        await uploadAttachment({
          itemId,
          workspaceId,
          attachmentId,
          commandId: uuidv7(),
          file,
        });
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
    if (accepted.length > 0)
      await queryClient.invalidateQueries({
        queryKey: ['snapshot', workspaceId],
      });
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

  /**
   * An image put into the description, attached to this Item like any other
   * file and answered with the address the text points at ("Embed an image
   * inline in an item's description", issue 442). Listed as "Attaching…"
   * while it uploads. Rejects with what to say under the editor's toolbar:
   * the server's own words for a refusal, and the file's name where the
   * request never got an answer.
   */
  const uploadImage = async (file: File): Promise<string> => {
    const attachmentId = uuidv7();
    setPendingAttachments((was) => [...was, { id: attachmentId, filename: file.name }]);
    try {
      await uploadAttachment({ itemId, workspaceId, attachmentId, commandId: uuidv7(), file });
    } catch (failure) {
      throw new Error(
        failure instanceof CommandRefused
          ? failure.message
          : `${file.name} could not be uploaded - the connection dropped.`,
      );
    } finally {
      setPendingAttachments((was) => was.filter((pending) => pending.id !== attachmentId));
    }
    void queryClient.invalidateQueries({ queryKey: ['snapshot', workspaceId] });
    return attachmentUrl(attachmentId);
  };

  /**
   * Whether this form is still the one on screen. An image that finishes
   * uploading after it has closed, or been swapped for another Item's, is
   * attached to the Item it was put into and changes no description: that
   * text is no longer anybody's.
   */
  const onScreen = useRef(true);
  useEffect(() => {
    onScreen.current = true;
    return () => {
      onScreen.current = false;
    };
  }, []);
  const descriptionCell = useRef<HTMLDivElement | null>(null);

  /** A file pasted into the form or dropped on it, outside the description text, is attached. */
  const takesFiles = (event: ReactDragEvent) => event.dataTransfer.types.includes('Files');
  const inTheDescriptionText = (target: EventTarget | null) =>
    target instanceof Element && target.closest('.description-prose') !== null;

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
  const dockResizingFrom = useRef<{
    startWidth: number;
    startX: number;
    latest: number;
    pointerId: number;
  } | null>(null);
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

  /**
   * Says how much of the right edge the docked form covers, so the bar that
   * offers to undo a field it has just written (`undo.tsx`) is centred in the
   * page left over rather than laid across the form's own footer - which
   * docked is where every such offer is about. It is also the room the shell
   * gives the form (`pages/Layout.tsx`), so it is written before the frame
   * is painted: a passive effect ran a frame after the form's own width
   * during a drag, and the page's edge trailed the form's.
   */
  useLayoutEffect(() => {
    if (!docked) return;
    const root = document.documentElement;
    root.style.setProperty('--docked-form-w', `${dockedWidthPx}px`);
    return () => {
      root.style.removeProperty('--docked-form-w');
    };
  }, [docked, dockedWidthPx]);

  /** What the boxes hold, and what they were filled from. */
  const [editing, setEditing] = useState<{ was: Draft; now: Draft } | null>(null);
  /**
   * The same value, held where an async commit can read what is in the boxes
   * *now* rather than what the render it started in closed over - updated in
   * the same breath as the state by `changeEditing`, never a render later.
   */
  const editingRef = useRef(editing);
  const changeEditing = (
    change: (held: { was: Draft; now: Draft } | null) => { was: Draft; now: Draft } | null,
  ) => {
    editingRef.current = change(editingRef.current);
    setEditing(editingRef.current);
  };
  const draft = editing?.now ?? null;
  const setDraft = (now: Draft) => changeEditing((held) => (held ? { ...held, now } : held));
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
   * Which tab is showing: the form itself, or the item's technical record -
   * what was captured, its id, when it was made. The record used to be two
   * buttons in the footer; a tab is where a person looks for it ("Give the
   * item's form more room, and put clutter out of the way", issue 480).
   * Starts on the form each time it opens.
   */
  const [tab, setTab] = useState<'item' | 'details'>('item');
  const formId = useId();

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
        // A type since deleted reads as none, the way the row draws it.
        typeId: typeOf(data?.itemTypes ?? [], item)?.id ?? null,
        done: !!item.completedAt,
      };
      changeEditing(() => ({ was: from, now: { ...from } }));
    }
  }, [item, editing, data?.itemTypes]);

  /** Worked out only while Details is showing: it walks every filter against every item, which nothing else on the form needs on a keystroke. */
  const shownOnNames =
    tab === 'details' && item
      ? shownOn(
          item,
          data?.items ?? [],
          data?.filings ?? [],
          data?.panels ?? [],
          data?.dashboards ?? [],
          data?.itemTypes ?? [],
          dayOf(new Date()),
        )
      : [];

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
      what: Field,
      change: CommandArgs,
    ): Promise<boolean> => {
      const answer = await send(change);
      if (!answer.applied) return false;
      changeEditing((held) =>
        held ? { ...held, was: { ...held.was, [what]: editing.now[what] } } : held,
      );
      return true;
    };

    try {
      for (const field of FIELDS) {
        const value = changed[field];
        if (value === undefined) continue;
        if (!(await landed(field, fieldCommand(field, envelope(), value)))) {
          setRefusal(CHANGED_ELSEWHERE);
          return;
        }
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

  /**
   * Docked, a field is written when it is done being edited rather than all at
   * once behind Save ("Save a docked item's fields as you finish them, not
   * behind one Save button", issue 483): a form meant to stay open for a while
   * has no session boundary for Save to be, and would sit holding an hour of
   * unsaved edits. The same four commands `save` sends, one per field.
   *
   * **Sent one at a time, each reading the boxes as they are when its turn
   * comes.** A blur and the next blur can land a round trip apart, and a
   * second commit started against a baseline the first has not yet moved would
   * send the same field twice.
   *
   * **A field that has not moved sends nothing**, the same `whatChanged`
   * reading `save` uses, so leaving a box unchanged, or one field's commit
   * finding another already sent, is a no-op rather than a rewrite.
   *
   * **One offer to undo per gesture**, however many fields it committed: a
   * reading chosen fills two boxes and is one thing to take back. The undo
   * puts the boxes back with the item, so the form never claims a value the
   * item no longer has.
   */
  const inTurn = useRef<Promise<void>>(Promise.resolve());
  /**
   * How many undos have been pressed. A commit that was asked for before one
   * was pressed and finishes after it must not offer to undo: the bar would
   * be handed an inverse to a value the person has just gone back past.
   */
  const undoneCount = useRef(0);
  /**
   * Fields a refused write left unwritten. The refusal stays up until every
   * one of them is written or put back by hand, so an unrelated field's
   * write succeeding cannot wipe out a message that is still true.
   */
  const unwritten = useRef(new Set<Field>());
  /**
   * Whether a close has already been refused for what is unwritten now, so the
   * next one may leave anyway. Rearmed whenever `unwritten` drains, so each
   * refusal gets its own warning before it can be overridden.
   */
  const closeRefused = useRef(false);
  const commitFields = (fields: readonly Field[]): Promise<void> => {
    const undoneAtCall = undoneCount.current;
    const turn = inTurn.current.then(async () => {
      const held = editingRef.current;
      if (!held) return;
      const changed = whatChanged(held.was, held.now);
      // One put back by hand is no longer unwritten, so nothing is left to refuse.
      const wasUnwritten = unwritten.current.size;
      for (const field of unwritten.current) {
        if (changed[field] === undefined) unwritten.current.delete(field);
      }
      if (wasUnwritten > 0 && unwritten.current.size === 0) {
        closeRefused.current = false;
        setRefusal(null);
      }
      const pending = fields.filter((field) => changed[field] !== undefined);
      if (pending.length === 0) return;
      const envelope = () => ({
        commandId: uuidv7(),
        issuedAt: new Date().toISOString(),
        workspaceId,
        itemId,
      });
      const committed: { field: Field; before: Draft[Field] }[] = [];
      let stopped: string | null = null;
      try {
        for (const field of pending) {
          // What would be written, not what is merely held: an over-long text
          // is refused where it stands (`tooLong`, below) and left in its box.
          const value = asStored(held.now, field);
          if (
            typeof value === 'string' &&
            value.length > (field === 'title' ? TITLE_LENGTH : DESCRIPTION_LIMIT)
          ) {
            continue;
          }
          const answer = await send(fieldCommand(field, envelope(), value));
          if (!answer.applied) {
            stopped = CHANGED_ELSEWHERE;
            break;
          }
          committed.push({ field, before: held.was[field] });
          unwritten.current.delete(field);
          changeEditing((now) =>
            now ? { ...now, was: { ...now.was, [field]: held.now[field] } } : now,
          );
        }
      } catch (failure) {
        stopped = failure instanceof Error ? failure.message : 'That could not be saved';
      }
      if (stopped !== null) {
        for (const field of pending) {
          if (!committed.some((done) => done.field === field)) unwritten.current.add(field);
        }
        setRefusal(stopped);
      } else if (unwritten.current.size === 0) {
        closeRefused.current = false;
        setRefusal(null);
      }
      // A type cannot be put back to none - nothing sends that - so an item that
      // had none has nothing to undo to.
      const undoable = committed.filter(({ field, before }) => !(field === 'typeId' && before === null));
      if (undoable.length === 0 || undoneCount.current !== undoneAtCall) return;
      offerToUndo({
        what: `Changed the ${undoable.map(({ field }) => FIELD_NAMES[field]).join(' and the ')}`,
        // Queued behind any write still in flight, for the reason the writes
        // are queued behind each other: run alongside one, it could land first
        // and be overwritten by a value the person had already gone back past.
        undo: () => {
          undoneCount.current += 1;
          const run = inTurn.current.then(async () => {
            for (const { field, before } of [...undoable].reverse()) {
              const back = asStored({ ...held.now, [field]: before }, field);
              const answer = await send(fieldCommand(field, envelope(), back));
              if (!answer.applied) throw new Error(CHANGED_ELSEWHERE);
              changeEditing((now) =>
                now
                  ? {
                      was: { ...now.was, [field]: before },
                      now: { ...now.now, [field]: before },
                    }
                  : now,
              );
              // The editor owns its document once made, so a description put
              // back from outside needs it rebuilt (`readingPicked`).
              if (field === 'description') setReadingPicked((was) => was + 1);
            }
          });
          inTurn.current = run.then(
            () => {},
            () => {},
          );
          return run;
        },
      });
    });
    inTurn.current = turn;
    return turn;
  };

  /**
   * The due date's own clock, docked: a typed date is committed once it has
   * sat still (`DUE_DATE_SETTLES_MS`), or when the field is left, whichever is
   * first.
   */
  const dueDateSettles = useRef<ReturnType<typeof setTimeout> | null>(null);
  const settleDueDate = () => {
    if (dueDateSettles.current) clearTimeout(dueDateSettles.current);
    dueDateSettles.current = null;
    return commitFields(['dueDate']);
  };

  /**
   * Closing a docked form keeps what is in it, by whatever route it closes: the
   * close button, Escape, the back button, another item opening in its place.
   * None of those blur a box that still holds the cursor, so this is what
   * stops them discarding it. Centered, closing discards, as it always has.
   * Read through refs because a cleanup only sees the render it was made in.
   *
   * **The close button and Escape wait for the write, and stay open on a
   * refusal**, for the reason the batched Save does: closing is the one case
   * where a write that did not land would throw away what was typed, with
   * nobody left to tell. The second press leaves anyway, so a form that can
   * never write - offline, an item since deleted - is not a trap. The routes
   * that are not ours to hold back (the back button, another item opening)
   * write on the way out and cannot wait.
   */
  const closing = useRef(false);
  const closeDocked = async () => {
    // A press while one is still waiting on its write is the same press, not
    // the second one that leaves: that has to come after the refusal is seen.
    if (closing.current) return;
    closing.current = true;
    try {
      await commitFields(FIELDS);
      if (unwritten.current.size > 0 && !closeRefused.current) {
        closeRefused.current = true;
        setRefusal((was) => `${was ?? 'That could not be saved.'} Close again to leave without it.`);
        return;
      }
      onClose();
    } finally {
      closing.current = false;
    }
  };
  // Tells the rows a plain click now follows this form ("Let the item's form
  // dock to the side of the screen instead of opening as a dialog", issue
  // 481). Cleared on unmount, so a form that closes - or is replaced by
  // another Item's - leaves nothing claiming a dock; the replacement reports
  // again in the same commit.
  const reportDocked = useReportDocked();
  useEffect(() => {
    reportDocked(docked);
    return () => reportDocked(false);
  }, [docked, reportDocked]);
  const dockedNow = useRef(docked);
  dockedNow.current = docked;
  const commitNow = useRef(commitFields);
  commitNow.current = commitFields;
  useEffect(
    () => () => {
      if (dueDateSettles.current) clearTimeout(dueDateSettles.current);
      if (dockedNow.current) void commitNow.current(FIELDS);
    },
    [],
  );

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
        if (stillOpen || saving) return;
        if (docked) void closeDocked();
        else onClose();
      }}
    >
      <Dialog.Portal>
        {/* No scrim while docked - the page behind stays visible as well as
            clickable, which a dimming overlay over it would contradict. */}
        {!docked && <Dialog.Overlay className="fixed inset-0 bg-black/30" />}
        <Dialog.Content
          ref={setContentEl}
          aria-describedby={undefined}
          onOpenAutoFocus={(event) => {
            // A switch that keeps the keyboard where it is (`show`, `keepFocus`).
            if (openedQuietly && docked) event.preventDefault();
          }}
          onInteractOutside={(event) => {
            // Non-modal already keeps a press on the page behind from
            // reaching it; this stops Radix reading that same press as a
            // request to close the *form*, which is the one part "non-modal"
            // does not already cover on its own.
            if (docked) event.preventDefault();
          }}
          // Files dragged anywhere over the form are the form's, never left to
          // the browser - which would open the file in Cockpit's place. Outside
          // the description text a drop attaches them; inside it, the editor
          // has already put an image in or said why not.
          onDragOver={(event) => {
            if (!takesFiles(event)) return;
            event.preventDefault();
            setFilesOver(!saving && !inTheDescriptionText(event.target));
          }}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFilesOver(false);
          }}
          onDrop={(event) => {
            if (!takesFiles(event)) return;
            event.preventDefault();
            setFilesOver(false);
            if (saving || !item || inTheDescriptionText(event.target)) return;
            if (event.dataTransfer.files.length > 0) void attachFiles(Array.from(event.dataTransfer.files));
          }}
          // Pasted with the cursor in no text box, a file is attached; in one,
          // the paste is that box's.
          onPaste={(event) => {
            const files = Array.from(event.clipboardData.files);
            if (files.length === 0 || saving || !item || isATextBox(event.target)) return;
            event.preventDefault();
            void attachFiles(files);
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
          className={`${
            docked
              ? '@container fixed right-0 top-0 flex h-full flex-col overflow-hidden rounded-l-lg border border-black/10 bg-surface p-5 shadow-lg'
              : '@container fixed left-1/2 top-1/2 flex h-[var(--item-form-h)] max-h-[var(--item-form-max-h)] min-h-[min(18rem,var(--item-form-max-h))] w-[var(--item-form-w)] max-w-[var(--item-form-max-w)] min-w-[min(20rem,var(--item-form-max-w))] -translate-x-1/2 -translate-y-1/2 flex-col resize-none overflow-hidden rounded-lg border border-black/10 bg-surface p-5 shadow-lg sm:resize'
          }${filesOver ? ' ring-2 ring-accent' : ''}`}
          style={
            docked
              ? { width: `${dockedWidthPx}px` }
              : remembered
                ? {
                    width: `${remembered.width}px`,
                    height: `${remembered.height}px`,
                  }
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
              {isLoading || (arriving && isFetching) ? 'Opening…' : 'That item is not here any more.'}
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
                    autoFocus={!(openedQuietly && docked)}
                    // Both boxes are closed while a save is in flight, for the
                    // reason Cancel and Save are: what is sent is worked out
                    // before the round trip, so a keystroke landing during it
                    // would be typed into a draft nobody is going to read and
                    // lost when the form closes.
                    disabled={saving}
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    onBlur={() => {
                      if (docked) void commitFields(['title']);
                    }}
                    className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                  />
                </label>

                {/* Where this came from, and - where the source gave a link -
                    the way back to it ("Open an Item at its source", issue
                    487): the same test the row and its menu apply. Above the
                    tabs so it shows on both. */}
                {item.source !== 'internal' && (
                  <p className="mt-2 shrink-0 text-xs text-ink-faint">
                    From {connectorNamed(item.source)}
                    {item.sender ? ` - ${item.sender}` : ''}
                    {atSource && (
                      <>
                        {' · '}
                        <a
                          href={atSource.link}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-accent-deep underline"
                        >
                          Open in {atSource.name}
                        </a>
                      </>
                    )}
                  </p>
                )}

                {/* Two tabs, the form and its technical record ("Give the
                    item's form more room, and put clutter out of the way",
                    issue 480). The form's panel stays mounted while the record
                    shows, only hidden, so the editor and whatever is half
                    typed are still there when the person comes back. */}
                <div
                  role="tablist"
                  aria-label="Item"
                  className="mt-3 flex shrink-0 gap-4 border-b border-black/10"
                  onKeyDown={(e) => {
                    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
                    e.preventDefault();
                    const next = tab === 'item' ? 'details' : 'item';
                    setTab(next);
                    document.getElementById(`${formId}-${next}-tab`)?.focus();
                  }}
                >
                  {(['item', 'details'] as const).map((which) => (
                    <button
                      key={which}
                      id={`${formId}-${which}-tab`}
                      type="button"
                      role="tab"
                      aria-selected={tab === which}
                      aria-controls={tab === which ? `${formId}-${which}` : undefined}
                      tabIndex={tab === which ? 0 : -1}
                      onClick={() => setTab(which)}
                      className={`-mb-px border-b-2 px-1 pb-1.5 text-sm font-medium ${
                        tab === which
                          ? 'border-accent text-ink'
                          : 'border-transparent text-ink-faint hover:text-ink'
                      }`}
                    >
                      {which === 'item' ? 'Item' : 'Details'}
                    </button>
                  ))}
                </div>

                <div
                  role="tabpanel"
                  id={`${formId}-item`}
                  aria-labelledby={`${formId}-item-tab`}
                  className={tab === 'item' ? 'flex min-h-0 flex-1 flex-col' : 'hidden'}
                >
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
                                  // A choice, not typing: nothing else will
                                  // blur to commit it, so docked it is written
                                  // now, as one thing to undo.
                                  if (docked) void commitFields(['title', 'description']);
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
                  <div className="mt-4 flex min-h-0 flex-1 flex-col">
                    {/* **Three cells written in the order a person reads them -
                      the short fields, the description, then the files - which
                      is also the order Tab and a screen reader take, so what is
                      drawn and what is announced never disagree.** Stacked they
                      are one column, the description taking whatever height is
                      left above a floor a couple of lines tall (a track of its
                      own, since a `flex-1 1 0%` box has nothing to shrink *from*
                      and a long Attachments list once left it at a genuine zero
                      - found in review, issue 480). From `@lg` the fields and
                      the files are the left column and the description spans
                      both rows beside them; the files cell scrolls on its own, so
                      a full Attachments list still reaches its "Add" button
                      rather than being clipped by the dialog's `overflow-hidden`
                      (`-mx-1 … px-1` keeps that scroll from clipping the
                      buttons' `focus:ring-2`). */}
                    <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-[auto_minmax(10rem,1fr)_auto] gap-4 @lg:grid-cols-[18rem_minmax(0,1fr)] @lg:grid-rows-[auto_minmax(0,1fr)]">
                      <div className="flex flex-col gap-3 @lg:col-start-1 @lg:row-start-1">
                      {/* Type and status beside each other above the rest of the short fields (issue 528). */}
                      <div className="flex gap-3">
                        <label className="block min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Type
                          <select
                            disabled={saving}
                            value={draft.typeId ?? ''}
                            onChange={(e) => {
                              // Nothing sets a type to none, so an empty pick is not a change.
                              if (!e.target.value) return;
                              setDraft({ ...draft, typeId: e.target.value });
                              if (docked) void commitFields(['typeId']);
                            }}
                            className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                          >
                            {/* Only while the item has none: nothing sets a type to none, so once one is picked it is not offered again. */}
                            {draft.typeId === null && <option value="">No type</option>}
                            {typesOffered(data?.itemTypes ?? [], data?.items ?? []).map((type) => (
                              <option key={type.id} value={type.id}>
                                {type.name}
                              </option>
                            ))}
                          </select>
                        </label>
                        <label className="block min-w-0 flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Status
                          <select
                            disabled={saving}
                            value={draft.done ? 'done' : 'open'}
                            onChange={(e) => {
                              setDraft({ ...draft, done: e.target.value === 'done' });
                              if (docked) void commitFields(['done']);
                            }}
                            className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                          >
                            <option value="open">To deal with</option>
                            <option value="done">Done</option>
                          </select>
                        </label>
                      </div>
                      {/* Priority and due date share a row (issue 480). */}
                      <div className="flex gap-3">
                        <label className="block flex-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Priority
                          <select
                            disabled={saving}
                            value={draft.priority ?? ''}
                            onChange={(e) => {
                              setDraft({
                                ...draft,
                                priority: (e.target.value || null) as Priority | null,
                              });
                              if (docked) void commitFields(['priority']);
                            }}
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
                              onChange={(e) => {
                                setDraft({
                                  ...draft,
                                  dueDate: e.target.value || null,
                                });
                                if (!docked) return;
                                if (dueDateSettles.current) clearTimeout(dueDateSettles.current);
                                // Empty settles like any other value: a native date
                                // input also reports '' while one segment of a
                                // complete date is being retyped, which is not a
                                // clear.
                                dueDateSettles.current = setTimeout(
                                  () => void settleDueDate(),
                                  DUE_DATE_SETTLES_MS,
                                );
                              }}
                              onBlur={() => {
                                if (docked) void settleDueDate();
                              }}
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
                                onClick={() => {
                                  setDraft({
                                    ...draft,
                                    dueDate: dueDate(new Date()),
                                  });
                                  if (docked) void settleDueDate();
                                }}
                                className="rounded-md border border-black/10 px-2 py-0.5 text-xs text-ink-faint hover:border-accent hover:bg-accent-tint hover:text-ink disabled:opacity-50"
                              >
                                {label}
                              </button>
                            ))}
                          </div>
                        </div>
                      </div>
                      </div>

                      {/* Formatted, with the Markdown behind it one button away
                        ("Format a description, and edit its source", issue 160).
                        The editor is fetched behind this form rather than on the
                        cold-open path, which is why this is a component and not a
                        box: the states around that fetch are the bulk of it.
                        Fills whatever height the form has, rather than shrinking
                        to fit only what it holds (issue 480). */}
                      <div
                        ref={descriptionCell}
                        className="flex min-h-0 flex-col @lg:col-start-2 @lg:row-span-2 @lg:row-start-1"
                        // Left for something outside the description - the Source
                        // toggle and the editor trade the cursor between them
                        // without leaving it.
                        onBlur={(e) => {
                          if (docked && !e.currentTarget.contains(e.relatedTarget)) {
                            void commitFields(['description']);
                          }
                        }}
                      >
                        <DescriptionBox
                          resetKey={readingPicked}
                          value={draft.description}
                          onChange={(description) => {
                            if (!onScreen.current) return;
                            setDraft({ ...draft, description });
                            // Nothing but an image landing changes the text
                            // with the cursor elsewhere. Docked, that is
                            // written as leaving the description would have.
                            if (docked && !descriptionCell.current?.contains(document.activeElement)) {
                              void commitFields(['description']);
                            }
                          }}
                          uploadImage={uploadImage}
                          editable={!saving}
                        />
                      </div>

                      {/* A screenshot, a scan or a clip the note is really about
                        ("Attach a file to an item", issue 441) - added by button
                        or drag-and-drop, drawn as a chip, opened or downloaded by
                        a click on it. */}
                      <div className="@lg:col-start-1 @lg:row-start-2 @lg:-mx-1 @lg:min-h-0 @lg:overflow-y-auto @lg:px-1">
                        <p className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Attachments
                        </p>
                        {/* Dropped on, a file is attached by the form's own
                            drop, which takes one anywhere outside the
                            description text (issue 442). */}
                        <div
                          className={`mt-1 flex flex-col gap-1.5 rounded-md border border-dashed px-3 py-2 ${
                            filesOver ? 'border-accent bg-accent-tint' : 'border-black/10'
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
                            aria-label="Files to attach"
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
                  </div>
                </div>

                {tab === 'details' && (
                  <div
                    role="tabpanel"
                    id={`${formId}-details`}
                    aria-labelledby={`${formId}-details-tab`}
                    className="mt-4 min-h-0 flex-1 overflow-y-auto"
                  >
                    <dl className="flex flex-col gap-4 text-sm">
                      {item.capturedMessage && (
                        <div>
                          <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                            Captured message
                          </dt>
                          {/* A record, not a control: it can never be edited,
                              so there is no box to put a cursor in. */}
                          <dd className="mt-1 whitespace-pre-wrap text-ink-soft">
                            {item.capturedMessage}
                          </dd>
                        </div>
                      )}
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Source
                        </dt>
                        <dd className="mt-1 text-ink-soft">
                          {item.source === 'internal' ? 'Cockpit' : connectorNamed(item.source)}
                          {item.sender ? ` - ${item.sender}` : ''}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          ID
                        </dt>
                        {/* The item's own id, in full - what a rewrite-history
                            row identifies this item by, since its title is the
                            very thing a rewrite changes ("See the history of
                            what Cockpit proposed for the Inbox's items", issue
                            444). */}
                        <dd className="mt-1 flex items-center gap-2">
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
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Created
                        </dt>
                        <dd className="mt-1 text-ink-soft">
                          {new Date(item.createdAt).toLocaleString()}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Last changed
                        </dt>
                        <dd className="mt-1 text-ink-soft">
                          {new Date(item.updatedAt).toLocaleString()}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-xs font-semibold uppercase tracking-wide text-ink-faint">
                          Shown on
                        </dt>
                        {/* A record, not a control: where an item is shown is
                            decided by filing it and by the filters, not here. */}
                        <dd className="mt-1 text-ink-soft">
                          {shownOnNames === null ? (
                            'Not shown on any panel while it is done.'
                          ) : (
                            <ul className="flex flex-col gap-0.5">
                              {shownOnNames.map((name) => (
                                <li key={name}>{name}</li>
                              ))}
                            </ul>
                          )}
                        </dd>
                      </div>
                    </dl>
                  </div>
                )}
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

          <div className="flex shrink-0 items-center justify-end gap-2 pt-4">
            {docked ? (
              // Nothing to save and nothing to discard: each field was written
              // as it was left (`commitFields`), and closing keeps whatever is
              // still in a box.
              <Dialog.Close className="shrink-0 rounded-md border border-black/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
                Close
              </Dialog.Close>
            ) : (
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
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

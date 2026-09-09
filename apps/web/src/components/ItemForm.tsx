import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { TITLE_LENGTH, itemLabel, uuidv7, type Item } from '@cockpit/shared';
import { snapshotQuery, useSendCommand, type CommandArgs } from '../api/queries';
import { DescriptionBox } from './DescriptionBox';
import { useItemForm } from '../itemForm';
import { browserStore } from '../lastVisited';
import { rememberItemFormSize, rememberedItemFormSize, type Size } from '../itemFormSize';

/** What the two boxes hold, before anything is sent. */
interface Draft {
  title: string;
  description: string;
}

const DESCRIPTION_LIMIT = 60_000;

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
export function whatChanged(was: Draft, now: Draft): { title?: string; description?: string | null } {
  const changed: { title?: string; description?: string | null } = {};
  const title = now.title.trim();
  const description = now.description.trim();

  if (title !== was.title.trim()) changed.title = title;
  if (description !== was.description.trim()) changed.description = description || null;
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
  const send = useSendCommand();
  const item = data?.items.find((candidate) => candidate.id === itemId);

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
   * `TheForm` and mounts this one within a single React update - and
   * `rememberCurrentSize`'s write (below) runs from that outgoing instance's
   * own layout-effect cleanup, which fires during the commit React makes for
   * that same update, strictly after every component's *render* has already
   * happened. A lazy initializer runs at render, before any of that commit
   * has taken place, so it would read what was remembered *before* the item
   * being swapped away from had a chance to write what it was just dragged
   * to. A layout effect runs during the commit itself, after the outgoing
   * instance's cleanup - late enough to see it.
   */
  const [remembered, setRemembered] = useState<Size | null>(null);
  const appliedRemembered = useRef(false);
  const openedAt = useRef<Size | null>(null);
  useLayoutEffect(() => {
    if (!contentEl) return;
    if (!appliedRemembered.current) {
      appliedRemembered.current = true;
      const stored = rememberedItemFormSize(browserStore());
      // Applying it is a re-render - measuring below has to wait for that
      // render to land, which happens by this same effect running again
      // once `remembered` itself has changed.
      if (stored) {
        setRemembered(stored);
        return;
      }
    }
    if (openedAt.current) return;
    const box = contentEl.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) {
      openedAt.current = { width: Math.round(box.width), height: Math.round(box.height) };
    }
  }, [contentEl, remembered]);
  /**
   * Whether this open has seen a drag on the handle at all - the gate on
   * remembering anything, below.
   *
   * **A `mousedown` inside the handle's own corner, and only that.** There is
   * no `resizeend` event, and a native resize does not reliably deliver the
   * `mouseup` it ends on either, so this does not try to measure a finished
   * drag - it only asks whether one *started*, which a `mousedown` answers
   * for certain: the grip is drawn inside the box's own padding, over
   * nothing else, so a press landing there has this element as its target
   * and nowhere close to the target a press on Cancel or Save would have.
   * `sm:resize` (below) is the only thing that makes the handle interactive
   * at all, which is why the width check matches its own breakpoint.
   */
  const dragged = useRef(false);
  useEffect(() => {
    if (!contentEl) return;
    const onDown = (e: MouseEvent) => {
      if (e.target !== contentEl || window.innerWidth < 640) return;
      const box = contentEl.getBoundingClientRect();
      if (
        e.clientX >= box.right - RESIZE_CORNER &&
        e.clientX <= box.right &&
        e.clientY >= box.bottom - RESIZE_CORNER &&
        e.clientY <= box.bottom
      ) {
        dragged.current = true;
      }
    };
    contentEl.addEventListener('mousedown', onDown);
    return () => contentEl.removeEventListener('mousedown', onDown);
  }, [contentEl]);
  /**
   * Remembers the size the box is measured at on the way out - one axis at a
   * time, and only where a drag actually happened this open.
   *
   * **Nothing is written unless `dragged` is true.** `max-w-`/`max-h-`
   * (below) track the screen live for as long as the dialog is open, so the
   * box the browser is showing can differ from what it opened at - or from
   * what was remembered - with no drag at all, purely from the window
   * changing shape under it. Gating on a real `mousedown` in the handle is
   * what tells that apart from a drag, rather than asking whether the size
   * merely *differs* from something: a live reclamp interleaved with a real
   * drag would otherwise either erase the drag (if the reclamp is read as
   * the new baseline) or invent one out of nothing (if it is not).
   *
   * **Compared per axis against how it opened, not written as one pair.** A
   * viewport that clamps only one axis (`--item-form-h` starts clamping
   * under about 736px, routine on a laptop) means `openedAt` can already
   * hold a clamped value on an axis nobody touched. Dragging only the other
   * axis must not carry that clamp back into storage as if it were chosen -
   * an axis whose current measurement still matches `openedAt` keeps
   * whatever was remembered for it before; only the axis that actually moved
   * is written from what the box measures now.
   *
   * **A cleanup, not a call from Cancel or Save.** A cleanup runs regardless
   * of *why* the dialog goes - Cancel, Save, Escape, a press outside, or a
   * straight swap from one item's form to another's (`ItemForm`,
   * `key={openItemId}`) skips both of those and unmounts this component
   * directly, which is the one path a call hung off Cancel or Save would
   * have missed a drag on.
   *
   * **A layout effect, not a plain one.** A plain effect's cleanup for a
   * component being unmounted runs after the DOM has already been mutated -
   * the box is detached by then, and a detached element measures as
   * `0`×`0` - so every close read nothing and remembered nothing. A layout
   * effect's cleanup runs synchronously, before that removal, while the box
   * is still exactly what was last on screen.
   */
  useLayoutEffect(() => {
    return () => {
      if (!dragged.current) return;
      const box = contentEl?.getBoundingClientRect();
      if (!box || box.width <= 0 || box.height <= 0) return;
      const now: Size = { width: Math.round(box.width), height: Math.round(box.height) };
      const was = openedAt.current;
      rememberItemFormSize(browserStore(), {
        width: was && now.width === was.width ? (remembered?.width ?? now.width) : now.width,
        height: was && now.height === was.height ? (remembered?.height ?? now.height) : now.height,
      });
    };
  }, [contentEl, remembered]);

  /** What the boxes hold, and what they were filled from. */
  const [editing, setEditing] = useState<{ was: Draft; now: Draft } | null>(null);
  const draft = editing?.now ?? null;
  const setDraft = (now: Draft) => setEditing((held) => (held ? { ...held, now } : held));
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

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
      const from = { title: item.title, description: item.description ?? '' };
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
      what: 'title' | 'description',
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
      onOpenChange={(stillOpen) => {
        // Escape, the close control and a press outside all land here, and all
        // three discard: Cancel means cancel (functional definition, "Editing
        // more than one field at a time"). Save is what writes, and it is
        // sitting in the form unpressed.
        if (!stillOpen && !saving) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/30" />
        <Dialog.Content
          ref={setContentEl}
          aria-describedby={undefined}
          // An explicit size rather than one that grows and shrinks with what
          // is inside it - the editor's async-loading placeholder is a fixed
          // 12 rows, usually taller than the real editor once it swaps in, so
          // sizing to content shrank the box the instant it arrived ("Fix the
          // item form's resize jank, and let it be resized", issue 295). A
          // remembered size starts the box here as `width`/`height`; with
          // nothing remembered it opens at `--item-form-w`/`-h` (styles.css),
          // the same formula that bounds it as `max-w-`/`max-h-` below - still
          // the tallest dialog in the app, so on a phone it fills the screen.
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
          // `--item-form-h`'s own comment gives: on a screen too short for
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
          className="fixed left-1/2 top-1/2 flex h-[var(--item-form-h)] max-h-[var(--item-form-h)] min-h-[min(18rem,var(--item-form-h))] w-[var(--item-form-w)] max-w-[var(--item-form-w)] min-w-[min(20rem,var(--item-form-w))] -translate-x-1/2 -translate-y-1/2 flex-col resize-none overflow-hidden rounded-lg border border-black/10 bg-surface p-5 shadow-lg sm:resize"
          style={
            remembered ? { width: `${remembered.width}px`, height: `${remembered.height}px` } : undefined
          }
        >
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
              <div className="-mx-1 mt-4 min-h-0 flex-1 overflow-y-auto px-1">
                <label className="block text-xs font-semibold uppercase tracking-wide text-ink-faint">
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

                {/* Formatted, with the Markdown behind it one button away
                    ("Format a description, and edit its source", issue 160).
                    The editor is fetched behind this form rather than on the
                    cold-open path, which is why this is a component and not a
                    box: the states around that fetch are the bulk of it. */}
                <DescriptionBox
                  value={draft.description}
                  onChange={(description) => setDraft({ ...draft, description })}
                  editable={!saving}
                />

                {/* What was captured, out of the way until it is looked for. It
                    can never be edited, so it is a record rather than a
                    control - and a `details` because the browser already knows
                    how to open one from a keyboard. */}
                {item.capturedMessage && (
                  <details className="mt-4">
                    <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wide text-ink-faint">
                      What was captured
                    </summary>
                    <p className="mt-1 whitespace-pre-wrap rounded-md bg-black/5 px-3 py-2 text-sm text-ink-soft">
                      {item.capturedMessage}
                    </p>
                  </details>
                )}
              </div>
            )
          )}

          {tooLong && (
            <p role="alert" className="pt-3 text-sm text-over">
              {overCap === 'title'
                ? `A title is at most ${TITLE_LENGTH} characters.`
                : `A description is at most ${DESCRIPTION_LIMIT.toLocaleString()} characters.`}
            </p>
          )}
          {refusal && (
            <p role="alert" className="pt-3 text-sm text-over">
              {refusal}
            </p>
          )}

          <div className="flex justify-end gap-2 pt-4">
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
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

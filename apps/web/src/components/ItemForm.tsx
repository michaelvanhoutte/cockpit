import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useParams } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { itemLabel, uuidv7, type Item } from '@cockpit/shared';
import { snapshotQuery, useSendCommand, type CommandArgs } from '../api/queries';
import { useItemForm } from '../itemForm';

/** What the two boxes hold, before anything is sent. */
interface Draft {
  title: string;
  description: string;
}

const TITLE_LIMIT = 200;
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
    (changing.title !== undefined && changing.title.length > TITLE_LIMIT
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
          aria-describedby={undefined}
          className="fixed left-1/2 top-1/2 flex max-h-[min(44rem,calc(100vh-2rem))] w-[min(42rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-black/10 bg-surface p-5 shadow-lg"
        >
          {/* The label the row was showing, so the form says which item is open.
              "Item" alone over two empty boxes says nothing at all - and the
              boxes are empty exactly when the item has only a captured message,
              which is the case that needs it most. Read from the stored item
              rather than from the boxes, so it holds still while a new title is
              being typed under it. */}
          <Dialog.Title className="truncate text-base font-semibold">
            {item ? itemLabel(item) || 'Item' : 'Item'}
          </Dialog.Title>

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
                    value={draft.title}
                    onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    className="mt-1 w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                  />
                </label>

                <label className="mt-4 block text-xs font-semibold uppercase tracking-wide text-ink-faint">
                  Description
                  <textarea
                    rows={12}
                    value={draft.description}
                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    className="mt-1 w-full resize-y rounded-md border border-black/10 bg-white px-3 py-2 text-sm font-normal normal-case tracking-normal text-ink outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                  />
                </label>

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
                ? `A title is at most ${TITLE_LIMIT} characters.`
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

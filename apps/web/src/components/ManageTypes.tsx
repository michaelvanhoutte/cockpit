import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE, ITEM_TYPE_COLORS, uuidv7 } from '@cockpit/shared';
import type { ItemType, ItemTypeList } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import {
  itemTypesQuery,
  snapshotQuery,
  useCommand,
  useSendCommand,
  workspacesQuery,
} from '../api/queries';
import { movedBy, movedTo } from '../reorder';
import { DeleteQuestion } from './DeleteQuestion';
import { LoadFailure } from './LoadFailure';
import { CloseWindow, ManageWindow } from './ManageWindow';
import { RowMenu } from './Menu';
import { RowForm, wasOnTheRow } from './RowForm';

/**
 * Where types are managed ("Manage the types, and put them in the order you
 * want", issue 156). It lists them, makes them, renames them, recolours them,
 * puts them in the order capture offers them in, and deletes them.
 *
 * **A sibling of the workspaces window, and the same window in every respect
 * that matters**: a box above the list makes one, a row keeps its shape, what
 * can be done to a type is in its own menu, its name and its colour are edited
 * together on a form over it (`components/RowForm.tsx`), deleting asks in a
 * dialog, and a type is moved two ways that are one change. It is a list of its
 * own rather than a section of a window about something else, which is what
 * would make it hard to find.
 *
 * **The box is where making one moved to** ("Make a type where types are
 * managed, not while capturing", issue 203). A type used to come into existence
 * by being named at capture, and only there; the rule that made that the only
 * way has not changed, only which place it names - a type's name is typed in
 * one place, so the same word cannot be spelled two ways. What capture had to
 * be was fast, and "I want a new kind of thing" is the one thing it was asked
 * to do that nobody is ever in a hurry about.
 */
export function ManageTypes({
  open,
  onClose,
  returnFocusTo,
}: {
  open: boolean;
  onClose: () => void;
  /** The control it was opened from, which gets the focus back. */
  returnFocusTo?: HTMLElement | null | undefined;
}) {
  const { data, error, refetch } = useQuery(itemTypesQuery);
  const workspaces = useQuery(workspacesQuery);
  const queryClient = useQueryClient();
  /** The name of the type being made, which is all making one asks for. */
  const [name, setName] = useState('');
  /**
   * The type whose form is open, and the draft in it: the name typed so far and
   * the colour picked so far. Nothing here has been sent - Save is what sends
   * it, and Cancel discards both halves together.
   */
  const [editing, setEditing] = useState<{ id: string; name: string; color: string } | null>(null);
  /** That a Save is in flight, and why the last one did not happen. */
  const [saving, setSaving] = useState(false);
  const [saveRefusal, setSaveRefusal] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; to: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  /**
   * The window itself, which the focus goes back to when a delete has taken
   * the row's menu with the row - the reason the workspaces' window keeps
   * one, and the dashboards' before it.
   */
  const list = useRef<HTMLDivElement>(null);
  /** That a delete has happened, so the focus is owed to the window. */
  const focusTheList = useRef(false);
  const command = useCommand();
  /**
   * The form sends its two changes one after the other, so it holds its own
   * pending and refusal: `useCommand` has room for one change in flight, and a
   * Save that moved both the name and the colour is two.
   */
  const send = useSendCommand();

  const types = data?.itemTypes ?? [];
  /**
   * Saying "no types yet" is a claim about what this account holds, so it needs
   * an answer to have arrived - the same lie the workspaces page records, where
   * `?? []` made a signed-out session read as an empty account.
   */
  const answered = data !== undefined;
  const listFailed = Boolean(error) && !answered;

  /**
   * How many items hold the type being deleted, and across how many workspaces,
   * so the question can say what it touches.
   *
   * Counted from the snapshots the app already reads, one per workspace,
   * because a type belongs to the account and its items are spread across all
   * of them. `enabled` keeps them off the page until a question is actually
   * being asked.
   */
  const held = useQuery({
    queryKey: ['itemTypeUse', deleting],
    enabled: deleting !== null && workspaces.data !== undefined,
    queryFn: async () => {
      const each = await Promise.all(
        (workspaces.data?.workspaces ?? []).map(async (workspace) => {
          const snapshot = await queryClient.fetchQuery(snapshotQuery(workspace.id));
          return snapshot.items.filter((item) => item.typeId === deleting).length;
        }),
      );
      return { items: each.reduce((a, b) => a + b, 0), workspaces: each.filter((n) => n > 0).length };
    },
  });

  const beingDeleted = types.find((type) => type.id === deleting);
  /**
   * The type the form is open on, read from the list rather than kept beside
   * the draft: one deleted in another tab is gone from the next list, and a
   * form open on a name nothing holds would save into nothing.
   */
  const beingEdited = types.find((type) => type.id === editing?.id);

  /** The focus, once a delete has taken the question away with the row. */
  useEffect(() => {
    if (!focusTheList.current || beingDeleted) return;
    focusTheList.current = false;
    const frame = requestAnimationFrame(() => list.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [beingDeleted]);

  const order = types.map((type) => type.id);
  const shownOrder = dragging ? movedTo(order, dragging.id, dragging.to) : order;
  const shown = shownOrder.flatMap((id) => types.filter((type) => type.id === id));

  /** The envelope every change here carries: a type belongs to the account, not a workspace. */
  const envelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId: ACCOUNT_WIDE,
  });

  /**
   * Moves a type, and shows it moved before the server has agreed - the one
   * control on this page that does not wait, for the two reasons the workspaces
   * page records: the order a move is computed from is the order in hand, so a
   * second move made before the first came back would undo it; and capture
   * reads this same order, so a snap-back would take it along.
   */
  const move = (typeId: string, moved: string[]) => {
    const before = queryClient.getQueryData<ItemTypeList>(itemTypesQuery.queryKey);
    if (before) {
      queryClient.setQueryData<ItemTypeList>(itemTypesQuery.queryKey, {
        itemTypes: moved.flatMap((id) => before.itemTypes.filter((type) => type.id === id)),
      });
    }
    command.mutate(
      { name: 'reorder_item_types', payload: { ...envelope(), typeId, typeIds: moved } },
      {
        // Both, and each covers what the other cannot - the copy in hand is the
        // only answer available when the request never reached the server, and
        // the re-read is what settles it when two moves were in flight.
        onError: () => {
          if (before) queryClient.setQueryData(itemTypesQuery.queryKey, before);
          void queryClient.invalidateQueries({ queryKey: itemTypesQuery.queryKey });
        },
      },
    );
  };

  const startDragging = (typeId: string, from: number) => (event: React.PointerEvent) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    closeForm();
    setDeleting(null);
    command.reset();
    setDragging({ id: typeId, to: from });
  };

  const dragTo = (event: React.PointerEvent) => {
    if (!dragging) return;
    const rows = listRef.current?.children;
    if (!rows || rows.length === 0) return;
    let to = rows.length - 1;
    for (let i = 0; i < rows.length; i += 1) {
      if (event.clientY <= rows[i]!.getBoundingClientRect().bottom) {
        to = i;
        break;
      }
    }
    if (to !== dragging.to) setDragging({ id: dragging.id, to });
  };

  const stopDragging = () => {
    if (!dragging) return;
    const moved = movedTo(order, dragging.id, dragging.to);
    setDragging(null);
    if (moved.some((id, i) => id !== order[i])) move(dragging.id, moved);
  };

  const startEditing = (type: ItemType, openedFrom: HTMLElement | null) => {
    setDeleting(null);
    command.reset();
    setSaveRefusal(null);
    askedFrom.current = openedFrom;
    setEditing({ id: type.id, name: type.name, color: type.color });
  };
  const startDeleting = (type: ItemType, openedFrom: HTMLElement | null) => {
    closeForm();
    command.reset();
    askedFrom.current = openedFrom;
    setDeleting(type.id);
  };
  /** The form goes, and the refusal it was showing goes with it. */
  const closeForm = () => {
    setEditing(null);
    setSaveRefusal(null);
  };
  const stopAsking = () => {
    closeForm();
    setDeleting(null);
    command.reset();
  };

  /**
   * What the form has to send: the halves that actually moved, and nothing
   * else - an untouched box would otherwise carry the value the form was opened
   * with over an edit made somewhere else in the meantime, and a colour nobody
   * touched would be re-sent on every rename.
   */
  const saveForm = async () => {
    if (!editing) return;
    const was = types.find((type) => type.id === editing.id);
    if (!was) return;
    const named = editing.name.trim();
    if (!named) return;

    setSaving(true);
    setSaveRefusal(null);
    try {
      if (named !== was.name) {
        await send({
          name: 'rename_item_type',
          payload: { ...envelope(), typeId: editing.id, name: named },
        });
      }
      if (editing.color !== was.color) {
        await send({
          name: 'set_item_type_color',
          payload: { ...envelope(), typeId: editing.id, color: editing.color },
        });
      }
      closeForm();
    } catch (failure) {
      // The form stays open with what was typed still in it, so a name the
      // server would not take can be corrected rather than typed again.
      setSaveRefusal(
        failure instanceof CommandRefused
          ? failure.message
          : 'That did not reach the server. Try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  /**
   * Closing it forgets what was half-typed and what was refused, for the reason
   * the workspaces' window gives: this stays mounted between openings, so a
   * refusal that is merely hidden comes back the next time over a name nobody
   * has touched.
   */
  const close = () => {
    stopAsking();
    setName('');
    onClose();
  };

  /**
   * Makes one. No colour goes with it: which of the palette is free is a fact
   * about the account rather than about the request, so the account picks it and
   * the row's own Edit… changes it afterwards - the same bargain New workspace
   * makes one list up.
   */
  const create = (e: React.FormEvent) => {
    e.preventDefault();
    const named = name.trim();
    // Not while one is already out: the button greys out, but Enter in the box
    // submits the form whatever the button says, and a second create of the
    // same name would now come back refused - naming the type the first press
    // had just made.
    if (!named || command.isPending) return;
    command.mutate(
      { name: 'create_item_type', payload: { ...envelope(), typeId: uuidv7(), name: named } },
      // Cleared only once it worked. A refusal - a name another type already
      // has, most of all - leaves what was typed where it is, so it can be
      // fixed rather than typed again.
      { onSuccess: () => setName('') },
    );
  };

  const confirmDelete = (typeId: string) => {
    command.mutate(
      { name: 'delete_item_type', payload: { ...envelope(), typeId } },
      {
        onSuccess: () => {
          setDeleting(null);
          focusTheList.current = true;
        },
      },
    );
  };

  const refusal =
    command.error instanceof CommandRefused
      ? command.error.message
      : command.error
        ? 'That did not reach the server. Try again.'
        : null;

  /** The refusal belongs to the control that asked for it, exact because only one is ever in flight. */
  const refusalFor = (
    what: 'create_item_type' | 'delete_item_type' | 'reorder_item_types',
    id?: string,
  ) =>
    refusal &&
    command.variables?.name === what &&
    (!id || (command.variables.payload as { typeId: string }).typeId === id)
      ? refusal
      : null;

  return (
    <ManageWindow
      title="Manage types"
      open={open}
      onClose={close}
      canClose={!command.isPending && !saving}
      returnFocusTo={returnFocusTo}
      ref={list}
    >
      <p className="mt-2 text-sm text-ink-faint">
        What kind of thing an item is. Capture offers these, the ones you used last first.
      </p>

      {/* Above the list, where the workspaces' window puts its own and for the
          reason recorded there: the list has no ceiling, so a box below it is a
          control whose reachability depends on how much you already own - and
          it is the one control here an account with nothing needs most. */}
      <form onSubmit={create} className="mt-4 flex flex-col gap-2">
        <div className="flex gap-2">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            // Two examples rather than three: a third is cut off in the 198px
            // this box gets on a 375px screen, and a hint that ends mid-word
            // is worse than a shorter one. Found in the browser.
            placeholder="Question, Decision…"
            aria-label="Name of the new type"
            maxLength={60}
            className="min-w-0 flex-1 rounded-md border border-black/10 bg-surface px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
          />
          <button
            type="submit"
            disabled={command.isPending || saving}
            className="shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
          >
            New type
          </button>
        </div>
        {refusalFor('create_item_type') && (
          <p role="alert" className="text-sm text-over">
            {refusalFor('create_item_type')}
          </p>
        )}
      </form>

      <section className="-mx-2 mt-4 min-h-0 flex-1 overflow-y-auto">
        <ul ref={listRef}>
          {shown.map((type, index) => (
            <li
              key={type.id}
              // A double-click opens the form, exactly as it does on an Item's
              // row and on a workspace's. Not a single click: a row here is
              // dragged, and every drag begins with a press.
              onDoubleClick={(event) => {
                if (wasOnTheRow(event)) startEditing(type, null);
              }}
              className={`border-b border-black/5 px-4 py-2 last:border-b-0 ${
                dragging?.id === type.id
                  ? 'rounded-md bg-accent-tint shadow-panel'
                  : dragging
                    ? 'opacity-60'
                    : ''
              }`}
            >
              <div className="flex items-center gap-3">
                {/* The grip, and deliberately not a button, for the reason the
                    workspaces page states: a drag is a pointer gesture with no
                    keyboard behaviour to offer, and Move up and Move down in
                    the menu are what a keyboard and a phone get instead. */}
                <span
                  aria-hidden="true"
                  title={`Drag to reorder ${type.name}`}
                  onPointerDown={startDragging(type.id, index)}
                  onPointerMove={dragTo}
                  onPointerUp={stopDragging}
                  onPointerCancel={() => setDragging(null)}
                  className="-my-2 -ml-2 shrink-0 cursor-grab touch-none py-2 pr-1 pl-2 text-ink-faint active:cursor-grabbing"
                >
                  <svg viewBox="0 0 10 16" className="size-4" fill="currentColor">
                    <circle cx="3" cy="3.5" r="1.3" />
                    <circle cx="7" cy="3.5" r="1.3" />
                    <circle cx="3" cy="8" r="1.3" />
                    <circle cx="7" cy="8" r="1.3" />
                    <circle cx="3" cy="12.5" r="1.3" />
                    <circle cx="7" cy="12.5" r="1.3" />
                  </svg>
                </span>
                <span
                  className="inline-block size-3 shrink-0 rounded-full"
                  style={{ backgroundColor: type.color }}
                />
                <span className="min-w-0 flex-1 truncate text-sm">{type.name}</span>
                <RowMenu
                  label={`Actions for ${type.name}`}
                  entries={[
                    // The name and the colour together, on a form of its own -
                    // the only way in from a keyboard, and the comfortable one
                    // on a phone.
                    {
                      label: 'Edit…',
                      onSelect: (openedFrom) => startEditing(type, openedFrom),
                    },
                    {
                      label: 'Move up',
                      keepsFocus: true,
                      unavailable: index === 0 ? 'It is already the first' : undefined,
                      onSelect: () => move(type.id, movedBy(order, type.id, -1)),
                    },
                    {
                      label: 'Move down',
                      keepsFocus: true,
                      unavailable:
                        index === shown.length - 1 ? 'It is already the last' : undefined,
                      onSelect: () => move(type.id, movedBy(order, type.id, 1)),
                    },
                    {
                      label: 'Delete',
                      destructive: true,
                      onSelect: (openedFrom) => startDeleting(type, openedFrom),
                    },
                  ]}
                />
              </div>
              {/* A refused delete says so in the dialog that asked for it, and
                  a refused rename or colour on the form that asked. A refused
                  move is the one left to say here, and the one that has to be
                  read: the row has already gone back, and without a word that
                  reads as the drag having missed. */}
              {refusalFor('reorder_item_types', type.id) && (
                <p role="alert" className="pt-2 text-sm text-over">
                  {refusalFor('reorder_item_types', type.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
        {/* One form for the page: at most one row can be being edited, and it
            covers the page while it is. */}
        {beingEdited && editing && (
          <RowForm
            title={`Edit ${beingEdited.name}`}
            name={editing.name}
            nameLabel={`Name of ${beingEdited.name}`}
            onName={(named) => setEditing({ ...editing, name: named })}
            paletteLabel={`Colour of ${beingEdited.name}`}
            palette={ITEM_TYPE_COLORS.map((color) => (
              /* A row of dots: a type wears one colour, which is the mark at
                 the head of every row it labels, so a swatch showing anything
                 more would be showing something that is not there. */
              <button
                key={color}
                type="button"
                onClick={() => setEditing({ ...editing, color })}
                disabled={saving}
                aria-label={`${color} for ${beingEdited.name}`}
                aria-pressed={editing.color === color}
                className={`flex size-8 items-center justify-center rounded-md border disabled:opacity-50 ${
                  editing.color === color
                    ? 'border-ink ring-2 ring-ink/20'
                    : 'border-black/10 hover:border-black/30'
                }`}
              >
                <span className="block size-4 rounded-full" style={{ backgroundColor: color }} />
              </button>
            ))}
            refusal={saveRefusal}
            saving={saving}
            returnFocusTo={askedFrom.current}
            onCancel={closeForm}
            onSave={() => void saveForm()}
          />
        )}
        {beingDeleted && (
          <DeleteQuestion
            open
            question={deleteQuestion(beingDeleted.name, held.data)}
            confirmLabel={`Yes, delete ${beingDeleted.name}`}
            // Nothing goes before the question has an answer in it, and a count
            // that could not be read lets it through rather than trapping you -
            // the same trade the workspace question makes. A workspace list
            // that failed is that case too, and the loudest version of it: the
            // count is never even asked for, so without this the dialog would
            // wait on an answer that is not coming.
            canConfirm={
              !command.isPending && (held.data !== undefined || held.isError || workspaces.isError)
            }
            refusal={refusalFor('delete_item_type', beingDeleted.id)}
            returnFocusTo={askedFrom.current}
            onCancel={stopAsking}
            onConfirm={() => confirmDelete(beingDeleted.id)}
          />
        )}
        {listFailed && (
          <div className="px-4 py-4">
            <LoadFailure error={error} onRetry={() => void refetch()} />
          </div>
        )}
        {answered && types.length === 0 && (
          <p className="px-4 py-4 text-sm text-ink-faint">No types yet. Make one above.</p>
        )}
      </section>
      <CloseWindow disabled={command.isPending || saving} />
    </ManageWindow>
  );
}

/**
 * What deleting this type takes with it, said before it happens. The items keep
 * everything except the label, and the wording says so: they stop having a type
 * rather than going anywhere.
 */
function deleteQuestion(
  name: string,
  use: { items: number; workspaces: number } | undefined,
): string {
  if (use === undefined) return `Delete ${name}?`;
  if (use.items === 0) return `Delete ${name}? Nothing is of this type.`;
  const items = `${use.items} item${use.items === 1 ? '' : 's'}`;
  const where =
    use.workspaces === 1 ? '' : ` across ${use.workspaces} workspaces`;
  return `Delete ${name}? ${items}${where} will stop having a type.`;
}

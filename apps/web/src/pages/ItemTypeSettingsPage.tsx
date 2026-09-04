import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE, ITEM_TYPE_COLORS, uuidv7 } from '@cockpit/shared';
import type { ItemType, ItemTypeList } from '@cockpit/shared';
import { CommandRefused } from '../api/client';
import { itemTypesQuery, snapshotQuery, useCommand, workspacesQuery } from '../api/queries';
import { movedBy, movedTo } from '../reorder';
import { DeleteQuestion } from '../components/DeleteQuestion';
import { LoadFailure } from '../components/LoadFailure';
import { RowMenu } from '../components/Menu';

/**
 * Where types are managed ("Manage the types, and put them in the order you
 * want", issue 156). It lists them, renames them, recolours them, puts them in
 * the order capture offers them in, and deletes them.
 *
 * **A sibling of the workspaces page, and the same page in every respect that
 * matters**: a row keeps its shape, what can be done to a type is in its own
 * menu, renaming happens in the row, deleting asks in a dialog, and a type is
 * moved two ways that are one change. Types are the fourth list of named things
 * in the app and the three before it are pages with rows and menus; making this
 * one a section of a page about something else is what would make it hard to
 * find.
 *
 * **There is no box for making one**, which is the one way it differs. A type
 * comes into existence by being used, at capture ("Capture a thought or an
 * action, and see which it is", issue 155) - a type you need once is not worth
 * a trip here, and a second way to make one would be a second place for the
 * same name to be typed differently.
 */
export function ItemTypeSettingsPage() {
  const { data, error, refetch } = useQuery(itemTypesQuery);
  const workspaces = useQuery(workspacesQuery);
  const queryClient = useQueryClient();
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; to: number } | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const askedFrom = useRef<HTMLElement | null>(null);
  const command = useCommand();

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
    setRenaming(null);
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

  const startRenaming = (type: ItemType) => {
    setDeleting(null);
    command.reset();
    setRenaming({ id: type.id, name: type.name });
  };
  const startDeleting = (type: ItemType, openedFrom: HTMLElement | null) => {
    setRenaming(null);
    command.reset();
    askedFrom.current = openedFrom;
    setDeleting(type.id);
  };
  const stopAsking = () => {
    setRenaming(null);
    setDeleting(null);
    command.reset();
  };

  const rename = (e: React.FormEvent) => {
    e.preventDefault();
    if (!renaming) return;
    const trimmed = renaming.name.trim();
    if (!trimmed) return;
    command.mutate(
      { name: 'rename_item_type', payload: { ...envelope(), typeId: renaming.id, name: trimmed } },
      // The box closes only once the new name is really the type's, so a
      // refused one is still there to be corrected.
      { onSuccess: () => setRenaming(null) },
    );
  };

  const chooseColor = (typeId: string, color: string) => {
    command.mutate({ name: 'set_item_type_color', payload: { ...envelope(), typeId, color } });
  };

  const confirmDelete = (typeId: string) => {
    command.mutate(
      { name: 'delete_item_type', payload: { ...envelope(), typeId } },
      { onSuccess: () => setDeleting(null) },
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
    what: 'rename_item_type' | 'set_item_type_color' | 'delete_item_type' | 'reorder_item_types',
    id?: string,
  ) =>
    refusal &&
    command.variables?.name === what &&
    (!id || (command.variables.payload as { typeId: string }).typeId === id)
      ? refusal
      : null;

  return (
    <div className="flex flex-col gap-6">
      <h1 className="text-xl font-semibold tracking-tight">Types</h1>
      <p className="text-sm text-ink-faint">
        What kind of thing an item is. A new one is made by naming it when you capture something.
      </p>

      <section className="rounded-lg bg-surface shadow-panel">
        <ul ref={listRef}>
          {shown.map((type, index) => (
            <li
              key={type.id}
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
                {renaming?.id === type.id ? (
                  <form onSubmit={rename} className="flex min-w-0 flex-1 items-center gap-2">
                    <input
                      value={renaming.name}
                      onChange={(e) => setRenaming({ id: type.id, name: e.target.value })}
                      aria-label={`New name for ${type.name}`}
                      maxLength={60}
                      autoFocus
                      className="min-w-0 flex-1 rounded-md border border-black/10 bg-surface px-2 py-1 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
                    />
                    <button type="submit" disabled={command.isPending} className={primaryButton}>
                      Save
                    </button>
                    <button type="button" onClick={stopAsking} className={quietButton}>
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <span className="min-w-0 flex-1 truncate text-sm">{type.name}</span>
                    <RowMenu
                      label={`Actions for ${type.name}`}
                      entries={[
                        { label: 'Rename', onSelect: () => startRenaming(type) },
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
                  </>
                )}
              </div>
              {/* The palette, as a row of dots: a type wears one colour, which
                  is the mark at the head of every row it labels, so a swatch
                  showing anything more would be showing something that is not
                  there. Hidden while the row is being renamed, the one thing
                  that takes the row over. */}
              {renaming?.id !== type.id && (
                <div className="flex flex-wrap gap-1.5 pt-2 pl-6">
                  {ITEM_TYPE_COLORS.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => chooseColor(type.id, color)}
                      disabled={command.isPending}
                      aria-label={`${color} for ${type.name}`}
                      aria-pressed={type.color === color}
                      className={`flex size-6 items-center justify-center rounded-md border disabled:opacity-50 ${
                        type.color === color
                          ? 'border-ink ring-2 ring-ink/20'
                          : 'border-black/10 hover:border-black/30'
                      }`}
                    >
                      <span
                        className="block size-3 rounded-full"
                        style={{ backgroundColor: color }}
                      />
                    </button>
                  ))}
                </div>
              )}
              {/* A refused delete says so in the dialog that asked for it. A
                  refused move is the one that has to be read: the row has
                  already gone back, and without a word that reads as the drag
                  having missed. */}
              {(refusalFor('rename_item_type', type.id) ??
                refusalFor('reorder_item_types', type.id) ??
                refusalFor('set_item_type_color', type.id)) && (
                <p role="alert" className="pt-2 text-sm text-over">
                  {refusalFor('rename_item_type', type.id) ??
                    refusalFor('reorder_item_types', type.id) ??
                    refusalFor('set_item_type_color', type.id)}
                </p>
              )}
            </li>
          ))}
        </ul>
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
          <p className="px-4 py-4 text-sm text-ink-faint">
            No types yet. Name one when you capture something.
          </p>
        )}
      </section>
    </div>
  );
}

const primaryButton =
  'shrink-0 rounded-md bg-accent px-3 py-1 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50';
const quietButton =
  'shrink-0 rounded-md border border-black/10 px-3 py-1 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep';

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

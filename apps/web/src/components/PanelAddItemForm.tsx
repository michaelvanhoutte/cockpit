import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { uuidv7 } from '@cockpit/shared';
import { useCapture } from '../capture';
import { CommandRefused } from '../api/client';
import { snapshotQuery, useLatestSnapshot, useSendCommand } from '../api/queries';
import { filedOrderOnPanel, orderWithItemAt } from '../filing';
import { NO_TYPES, typesOffered } from '../itemTypes';

/**
 * A panel's own front door, collapsed until asked for ("Create an item on a
 * panel, filed there directly", issue 449).
 *
 * **Closed by default, where the Inbox's own row never is.** Working the
 * items already on a panel is what it is opened for most of the time; adding
 * straight to it is the secondary action next to that, so this asks first
 * rather than spending a row on every panel whether or not it is used.
 *
 * **It reads the snapshot itself**, the way `ItemList` beside it already does
 * (`ItemList.tsx`'s own doc comment), rather than having `PanelBoard` and
 * `PanelCard` thread the account's types and this panel's held order through
 * two more components' props for a leaf that is closed, and reads none of it,
 * most of the time.
 *
 * **Two commands, not one.** There is no server command that captures and
 * files in a single write - `capture_item` always lands in the Inbox - so
 * this sends `capture_item` and then, once it has landed, `add_item_to_panel`
 * with the panel's own held order and the new item put at the top. That order
 * is re-read right before it is sent (`useLatestSnapshot`, the same guard
 * `ItemList.tsx` uses before a run of filings) rather than the one this row
 * opened with, so another filing landing on this panel during the round trip
 * cannot make the server refuse this one as stale. A refusal of the second
 * command leaves the item exactly where the first put it: visible in the
 * Inbox rather than lost, which is what makes chaining two commands safe
 * here - and nothing here resends it, which would only capture it twice.
 */
export function PanelAddItemForm({
  workspaceId,
  panelId,
}: {
  workspaceId: string;
  panelId: string;
}) {
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState('');
  const [typeId, setTypeId] = useState('');
  const [refused, setRefused] = useState<string | null>(null);
  const { ask, busy: capturing } = useCapture();
  const send = useSendCommand();
  const latestSnapshot = useLatestSnapshot();
  const [filing, setFiling] = useState(false);
  const busy = capturing || filing;

  // Asked for only once the row is open: a collapsed row - most panels, most
  // of the time - never reads what this returns, and every panel on a board
  // carries one of these.
  const { data } = useQuery({ ...snapshotQuery(workspaceId), enabled: open });

  const close = () => {
    setOpen(false);
    setMessage('');
    setTypeId('');
    setRefused(null);
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full border-b border-black/5 px-4 py-2 text-left text-sm text-ink-faint hover:bg-accent-tint hover:text-accent-deep"
      >
        + Add an item
      </button>
    );
  }

  const types = data?.itemTypes;
  const offered = typesOffered(types ?? [], data?.items ?? []);
  const answered = types !== undefined;
  const chosen = offered.find((type) => type.id === typeId) ?? offered[0];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = message.trim();
    if (!trimmed || !chosen) return;

    ask(
      { message: trimmed, typeId: chosen.id, workspaceId, decided: true },
      {
        asking: () => {
          setMessage('');
          setRefused(null);
        },
        captured: (_typeId, itemId) => {
          setFiling(true);
          void (async () => {
            try {
              const held = filedOrderOnPanel(
                (await latestSnapshot(workspaceId)).filings ?? [],
                panelId,
              );
              await send({
                name: 'add_item_to_panel',
                payload: {
                  commandId: uuidv7(),
                  issuedAt: new Date().toISOString(),
                  workspaceId,
                  itemId,
                  panelId,
                  order: orderWithItemAt(held, itemId, 0),
                },
              });
              setFiling(false);
              close();
            } catch (error) {
              setFiling(false);
              // The item itself was captured - it is in the Inbox rather
              // than lost - so nothing here offers to send it again, which
              // would only capture it a second time.
              setRefused(
                error instanceof CommandRefused
                  ? `Captured, but could not be filed here: ${error.message}`
                  : 'Captured, but could not be filed here. It is in the Inbox.',
              );
            }
          })();
        },
        refused: (why) => {
          setMessage(trimmed);
          setRefused(why);
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      className="flex flex-wrap gap-2 border-b border-black/5 px-4 py-3"
    >
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder="Capture a note or to-do…"
        aria-label="Capture a note or to-do"
        autoFocus
        className="min-w-0 flex-1 basis-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
      />
      {chosen && (
        <select
          value={chosen.id}
          onChange={(e) => setTypeId(e.target.value)}
          aria-label="What kind of thing this is"
          className="min-w-0 flex-1 rounded-md border border-black/10 bg-white px-3 py-2 text-sm shadow-[inset_0_1px_2px_rgb(41_43_49/0.06)] outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
        >
          {offered.map((type) => (
            <option key={type.id} value={type.id}>
              {type.name}
            </option>
          ))}
        </select>
      )}
      <button
        type="submit"
        disabled={busy || !chosen}
        className="milled shrink-0 rounded-md bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-deep disabled:opacity-50"
      >
        Add
      </button>
      <button
        type="button"
        onClick={close}
        disabled={busy}
        className="shrink-0 rounded-md border border-black/10 px-3 py-2 text-sm hover:bg-accent-tint hover:text-accent-deep disabled:opacity-50"
      >
        Cancel
      </button>
      {answered && offered.length === 0 && (
        <p className="basis-full text-sm text-ink-faint">{NO_TYPES}</p>
      )}
      {refused && (
        <p role="alert" className="basis-full text-sm text-over">
          {refused}
        </p>
      )}
    </form>
  );
}

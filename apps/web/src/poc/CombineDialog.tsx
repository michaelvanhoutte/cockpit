import * as Dialog from '@radix-ui/react-dialog';
import { useMemo, useState } from 'react';
import { itemLabel, stillOpen, type Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { sourceOnARow } from '../itemSource';
import { useUndo } from '../undo';
import { dashboardScope, endSelection } from '../selection';
import { useSendCommand } from '../api/queries';
import { addCard, itemBoxAround } from './board';
import { stopAsking } from './dialogs';
import { addChildren, isUuid } from './relations';
import { hiddenKey, updatePoc } from './store';

type Choice = 'merge' | 'new-parent' | 'existing-parent';

/** POC (throwaway): no Claude. The title and description Claude would write, canned. */
export function cannedTexts(items: readonly Item[], note: string): { title: string; description: string } {
  const first = items[0] ? itemLabel(items[0]) : 'Items';
  const title = `Combined: ${first}${items.length > 1 ? ` +${items.length - 1}` : ''}`;
  const titles = items.map((item) => `“${itemLabel(item)}”`);
  const listed = titles.length > 1 ? `${titles.slice(0, -1).join(', ')} and ${titles.at(-1)}` : (titles[0] ?? '');
  const description =
    `This brings together ${listed}.` + (note.trim() ? ` ${note.trim().replace(/\s+/g, ' ')}` : '');
  return { title, description };
}

/** The Panel on this Dashboard the first Item is filed on. */
export function panelOf(
  itemId: string | undefined,
  dashboardId: string | null,
  filings: readonly { panelId: string; itemId: string }[],
  panels: readonly { id: string; dashboardId: string }[],
): string | null {
  if (!itemId) return null;
  const onIt = filings.filter((filing) => filing.itemId === itemId).map((filing) => filing.panelId);
  const here = onIt.find((panelId) => panels.some((panel) => panel.id === panelId && panel.dashboardId === dashboardId));
  return here ?? onIt[0] ?? null;
}

export function CombineDialog({
  workspaceId,
  itemIds,
  dashboardId,
  boardNodeIds,
}: {
  workspaceId: string;
  itemIds: string[];
  dashboardId: string | null;
  boardNodeIds: string[];
}) {
  const { data } = useSnapshot(workspaceId);
  const offerToUndo = useUndo();
  const byId = new Map((data?.items ?? []).map((item) => [item.id, item]));
  const chosen = itemIds.flatMap((id) => byId.get(id) ?? []);
  const sourced = chosen.find((item) => item.source !== 'internal');
  const [choice, setChoice] = useState<Choice>('new-parent');
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [chosenParent, setParentId] = useState<string | null>(null);

  const candidates = useMemo(() => {
    const words = search.trim().toLowerCase();
    return (data?.items ?? [])
      .filter(stillOpen)
      .filter((item) => !itemIds.includes(item.id))
      .filter((item) => !words || itemLabel(item).toLowerCase().includes(words))
      .slice(0, 8);
  }, [data, itemIds, search]);

  const send = useSendCommand();
  const combine = () => {
    if (!data) return;
    const { title, description } = cannedTexts(chosen, note);
    const panelId = panelOf(chosen[0]?.id, dashboardId, data.filings, data.panels);
    const envelope = () => ({ commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId });
    const makeItem = (): string => {
      const itemId = crypto.randomUUID();
      void send({
        name: 'capture_item',
        payload: { ...envelope(), itemId, title, message: description, ...(panelId && isUuid(panelId) ? { panelIds: [panelId] } : {}) },
      });
      return itemId;
    };
    if (choice === 'merge') {
      const mergedIds = chosen.map((item) => item.id);
      const newItemId = makeItem();
      updatePoc<string[]>(hiddenKey(workspaceId), [], (was) => [...new Set([...was, ...mergedIds])]);
      if (dashboardId) addCard(dashboardId, newItemId);
      offerToUndo({
        what: `Merged ${chosen.length} Items into “${title}”`,
        undo: async () => {
          updatePoc<string[]>(hiddenKey(workspaceId), [], (was) => was.filter((id) => !mergedIds.includes(id)));
          await send({ name: 'set_dismissed', payload: { ...envelope(), itemId: newItemId, dismissed: true } });
        },
      });
    } else {
      const parentId = choice === 'existing-parent' && chosenParent ? chosenParent : makeItem();
      const childIds = chosen.map((item) => item.id);
      addChildren(workspaceId, parentId, childIds);
      if (dashboardId) itemBoxAround(dashboardId, parentId, childIds, boardNodeIds);
    }
    if (dashboardId) endSelection(dashboardScope(dashboardId));
    stopAsking();
  };

  const radio = (value: Choice, label: string, explains: string, unavailable: string | null = null) => (
    <label
      className={`flex cursor-pointer gap-3 rounded-md border p-3 ${
        choice === value ? 'border-accent bg-accent-tint' : 'border-shade/10 bg-field'
      } ${unavailable ? 'cursor-not-allowed opacity-50' : ''}`}
    >
      <input
        type="radio"
        name="combine-how"
        value={value}
        checked={choice === value}
        disabled={unavailable !== null}
        onChange={() => setChoice(value)}
        className="mt-1 accent-[var(--color-accent)]"
      />
      <span className="flex flex-col gap-0.5">
        <span className="text-sm font-medium text-ink-strong">{label}</span>
        <span className="text-sm text-ink-soft">{unavailable ?? explains}</span>
      </span>
    </label>
  );

  return (
    <Dialog.Root open onOpenChange={(open) => !open && stopAsking()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed z-floating left-1/2 top-1/2 flex max-h-[90vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">Combine {chosen.length} Items</Dialog.Title>
          <ul className="flex flex-wrap gap-1.5">
            {chosen.map((item) => (
              <li
                key={item.id}
                className="max-w-full truncate rounded-full border border-shade/10 bg-field px-2.5 py-0.5 text-sm text-ink"
              >
                {itemLabel(item)}
              </li>
            ))}
          </ul>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">How to combine them</legend>
            {radio(
              'merge',
              'Merge into one new Item',
              'The originals are replaced by one new Item.',
              sourced
                ? `Can't merge: ${itemLabel(sourced)} finishes from ${sourceOnARow(sourced, data?.sourceNames)}`
                : null,
            )}
            {radio('new-parent', 'Combine under a new parent', 'They stay where they are. A new Item holds them.')}
            {radio('existing-parent', 'Combine under an existing parent', 'They stay where they are. An Item you pick holds them.')}
            {choice === 'existing-parent' && (
              <div className="flex flex-col gap-1 pl-7">
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find an Item…"
                  aria-label="Find the parent Item"
                  className="w-full rounded-md border border-shade/10 bg-field px-3 py-1.5 text-sm outline-none focus:border-accent"
                />
                <ul className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-shade/10 bg-field">
                  {candidates.map((item) => (
                    <li key={item.id}>
                      <button
                        type="button"
                        onClick={() => setParentId(item.id)}
                        className={`w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent-tint ${
                          chosenParent === item.id ? 'bg-accent-tint font-medium text-accent-deep' : 'text-ink'
                        }`}
                      >
                        {itemLabel(item)}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-strong">Anything to add about the new Item?</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="w-full rounded-md border border-shade/10 bg-field px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />
          </label>
          <p className="text-xs text-ink-faint">
            Claude writes the new Item's title and description from these and what you add. You can change them afterwards.
          </p>
          <div className="flex justify-end gap-2">
            <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={combine}
              disabled={chosen.length < 2 || (choice === 'existing-parent' && !chosenParent)}
              className="milled shrink-0 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-on-accent hover:bg-accent-hover disabled:opacity-50"
            >
              Combine
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

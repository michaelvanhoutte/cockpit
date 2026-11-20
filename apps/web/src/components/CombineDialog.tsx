import * as Dialog from '@radix-ui/react-dialog';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import {
  CHILDREN_ADDED_AT_ONCE,
  combinedTitle,
  itemFromASource,
  itemLabel,
  panelTheFirstIsOn,
  parentDescription,
  stillOpen,
  workspaceIsDecided,
  stitchedDescription,
  uuidv7,
  type Item,
} from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { sourceOnARow } from '../itemSource';
import { useUndo } from '../undo';
import { ParentPicker, addAsChildren } from './AddAsChildOf';

type Choice = 'merge' | 'new-parent' | 'existing-parent';

/**
 * *Combine* ("Brainstorming: related loose notes can't be brought together",
 * issue 1826): the POC's dialog, *A · Combine: pick the action, then add
 * context*, wired to stored data. Three actions as cards, the Items being
 * combined named above them, and "Anything to add?" below. Pressing Combine
 * sends one change: `merge_items`, `combine_under_new_parent`, or
 * `add_children` for an Item you pick. The texts sent are stitched
 * (`stitchedDescription`), which is what stands where Claude cannot write: the
 * server asks Claude for the description of what a Merge or a new parent makes,
 * replacing the stitched one while it is still Claude's ("Brainstorming: a parent's description goes stale as children join or leave", issue 1827).
 */
export default function CombineDialog({
  workspaceId,
  itemIds,
  onClose,
  onCombined,
  returnFocusTo,
}: {
  /** Where the focus goes back to once it closes: the row's menu button, when it was opened from one. */
  returnFocusTo?: HTMLElement | null | undefined;
  workspaceId: string;
  /** The Items to combine, in the order they were picked, as the Workspace's read holds them. */
  itemIds: readonly string[];
  onClose: () => void;
  /** Called once the change is on its way, for the selection to end. */
  onCombined: () => void;
}) {
  const { data } = useSnapshot(workspaceId);
  const send = useSendCommand();
  const queryClient = useQueryClient();
  const offerToUndo = useUndo();
  /** Items picked in the window itself, for a Combine asked from one row's menu. */
  const [withIds, setWithIds] = useState<readonly string[]>([]);
  const byId = new Map((data?.items ?? []).filter(stillOpen).map((item) => [item.id, item]));
  // The Items picked stay named even if one finishes before the window draws: only one dismissed is gone.
  const named = new Map((data?.items ?? []).map((item) => [item.id, item]));
  const chosen = [...itemIds, ...withIds].flatMap((id) => named.get(id) ?? []);
  const sourced = itemFromASource(chosen);
  const [picked, setPicked] = useState<Choice>('new-parent');
  /** Why Merge and a new parent are not offered, as the dialog says; null where they are. */
  const mergeWhy = sourced
    ? `Can't merge: ${itemLabel(sourced)} finishes from ${sourceOnARow(sourced, data?.sourceNames)}`
    : chosen.length > CHILDREN_ADDED_AT_ONCE
      ? `Can't merge more than ${CHILDREN_ADDED_AT_ONCE} Items at once`
      : null;
  const newParentWhy = chosen.length > CHILDREN_ADDED_AT_ONCE ? `Can't hold more than ${CHILDREN_ADDED_AT_ONCE} Items at once` : null;
  // What is offered may change under a choice already made, as Items are added: then the next one that is offered stands.
  const choice = ([picked, 'new-parent', 'existing-parent'] as const).find(
    (one) => (one === 'merge' ? !mergeWhy : one === 'new-parent' ? !newParentWhy : true),
  )!;
  const [note, setNote] = useState('');
  const [pickedParent, setParent] = useState<Item | null>(null);
  // Only one still open and not among the Items going in.
  const parent = pickedParent && byId.has(pickedParent.id) && !chosen.includes(byId.get(pickedParent.id)!) ? byId.get(pickedParent.id)! : null;

  const combine = () => {
    if (!data) return;
    const envelope = () => ({ commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId });
    const childIds = chosen.map((item) => item.id);
    const title = combinedTitle(chosen);
    // An Item in no Workspace yet is drawn in every Inbox, so the others' reads are stale once it is merged or settled.
    const everyInbox = <T,>(answer: Promise<T>): Promise<T> => {
      if (chosen.some((item) => !workspaceIsDecided(item))) {
        void answer.then(() => queryClient.invalidateQueries({ queryKey: ['snapshot'] }), () => undefined);
      }
      return answer;
    };
    // The Dashboard open in the address bar, whose Panel a new parent prefers when the first Item is on several.
    const dashboardId = /\/d\/([^/?#]+)/.exec(window.location.pathname)?.[1] ?? null;
    if (choice === 'merge') {
      const itemId = uuidv7();
      const answer = everyInbox(send({
        name: 'merge_items',
        payload: { ...envelope(), itemId, originalIds: childIds, title, description: stitchedDescription(chosen, note) },
      }));
      offerToUndo({
        what: `Merged ${chosen.length} Items into “${title}”`,
        unlessRefused: answer,
        undo: () => everyInbox(send({ name: 'unmerge_items', payload: { ...envelope(), itemId, originalIds: childIds } })),
      });
    } else if (choice === 'new-parent') {
      // On no Panel, the store puts it inside the Item the first is inside, or leaves it in the Inbox.
      const panelId = panelTheFirstIsOn(childIds[0], dashboardId, data.filings, data.panels);
      const answer = everyInbox(send({
        name: 'combine_under_new_parent',
        payload: {
          ...envelope(),
          parentId: uuidv7(),
          title,
          description: parentDescription(chosen, note),
          childIds,
          panelId,
          // From the Inbox the new parent is an Item that stays there holding them, never a Panel ("Brainstorming: a Panel is an Item nobody can open", issue 1846).
          dashboardId: null,
        },
      }));
      offerToUndo({ what: `${chosen.length} Items combined under “${title}”`, unlessRefused: answer });
    } else if (parent) {
      addAsChildren({ workspaceId, send, offerToUndo, children: data.children ?? [] }, chosen, parent);
    }
    onCombined();
  };

  const card = (value: Choice, label: string, explains: string, unavailable: string | null = null) => (
    <label
      className={`flex gap-3 rounded-md border p-3 ${
        choice === value ? 'border-accent bg-accent-tint' : 'border-shade/10 bg-field'
      } ${unavailable ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}
    >
      <input
        type="radio"
        name="combine-how"
        value={value}
        checked={choice === value}
        disabled={unavailable !== null}
        onChange={() => {
          setPicked(value);
          setParent(null);
        }}
        className="mt-1 accent-[var(--color-accent)]"
      />
      <span className="flex min-w-0 flex-col gap-0.5">
        <span className="text-sm font-medium text-ink-strong">{label}</span>
        <span className="text-sm text-ink-soft">{unavailable ?? explains}</span>
      </span>
    </label>
  );

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-floating bg-scrim/30" />
        <Dialog.Content
          aria-describedby={undefined}
          onCloseAutoFocus={(event) => {
            if (!returnFocusTo) return;
            event.preventDefault();
            returnFocusTo.focus();
          }}
          className="fixed left-1/2 top-1/2 z-floating flex max-h-[90vh] w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 flex-col gap-4 overflow-y-auto rounded-lg border border-shade/10 bg-surface p-5 shadow-lg"
        >
          <Dialog.Title className="text-base font-semibold">
            {chosen.length < 2 ? `Combine “${chosen[0] ? itemLabel(chosen[0]) : ''}” with…` : `Combine ${chosen.length} Items`}
          </Dialog.Title>
          {itemIds.length < 2 && (
            <CombineWith
              items={[...byId.values()].filter(workspaceIsDecided)}
              chosen={chosen}
              onToggle={(id) => {
                setParent(null);
                setWithIds((was) => (was.includes(id) ? was.filter((one) => one !== id) : [...was, id]));
              }}
            />
          )}
          <ul className="flex flex-wrap gap-1.5">
            {chosen.map((item) => (
              <li key={item.id} className="max-w-full truncate rounded-full border border-shade/10 bg-field px-2.5 py-0.5 text-sm text-ink">
                {itemLabel(item)}
              </li>
            ))}
          </ul>
          <fieldset className="flex flex-col gap-2">
            <legend className="sr-only">How to combine them</legend>
            {card(
              'merge',
              'Merge into one new Item',
              'The originals are replaced by one new Item.',
              mergeWhy,
            )}
            {card('new-parent', 'Combine under a new parent', 'They stay where they are. A new Item holds them.', newParentWhy)}
            {card('existing-parent', 'Combine under an existing parent', 'They stay where they are. An Item you pick holds them.')}
            {choice === 'existing-parent' && (
              <div className="pl-7">
                <ParentPicker key={chosen.map((item) => item.id).join()} chosen={chosen} items={data?.items ?? []} children={data?.children ?? []} onPick={setParent} />
              </div>
            )}
          </fieldset>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm font-medium text-ink-strong">Anything to add?</span>
            <textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={3}
              className="w-full rounded-md border border-shade/10 bg-field px-3 py-2 text-sm outline-none focus:border-accent focus:ring-2 focus:ring-accent-soft/40"
            />
          </label>
          <p className="text-xs text-ink-faint">
            The new Item's title and description are made from these and what you add. You can change them afterwards.
          </p>
          <div className="flex justify-end gap-2">
            <Dialog.Close className="shrink-0 rounded-md border border-shade/10 px-3 py-1.5 text-sm text-ink-soft hover:bg-accent-tint hover:text-accent-deep">
              Cancel
            </Dialog.Close>
            <button
              type="button"
              onClick={combine}
              disabled={chosen.length < 2 || !data || (choice === 'existing-parent' && !parent)}
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

/** The most Items the *Combine with* list shows at once; typing narrows it. */
const LISTED = 8;

/**
 * Which other Items to combine the one a row's menu was opened on with: a search
 * over the Workspace's open Items, each toggled in or out, the ones in already
 * named under the title. An Item waiting in every Inbox belongs to no Workspace
 * yet, so it is not offered.
 */
function CombineWith({
  items,
  chosen,
  onToggle,
}: {
  items: readonly Item[];
  chosen: readonly Item[];
  onToggle: (id: string) => void;
}) {
  const [search, setSearch] = useState('');
  const words = search.trim().toLowerCase();
  const listed = items.filter((item) => !words || itemLabel(item).toLowerCase().includes(words)).slice(0, LISTED);
  return (
    <div className="flex flex-col gap-1">
      <input
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        placeholder="Find Items to combine it with…"
        aria-label="Find the Items to combine with"
        autoFocus
        className="w-full rounded-md border border-shade/10 bg-field px-3 py-1.5 text-sm outline-none focus:border-accent"
      />
      <ul aria-label="Items to combine with" className="flex max-h-40 flex-col overflow-y-auto rounded-md border border-shade/10 bg-field">
        {listed.length === 0 && <li className="px-3 py-1.5 text-sm text-ink-faint">No Item matches.</li>}
        {listed.map((item) => {
          const picked = chosen.includes(item);
          return (
            <li key={item.id}>
              <button
                type="button"
                aria-pressed={picked}
                // The Item the row's menu was opened on is already in.
                disabled={item === chosen[0]}
                onClick={() => onToggle(item.id)}
                className={`w-full truncate px-3 py-1.5 text-left text-sm hover:bg-accent-tint disabled:opacity-50 ${
                  picked ? 'bg-accent-tint font-medium text-accent-deep' : 'text-ink'
                }`}
              >
                {itemLabel(item)}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

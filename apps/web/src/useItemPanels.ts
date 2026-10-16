import { useRef, useState } from 'react';
import { itemLabel, uuidv7, type Item, type WorkspaceSnapshot } from '@cockpit/shared';
import { useLatestSnapshot, useSendCommand } from './api/queries';
import { filedOrderOnPanel, ordersForFilingSeveral } from './filing';
import {
  NO_PANEL_EDITS,
  afterAdding,
  afterRemoving,
  hasPanelEdits,
  panelsFiledOn,
  panelsWithEdits,
  type PanelEdits,
  type PanelOn,
} from './itemPanels';
import { browserStore } from './lastVisited';
import { rememberRecentPanel } from './recentPanels';
import { useUndo } from './undo';

const failureOf = (error: unknown) =>
  error instanceof Error ? error.message : 'That did not reach the server. Try again.';

/**
 * The Item form's *On panels* field ("List and change an Item's Panels in its
 * form, in place of Shown on", issue 1106): the Panels shown, and the changes to
 * them, with the commands **Move to…** and the row's menu send - one per change.
 *
 * **The form's own timing.** Docked, each change is written at once and offered
 * back with Undo. Otherwise it is held, and `save` sends it after the fields, one
 * change at a time: a refusal partway leaves the earlier ones applied and says
 * which one failed. Each is built on the Panel as it stands by then, since an
 * order has to name what the Panel holds.
 */
export function useItemPanels({
  item,
  workspaceId,
  data,
  docked,
}: {
  item: Item | undefined;
  workspaceId: string;
  data: WorkspaceSnapshot | undefined;
  docked: boolean;
}) {
  const send = useSendCommand();
  const latestSnapshot = useLatestSnapshot();
  const offerToUndo = useUndo();
  const [edits, setEdits] = useState<PanelEdits>(NO_PANEL_EDITS);
  const editsRef = useRef(edits);
  const change = (next: (was: PanelEdits) => PanelEdits) => {
    editsRef.current = next(editsRef.current);
    setEdits(editsRef.current);
  };
  /** Why the last change was refused, said beside the field and gone with the next attempt. */
  const [refusal, setRefusal] = useState<string | null>(null);
  /** Docked changes run one after another, each reading the Panel as the one before left it. */
  const inTurn = useRef<Promise<void>>(Promise.resolve());

  const itemId = item?.id ?? '';
  const held = item ? panelsFiledOn(itemId, data?.filings ?? [], data?.panels ?? []) : [];
  const shown = panelsWithEdits(held, edits);
  const heldRef = useRef(held);
  heldRef.current = held;

  const envelope = () => ({
    commandId: uuidv7(),
    issuedAt: new Date().toISOString(),
    workspaceId,
    itemId,
  });

  /** Files the Item on one more Panel, leaving the others alone. Answers whether it sent anything. */
  const fileOn = async (one: PanelOn): Promise<boolean> => {
    const filings = (await latestSnapshot(workspaceId)).filings ?? [];
    if (filings.some((filing) => filing.itemId === itemId && filing.panelId === one.panelId)) return false;
    const [order] = ordersForFilingSeveral(filedOrderOnPanel(filings, one.panelId), [itemId]);
    await send({ name: 'add_item_to_panel', payload: { ...envelope(), panelId: one.panelId, order: order! } });
    rememberRecentPanel(browserStore(), workspaceId, one.panelId);
    return true;
  };

  /** Takes the Item off one Panel. Answers the order the Panel was in, or null where it was not on it. */
  const takeOff = async (panelId: string): Promise<string[] | null> => {
    const filings = (await latestSnapshot(workspaceId)).filings ?? [];
    if (!filings.some((filing) => filing.itemId === itemId && filing.panelId === panelId)) return null;
    await send({ name: 'remove_item_from_panel', payload: { ...envelope(), panelId } });
    return filedOrderOnPanel(filings, panelId);
  };

  const putOn = (panelId: string, order: string[]) =>
    send({ name: 'add_item_to_panel', payload: { ...envelope(), panelId, order } });
  const putOff = (panelId: string) =>
    send({ name: 'remove_item_from_panel', payload: { ...envelope(), panelId } });

  const writeAdd = async (one: PanelOn) => {
    if (!item) return;
    setRefusal(null);
    try {
      if (!(await fileOn(one))) return;
    } catch (error) {
      setRefusal(`It was not filed on “${one.name}”. ${failureOf(error)}`);
      return;
    }
    offerToUndo({ what: `“${itemLabel(item)}” added to ${one.name}`, undo: () => putOff(one.panelId) });
  };

  const writeRemove = async (one: PanelOn) => {
    if (!item) return;
    setRefusal(null);
    let before: string[] | null;
    try {
      before = await takeOff(one.panelId);
    } catch (error) {
      setRefusal(`It was not taken off “${one.name}”. ${failureOf(error)}`);
      return;
    }
    if (before === null) return;
    // Back on in the order the Panel was in, which still names it: read before it was taken off.
    offerToUndo({ what: `“${itemLabel(item)}” removed from ${one.name}`, undo: () => putOn(one.panelId, before) });
  };

  const inTurnDo = (work: () => Promise<void>) => {
    inTurn.current = inTurn.current.then(work).catch(() => undefined);
  };

  return {
    /** The Panels the field lists. */
    shown,
    /** That something is held for Save to send. */
    pending: hasPanelEdits(edits),
    refusal,
    add: (one: PanelOn) => {
      // A removal still held (a refused one, from before the form was docked) is just put back.
      if (docked && !editsRef.current.removed.includes(one.panelId)) inTurnDo(() => writeAdd(one));
      else change((was) => afterAdding(was, heldRef.current, one));
    },
    remove: (panelId: string) => {
      const one = shown.find((there) => there.panelId === panelId);
      if (!one) return;
      // An addition still held (one the Dock switch could not send) was never filed: dropping it is all there is to write.
      if (docked && !editsRef.current.added.some((there) => there.panelId === panelId)) inTurnDo(() => writeRemove(one));
      else change((was) => afterRemoving(was, heldRef.current, panelId));
    },
    /**
     * Sends what is held, the filings before the removals so that swapping one
     * Panel for another never passes through the Inbox. Answers null where all
     * of it landed, else what failed; what landed stays applied and is no
     * longer held.
     */
    save: async (): Promise<string | null> => {
      setRefusal(null);
      for (const one of [...editsRef.current.added]) {
        try {
          await fileOn(one);
        } catch (error) {
          const why = `It was not filed on “${one.name}”. ${failureOf(error)}`;
          setRefusal(why);
          return why;
        }
        change((was) => ({ ...was, added: was.added.filter((there) => there.panelId !== one.panelId) }));
      }
      for (const panelId of [...editsRef.current.removed]) {
        try {
          await takeOff(panelId);
        } catch (error) {
          const name = heldRef.current.find((one) => one.panelId === panelId)?.name ?? 'a Panel';
          const why = `It was not taken off “${name}”. ${failureOf(error)}`;
          setRefusal(why);
          return why;
        }
        change((was) => ({ ...was, removed: was.removed.filter((id) => id !== panelId) }));
      }
      return null;
    },
  };
}

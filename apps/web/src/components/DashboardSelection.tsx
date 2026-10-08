import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { stillOpen } from '../filing';
import { dashboardScope, endSelection, useHeldTo, useSelection } from '../selection';
import { SelectionBar } from './SelectionBar';
import { useEditingSeveral } from './useEditingSeveral';
import { useFilingSeveral } from './useFilingSeveral';

/**
 * What is picked across the Panels of the open Dashboard, and the one bar to act
 * on it ("Select across every panel of a dashboard, with Select all on a panel
 * and on the dashboard", issue 863).
 *
 * **Drawn once by the board rather than by each Panel**, because the selection
 * is the Dashboard's: a bar per Panel could say only how many of its own rows
 * were picked. Moving files every picked Item, from whichever Panel, the way
 * the Inbox's bar files its own (`useFilingSeveral`), and editing a field of
 * every one the same way (`useEditingSeveral`).
 *
 * **It also keeps the selection honest.** It is what holds the Dashboard's
 * scope to the rows its Panels show between them, and what ends it when the
 * Dashboard is left.
 */
export function DashboardSelection({
  workspaceId,
  dashboardId,
}: {
  workspaceId: string;
  dashboardId: string;
}) {
  const scope = dashboardScope(dashboardId);
  const selection = useSelection(scope);
  useHeldTo(scope);
  const { data } = useQuery(snapshotQuery(workspaceId));

  // In the order they were picked, which is the only order the Panels have in
  // common: a Panel's own rows are in front of you, and one Item may be in two.
  // Read through the snapshot rather than through each Panel's rows, and left
  // out once finished, as pruning will in a moment.
  const byId = new Map((data?.items ?? []).filter(stillOpen).map((item) => [item.id, item]));
  const picked = [...selection.picked].flatMap((id) => byId.get(id) ?? []);
  const filingSeveral = useFilingSeveral({
    workspaceId,
    openDashboardId: dashboardId,
    scope,
    picked,
  });
  const editing = useEditingSeveral({ workspaceId, picked, filing: filingSeveral.filing });

  return (
    <>
      {picked.length > 0 && (
        <SelectionBar
          onBoard
          count={picked.length}
          filing={filingSeveral.filing}
          refusal={[filingSeveral.refusal, editing.refusal].filter(Boolean).join(' ') || null}
          saving={editing.saving}
          editMenu={editing.menu}
          dateField={editing.dateField}
          onMoveTo={filingSeveral.ask}
          onClear={() => endSelection(scope)}
        />
      )}
      {filingSeveral.pickers}
    </>
  );
}

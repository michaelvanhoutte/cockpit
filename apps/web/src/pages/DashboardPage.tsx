import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { dashboardRoute } from '../router';
import { LoadFailure } from '../components/LoadFailure';
import { PanelBoard } from '../components/PanelBoard';
import { itemsLeftOut } from '../persistence';

/**
 * One dashboard of a workspace ("Add and switch dashboards", issue 32), holding
 * its panels ("Panels on a dashboard, with per-screen-size layouts", issue 33).
 *
 * The panels and the layouts arranging them come out of the workspace's
 * snapshot, which this page is reading anyway (architecture, "The read model:
 * persisted snapshot, revalidate, push") - so switching dashboards changes what
 * is drawn without a call of its own to keep in step, and a dashboard opens
 * from the copy in hand.
 */
export function DashboardPage() {
  const { workspaceId, dashboardId } = dashboardRoute.useParams();
  const { data, dataUpdatedAt, isLoading, error, refetch } = useQuery(snapshotQuery(workspaceId));
  const leftOut = itemsLeftOut(workspaceId, dataUpdatedAt);

  if (error && !data) {
    return <LoadFailure error={error} onRetry={() => void refetch()} />;
  }
  if (isLoading || !data) {
    return <p className="text-ink-faint">Loading…</p>;
  }

  const dashboard = data.dashboards.find((d) => d.id === dashboardId);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {/* No notice here when there is a stored copy to draw from: the shell
          says it once for the whole window (Layout.tsx), because a workspace
          that cannot be read is a fact about the workspace rather than about
          this page - and the Inbox column beside it reads the same snapshot. */}
      {leftOut > 0 && (
        <p role="status" className="text-sm text-ink-faint">
          {leftOut === 1
            ? "1 Item was saved by an older version and can't be shown offline."
            : `${leftOut} Items were saved by an older version and can't be shown offline.`}
        </p>
      )}
      {dashboard && (
        // Keyed by the dashboard, so switching to another one starts clean: the
        // half-typed panel name, the open question and any arrangement not yet
        // saved all belong to the dashboard being left.
        <PanelBoard
          key={dashboard.id}
          workspaceId={workspaceId}
          dashboard={dashboard}
          dashboards={data.dashboards}
          // `?? []`: guards kept from before saved reads were checked on the
          // way back in (`savedReads.ts`), when a snapshot saved before these
          // fields had none.
          panels={(data.panels ?? []).filter((panel) => panel.dashboardId === dashboard.id)}
          // Unfiltered, and deliberately beside the line above: whether a
          // filing files is a fact about the Panel it names rather than about
          // the dashboard being drawn (`panelsInWorkspace`, PanelBoard.tsx).
          panelsInWorkspace={data.panels ?? []}
          layouts={data.layouts ?? []}
          items={data.items}
          filings={data.filings ?? []}
          attachments={data.attachments ?? []}
          agentRuns={data.agentRuns ?? []}
        />
      )}
    </div>
  );
}

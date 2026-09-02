import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { dashboardRoute } from '../router';
import { LoadFailure } from '../components/LoadFailure';
import { PanelBoard } from '../components/PanelBoard';

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
  const { data, isLoading, error, refetch } = useQuery(snapshotQuery(workspaceId));

  if (error && !data) {
    return <LoadFailure error={error} onRetry={() => void refetch()} canTakeOver />;
  }
  if (isLoading || !data) {
    return <p className="text-ink-faint">Loading…</p>;
  }

  const dashboard = data.dashboards.find((d) => d.id === dashboardId);

  return (
    <div className="flex min-w-0 flex-col gap-6">
      {error && <LoadFailure error={error} onRetry={() => void refetch()} />}

      {dashboard && (
        // Keyed by the dashboard, so switching to another one starts clean: the
        // half-typed panel name, the open question and any arrangement not yet
        // saved all belong to the dashboard being left.
        <PanelBoard
          key={dashboard.id}
          workspaceId={workspaceId}
          dashboard={dashboard}
          // `?? []` because a snapshot can be older than these two fields.
          // The stored copy is rehydrated from IndexedDB without being parsed
          // again (main.tsx), so somebody who had Cockpit open before this
          // landed opens it afterwards holding a snapshot with no `panels` at
          // all - and reading through it would be a blank screen rather than an
          // empty dashboard, worst of all while offline, where no answer is
          // coming to repair it.
          panels={(data.panels ?? []).filter((panel) => panel.dashboardId === dashboard.id)}
          layouts={data.layouts ?? []}
        />
      )}
    </div>
  );
}

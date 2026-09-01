import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { dashboardRoute } from '../router';
import { LoadFailure } from '../components/LoadFailure';

/**
 * One dashboard of a workspace ("Add and switch dashboards", issue 32).
 *
 * It holds nothing until "Panels on a dashboard, with per-screen-size layouts"
 * (issue 33) lands, so every dashboard is empty today and says so. That is
 * expected: the message is what makes switching visibly do something from the
 * day the bar ships, rather than moving between screens that look identical.
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
    <div className="flex flex-col gap-6">
      {error && <LoadFailure error={error} onRetry={() => void refetch()} />}

      <section className="rounded-lg bg-surface px-4 py-10 text-center shadow-panel">
        <h2 className="text-base font-semibold">{dashboard?.name ?? 'Dashboard'}</h2>
        <p className="mt-2 text-sm text-ink-faint">
          Nothing on this dashboard yet. Panels are what go here.
        </p>
      </section>
    </div>
  );
}

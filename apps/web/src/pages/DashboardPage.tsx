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

      {/* An invitation rather than an apology: it says what a dashboard is for
          instead of reporting that this one is empty. Deliberately with nothing
          to press - panels are "Panels on a dashboard, with per-screen-size
          layouts" (issue 33), so a button here would lead nowhere. */}
      <section className="rounded-lg bg-surface px-4 py-14 text-center shadow-panel">
        <h2 className="text-lg font-semibold tracking-tight">{dashboard?.name ?? 'Dashboard'}</h2>
        <p className="mx-auto mt-2 max-w-md text-sm text-ink-faint">
          A dashboard holds the panels you want in view — a slice of your work, kept where you can
          see it. This one has none yet.
        </p>
        {/* Three empty places where panels will go. It is what the screen is
            for, drawn faintly, rather than a sentence about what is missing. */}
        <div aria-hidden="true" className="mx-auto mt-8 flex max-w-lg gap-3">
          {[0, 1, 2].map((slot) => (
            // `black/20` rather than the `black/10` the app's hairlines use:
            // this sits on the panel's own near-white surface rather than on
            // the tinted ground, and at a tenth it was drawn but not visible.
            <div key={slot} className="h-16 flex-1 rounded-lg border border-dashed border-black/20" />
          ))}
        </div>
      </section>
    </div>
  );
}

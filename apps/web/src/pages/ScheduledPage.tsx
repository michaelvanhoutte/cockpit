import { Suspense, lazy } from 'react';
import { scheduledRoute } from '../router';

// Out of the initial bundle, as the *All items* table is: only the tab and its
// menu entry load first, the table once somebody has asked for it.
const ScheduledBoard = lazy(() => import('../components/ScheduledBoard'));

/**
 * The repeating Items of a workspace in one table, at an address of its own so
 * that Back, a reload and a copied link land on it ("See what is scheduled to
 * come back", issue 1431). The tab that selects it is the dashboard bar's
 * (`DashboardBar.tsx`).
 */
export function ScheduledPage() {
  const { workspaceId } = scheduledRoute.useParams();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Suspense fallback={<p className="text-ink-faint">Loading…</p>}>
        <ScheduledBoard workspaceId={workspaceId} />
      </Suspense>
    </div>
  );
}

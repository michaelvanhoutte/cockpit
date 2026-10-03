import { Suspense, lazy } from 'react';
import { allItemsRoute } from '../router';

// Out of the initial bundle: the table is only drawn once somebody has asked
// for it, so only the tab and its menu entry are in what loads first.
const AllItemsBoard = lazy(() => import('../components/AllItemsBoard'));

/**
 * Every item of a workspace in one table, at an address of its own so that
 * Back, a reload and a copied link land on it ("Put each setting where a person
 * looks for it", issue 688). The tab that selects it is the dashboard bar's
 * (`DashboardBar.tsx`).
 */
export function AllItemsPage() {
  const { workspaceId } = allItemsRoute.useParams();
  return (
    <div className="flex min-w-0 flex-col gap-6">
      <Suspense fallback={<p className="text-ink-faint">Loading…</p>}>
        <AllItemsBoard workspaceId={workspaceId} />
      </Suspense>
    </div>
  );
}

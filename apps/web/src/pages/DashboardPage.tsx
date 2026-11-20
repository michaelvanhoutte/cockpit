import { Suspense, lazy } from 'react';
import { useSnapshot } from '../api/useSnapshot';
import { dashboardRoute } from '../router';
import { LoadFailure } from '../components/LoadFailure';
import { PanelBoard } from '../components/PanelBoard';
import { itemsLeftOut } from '../persistence';
import { boardLayoutOf } from '../boardLayout';
import { useBoardOnPhone } from '../boardFocus';
import { useRoomForTheInbox } from '../roomForTheInbox';

/** The whiteboard and the panes around it, with `@xyflow/react`: a chunk of their own, fetched once a board is shown. */
const DashboardViews = lazy(() => import('../whiteboard/DashboardViews'));

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
  const { data, dataUpdatedAt, isLoading, error, refetch } = useSnapshot(workspaceId);
  const leftOut = itemsLeftOut(workspaceId, dataUpdatedAt);
  const phone = !useRoomForTheInbox();
  // A phone shows the Panels or the whiteboard, one at a time, chosen in the Dashboard bar (`LayoutSwitch`).
  const boardOnPhone = useBoardOnPhone(dashboardId);

  if (error && !data) {
    return <LoadFailure error={error} onRetry={() => void refetch()} />;
  }
  if (isLoading || !data) {
    return <p className="text-ink-faint">Loading…</p>;
  }

  const dashboard = data.dashboards.find((d) => d.id === dashboardId);
  const { view, splitShare } = boardLayoutOf(data, dashboardId);
  const showsBoard = phone ? boardOnPhone : view !== 'panels';

  return (
    <div className={`flex min-w-0 flex-col ${showsBoard ? 'h-full gap-2' : 'gap-6'}`}>
      {/* No notice here when there is a read held to draw from: the shell
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
      {dashboard &&
        (() => {
          const panels = (
            // Keyed by the dashboard, so switching to another one starts clean: the
            // half-typed panel name, the open question and any arrangement not yet
            // saved all belong to the dashboard being left.
            <PanelBoard
              key={dashboard.id}
              workspaceId={workspaceId}
              dashboard={dashboard}
              dashboards={data.dashboards}
              panels={data.panels.filter((panel) => panel.dashboardId === dashboard.id)}
              // Unfiltered, and deliberately beside the line above: whether a
              // filing files is a fact about the Panel it names rather than about
              // the dashboard being drawn (`panelsInWorkspace`, PanelBoard.tsx).
              panelsInWorkspace={data.panels}
              layouts={data.layouts}
              items={data.items}
              filings={data.filings}
              attachments={data.attachments}
              agentRuns={data.agentRuns}
              childRows={data.children ?? []}
            />
          );
          if (!showsBoard) return panels;
          return (
            <Suspense fallback={<p className="text-sm text-ink-faint">Loading the whiteboard…</p>}>
              <DashboardViews
                // Keyed for the reason the Panels are: each board's camera, tool and half-drawn box are its own.
                key={dashboard.id}
                workspaceId={workspaceId}
                dashboardId={dashboard.id}
                view={phone ? 'board' : view}
                splitShare={splitShare}
                readOnly={phone}
                panels={panels}
              />
            </Suspense>
          );
        })()}
    </div>
  );
}

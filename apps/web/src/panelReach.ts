import { useCallback } from 'react';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useNavigate, useParams, useRouter } from '@tanstack/react-router';
import { panelHoldsText } from '@cockpit/shared';
import type { Workspace, WorkspaceSnapshot } from '@cockpit/shared';
import { snapshotQuery, workspacesQuery } from './api/queries';
import { isFiltering, itemIdsWithAttachments, itemIdsWithRun, readDashboardFilter } from './dashboardFilter';
import { orderedAsDrawn } from './filterGroups';
import { dayOf } from './filters';
import { browserStore } from './lastVisited';
import { itemsShownOn } from './panelContents';
import type { PanelListEntry } from './panelList';

/**
 * Where Go to panel searches: 1 this Dashboard, 2 every Dashboard of this
 * Workspace, 3 every Workspace ("Go to a Panel on any Dashboard or Workspace,
 * the screen following the highlight", issue 814).
 */
export type Scope = 1 | 2 | 3;

export type ReachDashboard = { id: string; name: string; entries: readonly PanelListEntry[] };

/** One Workspace as the list draws it: read, still being read, or not readable. */
export type ReachWorkspace = {
  id: string;
  name: string;
  color: string;
  state: 'ready' | 'loading' | 'failed';
  /** How many Dashboards it has, empty ones too, so a scope that adds nothing can say so. */
  dashboardCount: number;
  /** In tab order; a Dashboard with no Panels is left out. */
  dashboards: readonly ReachDashboard[];
};

/** Where the screen is, which Workspaces there are, and how to move the screen. */
export type Reach = {
  workspaceId: string;
  dashboardId: string;
  /** In tab order. */
  workspaces: readonly ReachWorkspace[];
  /** Says how wide the list is searching, so no Workspace is read before a wider scope is chosen. */
  ask: (scope: Scope) => void;
  /** `push` adds a history entry, `replace` swaps the current one, `back` returns to the one before. */
  go: (to: { workspaceId: string; dashboardId: string }, how: 'push' | 'replace' | 'back') => void;
};

/**
 * Every Panel of every Dashboard of a Workspace, as its header would count it:
 * in the order the Layout draws them, counted by the same rule the board uses
 * (`itemsShownOn`) against the Dashboard's own stored filter - so a Panel the
 * filter leaves undrawn reads `hidden`, a Filter panel counts what it gathers
 * and a Panel of text counts nothing.
 */
export function dashboardsOf(snapshot: WorkspaceSnapshot, store: Storage | undefined): ReachDashboard[] {
  const panelsInWorkspace = snapshot.panels ?? [];
  const layouts = snapshot.layouts ?? [];
  const today = dayOf(new Date());
  const withAttachments = itemIdsWithAttachments(snapshot.attachments ?? []);
  const withRun = itemIdsWithRun(snapshot.agentRuns ?? []);
  const found: ReachDashboard[] = [];
  for (const dashboard of snapshot.dashboards) {
    const filter = readDashboardFilter(store, dashboard.id);
    const ordered = orderedAsDrawn(
      panelsInWorkspace.filter((panel) => panel.dashboardId === dashboard.id),
      layouts.find((layout) => layout.dashboardId === dashboard.id) ?? null,
    );
    const entries = ordered.map((panel): PanelListEntry => {
      const shown = itemsShownOn(panel, {
        items: snapshot.items,
        filings: snapshot.filings ?? [],
        panelsInWorkspace,
        itemTypes: snapshot.itemTypes,
        filter,
        withAttachments,
        withRun,
        today,
      });
      return {
        panelId: panel.id,
        title: panel.name,
        count: panelHoldsText(panel) ? null : shown.length,
        hidden: shown.length === 0 && isFiltering(filter),
      };
    });
    if (entries.length > 0) found.push({ id: dashboard.id, name: dashboard.name, entries });
  }
  return found;
}

/**
 * What the list searches beyond the Dashboard on screen. **A Workspace's
 * snapshot is read only once a scope that needs it is chosen**: the one on
 * screen for *Workspace*, every one for *All*; at *Dashboard* the cache is read
 * and nothing is asked for.
 */
export function useReach(asked: Scope, ask: (scope: Scope) => void): Reach {
  const params = useParams({ strict: false });
  const router = useRouter();
  const navigate = useNavigate();
  const workspaceId = params.workspaceId ?? '';
  const dashboardId = params.dashboardId ?? '';
  const { data: list } = useQuery(workspacesQuery);
  const workspaces: readonly Workspace[] = list?.workspaces ?? [];
  const snapshots = useQueries({
    queries: workspaces.map((workspace) => ({
      ...snapshotQuery(workspace.id),
      enabled: asked === 3 || (asked === 2 && workspace.id === workspaceId),
    })),
  });

  // Worked out each render, since a Dashboard's filter lives in the browser's
  // storage and says nothing when another board changes it; only the wider
  // scopes pay for it.
  const reaching = workspaces.map((workspace, at): ReachWorkspace => {
    const read = snapshots[at];
    const snapshot = read?.data;
    const wanted = asked === 3 || (asked === 2 && workspace.id === workspaceId);
    return {
      id: workspace.id,
      name: workspace.name,
      color: workspace.color,
      state: snapshot ? 'ready' : read?.isError ? 'failed' : 'loading',
      dashboardCount: snapshot?.dashboards.length ?? 0,
      dashboards: snapshot && wanted ? dashboardsOf(snapshot, browserStore()) : [],
    };
  });

  const go = useCallback<Reach['go']>(
    (to, how) => {
      if (how === 'back') router.history.back();
      else {
        void navigate({
          to: '/w/$workspaceId/d/$dashboardId',
          params: { workspaceId: to.workspaceId, dashboardId: to.dashboardId },
          replace: how === 'replace',
        });
      }
    },
    [router, navigate],
  );

  return { workspaceId, dashboardId, workspaces: reaching, ask, go };
}

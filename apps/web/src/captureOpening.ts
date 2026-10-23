import { isRedirect, redirect } from '@tanstack/react-router';
import type { WorkspaceSnapshot } from '@cockpit/shared';
import { CAPTURE_PANEL, CAPTURE_WORKSPACE, addressNames, captureOpenedBy } from './captureAddress';
import { captureStateFor } from './captureState';

/**
 * Capture opened from an address that names a Workspace and perhaps a Panel
 * (`captureAddress.ts`, issue 1445): what an installed widget's + opens.
 *
 * **Turned into the navigation state a Panel's own + opens Capture with, and
 * the address dropped**, so the page and the form know one way in and Back does
 * not come to an address that would open it again. The Workspace's snapshot is
 * read only to find the Panel; one that cannot be read leaves *File on* empty,
 * which is what a Panel gone from the Workspace does as well.
 *
 * **Loaded by the router only when an address names one** (`router.tsx`), so a
 * typed `/capture` and every other way in do not carry it in the first bundle.
 */
export async function opensFromItsAddress(
  snapshotHoldingPanel: (workspaceId: string, panelId: string) => Promise<Pick<WorkspaceSnapshot, 'panels'>>,
  workspaces: readonly { id: string }[],
  location: { pathname: string; search: unknown },
): Promise<void> {
  const search = location.search as Record<string, unknown>;
  const { workspaceId, panelId } = addressNames(search);
  if (!workspaceId && !panelId) return;
  const snapshot =
    panelId && workspaceId && workspaces.some((workspace) => workspace.id === workspaceId)
      ? await snapshotHoldingPanel(workspaceId, panelId).catch((failure: unknown) => {
          if (isRedirect(failure)) throw failure;
          return undefined;
        })
      : undefined;
  const opened = captureOpenedBy(search, workspaces, snapshot);
  const { [CAPTURE_WORKSPACE]: _workspace, [CAPTURE_PANEL]: _panel, ...left } = search;
  throw redirect({
    to: location.pathname as never,
    search: left as never,
    state: captureStateFor(opened?.captureFrom, opened?.captureOn),
    replace: true,
  });
}

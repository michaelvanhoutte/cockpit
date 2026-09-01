import { Navigate } from '@tanstack/react-router';
import { inboxRoute } from '../router';
import { InboxPanel } from '../components/InboxPanel';
import { useRoomForTheInbox } from '../roomForTheInbox';

/**
 * The Inbox as a screen of its own, which is what it is on a phone: below the
 * breakpoint it is a tab in the bar and this is what the tab opens ("Show the
 * Inbox beside the dashboards instead of as a tab", issue 117).
 *
 * **Where there is room, this address is not a screen.** The Inbox is already
 * on the left of every screen in the workspace, so rendering it here as well
 * would show it twice; the workspace's own address decides where to go
 * instead, which is a dashboard. That happens here rather than in the route so
 * that widening the window on this address is answered too - a route decides
 * once, on arrival, and a window can be resized long after.
 */
export function WorkspacePage() {
  const { workspaceId } = inboxRoute.useParams();
  const roomForTheInbox = useRoomForTheInbox();

  if (roomForTheInbox) {
    return <Navigate to="/w/$workspaceId" params={{ workspaceId }} replace />;
  }

  return <InboxPanel workspaceId={workspaceId} />;
}

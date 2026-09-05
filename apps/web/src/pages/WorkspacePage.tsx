import { Navigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { snapshotQuery } from '../api/queries';
import { inboxRoute } from '../router';
import { InboxHeading, InboxPanel } from '../components/InboxPanel';
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
 *
 * **Unless there is nowhere else to go**, and that guard is not decoration: the
 * workspace's address sends you back here when the workspace has no dashboards
 * (lastVisited.ts), so going there unconditionally would be a redirect loop
 * rather than a screen. It cannot happen - a workspace is created with a
 * dashboard and its last one cannot be deleted - and the same "cannot happen"
 * is why `viewToOpen` answers the Inbox there rather than throwing. Showing the
 * Inbox twice is a poor screen; bouncing between two addresses is not a screen
 * at all.
 */
export function WorkspacePage() {
  const { workspaceId } = inboxRoute.useParams();
  const roomForTheInbox = useRoomForTheInbox();
  // Already in hand: the route this page is under read it on the way in.
  const { data } = useQuery(snapshotQuery(workspaceId));
  const somewhereElse = (data?.dashboards.length ?? 0) > 0;

  if (roomForTheInbox && somewhereElse) {
    return <Navigate to="/w/$workspaceId" params={{ workspaceId }} replace />;
  }

  /* The heading is here rather than in the band, which is where it is on a
     screen wide enough for the column: there is no column to head here, and the
     band's leftmost slot is the column's own width, which this screen does not
     have to give. */
  return (
    <section aria-labelledby={INBOX_HEADING} className="well-inbox">
      <div className="px-4 pt-3 pb-2">
        <InboxHeading workspaceId={workspaceId} id={INBOX_HEADING} />
      </div>
      <InboxPanel workspaceId={workspaceId} />
    </section>
  );
}

/** Its own, because on this screen the heading and the list are one component. */
const INBOX_HEADING = 'the-inbox-screen';

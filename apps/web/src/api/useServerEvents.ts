import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { ACCOUNT_WIDE, serverEventSchema } from '@cockpit/shared';
import { diagnoseConnection } from './loadFailure';

/**
 * Liveness via SSE (architecture, "The read model: persisted snapshot,
 * revalidate, push", §5.2): the server pushes "something changed" events and the
 * client revalidates the affected snapshot.
 *
 * `EventSource` reconnects on its own, but only from *some* failures, and the
 * split is the opposite of what you would want. Measured 2026-08-31 against the
 * built app, counting attempts over twenty seconds:
 *
 * | how the stream failed              | attempts | outcome            |
 * |------------------------------------|----------|--------------------|
 * | connection dropped (a wifi blip)   | 7        | retries ~every 3s  |
 * | answered with a redirect to sign in| 1        | dead for good      |
 * | answered `503`                     | 1        | dead for good      |
 *
 * So the browser handles the failure that heals itself anyway, and gives up
 * permanently on the two that need handling. A dead stream is invisible: no
 * error surfaces, the screen simply stops being true, and with the tab left
 * open and looked at there is no focus event to catch up on either.
 *
 * Hence this: notice a permanently closed stream and open a new one, backing
 * off so a deployment that is down is not hammered by every open tab.
 */

/** Matches what EventSource itself uses for its own retries. */
const FIRST_WAIT_MS = 3_000;
const LONGEST_WAIT_MS = 60_000;

export function useServerEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    let source: EventSource | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let wait = FIRST_WAIT_MS;
    let unmounted = false;

    const listen = () => {
      const stream = new EventSource('/v1/events');
      source = stream;

      stream.addEventListener('open', () => {
        // Back to square one, so a later failure waits the short time again.
        wait = FIRST_WAIT_MS;
      });

      stream.addEventListener('change', (message) => {
        const parsed = serverEventSchema.safeParse(JSON.parse(message.data));
        if (!parsed.success) return;
        void queryClient.invalidateQueries({
          queryKey: ['snapshot', parsed.data.workspaceId],
        });
        // The list too, because creating a workspace is announced on the new
        // workspace and nothing else would ever refetch it - so another tab
        // would keep showing the tabs it had when it loaded. The event says
        // only "something changed", which is deliberately all it says
        // (architecture, "How the client talks to the backend"), so the list is
        // revalidated rather than reasoned about.
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
        // A type change names the account rather than a workspace, because
        // types belong to the account and the page that manages them is
        // outside every workspace ("Manage the types, and put them in the
        // order you want", issue 156). Every snapshot draws them, so every
        // snapshot goes stale.
        if (parsed.data.workspaceId === ACCOUNT_WIDE) {
          void queryClient.invalidateQueries({ queryKey: ['itemTypes'] });
          void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
        }
      });

      stream.addEventListener('error', () => {
        // A stream still trying is left alone: that is EventSource doing the
        // job itself, and interfering would open a second stream alongside it.
        if (unmounted || stream.readyState !== EventSource.CLOSED) return;
        stream.close();
        void afterDeath();
      });
    };

    const afterDeath = async () => {
      // Anything but a dead connection is re-read, because `EventSource`
      // reports that it stopped and never why: there is no status here to tell
      // a sign-in that went from a request that vanished, and both want the
      // same move. Being offline is the one case that does not, since there is
      // nothing to re-read it against.
      //
      // Re-reading is how it gets said out loud: the read fails the same way,
      // with a status this time, and the screen the person already knows
      // explains it. Deliberately not a second way of announcing it, and
      // deliberately not a navigation — a tab showing your work keeps showing
      // it (functional definition, "Offline / local-first behavior").
      //
      // Both keys, because they answer different halves. The snapshot is what a
      // workspace renders an error for, so it is what puts the reason on
      // screen; who is signed in is what the shell watches, so it is what sends
      // the browser to the logon page when the answer is that nobody is. The
      // workspace *list* is neither: Layout takes only its `data`, so
      // invalidating that would fail again in silence.
      const reason = await diagnoseConnection();
      if (reason !== 'offline') {
        void queryClient.invalidateQueries({ queryKey: ['snapshot'] });
        void queryClient.invalidateQueries({ queryKey: ['me'] });
      }
      if (unmounted) return;
      retry = setTimeout(listen, wait);
      wait = Math.min(wait * 2, LONGEST_WAIT_MS);
    };

    listen();

    return () => {
      unmounted = true;
      clearTimeout(retry);
      source?.close();
    };
  }, [queryClient]);
}

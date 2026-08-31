import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { serverEventSchema } from '@cockpit/shared';
import { diagnoseConnection } from './loadFailure';

/**
 * Liveness via SSE (§5.2): the server pushes "something changed" events and the
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
      // A healthy deployment refusing us means the sign-in went. Re-reading is
      // how that gets said out loud: the read fails the same way, and the
      // screen the person already knows explains it. Deliberately not a second
      // way of announcing it, and deliberately not a navigation — a tab showing
      // your work keeps showing it (functional definition §10).
      if ((await diagnoseConnection()) === 'signed-out') {
        void queryClient.invalidateQueries({ queryKey: ['workspaces'] });
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

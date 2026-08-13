import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { serverEventSchema } from '@cockpit/shared';

/**
 * Liveness via SSE (§5.2): the server pushes "something changed" events and
 * the client revalidates the affected snapshot. EventSource reconnects
 * natively if the platform recycles the connection.
 */
export function useServerEvents() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const source = new EventSource('/v1/events');
    source.addEventListener('change', (message) => {
      const parsed = serverEventSchema.safeParse(JSON.parse(message.data));
      if (!parsed.success) return;
      void queryClient.invalidateQueries({
        queryKey: ['snapshot', parsed.data.workspaceId],
      });
    });
    return () => source.close();
  }, [queryClient]);
}

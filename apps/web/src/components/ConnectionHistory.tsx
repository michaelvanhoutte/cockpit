import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { connectionHistorySchema, type ConnectionHistory as History, type SourceAccount } from '@cockpit/shared';
import { api, refusal } from '../api/client';
import { historyDays } from '../connectionHistory';
import { LoadFailure } from './LoadFailure';

/** One connection's history, read when it is opened and never from a copy. */
async function fetchHistory(workspaceId: string, sourceAccountId: string): Promise<History> {
  const res = await api.v1.workspaces[':workspaceId'].connections[':sourceAccountId'].history.$get({
    param: { workspaceId, sourceAccountId },
  });
  if (!res.ok) throw refusal('connection history', res.status);
  return connectionHistorySchema.parse(await res.json());
}

/**
 * A connection's history, drawn in place of the Connections list it was
 * opened from ("See when a pulled connection was checked, and why it failed,
 * from its row's History…", issue 1140): newest first, under the day each
 * line last ran on, *Worked* and *Failed* said in words as well as colour.
 * *‹ Connections* goes back to the list it came from.
 */
export function ConnectionHistory({
  workspaceId,
  account,
  onBack,
}: {
  workspaceId: string;
  account: SourceAccount;
  onBack: () => void;
}) {
  const { data, error, refetch } = useQuery({
    queryKey: ['connectionHistory', workspaceId, account.id],
    queryFn: () => fetchHistory(workspaceId, account.id),
    staleTime: 0,
  });
  const back = useRef<HTMLButtonElement>(null);
  // Opened from a menu that has gone with the list, so the focus starts on the way back.
  useEffect(() => back.current?.focus(), []);

  return (
    <section aria-label={`History of ${account.displayName}`} className="mt-4 flex min-h-0 flex-1 flex-col">
      <div>
        <button
          ref={back}
          type="button"
          onClick={onBack}
          className="rounded-md px-1 text-sm text-ink-soft hover:bg-shade/5 hover:text-ink"
        >
          ‹ Connections
        </button>
      </div>
      <h3 className="mt-2 text-sm font-medium">History of {account.displayName}</h3>
      <div className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto px-2">
        {error && !data && <LoadFailure error={error} onRetry={() => void refetch()} />}
        {data && data.lines.length === 0 && <p className="py-2 text-sm text-ink-faint">No checks yet.</p>}
        {data &&
          historyDays(data.lines, new Date()).map((day) => (
            <section key={day.heading} aria-label={day.heading} className="mt-3 first:mt-0">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{day.heading}</h4>
              <ul className="mt-1">
                {day.lines.map((line) => (
                  <li key={line.id} className="flex gap-3 border-b border-shade/5 py-1.5 text-sm last:border-b-0">
                    <span className="w-28 shrink-0 tabular-nums text-ink-faint">{line.when}</span>
                    <span className="min-w-0 flex-1">
                      <span className={line.failed ? 'font-medium text-over-ink' : 'text-ink-soft'}>{line.says}</span>
                      {line.detail && <span className="break-words text-ink-faint"> · {line.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
      </div>
    </section>
  );
}

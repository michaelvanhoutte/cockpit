import { useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { connectionHistorySchema, type ConnectionHistory as History, type SourceAccount } from '@cockpit/shared';
import { api, refusal } from '../api/client';
import { historyDays, olderDaysNote } from '../connectionHistory';
import { useOpenItem } from '../itemForm';
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
  onCheckNow,
  checkNowPending,
  checkNowNote,
  onBack,
}: {
  workspaceId: string;
  account: SourceAccount;
  /** Asks for the connection's check at once (issue 1143); its line arrives here when the check ends. */
  onCheckNow: () => void;
  checkNowPending: boolean;
  checkNowNote: { ok: boolean; text: string } | null;
  onBack: () => void;
}) {
  const { data, error, refetch } = useQuery({
    queryKey: ['connectionHistory', workspaceId, account.id],
    queryFn: () => fetchHistory(workspaceId, account.id),
    // Dropped as the view closes, so opening it again never draws the last
    // read while the new one is under way, or over a new one that failed.
    staleTime: 0,
    gcTime: 0,
  });
  const back = useRef<HTMLButtonElement>(null);
  const openItem = useOpenItem();
  // The quiet past days whose lines were asked for (issue 1145).
  const [unfolded, setUnfolded] = useState<ReadonlySet<string>>(new Set());
  const toggle = (day: string) =>
    setUnfolded((held) => {
      const next = new Set(held);
      if (!next.delete(day)) next.add(day);
      return next;
    });
  const now = new Date();
  const older = data ? olderDaysNote(data.olderRemain, now) : null;
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
      <div className="mt-2 flex items-center gap-3">
        <h3 className="min-w-0 flex-1 text-sm font-medium">History of {account.displayName}</h3>
        {account.pulled && (
          <button
            type="button"
            onClick={onCheckNow}
            disabled={checkNowPending}
            className="shrink-0 rounded-md border border-shade/10 px-3 py-1 text-sm hover:bg-shade/5 disabled:opacity-50"
          >
            Check now
          </button>
        )}
      </div>
      {checkNowNote && (
        <p
          role={checkNowNote.ok ? 'status' : 'alert'}
          className={`mt-1 text-sm ${checkNowNote.ok ? 'text-ink-soft' : 'text-over-ink'}`}
        >
          {checkNowNote.text}
        </p>
      )}
      <div className="-mx-2 mt-2 min-h-0 flex-1 overflow-y-auto px-2">
        {error && !data && <LoadFailure error={error} onRetry={() => void refetch()} />}
        {data && data.lines.length === 0 && <p className="py-2 text-sm text-ink-faint">{account.pulled ? 'No checks yet.' : 'Nothing delivered yet.'}</p>}
        {data &&
          historyDays(data.lines, now, data.olderRemain, account.followsListed).map((day) => (
            <section key={day.key} aria-label={day.heading} className="mt-3 first:mt-0">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{day.heading}</h4>
              <ul className="mt-1">
                {day.folded && (
                  <li className="flex gap-3 border-b border-shade/5 py-1.5 text-sm last:border-b-0">
                    <span className="w-28 shrink-0 tabular-nums text-ink-faint">{day.folded.when}</span>
                    <span className="min-w-0 flex-1">
                      <span className="text-ink-soft">{day.folded.says}</span>
                      <span className="text-ink-faint"> · </span>
                      <button
                        type="button"
                        aria-expanded={unfolded.has(day.key)}
                        onClick={() => toggle(day.key)}
                        className="rounded-sm text-ink-soft underline decoration-shade/30 hover:decoration-ink"
                      >
                        {unfolded.has(day.key) ? 'hide them' : 'show them'}
                      </button>
                    </span>
                  </li>
                )}
                {(day.folded === null || unfolded.has(day.key)) && day.lines.map((line) => (
                  <li key={line.id} className="flex gap-3 border-b border-shade/5 py-1.5 text-sm last:border-b-0">
                    <span className="w-28 shrink-0 tabular-nums text-ink-faint">{line.when}</span>
                    <span className="min-w-0 flex-1">
                      <span className={line.failed ? 'font-medium text-over-ink' : 'text-ink-soft'}>{line.says}</span>
                      {line.detail && <span className="break-words text-ink-faint"> · {line.detail}</span>}
                      {line.did.map((list) => (
                        <p key={list.label} className="mt-0.5 break-words text-ink-soft">
                          <span className="text-ink-faint">{list.label}: </span>
                          {list.items.map((item, index) => (
                            <span key={item.key}>
                              {index > 0 && ', '}
                              {item.id === null ? (
                                <span className="italic text-ink-faint">{item.text}</span>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => openItem(item.id!)}
                                  className="rounded-sm text-left underline decoration-shade/30 hover:decoration-ink"
                                >
                                  {item.text}
                                </button>
                              )}
                            </span>
                          ))}
                          {list.more > 0 && <span className="text-ink-faint"> and {list.more} more</span>}
                        </p>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        {older && <p className="mt-3 text-sm text-ink-faint">{older}</p>}
      </div>
    </section>
  );
}

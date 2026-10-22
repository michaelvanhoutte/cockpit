import { useSnapshot } from '../api/useSnapshot';
import { useOpenItem } from '../itemForm';
import { scheduledRows } from '../scheduled';
import { LoadFailure } from './LoadFailure';

const COLUMNS = ['Title', 'Repeats', 'Next on', 'Where it is'];

/**
 * Every running repeating Item of the workspace in one table, soonest *Next on*
 * first ("See what is scheduled to come back", issue 1431). Read from the
 * snapshot the workspace already holds, as *All items* is, so it asks the
 * server for nothing and works offline.
 *
 * A row opens the form of the series' latest copy, finished or not, where
 * *Repeats* is changed or stopped. There is no sort, filter or paging: a
 * workspace holds few series.
 */
export default function ScheduledBoard({ workspaceId }: { workspaceId: string }) {
  const { data, error, refetch } = useSnapshot(workspaceId);
  const openItem = useOpenItem();

  if (error && !data) return <LoadFailure error={error} onRetry={() => void refetch()} />;
  if (!data) return <p className="text-ink-faint">Loading…</p>;

  const rows = scheduledRows(data, new Date().getFullYear());

  return (
    <div className="flex min-w-0 flex-col">
      <section className="min-w-0 rounded-md border border-shade/10 bg-surface p-3" aria-label="Scheduled">
        <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-accent-deep">
          Scheduled <span className="text-ink-faint">{rows.length}</span>
        </h2>
        {rows.length === 0 ? (
          <p className="text-sm text-ink-faint">
            Nothing repeats yet. Open an Item and press ↻ Repeats on its form to make it come back every week, month or year.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[40rem] text-left text-sm">
              <thead>
                <tr className="border-b border-shade/10 text-xs uppercase tracking-wide text-ink-faint">
                  {COLUMNS.map((label) => (
                    <th key={label} scope="col" className="px-2 py-1.5 font-semibold">
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr
                    key={row.series.id}
                    data-series-id={row.series.id}
                    onClick={() => openItem(row.latest.id)}
                    className="cursor-pointer border-b border-shade/5 last:border-b-0 hover:bg-accent-tint"
                  >
                    <td className="max-w-[18rem] truncate px-2 py-1.5">
                      {/* The row's press reaches a mouse; this is the way in for a keyboard. */}
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          openItem(row.latest.id);
                        }}
                        className="max-w-full truncate text-left focus-visible:outline-2 focus-visible:outline-accent"
                      >
                        {row.title}
                      </button>
                    </td>
                    <td className="px-2 py-1.5">{row.repeats}</td>
                    <td className="whitespace-nowrap px-2 py-1.5">{row.nextOn}</td>
                    <td className="max-w-[14rem] truncate px-2 py-1.5">{row.where}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

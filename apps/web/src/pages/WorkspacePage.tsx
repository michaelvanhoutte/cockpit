import { useQuery } from '@tanstack/react-query';
import type { Item } from '@cockpit/shared';
import { snapshotQuery } from '../api/queries';
import { workspaceRoute } from '../router';
import { CaptureForm } from '../components/CaptureForm';
import { ItemRow } from '../components/ItemRow';

/**
 * v1 of the dashboard: the pinned Inbox panel (status to_process) plus one
 * "In play" panel for everything else that is open. Panel rules, pages, and
 * the grid layout build on top of this snapshot-derived rendering (§5.2:
 * panels evaluate client-side against the snapshot).
 */
export function WorkspacePage() {
  const { workspaceId } = workspaceRoute.useParams();
  const { data, isLoading, error } = useQuery(snapshotQuery(workspaceId));

  if (error) {
    return <p className="text-over">Could not load this workspace: {String(error)}</p>;
  }
  if (isLoading || !data) {
    return <p className="text-ink-faint">Loading…</p>;
  }

  const inbox = data.items.filter((i) => i.status === 'to_process');
  const inPlay = data.items.filter((i) => i.status !== 'to_process' && i.status !== 'done');
  const done = data.items.filter((i) => i.status === 'done');

  return (
    <div className="flex flex-col gap-6">
      <CaptureForm workspaceId={workspaceId} />

      <Panel title="Inbox" subtitle="to process" items={inbox} workspaceId={workspaceId} />
      <Panel title="In play" subtitle="tasks · waiting · snoozed" items={inPlay} workspaceId={workspaceId} />
      {done.length > 0 && (
        <Panel title="Done" subtitle="completed" items={done} workspaceId={workspaceId} />
      )}
    </div>
  );
}

function Panel(props: { title: string; subtitle: string; items: Item[]; workspaceId: string }) {
  return (
    <section className="rounded-lg bg-surface shadow-panel">
      <header className="flex items-baseline gap-2 border-b border-black/5 px-4 py-3">
        <h2 className="text-base font-semibold">{props.title}</h2>
        <span className="text-xs text-ink-faint">{props.subtitle}</span>
        <span className="ml-auto rounded-full bg-accent-tint px-2 text-xs text-accent-deep">
          {props.items.length}
        </span>
      </header>
      {props.items.length === 0 ? (
        <p className="px-4 py-4 text-sm text-ink-faint">Nothing here.</p>
      ) : (
        <ul>
          {props.items.map((item) => (
            <ItemRow key={item.id} item={item} workspaceId={props.workspaceId} />
          ))}
        </ul>
      )}
    </section>
  );
}

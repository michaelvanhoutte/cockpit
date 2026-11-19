import { lazy, Suspense, useState } from 'react';
import { createPortal } from 'react-dom';
import { stillOpen } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { ink, Swatches, tint, useColourOf, useSetColour } from './colour';
import { hiddenKey, panelParentsKey, usePoc } from './store';

const ItemList = lazy(() => import('../components/ItemList').then((loaded) => ({ default: loaded.ItemList })));

/** POC (throwaway): the Panels inside this one, each a row with its own expander, unfolding to its own rows. */
export function PocChildPanels({ workspaceId, panelId }: { workspaceId: string; panelId: string }) {
  const [parentOf] = usePoc<Record<string, string>>(panelParentsKey(workspaceId), {});
  const { data } = useSnapshot(workspaceId);
  const children = (data?.panels ?? []).filter((panel) => parentOf[panel.id] === panelId);
  if (!data || children.length === 0) return null;
  return (
    <ul className="border-b border-shade/10">
      {children.map((panel) => (
        <ChildPanel key={panel.id} workspaceId={workspaceId} panelId={panel.id} name={panel.name} dashboardId={panel.dashboardId} />
      ))}
    </ul>
  );
}

function ChildPanel({ workspaceId, panelId, name, dashboardId }: { workspaceId: string; panelId: string; name: string; dashboardId: string }) {
  const [open, setOpen] = useState(false);
  const { data } = useSnapshot(workspaceId);
  const [hidden] = usePoc<string[]>(hiddenKey(workspaceId), []);
  const colour = useColourOf(workspaceId, `panel:${panelId}`);
  const byId = new Map((data?.items ?? []).map((item) => [item.id, item]));
  const items = (data?.filings ?? [])
    .filter((filing) => filing.panelId === panelId)
    .sort((a, b) => a.position - b.position)
    .flatMap((filing) => {
      const item = byId.get(filing.itemId);
      return item && stillOpen(item) && !hidden.includes(item.id) ? [item] : [];
    });
  return (
    <li data-poc-child-panel={panelId}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-4 py-2 text-left hover:bg-row-hover"
        style={colour ? { background: tint(colour) } : undefined}
      >
        <span className="w-3 text-xs text-ink-faint">{open ? '▾' : '▸'}</span>
        <span className="truncate text-xs font-semibold tracking-[0.11em] uppercase" style={{ color: colour ? ink(colour) : 'var(--color-accent-deep)' }}>
          {name}
        </span>
        <span className="ml-auto shrink-0 text-xs text-ink-faint">
          {items.length} {items.length === 1 ? 'Item' : 'Items'}
        </span>
      </button>
      {open && (
        <div className="border-l-2 border-accent/25 ml-4">
          <Suspense fallback={null}>
            <ItemList workspaceId={workspaceId} items={items} openDashboardId={dashboardId} panelId={panelId} emptyMessage="Nothing filed here yet." />
          </Suspense>
        </div>
      )}
    </li>
  );
}

/** The colour of a Panel, picked from its header's menu. */
export function PocColourAsk({ workspaceId, target, onClose }: { workspaceId: string; target: string; onClose: () => void }) {
  const current = useColourOf(workspaceId, target);
  const setColour = useSetColour(workspaceId);
  return createPortal(
    <>
      <div className="fixed inset-0 z-floating bg-scrim/20" onPointerDown={onClose} />
      <div role="dialog" aria-label="Colour" className="fixed top-1/3 left-1/2 z-floating w-64 -translate-x-1/2 rounded-md border border-shade/10 bg-surface p-3 shadow-lg">
        <p className="pb-2 text-sm font-semibold">Colour</p>
        <Swatches
          current={current}
          onPick={(colour) => {
            setColour(target, colour);
            onClose();
          }}
        />
      </div>
    </>,
    document.body,
  );
}

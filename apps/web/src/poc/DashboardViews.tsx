import { Suspense, lazy, useRef, useState, type ReactNode } from 'react';
import { useScreenWidth } from '../panels/useScreenWidth';
import { DEFAULT_VIEW, splitKey, usePoc, viewKey, type DashboardView } from './store';
import { PHONE_WIDTH } from './ViewSwitch';

/** The whiteboard and xyflow are their own chunk, so the first paint does not grow. */
const Whiteboard = lazy(() => import('./Whiteboard'));

interface Split {
  side: number;
  stacked: number;
}

/**
 * POC (throwaway): the open Dashboard drawn as Panels, a whiteboard, or both,
 * with a divider between them.
 */
export function DashboardViews({
  workspaceId,
  dashboardId,
  panels,
}: {
  workspaceId: string;
  dashboardId: string;
  panels: ReactNode;
}) {
  const [view] = usePoc<DashboardView>(viewKey(dashboardId), DEFAULT_VIEW);
  const [split, setSplit] = usePoc<Split>(splitKey(dashboardId), { side: 0.4, stacked: 0.55 });
  const [phoneTab, setPhoneTab] = useState<'panels' | 'board'>('panels');
  const phone = useScreenWidth() < PHONE_WIDTH;
  const box = useRef<HTMLDivElement>(null);

  const board = (readOnly: boolean) => (
    <Suspense fallback={<p className="p-4 text-sm text-ink-faint">Loading the whiteboard…</p>}>
      <Whiteboard workspaceId={workspaceId} dashboardId={dashboardId} readOnly={readOnly} />
    </Suspense>
  );

  if (phone) {
    return (
      <div className="flex h-full min-h-[70vh] flex-col gap-2">
        <div role="tablist" aria-label="Show" className="flex self-center rounded-md bg-shade/10 p-0.5">
          {(['panels', 'board'] as const).map((tab) => (
            <button
              key={tab}
              type="button"
              role="tab"
              aria-selected={phoneTab === tab}
              onClick={() => setPhoneTab(tab)}
              className={`rounded px-4 py-1.5 text-sm ${phoneTab === tab ? 'bg-surface font-medium text-ink shadow-sm' : 'text-ink-soft'}`}
            >
              {tab === 'panels' ? 'Panels' : 'Whiteboard'}
            </button>
          ))}
        </div>
        {phoneTab === 'panels' ? panels : <div className="min-h-0 flex-1">{board(true)}</div>}
      </div>
    );
  }

  if (view === 'panels') return <>{panels}</>;
  if (view === 'board') return <div className="h-full min-h-[480px]">{board(false)}</div>;

  /** Dragging the divider; double-click puts it back. */
  const take = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const area = box.current?.getBoundingClientRect();
    if (!area) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (at: PointerEvent) => {
      if (view === 'side') setSplit((was) => ({ ...was, side: Math.max(0.15, Math.min(0.85, (at.clientX - area.left) / area.width)) }));
      else setSplit((was) => ({ ...was, stacked: Math.max(0.15, Math.min(0.85, (at.clientY - area.top) / area.height)) }));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };
  const reset = () => setSplit((was) => (view === 'side' ? { ...was, side: 0.4 } : { ...was, stacked: 0.55 }));

  if (view === 'side') {
    return (
      <div ref={box} className="flex h-full min-h-[480px]">
        <div className="min-w-0 shrink-0 overflow-y-auto" style={{ width: split.side > 1 ? split.side : `${split.side * 100}%` }} data-poc-pane="panels">
          {panels}
        </div>
        <div
          role="separator"
          aria-orientation="vertical"
          aria-label="Drag to resize the Panels and the whiteboard"
          onPointerDown={take}
          onDoubleClick={reset}
          className="group relative w-2 shrink-0 cursor-col-resize touch-none"
        >
          <div className="absolute inset-y-2 left-1/2 w-[2px] -translate-x-1/2 rounded-full bg-accent opacity-20 transition-opacity group-hover:opacity-60" />
        </div>
        <div className="min-w-0 flex-1">{board(false)}</div>
      </div>
    );
  }

  return (
    <div ref={box} className="flex h-full min-h-[600px] flex-col">
      <div className="min-h-0 shrink-0" style={{ height: `${split.stacked * 100}%` }}>
        {board(false)}
      </div>
      <div
        role="separator"
        aria-orientation="horizontal"
        aria-label="Drag to resize the whiteboard and the Panels"
        onPointerDown={take}
        onDoubleClick={reset}
        className="group relative h-2 shrink-0 cursor-row-resize touch-none"
      >
        <div className="absolute inset-x-2 top-1/2 h-[2px] -translate-y-1/2 rounded-full bg-accent opacity-20 transition-opacity group-hover:opacity-60" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto" data-poc-pane="panels">
        {panels}
      </div>
    </div>
  );
}

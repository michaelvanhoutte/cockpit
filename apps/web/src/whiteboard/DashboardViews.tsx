import { useRef, useState, type ReactNode } from 'react';
import { uuidv7 } from '@cockpit/shared';
import { DEFAULT_SPLIT_SHARE, type DashboardView } from '@cockpit/shared/board';
import { useSendCommand, whyNotDone } from '../api/queries';
import { useUndo } from '../undo';
import Whiteboard from './Whiteboard';

/** Let go this close to an edge, the divider closes the pane on that side. */
const SHUT = 0.06;

/** Where a divider let go at `share` settles: shut against an edge it was dragged to, else where it was let go. */
export function settledShare(share: number): number {
  if (share <= SHUT) return 0;
  if (share >= 1 - SHUT) return 1;
  return Math.round(share * 1000) / 1000;
}

/**
 * The open Dashboard drawn as its whiteboard, or as its Panels and its
 * whiteboard side by side or stacked ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829), with a divider between them that starts
 * at 40%, is remembered per Dashboard, and closes a pane when dragged to its
 * edge. Its Panels alone never reach here (`DashboardPage`). In the whiteboard's
 * chunk, so the Panels-only Dashboard costs nothing of it.
 */
export default function DashboardViews({
  workspaceId,
  dashboardId,
  view,
  splitShare,
  readOnly,
  panels,
}: {
  workspaceId: string;
  dashboardId: string;
  view: DashboardView;
  /** The Panels pane's share of the width or height. */
  splitShare: number;
  readOnly: boolean;
  panels: ReactNode;
}) {
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const area = useRef<HTMLDivElement>(null);
  /** The divider's place while it is being dragged; the remembered one otherwise. */
  const [dragging, setDragging] = useState<number | null>(null);
  const share = dragging ?? splitShare;
  const board = <Whiteboard workspaceId={workspaceId} dashboardId={dashboardId} readOnly={readOnly} />;

  if (view === 'board' || view === 'panels') return <div className="h-full min-h-[420px]">{board}</div>;

  const side = view === 'side';
  const keep = (next: number) =>
    send({ name: 'set_dashboard_split', payload: { commandId: uuidv7(), issuedAt: new Date().toISOString(), workspaceId, dashboardId, splitShare: next } }).catch(
      (failure: unknown) => offerToUndo({ what: `The divider was not moved. ${whyNotDone(failure)}` }),
    );
  /** Dragging the divider; letting go keeps where it was let go. */
  const take = (event: React.PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const rect = area.current?.getBoundingClientRect();
    if (!rect) return;
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    let now = splitShare;
    const move = (at: PointerEvent) => {
      // The Panels pane is the left one side by side, and the lower one stacked.
      now = Math.max(0, Math.min(1, side ? (at.clientX - rect.left) / rect.width : 1 - (at.clientY - rect.top) / rect.height));
      setDragging(now);
    };
    const up = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', up);
      handle.removeEventListener('pointercancel', up);
      const settled = settledShare(now);
      setDragging(null);
      if (settled !== splitShare) void keep(settled);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', up);
    handle.addEventListener('pointercancel', up);
  };
  const reset = () => void keep(DEFAULT_SPLIT_SHARE);
  const percent = `${share * 100}%`;
  const divider = (
    <div
      role="separator"
      aria-orientation={side ? 'vertical' : 'horizontal'}
      aria-label="Drag to resize the Panels and the whiteboard"
      aria-valuenow={Math.round(share * 100)}
      onPointerDown={take}
      onDoubleClick={reset}
      className={`group relative shrink-0 touch-none ${side ? 'w-2 cursor-col-resize' : 'h-2 cursor-row-resize'}`}
    >
      <div
        className={`absolute rounded-full bg-accent opacity-20 transition-opacity group-hover:opacity-60 ${
          side ? 'inset-y-2 left-1/2 w-[2px] -translate-x-1/2' : 'inset-x-2 top-1/2 h-[2px] -translate-y-1/2'
        }`}
      />
    </div>
  );
  const panelsPane = (
    <div
      data-pane="panels"
      className={`min-h-0 min-w-0 shrink-0 overflow-y-auto ${share === 0 ? 'hidden' : ''}`}
      style={side ? { width: percent } : { height: percent }}
    >
      {panels}
    </div>
  );
  const boardPane = <div className={`min-h-0 min-w-0 flex-1 ${share === 1 ? 'hidden' : ''}`}>{board}</div>;

  return side ? (
    <div ref={area} className="flex h-full min-h-[480px]">
      {panelsPane}
      {divider}
      {boardPane}
    </div>
  ) : (
    <div ref={area} className="flex h-full min-h-[600px] flex-col">
      {boardPane}
      {divider}
      {panelsPane}
    </div>
  );
}

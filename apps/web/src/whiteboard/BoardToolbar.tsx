import type { ReactNode } from 'react';

export type Tool = 'select' | 'box' | 'line';

const chip = 'flex items-center gap-1 rounded-md border border-shade/10 bg-surface p-1 shadow-md';
const small = 'flex items-center rounded px-2 py-1 text-xs text-ink hover:bg-accent-tint';

const TOOLS: { value: Tool; label: string; icon: ReactNode }[] = [
  {
    value: 'select',
    label: 'Select',
    icon: (
      <svg viewBox="0 0 16 16" className="size-4" fill="currentColor" aria-hidden="true">
        <path d="M3 2l9 5-4 1-2 4z" />
      </svg>
    ),
  },
  {
    value: 'box',
    label: 'Draw box',
    icon: (
      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
      </svg>
    ),
  },
  {
    value: 'line',
    label: 'Draw line',
    icon: (
      <svg viewBox="0 0 16 16" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeDasharray="3 2" aria-hidden="true">
        <path d="M2 13 14 3" />
      </svg>
    ),
  },
];

/**
 * A whiteboard's two toolbars ("Brainstorming: give every Dashboard a
 * whiteboard of its own", issue 1829): *Select · Draw box · Draw line*, the
 * kind the next link is drawn as, *Show labels* and the grid's snapping on the
 * left ("Brainstorming: the whiteboard can't show how Items connect", issue
 * 1831), the zoom, *Fit* and *Full screen* on the right. A narrow
 * board (under 700px) draws each as its icon, named on hover. A board only to
 * look at, on a phone, has the right-hand one alone.
 */
export function BoardToolbar({
  tool,
  onTool,
  kindPicker = null,
  showLabels = false,
  onShowLabels = () => {},
  grid,
  onGrid,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
  full,
  onFull,
  narrow,
  readOnly,
}: {
  tool: Tool;
  onTool: (tool: Tool) => void;
  /** The picker of the kind the next link is drawn as (`KindPicker`). */
  kindPicker?: ReactNode;
  showLabels?: boolean;
  onShowLabels?: () => void;
  grid: boolean;
  onGrid: () => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
  full: boolean;
  onFull: () => void;
  narrow: boolean;
  readOnly: boolean;
}) {
  const said = (label: string, icon: ReactNode) => (narrow ? icon : label);
  const fullLabel = full ? 'Exit full screen' : 'Full screen';
  return (
    <>
      {!readOnly && (
        <div className={`absolute top-3 left-3 z-20 ${chip}`} role="toolbar" aria-label="Whiteboard tools">
          {TOOLS.map((one) => (
            <button
              key={one.value}
              type="button"
              aria-label={one.label}
              title={one.label}
              aria-pressed={tool === one.value}
              onClick={() => onTool(one.value)}
              className={`flex items-center rounded px-2 py-1 text-xs ${tool === one.value ? 'bg-accent text-on-accent' : 'text-ink hover:bg-accent-tint'}`}
            >
              {said(one.label, one.icon)}
            </button>
          ))}
          <span className="mx-1 h-4 w-px bg-shade/15" />
          {kindPicker}
          <button
            type="button"
            aria-label="Show labels"
            title="Show labels"
            aria-pressed={showLabels}
            onClick={onShowLabels}
            className={`${small} ${showLabels ? 'bg-accent-tint text-accent-deep' : ''}`}
          >
            {said('Show labels', <span className="text-[11px] font-semibold">Aa</span>)}
          </button>
          <button
            type="button"
            aria-label="Snap to grid"
            title="Snap to grid"
            aria-pressed={grid}
            onClick={onGrid}
            className={`${small} ${grid ? '' : 'opacity-60'}`}
          >
            {said(grid ? 'Grid: on' : 'Grid: off', <span className="text-[13px]">⋯</span>)}
          </button>
        </div>
      )}
      <div className={`absolute top-3 right-3 z-20 ${chip}`} role="toolbar" aria-label="Zoom">
        <button type="button" aria-label="Zoom out" title="Zoom out" onClick={onZoomOut} className={small}>
          −
        </button>
        {!narrow && <span className="w-11 text-center text-xs tabular-nums text-ink-soft">{Math.round(zoom * 100)}%</span>}
        <button type="button" aria-label="Zoom in" title="Zoom in" onClick={onZoomIn} className={small}>
          +
        </button>
        <button type="button" aria-label="Fit" title="Fit" onClick={onFit} className={small}>
          {said('Fit', <span aria-hidden="true">⤢</span>)}
        </button>
        <button type="button" aria-label={fullLabel} title={fullLabel} onClick={onFull} className={small}>
          {said(fullLabel, <span aria-hidden="true">⛶</span>)}
        </button>
      </div>
    </>
  );
}

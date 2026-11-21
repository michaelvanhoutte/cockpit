import { BaseEdge, EdgeLabelRenderer, Handle, Position, getStraightPath, useInternalNode, useStore, type Edge, type EdgeProps, type InternalNode } from '@xyflow/react';
import type { BoardLine } from '@cockpit/shared/board';
import { DASHES, lineInk, nearestSides, type DrawnLink, type End, type Rect } from './links';

/**
 * How a whiteboard draws a link and a free line ("Brainstorming: the
 * whiteboard can't show how Items connect", issue 1831), from the POC's: a
 * link is a straight line between the nearest sides of its two cards, in its
 * kind's style and colour, under the cards, with its own label or, on hover,
 * selected or with *Show labels*, its kind's name as plain text. A free line is
 * a grey dashed line between two points of the board, its label at its middle.
 */

export type LinkEdgeData = { drawn: DrawnLink; hovered: boolean; showLabels: boolean };
export type LinkEdge = Edge<LinkEdgeData, 'link'>;

/**
 * A dot on each side of a card, shown on hover: drag one to another card to
 * link the two. A box has none. A board only to look at keeps them, unseen and
 * not to be dragged, since the board draws a link only between dots.
 */
export function Dots({ readOnly }: { readOnly: boolean }) {
  return (
    <>
      {([Position.Top, Position.Right, Position.Bottom, Position.Left] as const).map((side) => (
        <Handle
          key={side}
          id={side}
          type="source"
          position={side}
          isConnectable={!readOnly}
          className={readOnly ? 'board-dot board-dot-unseen' : 'board-dot'}
          aria-label={`Link from the ${side} side`}
        />
      ))}
    </>
  );
}

/** Where one end is on the board: its card, or the Item inside its parent's unfolded card, measured from the page where the board scales it. */
function frameOf(node: InternalNode, end: End, zoom: number): Rect {
  const { x, y } = node.internals.positionAbsolute;
  const card = { x, y, w: node.measured.width ?? 0, h: node.measured.height ?? 0 };
  if (end.inside === null || typeof document === 'undefined') return card;
  const nodeEl = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${CSS.escape(end.cardId)}"]`);
  const childEl = nodeEl?.querySelector<HTMLElement>(`[data-nested-item="${CSS.escape(end.inside)}"]`);
  if (!nodeEl || !childEl) return card;
  const outer = nodeEl.getBoundingClientRect();
  const inner = childEl.getBoundingClientRect();
  return { x: x + (inner.left - outer.left) / zoom, y: y + (inner.top - outer.top) / zoom, w: inner.width / zoom, h: inner.height / zoom };
}

export function LinkEdgeView({ id, source, target, data, markerEnd, selected }: EdgeProps<LinkEdge>) {
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  const zoom = useStore((state) => state.transform[2]);
  if (!from || !to || !data) return null;
  const { drawn } = data;
  const ends = nearestSides(frameOf(from, drawn.from, zoom), frameOf(to, drawn.to, zoom));
  const [path, labelX, labelY] = getStraightPath({ sourceX: ends.from.x, sourceY: ends.from.y, targetX: ends.to.x, targetY: ends.to.y });
  const { kind } = drawn;
  const ink = lineInk(kind);
  const width = selected || data.hovered ? 2.75 : 1.75;
  const label = drawn.link.label ?? (data.showLabels || data.hovered || selected ? kind.name : null);
  return (
    <>
      {kind.style === 'double' ? (
        <>
          <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} style={{ stroke: ink, strokeWidth: width + 4 }} interactionWidth={18} />
          <path d={path} fill="none" stroke="var(--color-surface)" strokeWidth={width} pointerEvents="none" />
        </>
      ) : (
        <BaseEdge
          id={id}
          path={path}
          {...(markerEnd ? { markerEnd } : {})}
          interactionWidth={18}
          style={{
            stroke: ink,
            strokeWidth: width,
            strokeLinecap: kind.style === 'dotted' ? 'round' : 'butt',
            ...(DASHES[kind.style] ? { strokeDasharray: DASHES[kind.style] } : {}),
          }}
        />
      )}
      {label !== null && (
        <EdgeLabelRenderer>
          {/* Plain text on the board's own ground: no chip, no shadow. */}
          <div
            className="nodrag nopan pointer-events-none absolute px-1 text-[11px] font-medium"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: ink, background: 'var(--color-surface)' }}
            data-link-label={label}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

export const edgeTypes = { link: LinkEdgeView };

/** A board's free lines, in the board's own units, each pressed to change its label or remove it. */
export function FreeLines({ lines, readOnly, onPress }: { lines: readonly BoardLine[]; readOnly: boolean; onPress: (line: BoardLine, at: { x: number; y: number }) => void }) {
  return (
    <>
      <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }} aria-hidden="true">
        {lines.map((line) => (
          <g key={line.id} data-free-line={line.label || line.id}>
            <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="var(--color-ink-soft)" strokeWidth={2} strokeDasharray="10 6" />
            <line
              x1={line.x1}
              y1={line.y1}
              x2={line.x2}
              y2={line.y2}
              stroke="transparent"
              strokeWidth={14}
              style={{ pointerEvents: readOnly ? 'none' : 'stroke', cursor: 'pointer' }}
              onClick={(event) => onPress(line, { x: event.clientX, y: event.clientY })}
            />
          </g>
        ))}
      </svg>
      {lines.map((line) =>
        line.label ? (
          <div
            key={line.id}
            className="absolute whitespace-nowrap px-1 text-xs font-semibold tracking-wide text-ink-soft"
            style={{ left: (line.x1 + line.x2) / 2, top: (line.y1 + line.y2) / 2, transform: 'translate(-50%, -50%)', pointerEvents: readOnly ? 'none' : 'all', background: 'var(--color-surface)', cursor: 'pointer' }}
            onClick={(event) => onPress(line, { x: event.clientX, y: event.clientY })}
            data-line-label={line.label}
          >
            {line.label}
          </div>
        ) : null,
      )}
    </>
  );
}

/** A line, a link's or a free one's, being drawn: from where the press began to the pointer, in the board's frame on screen. */
export function LineBeingDrawn({ x0, y0, x1, y1 }: { x0: number; y0: number; x1: number; y1: number }) {
  return <line x1={x0} y1={y0} x2={x1} y2={y1} stroke="var(--color-ink-soft)" strokeWidth={2} strokeDasharray="10 6" />;
}

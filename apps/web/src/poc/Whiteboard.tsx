import '@xyflow/react/dist/style.css';
import * as Popover from '@radix-ui/react-popover';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  ConnectionMode,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  ViewportPortal,
  applyNodeChanges,
  getStraightPath,
  useInternalNode,
  useNodesInitialized,
  useReactFlow,
  useViewport,
  type FinalConnectionState,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { itemLabel, itemStatus, stillOpen, type Item } from '@cockpit/shared';
import { useSendCommand } from '../api/queries';
import { useSnapshot } from '../api/useSnapshot';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { useOpenItem } from '../itemForm';
import { selectionCarried } from '../itemInTheAir';
import { sourceOnARow } from '../itemSource';
import { useUndo } from '../undo';
import { BOX_HEAD, CARD_H, CARD_W, PAD, absolute, cardIn, descendants, fitBox, isBoxed, nextSlot, ordered, sizeOf, withSize } from './board';
import { askToCombine, askToSplit } from './dialogs';
import { addChildren, childrenOf, isUuid } from './relations';
import { StatusMark } from './StatusMark';
import {
  DEFAULT_KINDS,
  EMPTY_BOARD,
  FOCUS_KEY,
  LEADS_TO,
  boardKey,
  hiddenKey,
  kindsKey,
  linksKey,
  newId,
  relationsKey,
  usePoc,
  writePoc,
  type Board,
  type BoardNode,
  type LineKind,
  type LineStyle,
  type Link,
  type Relations,
} from './store';

/** POC (throwaway): a whiteboard of a Dashboard's Items, kept in the browser. */

type Status = ReturnType<typeof itemStatus>;
type CardData = { title: string; status: Status; source: string | null; missing: boolean; sketch: boolean; panel: boolean; count: number; done: number };
type BoxData = { name: string; count: number; itemBacked: boolean };
type CardNode = Node<CardData, 'card'>;
type BoxNode = Node<BoxData, 'box'>;
type FlowNode = CardNode | BoxNode;
type KindEdgeData = { kind: LineKind; label: string | undefined; linkId: string; hovered: boolean };
type KindEdge = Edge<KindEdgeData, 'kind'>;

const STATUS_WORDS: Record<Status, string> = { to_do: 'To do', in_progress: 'In progress', waiting: 'Waiting', done: 'Done' };
const SWATCHES = ['#3a3f4b', '#6f62b5', '#0e7490', '#0b7a55', '#9a5b14', '#bf5d55'];
const GRID = 20;
const PHONE_ZOOM = 0.7;

interface Ctx {
  readOnly: boolean;
  editingId: string | null;
  showLabels: boolean;
  dropTargetId: string | null;
  flashId: string | null;
  commitName: (id: string, text: string) => void;
  stopEditing: () => void;
  zoomTo: (id: string) => void;
}
const BoardContext = createContext<Ctx>({
  readOnly: true,
  editingId: null,
  showLabels: false,
  dropTargetId: null,
  flashId: null,
  commitName: () => {},
  stopEditing: () => {},
  zoomTo: () => {},
});

/**
 * The name typed into a new box or sketch. Until it has the focus, every key
 * meant for it is caught first and put into it, so no app shortcut fires and
 * no first letter is lost.
 */
function InlineName({ id, initial, placeholder, className }: { id: string; initial: string; placeholder: string; className: string }) {
  const { commitName, stopEditing } = useContext(BoardContext);
  const [text, setText] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const catchKey = (event: KeyboardEvent) => {
      const input = field.current;
      if (!input || document.activeElement === input) return;
      if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        setText((was) => was + event.key);
        input.focus();
      } else if (event.key === 'Enter' || event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        input.focus();
        input.blur();
      }
    };
    window.addEventListener('keydown', catchKey, true);
    const later = window.setTimeout(() => field.current?.focus(), 30);
    return () => {
      window.removeEventListener('keydown', catchKey, true);
      window.clearTimeout(later);
    };
  }, []);
  return (
    <input
      ref={field}
      autoFocus
      value={text}
      placeholder={placeholder}
      aria-label={placeholder}
      onChange={(event) => setText(event.target.value)}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') commitName(id, text);
        if (event.key === 'Escape') stopEditing();
      }}
      onBlur={() => commitName(id, text)}
      className={`nodrag nopan rounded border border-accent bg-field px-1 outline-none ${className}`}
    />
  );
}

/** A connection dot on each side, shown on hover; drag one to another card or box to link them. */
function Dots() {
  const { readOnly } = useContext(BoardContext);
  if (readOnly) return null;
  return (
    <>
      {([Position.Top, Position.Right, Position.Bottom, Position.Left] as const).map((side) => (
        <Handle key={side} id={side} type="source" position={side} className="poc-dot" />
      ))}
    </>
  );
}

function marks(id: string, ctx: Ctx, selected: boolean | undefined) {
  if (ctx.flashId === id) return 'ring-4 ring-accent animate-pulse';
  if (ctx.dropTargetId === id) return 'ring-4 ring-accent/60 bg-accent-tint';
  return selected ? 'ring-2 ring-accent' : '';
}

function CardView({ id, data, selected, parentId }: NodeProps<CardNode>) {
  const ctx = useContext(BoardContext);
  const finished = data.status === 'done';
  return (
    <div
      data-card={data.title}
      data-inside={parentId ? 'box' : 'open'}
      className={`group flex h-[64px] w-[200px] flex-col justify-center gap-1 rounded-md border px-2.5 py-1.5 text-left shadow-panel ${
        data.sketch ? 'border-dashed border-accent/60 bg-accent-tint/60' : data.panel ? 'border-accent/40 bg-field' : 'border-shade/10 bg-field'
      } ${marks(id, ctx, selected)} ${finished || data.missing ? 'opacity-60' : ''}`}
    >
      <Dots />
      {ctx.editingId === id ? (
        <InlineName id={id} initial={data.title} placeholder="Name this sketch" className="text-sm" />
      ) : (
        <span className={`line-clamp-2 text-[13px] leading-tight font-medium ${finished ? 'text-ink-faint line-through' : 'text-ink-strong'}`}>
          {data.panel && <span className="mr-1 text-[10px] font-semibold tracking-[0.12em] text-accent-deep uppercase">Panel</span>}
          {data.title || <span className="text-ink-faint italic">Untitled sketch</span>}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {data.sketch ? (
          <span className="italic">Sketch · not saved</span>
        ) : data.missing ? (
          <span>Not in this Workspace now</span>
        ) : data.panel ? (
          <span>{data.count} {data.count === 1 ? 'Item' : 'Items'}</span>
        ) : (
          <>
            <StatusMark status={data.status} />
            <span>{STATUS_WORDS[data.status]}</span>
            {data.count > 0 && (
              <span className="truncate text-accent-deep">
                · {data.count} {data.count === 1 ? 'Item' : 'Items'}, {data.done} done
              </span>
            )}
            {data.source && <span className="truncate">· {data.source}</span>}
          </>
        )}
      </span>
    </div>
  );
}

function BoxView({ id, data, selected }: NodeProps<BoxNode>) {
  const ctx = useContext(BoardContext);
  const [, setBoard] = useContext(BoardWriter);
  return (
    <div
      data-box={data.name}
      className={`group h-full w-full rounded-lg border-2 bg-accent-tint/25 ${selected ? 'border-accent' : data.itemBacked ? 'border-accent/45' : 'border-accent/30'} ${marks(id, ctx, false)}`}
    >
      {!ctx.readOnly && (
        <NodeResizer
          isVisible={selected}
          minWidth={CARD_W + 2 * PAD}
          minHeight={100}
          color="var(--color-accent)"
          onResizeEnd={(_, size) => {
            setBoard((was) => ({
              ...was,
              nodes: was.nodes.map((node) => (node.id === id ? { ...withSize(node, size.width, size.height), x: size.x, y: size.y } : node)),
            }));
          }}
        />
      )}
      <Dots />
      <div className="flex h-[36px] items-center justify-between gap-2 px-3">
        {ctx.editingId === id ? (
          <InlineName id={id} initial={data.name} placeholder="Name this box" className="text-sm font-semibold" />
        ) : (
          <span className={`truncate text-xs font-semibold tracking-[0.12em] uppercase ${data.itemBacked ? 'text-ink-strong' : 'text-accent-deep'}`}>
            {data.name || 'Box'}
          </span>
        )}
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-ink-faint">
          {data.count} {data.count === 1 ? 'Item' : 'Items'}
          <button
            type="button"
            title="Zoom to box"
            aria-label={`Zoom to ${data.name || 'box'}`}
            onClick={(event) => {
              event.stopPropagation();
              ctx.zoomTo(id);
            }}
            className="nodrag nopan flex size-5 items-center justify-center rounded text-ink-soft hover:bg-accent-tint hover:text-accent-deep"
          >
            <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <circle cx="7" cy="7" r="4.5" />
              <path d="M10.5 10.5 14 14M5 7h4M7 5v4" />
            </svg>
          </button>
        </span>
      </div>
    </div>
  );
}

/** Where the line between two nodes' centres leaves the first one's rectangle. */
function borderPoint(node: InternalNode, toward: { x: number; y: number }) {
  const w = node.measured.width ?? 0;
  const h = node.measured.height ?? 0;
  const cx = node.internals.positionAbsolute.x + w / 2;
  const cy = node.internals.positionAbsolute.y + h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(dx === 0 ? Infinity : w / 2 / Math.abs(dx), dy === 0 ? Infinity : h / 2 / Math.abs(dy));
  return { x: cx + dx * scale, y: cy + dy * scale };
}
const centre = (node: InternalNode) => ({
  x: node.internals.positionAbsolute.x + (node.measured.width ?? 0) / 2,
  y: node.internals.positionAbsolute.y + (node.measured.height ?? 0) / 2,
});

const DASHES: Record<LineStyle, string | undefined> = { solid: undefined, dashed: '9 6', dotted: '1.5 5', double: undefined };

function KindEdgeView({ id, source, target, data, markerEnd, selected }: EdgeProps<KindEdge>) {
  const { showLabels } = useContext(BoardContext);
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  if (!from || !to || !data) return null;
  const start = borderPoint(from, centre(to));
  const end = borderPoint(to, centre(from));
  const [path, labelX, labelY] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  const { kind } = data;
  const width = selected ? 2.75 : 1.75;
  const label = data.label ?? (showLabels || data.hovered || selected ? kind.name : null);
  return (
    <>
      {kind.style === 'double' ? (
        <>
          <BaseEdge id={id} path={path} {...(markerEnd ? { markerEnd } : {})} style={{ stroke: kind.colour, strokeWidth: width + 4 }} interactionWidth={18} />
          <path d={path} fill="none" stroke="var(--color-surface)" strokeWidth={width} pointerEvents="none" />
        </>
      ) : (
        <BaseEdge
          id={id}
          path={path}
          {...(markerEnd ? { markerEnd } : {})}
          interactionWidth={18}
          style={{
            stroke: kind.colour,
            strokeWidth: width,
            strokeLinecap: kind.style === 'dotted' ? 'round' : 'butt',
            ...(DASHES[kind.style] ? { strokeDasharray: DASHES[kind.style] } : {}),
          }}
        />
      )}
      {label !== null && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan pointer-events-none absolute rounded bg-surface/95 px-1.5 py-0.5 text-[11px] font-medium shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: kind.colour }}
            data-edge-label={label}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const nodeTypes = { card: CardView, box: BoxView };
const edgeTypes = { kind: KindEdgeView };

type BoardSetter = (update: Board | ((was: Board) => Board)) => void;
const BoardWriter = createContext<[Board, BoardSetter]>([EMPTY_BOARD, () => {}]);

/** The endpoint a link names for a node: the Item or Panel it is, or the node itself. */
const refOf = (node: BoardNode) =>
  node.kind === 'card' ? `item:${node.itemId}` : node.kind === 'panel' ? `panel:${node.panelId}` : `node:${node.id}`;

/** A node that is an Item or a Panel, which can take another Item inside it. */
const isItemLike = (node: BoardNode | undefined): node is Extract<BoardNode, { kind: 'card' | 'panel' }> =>
  node?.kind === 'card' || node?.kind === 'panel';

interface Lookups {
  items: Map<string, Item>;
  panelNames: Map<string, string>;
  sourceNames: Record<string, string> | undefined;
  childItems: (node: BoardNode) => string[];
}

function titleOf(node: BoardNode, look: Lookups): string {
  if (node.kind === 'card') {
    const item = look.items.get(node.itemId);
    return item ? itemLabel(item) : 'Item';
  }
  if (node.kind === 'panel') return look.panelNames.get(node.panelId) ?? 'Panel';
  if (node.kind === 'box') return node.name;
  return node.title;
}

function build(board: Board, look: Lookups, selected: Set<string>): FlowNode[] {
  return ordered(board.nodes).map((node): FlowNode => {
    const common = {
      id: node.id,
      position: { x: node.x, y: node.y },
      selected: selected.has(node.id),
      ...(node.parentId ? { parentId: node.parentId } : {}),
    };
    if (isBoxed(node)) {
      const size = sizeOf(node);
      const count = board.nodes.filter((one) => one.parentId === node.id && !(one.kind === 'box')).length;
      return {
        ...common,
        type: 'box',
        width: size.w,
        height: size.h,
        data: { name: titleOf(node, look), count, itemBacked: node.kind !== 'box' },
        zIndex: -1,
      } satisfies BoxNode;
    }
    if (node.kind === 'sketch') {
      return { ...common, type: 'card', data: { title: node.title, status: 'to_do', source: null, missing: false, sketch: true, panel: false, count: 0, done: 0 } };
    }
    const children = look.childItems(node);
    const done = children.filter((id) => {
      const child = look.items.get(id);
      return child && itemStatus(child) === 'done';
    }).length;
    if (node.kind === 'panel') {
      return {
        ...common,
        type: 'card',
        data: { title: titleOf(node, look), status: 'to_do', source: null, missing: !look.panelNames.has(node.panelId), sketch: false, panel: true, count: children.length, done },
      };
    }
    if (node.kind !== 'card') throw new Error('unreachable');
    const item = look.items.get(node.itemId);
    return {
      ...common,
      type: 'card',
      data: {
        title: titleOf(node, look),
        status: item ? itemStatus(item) : 'to_do',
        source: item && item.source !== 'internal' ? sourceOnARow(item, look.sourceNames) : null,
        missing: !item,
        sketch: false,
        panel: false,
        count: children.length,
        done,
      },
    };
  });
}

type Tool = 'select' | 'box' | 'line';
type Drawing = { tool: Tool | 'arrow'; x0: number; y0: number; x1: number; y1: number };
type Menu = { x: number; y: number; nodeId: string | null };
/** What was let go over another Item, waiting for Put inside / Combine with. */
type DropAsk = { x: number; y: number; targetId: string; itemId: string; nodeId: string | null; at: { x: number; y: number } };

function BoardInner({ workspaceId, dashboardId, readOnly }: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  const { data } = useSnapshot(workspaceId);
  const openItem = useOpenItem();
  const send = useSendCommand();
  const offerToUndo = useUndo();
  const flow = useReactFlow<FlowNode, KindEdge>();
  const initialised = useNodesInitialized();
  const { zoom } = useViewport();
  const [stored, setBoard] = usePoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
  const [hidden] = usePoc<string[]>(hiddenKey(workspaceId), []);
  const [relations] = usePoc<Relations>(relationsKey(workspaceId), {});
  // Merged-away Items are off the board until the merge is undone.
  const board = useMemo(
    () => (hidden.length ? { ...stored, nodes: stored.nodes.filter((node) => !(node.kind === 'card' && hidden.includes(node.itemId))) } : stored),
    [stored, hidden],
  );
  const [kinds, setKinds] = usePoc<LineKind[]>(kindsKey(workspaceId), DEFAULT_KINDS);
  const [links, setLinks] = usePoc<Link[]>(linksKey(workspaceId), []);
  const [tool, setTool] = useState<Tool>('select');
  const [kindId, setKindId] = useState(LEADS_TO);
  const [showLabels, setShowLabels] = useState(false);
  const [grid, setGrid] = useState(true);
  const [full, setFull] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [edgePop, setEdgePop] = useState<{ x: number; y: number; linkId: string } | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [arrowFrom, setArrowFrom] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [dropAsk, setDropAsk] = useState<DropAsk | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const wrapper = useRef<HTMLDivElement>(null);
  const animating = useRef(false);
  const cameraPlaced = useRef(false);

  // POC only: lets a driving script move the camera.
  if (import.meta.env.DEV) (window as unknown as { __pocFlow?: unknown }).__pocFlow = flow;
  const items = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data]);
  const kind = kinds.find((one) => one.id === kindId) ?? kinds[0]!;

  const look = useMemo<Lookups>(() => {
    const panelNames = new Map((data?.panels ?? []).map((panel) => [panel.id, panel.name]));
    const filedOn = (panelId: string) =>
      (data?.filings ?? [])
        .filter((filing) => filing.panelId === panelId)
        .sort((a, b) => a.position - b.position)
        .map((filing) => filing.itemId)
        .filter((id) => {
          const item = items.get(id);
          return item && stillOpen(item) && !hidden.includes(id);
        });
    return {
      items,
      panelNames,
      sourceNames: data?.sourceNames,
      childItems: (node) => (node.kind === 'card' ? childrenOf(relations, node.itemId) : node.kind === 'panel' ? filedOn(node.panelId) : []),
    };
  }, [data, items, relations, hidden]);

  useEffect(() => {
    if (animating.current) return;
    setNodes((was) => build(board, look, new Set(was.filter((node) => node.selected).map((node) => node.id))));
  }, [board, look]);

  // ---- The camera: a phone opens readable at the top left; a whiteboard asked to show a card zooms to it ----
  useEffect(() => {
    if (!initialised || cameraPlaced.current || board.nodes.length === 0) return;
    cameraPlaced.current = true;
    if (readOnly) {
      const tops = board.nodes.filter((node) => !node.parentId);
      const minX = Math.min(...tops.map((node) => node.x));
      const minY = Math.min(...tops.map((node) => node.y));
      void flow.setViewport({ x: 16 - minX * PHONE_ZOOM, y: 16 - minY * PHONE_ZOOM, zoom: PHONE_ZOOM });
    }
  }, [initialised, board.nodes, readOnly, flow]);

  const [focus] = usePoc<{ dashboardId: string; nodeId: string } | null>(FOCUS_KEY, null);
  useEffect(() => {
    if (!initialised || !focus || focus.dashboardId !== dashboardId) return;
    writePoc(FOCUS_KEY, null);
    setNodes((was) => was.map((node) => ({ ...node, selected: node.id === focus.nodeId })));
    window.setTimeout(() => void flow.fitView({ nodes: [{ id: focus.nodeId }], duration: 600, maxZoom: 1.2, padding: 0.4 }), 50);
    setFlashId(focus.nodeId);
    window.setTimeout(() => setFlashId(null), 1400);
  }, [initialised, focus, dashboardId, flow]);

  // ---- Edges, from the Workspace's links, between every pair of nodes drawn for their ends ----
  const edges = useMemo(() => {
    const byRef = new Map<string, string[]>();
    for (const node of board.nodes) byRef.set(refOf(node), [...(byRef.get(refOf(node)) ?? []), node.id]);
    return links.flatMap((link) => {
      const linkKind = kinds.find((one) => one.id === link.kindId) ?? kinds[0]!;
      return (byRef.get(link.from) ?? []).flatMap((source) =>
        (byRef.get(link.to) ?? [])
          .filter((target) => target !== source)
          .map((target): KindEdge => {
            const id = `${link.id}:${source}:${target}`;
            return {
              id,
              source,
              target,
              type: 'kind',
              selected: selectedEdges.has(id),
              ...(linkKind.arrow ? { markerEnd: { type: MarkerType.ArrowClosed, color: linkKind.colour, width: 16, height: 16 } } : {}),
              data: { kind: linkKind, label: link.label, linkId: link.id, hovered: hoveredEdge === id },
            };
          }),
      );
    });
  }, [board.nodes, links, kinds, hoveredEdge, selectedEdges]);

  // ---- Small helpers ----
  const flash = useCallback(
    (nodeId: string) => {
      setFlashId(nodeId);
      window.setTimeout(() => setFlashId(null), 1400);
      const node = board.nodes.find((one) => one.id === nodeId);
      if (!node) return;
      const spot = absolute(board, node);
      const size = sizeOf(node);
      void flow.setCenter(spot.x + size.w / 2, spot.y + size.h / 2, { zoom: Math.max(zoom, 0.6), duration: 450 });
    },
    [board, flow, zoom],
  );
  const zoomTo = useCallback((id: string) => void flow.fitView({ nodes: [{ id }], duration: 500, padding: 0.12 }), [flow]);

  const commitName = useCallback(
    (id: string, text: string) => {
      setEditingId(null);
      setBoard((was) => {
        const node = was.nodes.find((one) => one.id === id);
        if (node?.kind === 'sketch' && !text.trim() && !node.title) return { ...was, nodes: was.nodes.filter((one) => one.id !== id) };
        return {
          ...was,
          nodes: was.nodes.map((one) =>
            one.id !== id ? one : one.kind === 'box' ? { ...one, name: text.trim() || one.name } : one.kind === 'sketch' ? { ...one, title: text.trim() } : one,
          ),
        };
      });
    },
    [setBoard],
  );
  const ctx = useMemo<Ctx>(
    () => ({ readOnly, editingId, showLabels, dropTargetId, flashId, commitName, stopEditing: () => setEditingId(null), zoomTo }),
    [readOnly, editingId, showLabels, dropTargetId, flashId, commitName, zoomTo],
  );

  const takeOff = useCallback(
    (ids: string[]) => {
      setBoard((was) => {
        const going = new Set(ids);
        const kept = was.nodes.filter((node) => !going.has(node.id));
        return {
          ...was,
          nodes: kept.map((node) => {
            if (!node.parentId || !going.has(node.parentId)) return node;
            const spot = absolute(was, node);
            const up = was.nodes.find((one) => one.id === node.parentId)?.parentId;
            const base = up ? absolute(was, was.nodes.find((one) => one.id === up)!) : { x: 0, y: 0 };
            return { ...node, parentId: up, x: spot.x - base.x, y: spot.y - base.y };
          }),
        };
      });
    },
    [setBoard],
  );

  /** Draws an Item or Panel as a box holding cards for its children, or back as a card. */
  const showAsBox = useCallback(
    (nodeId: string, box: boolean, also: string[] = []) => {
      setBoard((was) => {
        const node = was.nodes.find((one) => one.id === nodeId);
        if (!isItemLike(node)) return was;
        if (!box) {
          const inside = descendants(was, nodeId);
          return { ...was, nodes: was.nodes.filter((one) => !inside.has(one.id)).map((one) => (one.id === nodeId ? { ...node, asBox: false } : one)) };
        }
        let next: Board = { ...was, nodes: was.nodes.map((one) => (one.id === nodeId ? { ...node, asBox: true, w: node.w ?? CARD_W + 2 * PAD, h: node.h ?? 120 } : one)) };
        for (const itemId of [...look.childItems(node), ...also]) {
          if (cardIn(next, itemId, nodeId)) continue;
          next = { ...next, nodes: [...next.nodes, { id: newId(), kind: 'card', itemId, parentId: nodeId, ...nextSlot(next, nodeId) }] };
        }
        return fitBox(next, nodeId);
      });
    },
    [setBoard, look],
  );

  /** Makes `itemId` a child of the target - an Item's child, or filed on a Panel - and shows the target as a box holding it. */
  const putInside = (ask: DropAsk) => {
    const target = board.nodes.find((node) => node.id === ask.targetId);
    if (!isItemLike(target)) return;
    if (target.kind === 'card') addChildren(workspaceId, target.itemId, [ask.itemId]);
    else if (isUuid(target.panelId) && isUuid(ask.itemId)) {
      const order = [...look.childItems(target).filter((id) => id !== ask.itemId), ask.itemId];
      void send({
        name: 'add_item_to_panel',
        payload: { commandId: crypto.randomUUID(), issuedAt: new Date().toISOString(), workspaceId, itemId: ask.itemId, panelId: target.panelId, order },
      });
    }
    // The card dragged in from elsewhere on the board goes in itself; anything else gets a new card inside.
    if (ask.nodeId) setBoard((was) => ({ ...was, nodes: was.nodes.filter((node) => node.id !== ask.nodeId) }));
    showAsBox(target.id, true, [ask.itemId]);
  };

  /** Let go over another Item and asked nothing more: the card lands beside it. */
  const landBeside = (ask: DropAsk) => {
    const target = board.nodes.find((node) => node.id === ask.targetId);
    if (!target) return;
    const spot = { x: target.x + sizeOf(target).w + 24, y: target.y };
    setBoard((was) => {
      if (ask.nodeId) return { ...was, nodes: was.nodes.map((node) => (node.id === ask.nodeId ? { ...node, parentId: target.parentId, ...spot } : node)) };
      if (cardIn(was, ask.itemId, target.parentId)) return was;
      return { ...was, nodes: [...was.nodes, { id: newId(), kind: 'card', itemId: ask.itemId, parentId: target.parentId, ...spot }] };
    });
  };
  const answerDrop = (answer: 'inside' | 'combine' | 'cancel') => {
    const ask = dropAsk;
    setDropAsk(null);
    setDropTargetId(null);
    if (!ask) return;
    const target = board.nodes.find((node) => node.id === ask.targetId);
    if (answer === 'inside') putInside(ask);
    else {
      landBeside(ask);
      if (answer === 'combine' && target?.kind === 'card') askToCombine([ask.itemId, target.itemId], dashboardId);
    }
  };

  const onNodesChange = useCallback(
    (changes: NodeChange<FlowNode>[]) => {
      setNodes((was) => applyNodeChanges(changes, was));
      const removed = changes.flatMap((change) => (change.type === 'remove' ? [change.id] : []));
      if (removed.length) takeOff(removed);
    },
    [takeOff],
  );
  const onEdgesChange = useCallback(
    (changes: EdgeChange<KindEdge>[]) => {
      setSelectedEdges((was) => {
        const next = new Set(was);
        for (const change of changes) if (change.type === 'select') (change.selected ? next.add(change.id) : next.delete(change.id));
        return next;
      });
      const removed = changes.flatMap((change) => (change.type === 'remove' ? [change.id.split(':')[0]!] : []));
      if (removed.length) setLinks((was) => was.filter((link) => !removed.includes(link.id)));
    },
    [setLinks],
  );

  // ---- What is under the pointer ----
  const nodeUnder = (clientX: number, clientY: number, skip: Set<string> = new Set()): string | null => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const node = element.closest('.react-flow__node');
      if (node instanceof HTMLElement && node.dataset.id && !skip.has(node.dataset.id)) return node.dataset.id;
    }
    return null;
  };
  const skipping = (ids: string[]) => {
    const skip = new Set(ids);
    for (const id of ids) descendants(board, id).forEach((one) => skip.add(one));
    return skip;
  };

  const onNodeDrag = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent, _: FlowNode, dragged: FlowNode[]) => {
      if (!('clientX' in event)) return;
      setDropTargetId(nodeUnder(event.clientX, event.clientY, skipping(dragged.map((one) => one.id))));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board],
  );

  /** A drag on the board ended: into a frame, onto another Item (and ask), or onto open space. */
  const onNodeDragStop = useCallback(
    (event: React.MouseEvent | MouseEvent | TouchEvent, _: FlowNode, dragged: FlowNode[]) => {
      setDropTargetId(null);
      const point = 'clientX' in event ? { x: event.clientX, y: event.clientY } : null;
      const targetId = point ? nodeUnder(point.x, point.y, skipping(dragged.map((one) => one.id))) : null;
      const moved = (was: Board): Board => ({
        ...was,
        nodes: was.nodes.map((node) => {
          const one = dragged.find((d) => d.id === node.id);
          return one ? { ...node, x: one.position.x, y: one.position.y } : node;
        }),
      });
      const single = dragged.length === 1 ? board.nodes.find((node) => node.id === dragged[0]!.id) : undefined;
      const target = targetId ? board.nodes.find((node) => node.id === targetId) : undefined;
      const restore = () => setNodes(build(board, look, new Set()));

      // Onto another Item that is not already holding it: ask.
      if (single && single.kind === 'card' && isItemLike(target) && target.id !== single.parentId && point) {
        setBoard(moved);
        setDropAsk({ x: point.x, y: point.y, targetId: target.id, itemId: single.itemId, nodeId: single.id, at: { x: 0, y: 0 } });
        return;
      }
      setBoard((was0) => {
        let next = moved(was0);
        for (const one of dragged) {
          const node = next.nodes.find((n) => n.id === one.id);
          if (!node) continue;
          const spot = absolute(next, node);
          // The innermost box under the pointer (or, for several, under the node's middle) holds it.
          const size = sizeOf(node);
          const middle = dragged.length === 1 && point ? flow.screenToFlowPosition(point) : { x: spot.x + size.w / 2, y: spot.y + size.h / 2 };
          const inside = descendants(next, node.id);
          const holding = next.nodes
            .filter((n) => isBoxed(n) && n.id !== node.id && !inside.has(n.id))
            .filter((box) => {
              const at = absolute(next, box);
              const { w, h } = sizeOf(box);
              return middle.x > at.x && middle.x < at.x + w && middle.y > at.y && middle.y < at.y + h;
            })
            .sort((a, b) => sizeOf(a).w * sizeOf(a).h - sizeOf(b).w * sizeOf(b).h)[0];
          if (holding?.id === node.parentId) continue;
          // Once on open space and once per box: a second copy flashes the first instead.
          if (node.kind === 'card') {
            const twin = cardIn(next, node.itemId, holding?.id);
            if (twin && twin.id !== node.id) {
              window.setTimeout(() => {
                restore();
                flash(twin.id);
              }, 0);
              return was0;
            }
          }
          const base = holding ? absolute(next, holding) : { x: 0, y: 0 };
          next = {
            ...next,
            nodes: next.nodes.map((n) =>
              n.id === node.id ? { ...n, parentId: holding?.id, x: Math.max(holding ? 8 : -Infinity, spot.x - base.x), y: Math.max(holding ? BOX_HEAD : -Infinity, spot.y - base.y) } : n,
            ),
          };
          if (holding) next = fitBox(next, holding.id);
        }
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [board, look, setBoard, flash, flow],
  );

  // ---- Arrangements, tweened, with Undo ----
  const animateTo = useCallback(
    (next: Board, what: string) => {
      const before = new Map(stored.nodes.map((node) => [node.id, node]));
      const from = new Map(nodes.map((node) => [node.id, node]));
      const target = build(next, look, new Set(nodes.filter((n) => n.selected).map((n) => n.id)));
      const changed = next.nodes.filter((node) => JSON.stringify(node) !== JSON.stringify(before.get(node.id))).map((node) => node.id);
      animating.current = true;
      const start = performance.now();
      const step = (now: number) => {
        const t = Math.min(1, (now - start) / 500);
        const ease = 1 - Math.pow(1 - t, 3);
        setNodes(
          target.map((node) => {
            const was = from.get(node.id);
            if (!was || was.parentId !== node.parentId) return node;
            return {
              ...node,
              position: { x: was.position.x + (node.position.x - was.position.x) * ease, y: was.position.y + (node.position.y - was.position.y) * ease },
            } as FlowNode;
          }),
        );
        if (t < 1) requestAnimationFrame(step);
        else {
          animating.current = false;
          const byId = new Map(next.nodes.map((node) => [node.id, node]));
          setBoard((was) => ({ ...was, nodes: was.nodes.map((node) => (changed.includes(node.id) ? (byId.get(node.id) ?? node) : node)) }));
          offerToUndo({
            what,
            undo: async () => {
              setBoard((was) => ({ ...was, nodes: was.nodes.map((node) => (changed.includes(node.id) ? (before.get(node.id) ?? node) : node)) }));
            },
          });
        }
      };
      requestAnimationFrame(step);
    },
    [nodes, look, stored, setBoard, offerToUndo],
  );

  /** The chosen node in the middle; what it links to (same level) or what it holds, in a ring round it. Nothing else moves. */
  const arrangeStar = (id: string) => {
    const centreNode = board.nodes.find((node) => node.id === id);
    if (!centreNode) return;
    let next = board;
    if (isBoxed(centreNode)) {
      const children = board.nodes.filter((node) => node.parentId === id);
      if (children.length === 0) return;
      const r = Math.max(140, (children.length * (CARD_W + 20)) / (2 * Math.PI));
      const cx = PAD + r + CARD_W / 2;
      const cy = BOX_HEAD + r + CARD_H / 2;
      const placed = new Map(
        children.map((child, n) => {
          const angle = (2 * Math.PI * n) / children.length - Math.PI / 2;
          return [child.id, { x: cx + r * Math.cos(angle) - CARD_W / 2, y: cy + r * Math.sin(angle) - CARD_H / 2 }];
        }),
      );
      next = {
        ...board,
        nodes: board.nodes.map((node) => {
          if (node.id === id) return withSize(node, 2 * r + CARD_W + 2 * PAD, 2 * r + CARD_H + BOX_HEAD + PAD);
          const at = placed.get(node.id);
          return at ? { ...node, ...at } : node;
        }),
      };
    } else {
      const ref = refOf(centreNode);
      const others = new Set(links.flatMap((link) => (link.from === ref ? [link.to] : link.to === ref ? [link.from] : [])));
      const around = board.nodes.filter((node) => node.id !== id && node.parentId === centreNode.parentId && others.has(refOf(node)));
      if (around.length === 0) return;
      const r = Math.max(200, (around.length * (CARD_W + 30)) / (2 * Math.PI));
      next = {
        ...board,
        nodes: board.nodes.map((node) => {
          const n = around.indexOf(node);
          if (n === -1) return node;
          const angle = (2 * Math.PI * n) / around.length - Math.PI / 2;
          return { ...node, x: centreNode.x + r * Math.cos(angle), y: centreNode.y + r * Math.sin(angle) };
        }),
      };
    }
    animateTo(next, 'Arranged as a star');
  };

  /** Left to right along Leads to; boxes inside become lanes; cards on no path wait in a strip underneath, in the order placed. */
  const arrangeTimeline = (containerId: string | null) => {
    const members = board.nodes.filter((node) => (node.parentId ?? null) === containerId);
    if (members.length === 0) return;
    const laneBoxes = members.filter((node) => isBoxed(node));
    const leadsRefs = new Set(links.filter((link) => link.kindId === LEADS_TO).flatMap((link) => [link.from, link.to]));
    const loose = members.filter((node) => !isBoxed(node) && !leadsRefs.has(refOf(node)));
    const mainCards = members.filter((node) => !isBoxed(node) && leadsRefs.has(refOf(node)));
    const lanes = laneBoxes.map((box) => ({ box, cards: board.nodes.filter((node) => node.parentId === box.id && !isBoxed(node)) }));
    const cards = [...mainCards, ...lanes.flatMap((lane) => lane.cards)];
    const byRef = new Map<string, BoardNode[]>();
    for (const card of cards) byRef.set(refOf(card), [...(byRef.get(refOf(card)) ?? []), card]);
    const col = new Map(cards.map((card) => [card.id, 0]));
    const leads = links.filter((link) => link.kindId === LEADS_TO);
    for (let round = 0; round < cards.length; round += 1) {
      let changed = false;
      for (const link of leads)
        for (const a of byRef.get(link.from) ?? [])
          for (const b of byRef.get(link.to) ?? []) {
            if (col.get(b.id)! < col.get(a.id)! + 1) {
              col.set(b.id, col.get(a.id)! + 1);
              changed = true;
            }
          }
      if (!changed) break;
    }
    const COLW = CARD_W + 70;
    const ROWH = CARD_H + 24;
    const rowsOf = (laneCards: BoardNode[]) => {
      const used = new Map<number, number>();
      const at = new Map<string, { col: number; row: number }>();
      for (const card of [...laneCards].sort((a, b) => col.get(a.id)! - col.get(b.id)! || a.y - b.y)) {
        const c = col.get(card.id)!;
        const row = used.get(c) ?? 0;
        used.set(c, row + 1);
        at.set(card.id, { col: c, row });
      }
      return { at, rows: Math.max(1, ...used.values()) };
    };
    const maxCol = Math.max(0, ...col.values());
    const origin = containerId
      ? { x: 0, y: BOX_HEAD - PAD }
      : { x: Math.min(...members.map((m) => m.x)) - PAD, y: Math.min(...members.map((m) => m.y)) };
    const placed = new Map<string, { x: number; y: number; w?: number; h?: number }>();
    let y = origin.y;
    if (mainCards.length) {
      const { at, rows } = rowsOf(mainCards);
      for (const [id, spot] of at) placed.set(id, { x: origin.x + PAD + spot.col * COLW, y: y + PAD + spot.row * ROWH });
      y += rows * ROWH + PAD;
    }
    for (const lane of lanes) {
      const { at, rows } = rowsOf(lane.cards);
      const h = BOX_HEAD + rows * ROWH + PAD - 8;
      placed.set(lane.box.id, { x: origin.x, y, w: (maxCol + 1) * COLW - 70 + 2 * PAD, h });
      for (const [id, spot] of at) placed.set(id, { x: PAD + spot.col * COLW, y: BOX_HEAD + spot.row * ROWH });
      y += h + 20;
    }
    loose.forEach((card, n) => placed.set(card.id, { x: origin.x + PAD + n * COLW, y: y + PAD }));
    if (loose.length) y += ROWH + PAD;
    let next: Board = {
      ...board,
      nodes: board.nodes.map((node) => {
        const at = placed.get(node.id);
        if (!at) return node;
        const moved = { ...node, x: at.x, y: at.y } as BoardNode;
        return at.w !== undefined && at.h !== undefined ? withSize(moved, at.w, at.h) : moved;
      }),
    };
    if (containerId) {
      next = { ...next, nodes: next.nodes.map((node) => (node.id === containerId ? withSize(node, (maxCol + 1) * COLW - 70 + 4 * PAD, y + PAD) : node)) };
    }
    animateTo(next, 'Arranged as a timeline');
  };

  // ---- Pointer tools: Box, Line, and an arrow drawn from the menu ----
  const local = (clientX: number, clientY: number) => {
    const rect = wrapper.current!.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };
  const link = (fromId: string, toId: string) => {
    const a = board.nodes.find((node) => node.id === fromId);
    const b = board.nodes.find((node) => node.id === toId);
    if (!a || !b || a.id === b.id) return;
    setLinks((was) => [...was, { id: newId(), from: refOf(a), to: refOf(b), kindId: kind.id }]);
  };
  /** A dot dragged to another card or box - its dot, or anywhere on it - links the two. */
  const onConnectEnd = (event: MouseEvent | TouchEvent, state: FinalConnectionState) => {
    const from = state.fromNode?.id;
    if (!from) return;
    const point = 'clientX' in event ? event : event.changedTouches[0];
    const to = state.toNode?.id ?? (point ? nodeUnder(point.clientX, point.clientY, new Set([from])) : null);
    if (to && to !== from) link(from, to);
  };
  const overlayDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = local(event.clientX, event.clientY);
    if (arrowFrom) {
      const target = nodeUnder(event.clientX, event.clientY);
      if (target) link(arrowFrom, target);
      setArrowFrom(null);
      setDrawing(null);
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing({ tool, x0: at.x, y0: at.y, x1: at.x, y1: at.y });
  };
  const overlayMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const at = local(event.clientX, event.clientY);
    if (arrowFrom) {
      const from = flow.getInternalNode(arrowFrom);
      if (!from) return;
      const s = flow.flowToScreenPosition(centre(from));
      const o = local(s.x, s.y);
      setDrawing({ tool: 'arrow', x0: o.x, y0: o.y, x1: at.x, y1: at.y });
      return;
    }
    if (drawing) setDrawing({ ...drawing, x1: at.x, y1: at.y });
  };
  const overlayUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drawing || arrowFrom) return;
    setDrawing(null);
    const rect = wrapper.current!.getBoundingClientRect();
    const a = flow.screenToFlowPosition({ x: drawing.x0 + rect.left, y: drawing.y0 + rect.top });
    const b = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    if (Math.abs(b.x - a.x) < 12 && Math.abs(b.y - a.y) < 12) return;
    const id = newId();
    if (drawing.tool === 'box') {
      const snap = (v: number) => (grid ? Math.round(v / GRID) * GRID : v);
      setBoard((was) => ({
        ...was,
        nodes: [
          ...was.nodes,
          {
            id,
            kind: 'box',
            name: '',
            x: snap(Math.min(a.x, b.x)),
            y: snap(Math.min(a.y, b.y)),
            w: Math.max(CARD_W + 2 * PAD, snap(Math.abs(b.x - a.x))),
            h: Math.max(100, snap(Math.abs(b.y - a.y))),
          },
        ],
      }));
      setEditingId(id);
    } else {
      setBoard((was) => ({ ...was, lines: [...was.lines, { id, x1: a.x, y1: a.y, x2: b.x, y2: b.y, label: '' }] }));
      setEditingLine(id);
    }
    setTool('select');
  };

  // ---- Dropping a row from a Panel, or a whole Panel ----
  const onDragOver = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    const under = nodeUnder(event.clientX, event.clientY);
    if (under !== dropTargetId) setDropTargetId(under);
  };
  const placeNew = (ids: string[], point: { x: number; y: number }, targetId: string | null) => {
    const at = flow.screenToFlowPosition(point);
    const target = targetId ? board.nodes.find((node) => node.id === targetId) : undefined;
    const frame = target && isBoxed(target) ? target : undefined;
    let twin: BoardNode | undefined;
    setBoard((was) => {
      let next = was;
      ids.forEach((itemId, n) => {
        const already = cardIn(next, itemId, frame?.id);
        if (already) {
          twin = already;
          return;
        }
        next = {
          ...next,
          nodes: [
            ...next.nodes,
            frame
              ? // Into a box: under what it already holds, so nothing lands on top of a card.
                { id: newId(), kind: 'card', itemId, parentId: frame.id, ...nextSlot(next, frame.id) }
              : { id: newId(), kind: 'card', itemId, x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 + n * (CARD_H + 12) },
          ],
        };
      });
      return frame ? fitBox(next, frame.id) : next;
    });
    window.setTimeout(() => twin && flash(twin.id), 0);
  };
  const onDrop = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    const targetId = dropTargetId;
    setDropTargetId(null);
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    if (!itemId) return;
    const carried = selectionCarried();
    const ids = carried?.ids.includes(itemId) ? [...carried.ids] : [itemId];
    const target = targetId ? board.nodes.find((node) => node.id === targetId) : undefined;
    // Onto another Item (as a card, or a box that is an Item): ask what it means.
    if (ids.length === 1 && isItemLike(target) && !(target.kind === 'card' && target.itemId === itemId)) {
      setDropTargetId(target.id);
      setDropAsk({ x: event.clientX, y: event.clientY, targetId: target.id, itemId, nodeId: null, at: flow.screenToFlowPosition({ x: event.clientX, y: event.clientY }) });
      return;
    }
    placeNew(ids, { x: event.clientX, y: event.clientY }, target && target.kind === 'box' ? target.id : null);
  };
  useEffect(() => {
    if (readOnly) return;
    const onPanel = (event: Event) => {
      const { panelId, x, y } = (event as CustomEvent<{ panelId: string; x: number; y: number }>).detail;
      const existing = board.nodes.find((node) => node.kind === 'panel' && node.panelId === panelId && !node.parentId);
      if (existing) {
        flash(existing.id);
        return;
      }
      const at = flow.screenToFlowPosition({ x, y });
      setBoard((was) => ({ ...was, nodes: [...was.nodes, { id: newId(), kind: 'panel', panelId, x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 }] }));
    };
    window.addEventListener('poc-panel-drop', onPanel);
    return () => window.removeEventListener('poc-panel-drop', onPanel);
  }, [readOnly, board, flash, flow, setBoard]);

  // ---- Keys and double-clicks ----
  const selected = nodes.filter((node) => node.selected);
  const open = (nodeId: string) => {
    const node = board.nodes.find((one) => one.id === nodeId);
    if (node?.kind === 'card') openItem(node.itemId);
    else if ((node?.kind === 'box' || node?.kind === 'sketch') && !readOnly) setEditingId(node.id);
  };
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const typing = event.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(event.target.tagName);
      if (typing || document.querySelector('[role="dialog"]')) return;
      if (event.key === 'Escape') {
        if (dropAsk) {
          answerDrop('cancel');
          return;
        }
        setMenu(null);
        setEdgePop(null);
        setArrowFrom(null);
        setDrawing(null);
        void flow.fitView({ duration: 450, padding: 0.15 });
      }
      if (event.key === 'Enter' && selected.length === 1 && wrapper.current?.contains(document.activeElement ?? null)) {
        event.preventDefault();
        open(selected[0]!.id);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onDoubleClick = (event: React.MouseEvent) => {
    if (readOnly || tool !== 'select') return;
    if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return;
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = newId();
    setBoard((was) => ({ ...was, nodes: [...was.nodes, { id, kind: 'sketch', title: '', x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 }] }));
    setEditingId(id);
  };

  const selectedCards = selected.flatMap((node) => {
    const held = board.nodes.find((one) => one.id === node.id);
    return held?.kind === 'card' ? [held] : [];
  });
  const menuNode = menu?.nodeId ? board.nodes.find((node) => node.id === menu.nodeId) : undefined;
  const editingFree = board.lines.find((line) => line.id === editingLine);
  const popLink = edgePop ? links.find((one) => one.id === edgePop.linkId) : undefined;
  const askTarget = dropAsk ? board.nodes.find((node) => node.id === dropAsk.targetId) : undefined;

  const toolButton = (value: Tool, label: string) => (
    <button
      type="button"
      aria-pressed={tool === value}
      onClick={() => {
        setTool(value);
        setArrowFrom(null);
      }}
      className={`rounded px-2 py-1 text-xs ${tool === value ? 'bg-accent text-on-accent' : 'text-ink hover:bg-accent-tint'}`}
    >
      {label}
    </button>
  );
  const chip = 'flex items-center gap-1 rounded-md border border-shade/10 bg-surface p-1 shadow-md';
  const small = 'rounded px-2 py-1 text-xs text-ink hover:bg-accent-tint';
  const floating = 'fixed z-floating min-w-48 rounded-md border border-shade/10 bg-surface p-1 shadow-lg';
  const entryClass = 'block w-full rounded px-3 py-1.5 text-left text-sm text-ink hover:bg-accent-tint hover:text-accent-deep';

  const menuEntries = (): [string, () => void][] => {
    const entries: [string, () => void][] = [];
    if (!menuNode) {
      entries.push(['Arrange board as timeline', () => arrangeTimeline(null)]);
      entries.push(['Fit everything', () => void flow.fitView({ duration: 400, padding: 0.15 })]);
      return entries;
    }
    if (menuNode.kind === 'card') {
      entries.push(['Open', () => openItem(menuNode.itemId)]);
      entries.push(['Split…', () => askToSplit(menuNode.itemId, dashboardId)]);
    }
    if (menuNode.kind === 'box' || menuNode.kind === 'sketch') entries.push(['Rename', () => setEditingId(menuNode.id)]);
    if (isItemLike(menuNode) && (menuNode.asBox || look.childItems(menuNode).length > 0 || menuNode.kind === 'panel'))
      entries.push(menuNode.asBox ? ['Show as card', () => showAsBox(menuNode.id, false)] : ['Show as box', () => showAsBox(menuNode.id, true)]);
    if (isBoxed(menuNode)) {
      entries.push(['Zoom to box', () => zoomTo(menuNode.id)]);
      entries.push(['Arrange as timeline', () => arrangeTimeline(menuNode.id)]);
    }
    entries.push(['Arrange as star', () => arrangeStar(menuNode.id)]);
    entries.push(['Draw arrow from here', () => setArrowFrom(menuNode.id)]);
    entries.push(['Take off the whiteboard', () => takeOff([menuNode.id])]);
    return entries;
  };

  return (
    <BoardContext.Provider value={ctx}>
      <BoardWriter.Provider value={[board, setBoard]}>
        <style>{`
          [data-poc-whiteboard] .poc-dot { width: 10px; height: 10px; background: var(--color-surface); border: 2px solid var(--color-accent); opacity: 0; transition: opacity .12s; }
          [data-poc-whiteboard] .react-flow__node:hover > div > .poc-dot, [data-poc-whiteboard] .react-flow__node.selected > div > .poc-dot { opacity: 1; }
          [data-poc-whiteboard] .poc-dot:hover { background: var(--color-accent); }
        `}</style>
        <div
          ref={wrapper}
          data-poc-whiteboard
          onDragOver={onDragOver}
          onDragLeave={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setDropTargetId(null);
          }}
          onDrop={onDrop}
          onDoubleClick={onDoubleClick}
          className={`${full ? 'fixed inset-0 z-floating' : 'relative h-full w-full'} overflow-hidden rounded-md border border-shade/10 bg-surface`}
        >
          <ReactFlow<FlowNode, KindEdge>
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnectEnd={onConnectEnd}
            connectionMode={ConnectionMode.Loose}
            onNodeDrag={onNodeDrag}
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(_, node) => {
              setMenu(null);
              setEdgePop(null);
              if (readOnly) open(node.id);
            }}
            onNodeDoubleClick={(_, node) => !readOnly && open(node.id)}
            onNodeContextMenu={(event, node) => {
              if (readOnly) return;
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id });
            }}
            onPaneContextMenu={(event) => {
              if (readOnly) return;
              event.preventDefault();
              setMenu({ x: event.clientX, y: event.clientY, nodeId: null });
            }}
            onPaneClick={() => {
              setMenu(null);
              setEdgePop(null);
              if (dropAsk) answerDrop('cancel');
            }}
            onEdgeClick={(event, edge) => {
              if (readOnly || !edge.data) return;
              setEdgePop({ x: event.clientX, y: event.clientY, linkId: edge.data.linkId });
            }}
            onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
            onEdgeMouseLeave={() => setHoveredEdge(null)}
            {...(readOnly ? {} : { fitView: true })}
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.1}
            maxZoom={2.5}
            zoomOnDoubleClick={false}
            elevateNodesOnSelect={false}
            snapToGrid={grid}
            snapGrid={[GRID, GRID]}
            nodesDraggable={!readOnly}
            nodesConnectable={!readOnly}
            elementsSelectable={!readOnly}
            panOnDrag
            panOnScroll={!readOnly}
            zoomActivationKeyCode={['Meta', 'Control']}
            selectionKeyCode={readOnly ? null : "Shift"}
            selectionMode={SelectionMode.Partial}
            multiSelectionKeyCode={['Shift', 'Meta', 'Control']}
            deleteKeyCode={readOnly ? null : ['Backspace', 'Delete']}
            proOptions={{ hideAttribution: true }}
          >
            {grid && <Background variant={BackgroundVariant.Dots} gap={GRID} size={1.4} color="#c3c6d4" />}
            <ViewportPortal>
              <svg className="pointer-events-none absolute overflow-visible" style={{ left: 0, top: 0, width: 1, height: 1 }}>
                {board.lines.map((line) => (
                  <g key={line.id}>
                    <line x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} stroke="#8b8d94" strokeWidth={2} strokeDasharray="10 6" />
                    <line
                      x1={line.x1}
                      y1={line.y1}
                      x2={line.x2}
                      y2={line.y2}
                      stroke="transparent"
                      strokeWidth={14}
                      style={{ pointerEvents: readOnly ? 'none' : 'stroke', cursor: 'pointer' }}
                      onDoubleClick={() => setEditingLine(line.id)}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        if (confirm('Take this line off the whiteboard?'))
                          setBoard((was) => ({ ...was, lines: was.lines.filter((one) => one.id !== line.id) }));
                      }}
                    />
                  </g>
                ))}
              </svg>
              {board.lines.map((line) =>
                line.label || editingLine === line.id ? (
                  <div
                    key={line.id}
                    className="absolute whitespace-nowrap rounded bg-surface px-2 py-0.5 text-xs font-semibold tracking-wide text-ink-soft shadow-sm"
                    style={{ left: (line.x1 + line.x2) / 2, top: (line.y1 + line.y2) / 2, transform: 'translate(-50%, -50%)', pointerEvents: 'all' }}
                    onDoubleClick={() => !readOnly && setEditingLine(line.id)}
                    data-line-label={line.label}
                  >
                    {editingLine === line.id && editingFree ? (
                      <input
                        autoFocus
                        defaultValue={line.label}
                        placeholder="Label (optional)"
                        aria-label="Label this line"
                        className="nodrag w-36 bg-transparent outline-none"
                        onKeyDown={(event) => {
                          event.stopPropagation();
                          if (event.key === 'Enter' || event.key === 'Escape') (event.target as HTMLInputElement).blur();
                        }}
                        onBlur={(event) => {
                          const label = event.target.value.trim();
                          setEditingLine(null);
                          setBoard((was) => ({ ...was, lines: was.lines.map((one) => (one.id === line.id ? { ...one, label } : one)) }));
                        }}
                      />
                    ) : (
                      line.label
                    )}
                  </div>
                ) : null,
              )}
            </ViewportPortal>
          </ReactFlow>

          {/* Box and Line take the pointer from the board while they are on, as does an arrow begun from the menu. */}
          {!readOnly && (tool !== 'select' || arrowFrom) && (
            <div className="absolute inset-0 z-10 cursor-crosshair" data-poc-overlay={tool} onPointerDown={overlayDown} onPointerMove={overlayMove} onPointerUp={overlayUp}>
              {drawing && (
                <svg className="pointer-events-none absolute inset-0 h-full w-full">
                  {drawing.tool === 'box' ? (
                    <rect
                      x={Math.min(drawing.x0, drawing.x1)}
                      y={Math.min(drawing.y0, drawing.y1)}
                      width={Math.abs(drawing.x1 - drawing.x0)}
                      height={Math.abs(drawing.y1 - drawing.y0)}
                      rx={10}
                      fill="rgb(111 98 181 / 0.08)"
                      stroke="var(--color-accent)"
                      strokeWidth={2}
                    />
                  ) : (
                    <line
                      x1={drawing.x0}
                      y1={drawing.y0}
                      x2={drawing.x1}
                      y2={drawing.y1}
                      stroke={drawing.tool === 'line' ? '#8b8d94' : kind.colour}
                      strokeWidth={2}
                      strokeDasharray={drawing.tool === 'line' ? '10 6' : DASHES[kind.style]}
                    />
                  )}
                </svg>
              )}
              {arrowFrom && (
                <p className="absolute bottom-3 left-1/2 -translate-x-1/2 rounded bg-toast px-3 py-1 text-xs text-white">
                  Click the card or box it goes to · Esc to stop
                </p>
              )}
            </div>
          )}

          {!readOnly && (
            <div className={`absolute top-3 left-3 z-20 max-w-[calc(100%-330px)] flex-wrap ${chip}`} role="toolbar" aria-label="Whiteboard tools">
              {toolButton('select', 'Select')}
              {toolButton('box', 'Box')}
              {toolButton('line', 'Line')}
              <span className="mx-1 h-4 w-px bg-shade/15" />
              <KindPicker kinds={kinds} kind={kind} onPick={setKindId} onAdd={(made) => (setKinds([...kinds, made]), setKindId(made.id))} />
              <span className="mx-1 h-4 w-px bg-shade/15" />
              <button type="button" aria-pressed={showLabels} onClick={() => setShowLabels(!showLabels)} className={`${small} ${showLabels ? 'bg-accent-tint text-accent-deep' : ''}`}>
                Show labels
              </button>
              <button type="button" aria-pressed={grid} onClick={() => setGrid(!grid)} className={small}>
                Grid: {grid ? 'on' : 'off'}
              </button>
            </div>
          )}

          <div className={`absolute top-3 right-3 z-20 ${chip}`} role="toolbar" aria-label="Zoom">
            <button type="button" aria-label="Zoom out" onClick={() => void flow.zoomOut({ duration: 200 })} className={small}>
              −
            </button>
            <span className="w-11 text-center text-xs tabular-nums text-ink-soft">{Math.round(zoom * 100)}%</span>
            <button type="button" aria-label="Zoom in" onClick={() => void flow.zoomIn({ duration: 200 })} className={small}>
              +
            </button>
            <button type="button" onClick={() => void flow.fitView({ duration: 400, padding: 0.15 })} className={small}>
              Fit
            </button>
            <button type="button" onClick={() => setFull(!full)} className={small}>
              {full ? 'Exit full screen' : 'Full screen'}
            </button>
          </div>

          {!readOnly && selected.length > 0 && (
            <div className={`absolute top-14 left-1/2 z-20 -translate-x-1/2 ${chip}`} aria-label="Selection">
              <span className="px-2 text-xs text-ink-soft">{selected.length} selected</span>
              {selectedCards.length >= 2 && (
                <button
                  type="button"
                  onClick={() => askToCombine(selectedCards.flatMap((card) => (card.kind === 'card' ? [card.itemId] : [])), dashboardId, selectedCards.map((card) => card.id))}
                  className="milled rounded bg-accent px-2.5 py-1 text-xs font-medium text-on-accent hover:bg-accent-hover"
                >
                  Combine
                </button>
              )}
              {selected.length === 1 && (
                <button type="button" onClick={() => arrangeStar(selected[0]!.id)} className={small}>
                  Arrange as star
                </button>
              )}
              {selected.length === 1 && selected[0]!.type === 'box' && (
                <button type="button" onClick={() => arrangeTimeline(selected[0]!.id)} className={small}>
                  Arrange as timeline
                </button>
              )}
            </div>
          )}

          {board.nodes.length === 0 && !readOnly && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-ink-faint">
              Drag a row or a Panel here, or double-click to sketch.
            </p>
          )}
        </div>

        {/* Menus float over everything, at the pointer. */}
        {menu &&
          createPortal(
            <div role="menu" className={floating} style={{ left: menu.x, top: menu.y }} onContextMenu={(event) => event.preventDefault()}>
              {menuEntries().map(([label, run]) => (
                <button
                  key={label}
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setMenu(null);
                    run();
                  }}
                  className={entryClass}
                >
                  {label}
                </button>
              ))}
            </div>,
            document.body,
          )}
        {dropAsk &&
          askTarget &&
          createPortal(
            <>
              <div className="fixed inset-0 z-floating" onPointerDown={() => answerDrop('cancel')} />
              <div role="menu" aria-label="Dropped on an Item" className={floating} style={{ left: dropAsk.x + 4, top: dropAsk.y + 4 }}>
                <button type="button" role="menuitem" onClick={() => answerDrop('inside')} className={entryClass}>
                  Put inside {titleOf(askTarget, look)}
                </button>
                {askTarget.kind === 'card' && (
                  <button type="button" role="menuitem" onClick={() => answerDrop('combine')} className={entryClass}>
                    Combine with {titleOf(askTarget, look)}…
                  </button>
                )}
              </div>
            </>,
            document.body,
          )}
        {edgePop &&
          popLink &&
          createPortal(
            <div className={`${floating} w-56 p-2`} style={{ left: edgePop.x + 6, top: edgePop.y + 6 }} aria-label="Link">
              <p className="px-1 pb-1 text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">Kind</p>
              {kinds.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  onClick={() => setLinks((was) => was.map((l) => (l.id === popLink.id ? { ...l, kindId: one.id } : l)))}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1 text-left text-sm hover:bg-accent-tint ${one.id === popLink.kindId ? 'font-medium text-accent-deep' : 'text-ink'}`}
                >
                  <KindSample kind={one} />
                  {one.name}
                </button>
              ))}
              <input
                defaultValue={popLink.label ?? ''}
                placeholder="Label (optional)"
                aria-label="Label of this link"
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter' || event.key === 'Escape') setEdgePop(null);
                }}
                onChange={(event) => {
                  const label = event.target.value.trim() || undefined;
                  setLinks((was) => was.map((l) => (l.id === popLink.id ? { ...l, label } : l)));
                }}
                className="mt-2 w-full rounded-md border border-shade/10 bg-field px-2 py-1 text-sm outline-none focus:border-accent"
              />
              <button
                type="button"
                onClick={() => {
                  setLinks((was) => was.filter((l) => l.id !== popLink.id));
                  setEdgePop(null);
                }}
                className="mt-1 w-full rounded px-2 py-1 text-left text-sm text-over-ink hover:bg-accent-tint"
              >
                Remove link
              </button>
            </div>,
            document.body,
          )}
      </BoardWriter.Provider>
    </BoardContext.Provider>
  );
}

function KindSample({ kind, width = 28 }: { kind: Pick<LineKind, 'style' | 'colour' | 'arrow'>; width?: number }) {
  return (
    <svg width={width} height={10} aria-hidden="true" className="shrink-0">
      {kind.style === 'double' ? (
        <>
          <line x1={1} y1={3} x2={width - 6} y2={3} stroke={kind.colour} strokeWidth={1.5} />
          <line x1={1} y1={7} x2={width - 6} y2={7} stroke={kind.colour} strokeWidth={1.5} />
        </>
      ) : (
        <line x1={1} y1={5} x2={width - 6} y2={5} stroke={kind.colour} strokeWidth={2} strokeDasharray={DASHES[kind.style]} strokeLinecap="round" />
      )}
      {kind.arrow && <path d={`M${width - 7} 1 L${width - 1} 5 L${width - 7} 9 Z`} fill={kind.colour} />}
    </svg>
  );
}

function KindPicker({ kinds, kind, onPick, onAdd }: { kinds: LineKind[]; kind: LineKind; onPick: (id: string) => void; onAdd: (kind: LineKind) => void }) {
  const [open, setOpen] = useState(false);
  const [making, setMaking] = useState(false);
  const [name, setName] = useState('');
  const [style, setStyle] = useState<LineStyle>('dashed');
  const [colour, setColour] = useState(SWATCHES[1]!);
  const [arrow, setArrow] = useState(true);
  return (
    <Popover.Root
      open={open}
      onOpenChange={(now) => {
        setOpen(now);
        if (!now) setMaking(false);
      }}
    >
      <Popover.Trigger className="flex items-center gap-1.5 rounded px-2 py-1 text-xs text-ink hover:bg-accent-tint" aria-label="Line kind">
        <KindSample kind={kind} />
        {kind.name} ▾
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content align="start" sideOffset={6} className="z-floating w-60 rounded-md border border-shade/10 bg-surface p-1 shadow-lg">
          {!making ? (
            <>
              {kinds.map((one) => (
                <button
                  key={one.id}
                  type="button"
                  onClick={() => {
                    onPick(one.id);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent-tint ${one.id === kind.id ? 'font-medium text-accent-deep' : 'text-ink'}`}
                >
                  <KindSample kind={one} />
                  {one.name}
                </button>
              ))}
              <div className="my-1 h-px bg-shade/10" />
              <button type="button" onClick={() => setMaking(true)} className="w-full rounded px-2 py-1.5 text-left text-sm text-accent-deep hover:bg-accent-tint">
                + New kind…
              </button>
            </>
          ) : (
            <form
              className="flex flex-col gap-2 p-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim()) return;
                onAdd({ id: newId(), name: name.trim(), style, colour, arrow });
                setName('');
                setMaking(false);
                setOpen(false);
              }}
            >
              <input
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.stopPropagation()}
                placeholder="Name, e.g. Blocks"
                aria-label="Name of the line kind"
                className="rounded-md border border-shade/10 bg-field px-2 py-1 text-sm outline-none focus:border-accent"
              />
              <div className="grid grid-cols-4 gap-1" role="radiogroup" aria-label="Style">
                {(['solid', 'dashed', 'dotted', 'double'] as const).map((one) => (
                  <button
                    key={one}
                    type="button"
                    role="radio"
                    aria-checked={style === one}
                    aria-label={one}
                    onClick={() => setStyle(one)}
                    className={`flex flex-col items-center gap-0.5 rounded border px-1 py-1 text-[10px] ${style === one ? 'border-accent bg-accent-tint' : 'border-shade/10'}`}
                  >
                    <KindSample kind={{ style: one, colour, arrow: false }} width={30} />
                    {one}
                  </button>
                ))}
              </div>
              <div className="flex gap-1.5" role="radiogroup" aria-label="Colour">
                {SWATCHES.map((one) => (
                  <button
                    key={one}
                    type="button"
                    role="radio"
                    aria-checked={colour === one}
                    aria-label={`Colour ${one}`}
                    onClick={() => setColour(one)}
                    className={`size-5 rounded-full ${colour === one ? 'ring-2 ring-accent ring-offset-2' : ''}`}
                    style={{ background: one }}
                  />
                ))}
              </div>
              <label className="flex items-center gap-2 text-sm text-ink">
                <input type="checkbox" checked={arrow} onChange={(event) => setArrow(event.target.checked)} className="accent-[var(--color-accent)]" />
                Arrowhead
              </label>
              <div className="flex justify-end gap-1">
                <button type="button" onClick={() => setMaking(false)} className="rounded px-2 py-1 text-xs text-ink-soft hover:bg-accent-tint">
                  Cancel
                </button>
                <button type="submit" className="milled rounded bg-accent px-2 py-1 text-xs font-medium text-on-accent">
                  Add kind
                </button>
              </div>
            </form>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export default function Whiteboard(props: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  return (
    <ReactFlowProvider>
      <BoardInner {...props} />
    </ReactFlowProvider>
  );
}

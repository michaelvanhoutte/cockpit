import '@xyflow/react/dist/style.css';
import * as Popover from '@radix-ui/react-popover';
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  EdgeLabelRenderer,
  Handle,
  MarkerType,
  NodeResizer,
  Position,
  ReactFlow,
  ReactFlowProvider,
  ViewportPortal,
  applyNodeChanges,
  getStraightPath,
  useInternalNode,
  useReactFlow,
  useViewport,
  type Edge,
  type EdgeChange,
  type EdgeProps,
  type InternalNode,
  type Node,
  type NodeChange,
  type NodeProps,
} from '@xyflow/react';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { itemLabel, itemStatus, type Item } from '@cockpit/shared';
import { useSnapshot } from '../api/useSnapshot';
import { ITEM_BEING_DRAGGED } from '../dropAt';
import { useOpenItem } from '../itemForm';
import { selectionCarried } from '../itemInTheAir';
import { sourceOnARow } from '../itemSource';
import { BOX_HEAD, CARD_H, CARD_W, PAD, absolute, fitBox, ordered, sizeOf } from './board';
import { askToCombine, askToSplit } from './dialogs';
import { StatusMark } from './PocGroups';
import {
  DEFAULT_KINDS,
  EMPTY_BOARD,
  LEADS_TO,
  boardKey,
  hiddenKey,
  kindsKey,
  linksKey,
  newId,
  usePoc,
  type Board,
  type BoardNode,
  type LineKind,
  type LineStyle,
  type Link,
} from './store';

/** POC (throwaway): a whiteboard of a Dashboard's Items, kept in the browser. */

type Status = ReturnType<typeof itemStatus>;
type CardData = { title: string; status: Status; source: string | null; missing: boolean; sketch: boolean; merged: boolean };
type BoxData = { name: string; count: number };
type CardNode = Node<CardData, 'card'>;
type BoxNode = Node<BoxData, 'box'>;
type FlowNode = CardNode | BoxNode;
type KindEdgeData = { kind: LineKind; label: string | undefined; linkId: string; hovered: boolean; editing: boolean };
type KindEdge = Edge<KindEdgeData, 'kind'>;

const STATUS_WORDS: Record<Status, string> = { to_do: 'To do', in_progress: 'In progress', waiting: 'Waiting', done: 'Done' };
const SWATCHES = ['#3a3f4b', '#6f62b5', '#0e7490', '#0b7a55', '#9a5b14', '#bf5d55'];
const GRID = 20;

interface Ctx {
  readOnly: boolean;
  editingId: string | null;
  showLabels: boolean;
  commitName: (id: string, text: string) => void;
  commitEdgeLabel: (linkId: string, text: string) => void;
  stopEditing: () => void;
}
const BoardContext = createContext<Ctx>({
  readOnly: true,
  editingId: null,
  showLabels: false,
  commitName: () => {},
  commitEdgeLabel: () => {},
  stopEditing: () => {},
});

function InlineName({ id, initial, placeholder, className }: { id: string; initial: string; placeholder: string; className: string }) {
  const { commitName, stopEditing } = useContext(BoardContext);
  const [text, setText] = useState(initial);
  const field = useRef<HTMLInputElement>(null);
  // xyflow focuses the node on the click that made it; take the keyboard back after.
  useEffect(() => {
    const later = window.setTimeout(() => field.current?.focus(), 30);
    return () => window.clearTimeout(later);
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
      className={`nodrag rounded border border-accent bg-field px-1 outline-none ${className}`}
    />
  );
}

const hiddenHandle = { opacity: 0, pointerEvents: 'none' as const, left: '50%', top: '50%' };

function CardView({ id, data, selected }: NodeProps<CardNode>) {
  const { editingId } = useContext(BoardContext);
  const finished = data.status === 'done';
  return (
    <div
      data-card={data.title}
      className={`flex h-[64px] w-[200px] flex-col justify-center gap-1 rounded-md border px-2.5 py-1.5 text-left shadow-panel ${
        data.sketch ? 'border-dashed border-accent/60 bg-accent-tint/60' : 'border-shade/10 bg-field'
      } ${selected ? 'ring-2 ring-accent' : ''} ${finished || data.missing ? 'opacity-60' : ''}`}
    >
      <Handle type="target" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hiddenHandle} isConnectable={false} />
      {editingId === id ? (
        <InlineName id={id} initial={data.title} placeholder="Name this sketch" className="text-sm" />
      ) : (
        <span className={`line-clamp-2 text-[13px] leading-tight font-medium ${finished ? 'text-ink-faint line-through' : 'text-ink-strong'}`}>
          {data.title || <span className="text-ink-faint italic">Untitled sketch</span>}
        </span>
      )}
      <span className="flex items-center gap-1.5 text-[11px] text-ink-faint">
        {data.sketch ? (
          <span className="italic">{data.merged ? 'New · merged (not saved)' : 'Sketch · not saved'}</span>
        ) : data.missing ? (
          <span>Not in this Workspace now</span>
        ) : (
          <>
            <StatusMark status={data.status} />
            <span>{STATUS_WORDS[data.status]}</span>
            {data.source && <span className="truncate">· {data.source}</span>}
          </>
        )}
      </span>
    </div>
  );
}

function BoxView({ id, data, selected }: NodeProps<BoxNode>) {
  const { editingId, readOnly } = useContext(BoardContext);
  const [, setBoard] = useContext(BoardWriter);
  return (
    <div
      data-box={data.name}
      className={`h-full w-full rounded-lg border-2 bg-accent-tint/25 ${selected ? 'border-accent' : 'border-accent/30'}`}
    >
      {!readOnly && (
        <NodeResizer
          isVisible={selected}
          minWidth={CARD_W + 2 * PAD}
          minHeight={100}
          color="var(--color-accent)"
          onResizeEnd={(_, size) => {
            setBoard((was) => ({
              ...was,
              nodes: was.nodes.map((node) =>
                node.id === id && node.kind === 'box' ? { ...node, x: size.x, y: size.y, w: size.width, h: size.height } : node,
              ),
            }));
          }}
        />
      )}
      <Handle type="target" position={Position.Top} style={hiddenHandle} isConnectable={false} />
      <Handle type="source" position={Position.Bottom} style={hiddenHandle} isConnectable={false} />
      <div className="flex h-[36px] items-center justify-between gap-2 px-3">
        {editingId === id ? (
          <InlineName id={id} initial={data.name} placeholder="Name this box" className="text-sm font-semibold" />
        ) : (
          <span className="truncate text-xs font-semibold tracking-[0.12em] text-accent-deep uppercase">{data.name || 'Box'}</span>
        )}
        <span className="shrink-0 text-xs text-ink-faint">
          {data.count} {data.count === 1 ? 'Item' : 'Items'}
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
  const { showLabels, commitEdgeLabel, stopEditing } = useContext(BoardContext);
  const from = useInternalNode(source);
  const to = useInternalNode(target);
  const [text, setText] = useState(data?.label ?? '');
  if (!from || !to || !data) return null;
  const start = borderPoint(from, centre(to));
  const end = borderPoint(to, centre(from));
  const [path, labelX, labelY] = getStraightPath({ sourceX: start.x, sourceY: start.y, targetX: end.x, targetY: end.y });
  const { kind } = data;
  const width = selected ? 2.5 : 1.75;
  const label = data.label ?? (showLabels || data.hovered ? kind.name : null);
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
      {(label !== null || data.editing) && (
        <EdgeLabelRenderer>
          <div
            className="nodrag nopan absolute rounded bg-surface/95 px-1.5 py-0.5 text-[11px] font-medium shadow-sm"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`, color: kind.colour, pointerEvents: 'all' }}
            data-edge-label={label ?? ''}
          >
            {data.editing ? (
              <input
                autoFocus
                value={text}
                placeholder={kind.name}
                aria-label="Label this link"
                onChange={(event) => setText(event.target.value)}
                onKeyDown={(event) => {
                  event.stopPropagation();
                  if (event.key === 'Enter') commitEdgeLabel(data.linkId, text);
                  if (event.key === 'Escape') stopEditing();
                }}
                onBlur={() => commitEdgeLabel(data.linkId, text)}
                className="w-28 bg-transparent outline-none"
              />
            ) : (
              label
            )}
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

/** The endpoint a link names for a node: the Item for a card, the node itself otherwise. */
const refOf = (node: BoardNode) => (node.kind === 'card' ? `item:${node.itemId}` : `node:${node.id}`);

function build(board: Board, items: Map<string, Item>, sourceNames: Record<string, string> | undefined, selected: Set<string>): FlowNode[] {
  return ordered(board.nodes).map((node): FlowNode => {
    const common = {
      id: node.id,
      position: { x: node.x, y: node.y },
      selected: selected.has(node.id),
      ...(node.parentId ? { parentId: node.parentId } : {}),
    };
    if (node.kind === 'box') {
      const count = board.nodes.filter((one) => one.parentId === node.id && one.kind !== 'box').length;
      return { ...common, type: 'box', width: node.w, height: node.h, data: { name: node.name, count }, zIndex: -1 } satisfies BoxNode;
    }
    if (node.kind === 'sketch') {
      return { ...common, type: 'card', data: { title: node.title, status: 'to_do', source: null, missing: false, sketch: true, merged: node.local === 'merged' } };
    }
    const item = items.get(node.itemId);
    return {
      ...common,
      type: 'card',
      data: {
        title: item ? itemLabel(item) : 'Item',
        status: item ? itemStatus(item) : 'to_do',
        source: item && item.source !== 'internal' ? sourceOnARow(item, sourceNames) : null,
        missing: !item,
        sketch: false,
        merged: false,
      },
    };
  });
}

type Tool = 'select' | 'box' | 'arrow' | 'line';
type Drawing = { tool: Tool; x0: number; y0: number; x1: number; y1: number; fromNode?: string | undefined };

function BoardInner({ workspaceId, dashboardId, readOnly }: { workspaceId: string; dashboardId: string; readOnly: boolean }) {
  const { data } = useSnapshot(workspaceId);
  const openItem = useOpenItem();
  const flow = useReactFlow<FlowNode, KindEdge>();
  const { zoom } = useViewport();
  const [stored, setBoard] = usePoc<Board>(boardKey(dashboardId), EMPTY_BOARD);
  const [hidden] = usePoc<string[]>(hiddenKey(workspaceId), []);
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
  const [editingEdge, setEditingEdge] = useState<string | null>(null);
  const [editingLine, setEditingLine] = useState<string | null>(null);
  const [hoveredEdge, setHoveredEdge] = useState<string | null>(null);
  const [drawing, setDrawing] = useState<Drawing | null>(null);
  const [arrowFrom, setArrowFrom] = useState<string | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; nodeId: string | null } | null>(null);
  const [nodes, setNodes] = useState<FlowNode[]>([]);
  const [selectedEdges, setSelectedEdges] = useState<Set<string>>(new Set());
  const wrapper = useRef<HTMLDivElement>(null);
  const animating = useRef(false);

  // POC only: lets a driving script move the camera.
  if (import.meta.env.DEV) (window as unknown as { __pocFlow?: unknown }).__pocFlow = flow;
  const items = useMemo(() => new Map((data?.items ?? []).map((item) => [item.id, item])), [data]);
  const kind = kinds.find((one) => one.id === kindId) ?? kinds[0]!;

  useEffect(() => {
    if (animating.current) return;
    setNodes((was) => build(board, items, data?.sourceNames, new Set(was.filter((node) => node.selected).map((node) => node.id))));
  }, [board, items, data?.sourceNames]);

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
              data: { kind: linkKind, label: link.label, linkId: link.id, hovered: hoveredEdge === id, editing: editingEdge === link.id },
            };
          }),
      );
    });
  }, [board.nodes, links, kinds, hoveredEdge, editingEdge, selectedEdges]);

  // ---- Writing back ----
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
  const commitEdgeLabel = useCallback(
    (linkId: string, text: string) => {
      setEditingEdge(null);
      setLinks((was) => was.map((link) => (link.id === linkId ? { ...link, label: text.trim() || undefined } : link)));
    },
    [setLinks],
  );
  const ctx = useMemo<Ctx>(
    () => ({ readOnly, editingId, showLabels, commitName, commitEdgeLabel, stopEditing: () => (setEditingId(null), setEditingEdge(null)) }),
    [readOnly, editingId, showLabels, commitName, commitEdgeLabel],
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

  /** A drag ended: keep where things were left, and put each into the innermost box under its middle. */
  const onNodeDragStop = useCallback(
    (_: unknown, __: FlowNode, dragged: FlowNode[]) => {
      setBoard((was) => {
        let next: Board = {
          ...was,
          nodes: was.nodes.map((node) => {
            const moved = dragged.find((one) => one.id === node.id);
            return moved ? { ...node, x: moved.position.x, y: moved.position.y } : node;
          }),
        };
        for (const one of dragged) {
          const node = next.nodes.find((n) => n.id === one.id);
          if (!node) continue;
          const spot = absolute(next, node);
          const size = sizeOf(node);
          const middle = { x: spot.x + size.w / 2, y: spot.y + size.h / 2 };
          const inside = (boxId: string | undefined): boolean => {
            let at = boxId;
            while (at) {
              if (at === node.id) return true;
              at = next.nodes.find((n) => n.id === at)?.parentId;
            }
            return false;
          };
          const boxes = next.nodes.filter((n) => n.kind === 'box' && n.id !== node.id && !inside(n.id));
          const holding = boxes
            .filter((box) => {
              const at = absolute(next, box);
              const { w, h } = sizeOf(box);
              return middle.x > at.x && middle.x < at.x + w && middle.y > at.y && middle.y < at.y + h;
            })
            .sort((a, b) => sizeOf(a).w * sizeOf(a).h - sizeOf(b).w * sizeOf(b).h)[0];
          if (holding?.id === node.parentId) continue;
          const base = holding ? absolute(next, holding) : { x: 0, y: 0 };
          next = {
            ...next,
            nodes: next.nodes.map((n) => (n.id === node.id ? { ...n, parentId: holding?.id, x: spot.x - base.x, y: Math.max(holding ? BOX_HEAD : -Infinity, spot.y - base.y) } : n)),
          };
          if (holding) next = fitBox(next, holding.id);
        }
        return next;
      });
    },
    [setBoard],
  );

  // ---- Arrangements, tweened so the eye can follow ----
  const animateTo = useCallback(
    (next: Board) => {
      const from = new Map(nodes.map((node) => [node.id, node]));
      const target = build(next, items, data?.sourceNames, new Set(nodes.filter((n) => n.selected).map((n) => n.id)));
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
          // Keep what the arrangement did not see (cards of merged-away Items).
          setBoard((was) => ({ ...next, nodes: [...next.nodes, ...was.nodes.filter((node) => !next.nodes.some((one) => one.id === node.id))] }));
        }
      };
      requestAnimationFrame(step);
    },
    [nodes, items, data?.sourceNames, setBoard],
  );

  /** The chosen node in the middle; what it links to (same level) and what it holds, in a ring round it. */
  const arrangeStar = (id: string) => {
    const centreNode = board.nodes.find((node) => node.id === id);
    if (!centreNode) return;
    let next = board;
    if (centreNode.kind === 'box') {
      const children = board.nodes.filter((node) => node.parentId === id);
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
          if (node.id === id && node.kind === 'box') return { ...node, w: 2 * r + CARD_W + 2 * PAD, h: 2 * r + CARD_H + BOX_HEAD + PAD };
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
      if (centreNode.parentId) next = fitBox(next, centreNode.parentId);
    }
    animateTo(next);
  };

  /** Left to right along Leads to; a box's sub-boxes become lanes stacked under its own cards. */
  const arrangeTimeline = (containerId: string | null) => {
    const members = board.nodes.filter((node) => (node.parentId ?? null) === containerId);
    if (members.length === 0) return;
    const laneBoxes = members.filter((node) => node.kind === 'box');
    const leadsRefs = new Set(links.filter((link) => link.kindId === LEADS_TO).flatMap((link) => [link.from, link.to]));
    // Cards on no Leads to path wait in a strip under the timeline rather than piling up at its start.
    const loose = members.filter((node) => node.kind !== 'box' && !leadsRefs.has(refOf(node)));
    const mainCards = members.filter((node) => node.kind !== 'box' && leadsRefs.has(refOf(node)));
    const lanes = laneBoxes.map((box) => ({ box, cards: board.nodes.filter((node) => node.parentId === box.id && node.kind !== 'box') }));
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
    const placed = new Map<string, Partial<BoardNode>>();
    let y = origin.y;
    if (mainCards.length) {
      const { at, rows } = rowsOf(mainCards);
      for (const [id, spot] of at) placed.set(id, { x: origin.x + PAD + spot.col * COLW, y: y + PAD + spot.row * ROWH });
      y += rows * ROWH + PAD;
    }
    for (const lane of lanes) {
      const { at, rows } = rowsOf(lane.cards);
      const h = BOX_HEAD + rows * ROWH + PAD - 8;
      placed.set(lane.box.id, { x: origin.x, y, w: (maxCol + 1) * COLW - 70 + 2 * PAD, h } as Partial<BoardNode>);
      for (const [id, spot] of at) placed.set(id, { x: PAD + spot.col * COLW, y: BOX_HEAD + spot.row * ROWH });
      y += h + 20;
    }
    loose.forEach((card, n) => placed.set(card.id, { x: origin.x + PAD + n * COLW, y: y + PAD }));
    if (loose.length) y += ROWH + PAD;
    let next: Board = { ...board, nodes: board.nodes.map((node) => ({ ...node, ...(placed.get(node.id) ?? {}) }) as BoardNode) };
    if (containerId) {
      next = {
        ...next,
        nodes: next.nodes.map((node) =>
          node.id === containerId && node.kind === 'box' ? { ...node, w: (maxCol + 1) * COLW - 70 + 4 * PAD, h: y + PAD } : node,
        ),
      };
    }
    animateTo(next);
  };

  // ---- Pointer tools: Box, Line, Arrow ----
  const nodeUnder = (clientX: number, clientY: number): string | null => {
    for (const element of document.elementsFromPoint(clientX, clientY)) {
      const node = element.closest('.react-flow__node');
      if (node instanceof HTMLElement && node.dataset.id) return node.dataset.id;
    }
    return null;
  };
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
  const overlayDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const at = local(event.clientX, event.clientY);
    if (arrowFrom) {
      const target = nodeUnder(event.clientX, event.clientY);
      if (target) link(arrowFrom, target);
      setArrowFrom(null);
      setDrawing(null);
      setTool('select');
      return;
    }
    const fromNode = tool === 'arrow' ? nodeUnder(event.clientX, event.clientY) : null;
    if (tool === 'arrow' && !fromNode) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    setDrawing({ tool, x0: at.x, y0: at.y, x1: at.x, y1: at.y, fromNode: fromNode ?? undefined });
  };
  const overlayMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const at = local(event.clientX, event.clientY);
    if (arrowFrom) {
      const from = flow.getInternalNode(arrowFrom);
      if (!from) return;
      const c = centre(from);
      const s = flow.flowToScreenPosition(c);
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
    if (drawing.tool === 'arrow') {
      const target = nodeUnder(event.clientX, event.clientY);
      if (drawing.fromNode && target) link(drawing.fromNode, target);
      return;
    }
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

  // ---- Dropping a row from a Panel ----
  const onDragOver = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
  };
  const onDrop = (event: React.DragEvent) => {
    if (readOnly || !event.dataTransfer.types.includes(ITEM_BEING_DRAGGED)) return;
    event.preventDefault();
    const itemId = event.dataTransfer.getData(ITEM_BEING_DRAGGED);
    if (!itemId) return;
    const carried = selectionCarried();
    const ids = carried?.ids.includes(itemId) ? [...carried.ids] : [itemId];
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    let boxId: string | null = null;
    for (const element of document.elementsFromPoint(event.clientX, event.clientY)) {
      const found = element.closest('.react-flow__node-box');
      if (found instanceof HTMLElement && found.dataset.id) {
        boxId = found.dataset.id;
        break;
      }
    }
    setBoard((was) => {
      const box = boxId ? was.nodes.find((node) => node.id === boxId) : undefined;
      const base = box ? absolute(was, box) : { x: 0, y: 0 };
      const added: BoardNode[] = ids.map((id, n) => ({
        id: newId(),
        kind: 'card',
        itemId: id,
        parentId: box?.id,
        x: at.x - CARD_W / 2 - base.x,
        y: Math.max(box ? BOX_HEAD : -Infinity, at.y - CARD_H / 2 + n * (CARD_H + 12) - base.y),
      }));
      const next = { ...was, nodes: [...was.nodes, ...added] };
      return box ? fitBox(next, box.id) : next;
    });
  };

  // ---- Keys and double-clicks ----
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const typing = event.target instanceof HTMLElement && /INPUT|TEXTAREA/.test(event.target.tagName);
      if (typing || document.querySelector('[role="dialog"]')) return;
      setMenu(null);
      setArrowFrom(null);
      setDrawing(null);
      void flow.fitView({ duration: 450, padding: 0.15 });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flow]);

  const onDoubleClick = (event: React.MouseEvent) => {
    if (readOnly || tool !== 'select') return;
    if (!(event.target instanceof Element) || !event.target.classList.contains('react-flow__pane')) return;
    const at = flow.screenToFlowPosition({ x: event.clientX, y: event.clientY });
    const id = newId();
    setBoard((was) => ({ ...was, nodes: [...was.nodes, { id, kind: 'sketch', title: '', x: at.x - CARD_W / 2, y: at.y - CARD_H / 2 }] }));
    setEditingId(id);
  };

  const selected = nodes.filter((node) => node.selected);
  const selectedCards = selected.flatMap((node) => {
    const held = board.nodes.find((one) => one.id === node.id);
    return held?.kind === 'card' ? [held] : [];
  });
  const menuNode = menu?.nodeId ? board.nodes.find((node) => node.id === menu.nodeId) : undefined;
  const editingFree = board.lines.find((line) => line.id === editingLine);

  const toolButton = (value: Tool, label: string, keyHint: string) => (
    <button
      type="button"
      aria-pressed={tool === value}
      title={`${label} (${keyHint})`}
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

  return (
    <BoardContext.Provider value={ctx}>
      <BoardWriter.Provider value={[board, setBoard]}>
        <div
          ref={wrapper}
          data-poc-whiteboard
          onDragOver={onDragOver}
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
            onNodeDragStop={onNodeDragStop}
            onNodeClick={(event, node) => {
              setMenu(null);
              if (event.shiftKey || event.metaKey || event.ctrlKey) return;
              const held = board.nodes.find((one) => one.id === node.id);
              if (held?.kind === 'card') openItem(held.itemId);
            }}
            onNodeDoubleClick={(_, node) => {
              const held = board.nodes.find((one) => one.id === node.id);
              if (held?.kind === 'box') void flow.fitView({ nodes: [{ id: node.id }], duration: 500, padding: 0.12 });
              else if (held?.kind === 'sketch' && !readOnly) setEditingId(held.id);
            }}
            onNodeContextMenu={(event, node) => {
              if (readOnly) return;
              event.preventDefault();
              const at = local(event.clientX, event.clientY);
              setMenu({ ...at, nodeId: node.id });
            }}
            onPaneContextMenu={(event) => {
              if (readOnly) return;
              event.preventDefault();
              const at = local(event.clientX, event.clientY);
              setMenu({ ...at, nodeId: null });
            }}
            onPaneClick={() => setMenu(null)}
            onEdgeMouseEnter={(_, edge) => setHoveredEdge(edge.id)}
            onEdgeMouseLeave={() => setHoveredEdge(null)}
            onEdgeDoubleClick={(_, edge) => !readOnly && edge.data && setEditingEdge(edge.data.linkId)}
            fitView
            fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
            minZoom={0.1}
            maxZoom={2.5}
            zoomOnDoubleClick={false}
            elevateNodesOnSelect={false}
            snapToGrid={grid}
            snapGrid={[GRID, GRID]}
            nodesDraggable={!readOnly}
            nodesConnectable={false}
            elementsSelectable={!readOnly}
            selectionKeyCode={null}
            selectionOnDrag={!readOnly}
            panOnDrag={readOnly ? true : [1]}
            panOnScroll={!readOnly}
            zoomActivationKeyCode={['Meta', 'Control']}
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

          {/* Box, Line and Arrow take the pointer from the board while they are on. */}
          {!readOnly && (tool !== 'select' || arrowFrom) && (
            <div
              className="absolute inset-0 z-10 cursor-crosshair"
              data-poc-overlay={tool}
              onPointerDown={overlayDown}
              onPointerMove={overlayMove}
              onPointerUp={overlayUp}
            >
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

          {/* Tools, top left */}
          {!readOnly && (
            <div className={`absolute top-3 left-3 z-20 max-w-[calc(100%-330px)] flex-wrap ${chip}`} role="toolbar" aria-label="Whiteboard tools">
              {toolButton('select', 'Select', 'V')}
              {toolButton('box', 'Box', 'B')}
              {toolButton('arrow', 'Arrow', 'A')}
              {toolButton('line', 'Line', 'L')}
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

          {/* Camera, top right */}
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

          {/* What can be done with the selection */}
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

          {/* Right-click */}
          {menu && (
            <div
              role="menu"
              className="absolute z-30 min-w-44 rounded-md border border-shade/10 bg-surface p-1 shadow-lg"
              style={{ left: menu.x, top: menu.y }}
              onContextMenu={(event) => event.preventDefault()}
            >
              {(() => {
                const entries: [string, () => void][] = [];
                if (menuNode?.kind === 'card') {
                  entries.push(['Open', () => openItem(menuNode.itemId)]);
                  entries.push(['Split…', () => askToSplit(menuNode.itemId, dashboardId)]);
                }
                if (menuNode?.kind === 'box') {
                  entries.push(['Rename', () => setEditingId(menuNode.id)]);
                  entries.push(['Arrange as star', () => arrangeStar(menuNode.id)]);
                  entries.push(['Arrange as timeline', () => arrangeTimeline(menuNode.id)]);
                }
                if (menuNode?.kind === 'sketch') entries.push(['Rename', () => setEditingId(menuNode.id)]);
                if (menuNode) {
                  entries.push([
                    'Draw arrow from here',
                    () => {
                      setArrowFrom(menuNode.id);
                      setTool('arrow');
                    },
                  ]);
                  entries.push(['Take off the whiteboard', () => takeOff([menuNode.id])]);
                } else {
                  entries.push(['Arrange board as timeline', () => arrangeTimeline(null)]);
                  entries.push(['Fit everything', () => void flow.fitView({ duration: 400, padding: 0.15 })]);
                }
                return entries.map(([label, run]) => (
                  <button
                    key={label}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenu(null);
                      run();
                    }}
                    className="block w-full rounded px-3 py-1.5 text-left text-sm text-ink hover:bg-accent-tint hover:text-accent-deep"
                  >
                    {label}
                  </button>
                ));
              })()}
            </div>
          )}

          {board.nodes.length === 0 && !readOnly && (
            <p className="pointer-events-none absolute inset-x-0 top-1/2 text-center text-sm text-ink-faint">
              Drag a row from a Panel here, or double-click to sketch.
            </p>
          )}
        </div>
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

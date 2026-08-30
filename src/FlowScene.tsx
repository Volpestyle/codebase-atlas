import { useMemo, useRef, useState } from "react";
import { crossingLabel, type LayerVisibility, type RepositoryGraph, type RepositoryNode } from "./model";
import {
  buildFlowLayout,
  chipContents,
  chipForSelection,
  flowStatus,
  isSupportCell,
  type FlowChip,
} from "./flowLayout";
import type { ImportFlow } from "./repositoryLayout";
import RepositoryScene from "./RepositoryScene";
import RoutePanel from "./RoutePanel";

interface FlowSceneProps {
  graph: RepositoryGraph;
  selectedId: string | null;
  searchQuery: string;
  maxDepth: number;
  onSelect: (id: string) => void;
}

const CHIP_W_MIN = 208;
const CHIP_W_MAX = 328;
const CHIP_HEADER = 44;
const CHIP_H_MIN = CHIP_HEADER;
const CHIP_BODY_MIN = 52;
const CHIP_BODY_MAX = 220;
const COL_GAP = 112;
const ROW_GAP = 20;
const MARGIN_X = 56;
// The panel header and the floating toolbar overlay the top of the mount, so
// the diagram starts below them.
const LABEL_Y = 116;
const HEADER_Y = 140;
const MARGIN_BOTTOM = 72;
// ponytail: every edge carries a CSS dash animation; past this the repaint cost shows.
const MAX_ANIMATED_EDGES = 250;

const edgeKey = (edge: ImportFlow) => `${edge.source}→${edge.target}`;

function chipLabel(name: string, width: number) {
  const max = Math.max(12, Math.floor((width - 32) / 7.2));
  return name.length > max ? `${name.slice(0, max - 2)}..` : name;
}

function cellLabel(name: string, width: number) {
  const max = Math.max(3, Math.floor((width - 6) / 5.4));
  const text = name.length > max ? `${name.slice(0, max - 1)}…` : name;
  return text.toUpperCase();
}

function columnLabel(column: number, columnCount: number) {
  if (columnCount === 1) return "MODULES";
  if (column === 0) return "ENTRY";
  if (column === columnCount - 1) return "FOUNDATION";
  return `STAGE ${column + 1}`;
}

function matchesQuery(node: RepositoryNode, query: string) {
  return (
    !query ||
    node.name.toLowerCase().includes(query) ||
    node.path.toLowerCase().includes(query) ||
    node.language?.toLowerCase().includes(query) ||
    node.description?.toLowerCase().includes(query)
  );
}

// Every module and edge reachable from `id` along imports (downstream
// dependencies) and against them (upstream dependents).
function trace(id: string, edges: ImportFlow[]) {
  const chips = new Set([id]);
  const hot = new Set<string>();
  for (const follow of ["source", "target"] as const) {
    const from = follow === "source" ? "target" : "source";
    const queue = [id];
    const seen = new Set([id]);
    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const edge of edges) {
        if (edge[from] !== current) continue;
        hot.add(edgeKey(edge));
        chips.add(edge[follow]);
        if (!seen.has(edge[follow])) {
          seen.add(edge[follow]);
          queue.push(edge[follow]);
        }
      }
    }
  }
  return { chips, hot };
}

// The inset ignores the main map's layer toggles but matches its default:
// everything on except tests.
const MINI_LAYERS: LayerVisibility = {
  structure: true,
  source: true,
  config: true,
  docs: true,
  tests: false,
  imports: true,
};

interface MiniMapProps {
  graph: RepositoryGraph;
  node: RepositoryNode;
  searchQuery: string;
  depth: number;
  onSelect: (id: string) => void;
}

// The real 3D map embedded as an inset: same scene, import arcs, and district
// reveal as the map view, aggregated at the flow's effective depth. Resizable
// by dragging its top-right corner.
function MiniMap({ graph, node, searchQuery, depth, onSelect }: MiniMapProps) {
  const [size, setSize] = useState({ width: 380, height: 320 });
  const drag = useRef<{ x: number; y: number; width: number; height: number } | null>(null);

  return (
    <figure className="flow-minimap" style={size} aria-label={`Map location of ${node.path}`}>
      <figcaption>{`MAP / ${node.path === "." ? node.name : node.path}`}</figcaption>
      <button
        type="button"
        className="mini-resize"
        aria-label="Drag to resize the map inset"
        onPointerDown={(event) => {
          drag.current = { x: event.clientX, y: event.clientY, ...size };
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          const start = drag.current;
          if (!start) return;
          setSize({
            width: Math.min(
              Math.max(240, start.width - (event.clientX - start.x)),
              window.innerWidth - 120,
            ),
            height: Math.min(
              Math.max(200, start.height - (event.clientY - start.y)),
              window.innerHeight - 220,
            ),
          });
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
      >
        ⤡
      </button>
      <div className="mini-scene">
        <RepositoryScene
          graph={graph}
          selectedId={node.id}
          openedId={node.id}
          searchQuery={searchQuery}
          layers={MINI_LAYERS}
          maxDepth={depth}
          zoomToSelection
          animateCamera={false}
          onSelect={(id) => {
            if (id) onSelect(id);
          }}
        />
      </div>
    </figure>
  );
}

function FlowScene({ graph, selectedId, searchQuery, maxDepth, onSelect }: FlowSceneProps) {
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  // A route is worth asking about on its own: its weight says how much crosses,
  // but only the bindings say what.
  const [openEdge, setOpenEdge] = useState<string | null>(null);
  // Touch-primary devices (iPad) have no hover; tracing rides selection there.
  const hoverCapable = useMemo(() => window.matchMedia("(hover: hover)").matches, []);
  const layout = useMemo(() => buildFlowLayout(graph, maxDepth), [graph, maxDepth]);
  const chipById = useMemo(
    () => new Map(layout.chips.map((chip) => [chip.node.id, chip])),
    [layout],
  );

  // The minimap follows the app selection even when it is finer than a chip.
  const selectedNode = useMemo(
    () => (selectedId ? (graph.nodes.find((node) => node.id === selectedId) ?? null) : null),
    [graph, selectedId],
  );
  const validId = (id: string | null) => (id !== null && chipById.has(id) ? id : null);
  const traceId = validId(hoveredId) ?? chipForSelection(selectedId, chipById);
  const active = useMemo(
    () => (traceId ? trace(traceId, layout.edges) : null),
    [traceId, layout],
  );
  const childCount = useMemo(() => {
    const counts = new Map<string, number>();
    for (const edge of graph.edges) {
      if (edge.kind !== "contains") continue;
      counts.set(edge.source, (counts.get(edge.source) ?? 0) + 1);
    }
    return counts;
  }, [graph]);

  const status = flowStatus(graph.stats.importsAvailable, layout.edges.length);
  if (status === "unavailable") {
    return (
      <div className="flow-empty">
        <span className="section-index">Flow / unavailable</span>
        <p>
          GitHub sources carry no file contents, so imports cannot be read. Scan a local
          directory, or open a map exported from a desktop scan, to trace flow.
        </p>
      </div>
    );
  }
  if (status === "quiet") {
    return (
      <div className="flow-empty">
        <span className="section-index">Flow / quiet</span>
        <p>
          No imports resolved between modules at this depth. Raise the depth slider for a
          finer view, or the repository may use languages the scanner does not read yet.
        </p>
      </div>
    );
  }

  const maxWeight = Math.max(1, ...layout.edges.map((edge) => edge.weight));
  // Module sizes are power-law distributed; sqrt keeps small modules visible
  // without flattening the giants the way a log scale would.
  const sizeOf = (node: RepositoryNode) =>
    graph.stats.lineCountAvailable ? node.lines : node.sizeBytes;
  const maxSize = Math.max(1, ...layout.chips.map((chip) => sizeOf(chip.node)));
  const scaleOfSize = (node: RepositoryNode) => Math.sqrt(sizeOf(node) / maxSize);
  const chipW = (node: RepositoryNode) => {
    if ((childCount.get(node.id) ?? 0) === 0) return CHIP_W_MIN;
    return CHIP_W_MIN + (CHIP_W_MAX - CHIP_W_MIN) * scaleOfSize(node);
  };
  const chipH = (node: RepositoryNode) => {
    if ((childCount.get(node.id) ?? 0) === 0) return CHIP_H_MIN;
    return (
      CHIP_HEADER +
      CHIP_BODY_MIN +
      (CHIP_BODY_MAX - CHIP_BODY_MIN) * scaleOfSize(node)
    );
  };
  const columnWidth = Array.from({ length: layout.columnCount }, () => CHIP_W_MIN);
  for (const chip of layout.chips) {
    columnWidth[chip.column] = Math.max(columnWidth[chip.column], chipW(chip.node));
  }
  const columnX: number[] = [];
  {
    let x = MARGIN_X;
    for (let column = 0; column < layout.columnCount; column += 1) {
      columnX.push(x);
      x += columnWidth[column] + COL_GAP;
    }
  }
  const chipX = (column: number) => columnX[column] ?? MARGIN_X;
  const width =
    layout.columnCount === 0
      ? MARGIN_X * 2
      : chipX(layout.columnCount - 1) + columnWidth[layout.columnCount - 1] + MARGIN_X;
  // Heights vary, so chips stack per column instead of sitting on a row grid.
  const chipTop = new Map<string, number>();
  let bottom = HEADER_Y;
  {
    const nextY = Array<number>(layout.columnCount).fill(HEADER_Y);
    for (const chip of layout.chips) {
      chipTop.set(chip.node.id, nextY[chip.column]);
      nextY[chip.column] += chipH(chip.node) + ROW_GAP;
      bottom = Math.max(bottom, nextY[chip.column] - ROW_GAP);
    }
  }
  const height = bottom + MARGIN_BOTTOM;
  const query = searchQuery.trim().toLowerCase();
  const animated = layout.edges.length <= MAX_ANIMATED_EDGES;

  interface EdgeShape {
    edge: ImportFlow;
    path: string;
    arrow: string;
    cycle: boolean;
  }
  const edgeShapes: EdgeShape[] = [];
  for (const edge of layout.edges) {
    const source = chipById.get(edge.source)!;
    const target = chipById.get(edge.target)!;
    const sy = chipTop.get(edge.source)! + chipH(source.node) / 2;
    const ty = chipTop.get(edge.target)! + chipH(target.node) / 2;
    const cycle = target.column <= source.column;
    let path: string;
    let control: { x: number; y: number };
    let end: { x: number; y: number };
    if (!cycle) {
      // Forward: right side of the importer to the left side of the imported.
      const x1 = chipX(source.column) + chipW(source.node);
      const x2 = chipX(target.column);
      const bend = Math.max(44, (x2 - x1) * 0.45);
      control = { x: x2 - bend, y: ty };
      end = { x: x2, y: ty };
      path = `M ${x1} ${sy} C ${x1 + bend} ${sy}, ${control.x} ${control.y}, ${end.x} ${end.y}`;
    } else if (target.column < source.column) {
      // Backward cycle edge: leftward sweep from the importer's left side into
      // the imported module's right side.
      const x1 = chipX(source.column);
      const x2 = chipX(target.column) + chipW(target.node);
      control = { x: x2 + 44, y: ty };
      end = { x: x2, y: ty };
      path = `M ${x1} ${sy} C ${x1 - 44} ${sy}, ${control.x} ${control.y}, ${end.x} ${end.y}`;
    } else {
      // Same-column edge (intra-cycle siblings): bow around the left of both.
      const x = chipX(source.column);
      control = { x: x - 64, y: ty };
      end = { x, y: ty };
      path = `M ${x} ${sy} C ${x - 64} ${sy}, ${control.x} ${control.y}, ${end.x} ${end.y}`;
    }
    const angle = Math.atan2(end.y - control.y, end.x - control.x);
    const barb = (spread: number) =>
      `${end.x - Math.cos(angle + spread) * 9} ${end.y - Math.sin(angle + spread) * 9}`;
    const arrow = `M ${end.x} ${end.y} L ${barb(0.42)} L ${barb(-0.42)} Z`;
    edgeShapes.push({ edge, path, arrow, cycle });
  }

  const openFlow = openEdge
    ? (layout.edges.find((edge) => edgeKey(edge) === openEdge) ?? null)
    : null;

  return (
    <div className="flow-mount">
      <div className="flow-scroll">
        <svg
          className="flow-diagram"
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`Import flow diagram of ${graph.name}: entry modules on the left import toward foundation modules on the right.`}
        >
          {Array.from({ length: layout.columnCount }, (_, column) => (
            <text key={column} className="flow-column-label" x={chipX(column)} y={LABEL_Y}>
              {`${String(column + 1).padStart(2, "0")} / ${columnLabel(column, layout.columnCount)}`}
            </text>
          ))}

          {edgeShapes.map(({ edge, path, arrow, cycle }) => {
            const key = edgeKey(edge);
            const hot = active?.hot.has(key) ?? false;
            const state = active ? (hot ? " is-hot" : " is-cold") : "";
            const crossing = crossingLabel(edge.symbols);
            return (
              <g
                key={key}
                className={`flow-edge${cycle ? " is-cycle" : ""}${state}${
                  openEdge === key ? " is-open" : ""
                }`}
              >
                <path
                  className="flow-edge-hit"
                  d={path}
                  role="button"
                  tabIndex={0}
                  aria-label={`Route: ${edge.source} imports ${edge.target}`}
                  onClick={() => setOpenEdge((current) => (current === key ? null : key))}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setOpenEdge((current) => (current === key ? null : key));
                    }
                  }}
                >
                  <title>
                    {`${edge.source} imports ${edge.target} × ${edge.weight}`}
                    {crossing ? `\n${crossing}` : ""}
                  </title>
                </path>
                <path
                  className="flow-edge-line"
                  d={path}
                  strokeWidth={1 + 2.4 * (edge.weight / maxWeight)}
                />
                {animated && !cycle ? <path className="flow-edge-pulse" d={path} /> : null}
                <path className="flow-edge-arrow" d={arrow} />
              </g>
            );
          })}

          {layout.chips.map((chip: FlowChip) => {
            const { node } = chip;
            const w = chipW(node);
            const h = chipH(node);
            const bodyH = h - CHIP_HEADER - 6;
            const bodyW = w - 14;
            const cells =
              bodyH >= 24
                ? chipContents(graph, node.id, bodyW, bodyH)
                : [];
            const faded = query !== "" && !matchesQuery(node, query);
            const dimmed = active !== null && !active.chips.has(node.id);
            const classes = [
              "flow-chip",
              node.id === selectedId ? "is-selected" : "",
              faded ? "is-faded" : dimmed ? "is-dimmed" : "",
            ]
              .filter(Boolean)
              .join(" ");
            return (
              <g
                key={node.id}
                className={classes}
                transform={`translate(${chipX(chip.column)}, ${chipTop.get(node.id)!})`}
                tabIndex={0}
                role="button"
                aria-label={`${node.path}: imports ${chip.fanOut}, imported by ${chip.fanIn}`}
                onClick={(event) => {
                  const target = event.target as SVGElement;
                  onSelect(target.dataset.childId ?? node.id);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    onSelect(node.id);
                  }
                }}
                onPointerEnter={hoverCapable ? () => setHoveredId(node.id) : undefined}
                onPointerLeave={hoverCapable ? () => setHoveredId(null) : undefined}
              >
                <title>{node.description ?? node.path}</title>
                <rect className="chip-plate" width={w} height={h} rx={3} />
                <rect className={`chip-mark chip-${node.kind}`} x={10} y={11} width={7} height={7} />
                <text className="chip-name" x={24} y={19}>
                  {chipLabel(node.name, w)}
                </text>
                <text className="chip-meta" x={24} y={35}>
                  {`IN ${chip.fanIn} · OUT ${chip.fanOut}${
                    graph.stats.lineCountAvailable
                      ? ` · ${node.lines.toLocaleString()} LN`
                      : ""
                  }`}
                </text>
                {cells.map((cell) => {
                  const x = 7 + cell.x;
                  const y = CHIP_HEADER + cell.y;
                  const labeled = cell.width >= 40 && cell.height >= 14;
                  return (
                    <g key={cell.node.id} className={isSupportCell(cell.node) ? "chip-support" : undefined}>
                      <rect
                        className={`chip-cell chip-${cell.node.kind}`}
                        data-child-id={cell.node.id}
                        x={x + 0.6}
                        y={y + 0.6}
                        width={Math.max(1, cell.width - 1.2)}
                        height={Math.max(1, cell.height - 1.2)}
                      >
                        <title>{cell.node.path}</title>
                      </rect>
                      {labeled ? (
                        <text
                          className="chip-cell-label"
                          x={x + 4}
                          y={y + Math.min(12, cell.height - 3)}
                        >
                          {cellLabel(cell.node.name, cell.width)}
                        </text>
                      ) : null}
                    </g>
                  );
                })}
              </g>
            );
          })}
        </svg>
      </div>

      {openFlow ? (
        <RoutePanel
          source={{ id: openFlow.source, label: openFlow.source }}
          target={{ id: openFlow.target, label: openFlow.target }}
          weight={openFlow.weight}
          symbols={openFlow.symbols}
          onSelect={onSelect}
          onClose={() => setOpenEdge(null)}
        />
      ) : null}

      {selectedNode ? (
        <MiniMap
          graph={graph}
          node={selectedNode}
          searchQuery={searchQuery}
          depth={layout.effectiveDepth}
          onSelect={onSelect}
        />
      ) : null}

      <div className="axis-key" aria-hidden="true">
        <span>Left imports right / pulses follow imports</span>
        <span>Line weight / import count</span>
        <span>{`Chip size / nested modules (${graph.stats.lineCountAvailable ? "lines" : "bytes"})`}</span>
        {Number.isFinite(maxDepth) && layout.effectiveDepth > maxDepth ? (
          <span>Auto detail / depth {layout.effectiveDepth}</span>
        ) : null}
      </div>
      {layout.chips.length < layout.totalModules ? (
        <p className="render-cap" title="Lower the depth slider to aggregate the remaining modules.">
          FLOW {layout.chips.length}/{layout.totalModules}
        </p>
      ) : null}
    </div>
  );
}

export default FlowScene;

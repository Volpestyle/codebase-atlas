import { SUPPORT_DIR_NAMES, type RepositoryGraph, type RepositoryNode } from "./model.ts";
// The .ts extension keeps this importable by the node:test runner, which
// strips types but does not resolve extensionless value imports.
import { isWrapperNode, parentPath } from "./placeNames.ts";
import { aggregateImports, packTreemap, type ImportFlow } from "./repositoryLayout.ts";

export const MAX_CHIP_CELLS = 16;

// A map selection finer than a chip (a file, a src wrapper) still traces
// through the nearest chip that is on the diagram.
export function chipForSelection(
  id: string | null,
  chips: { has(id: string): boolean },
): string | null {
  let current: string | null = id;
  while (current) {
    if (chips.has(current)) return current;
    current = parentPath(current);
  }
  return null;
}

export type FlowStatus = "ready" | "unavailable" | "quiet";

export function flowStatus(importsAvailable: boolean, edgeCount: number): FlowStatus {
  if (!importsAvailable) return "unavailable";
  if (edgeCount === 0) return "quiet";
  return "ready";
}

// Chips carry readable labels; past this count a diagram stops being one.
export const MAX_FLOW_NODES = 220;
// Below this many chips the diagram reads as an empty shrug, so the flow view
// deepens past the requested depth until it has something to say.
export const MIN_FLOW_CHIPS = 12;

export interface FlowChip {
  node: RepositoryNode;
  column: number;
  row: number;
  /** Weighted count of imports into this module (its dependents). */
  fanIn: number;
  /** Weighted count of imports out of this module (its dependencies). */
  fanOut: number;
}

export interface FlowLayout {
  chips: FlowChip[];
  /** Aggregated import edges: source imports target. */
  edges: ImportFlow[];
  columnCount: number;
  rowCount: number;
  /** Modules participating in flow before the chip cap. */
  totalModules: number;
  /** Aggregation depth actually rendered; deeper than requested when the
   * requested level yielded fewer than MIN_FLOW_CHIPS modules. */
  effectiveDepth: number;
}

// Tarjan's strongly connected components; import cycles collapse into one
// component so the diagram can still be layered left to right.
function connectedComponents(ids: string[], out: Map<string, string[]>): Map<string, number> {
  let index = 0;
  let componentCount = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const componentOf = new Map<string, number>();

  function connect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index += 1;
    stack.push(v);
    onStack.add(v);
    for (const w of out.get(v) ?? []) {
      if (!indices.has(w)) {
        connect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }
    if (lowlinks.get(v) === indices.get(v)) {
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        componentOf.set(w, componentCount);
      } while (w !== v);
      componentCount += 1;
    }
  }

  for (const id of ids) if (!indices.has(id)) connect(id);
  return componentOf;
}

// Longest path from the entry side of the condensation DAG: a module sits one
// column right of the furthest module that imports it.
function columnByLongestPath(
  ids: string[],
  componentOf: Map<string, number>,
  edges: ImportFlow[],
): Map<string, number> {
  const successors = new Map<number, Set<number>>();
  const indegree = new Map<number, number>();
  for (const id of ids) indegree.set(componentOf.get(id)!, 0);
  for (const edge of edges) {
    const from = componentOf.get(edge.source)!;
    const to = componentOf.get(edge.target)!;
    if (from === to) continue;
    const set = successors.get(from) ?? new Set();
    if (!set.has(to)) {
      set.add(to);
      successors.set(from, set);
      indegree.set(to, (indegree.get(to) ?? 0) + 1);
    }
  }

  const layer = new Map<number, number>();
  const queue = [...indegree].filter(([, degree]) => degree === 0).map(([component]) => component);
  for (const component of queue) layer.set(component, 0);
  while (queue.length > 0) {
    const component = queue.shift()!;
    for (const next of successors.get(component) ?? []) {
      layer.set(next, Math.max(layer.get(next) ?? 0, layer.get(component)! + 1));
      indegree.set(next, indegree.get(next)! - 1);
      if (indegree.get(next) === 0) queue.push(next);
    }
  }

  const columns = new Map<string, number>();
  for (const id of ids) columns.set(id, layer.get(componentOf.get(id)!) ?? 0);
  return columns;
}

export function buildFlowLayout(
  graph: RepositoryGraph,
  maxDepth: number = Number.POSITIVE_INFINITY,
): FlowLayout {
  const deepest = Math.max(1, ...graph.nodes.map((node) => node.depth));
  let depth = Math.min(maxDepth, deepest);
  let layout = layoutAtDepth(graph, depth);
  while (layout.chips.length < MIN_FLOW_CHIPS && depth < deepest) {
    depth += 1;
    layout = layoutAtDepth(graph, depth);
  }
  return { ...layout, effectiveDepth: depth };
}

export interface ChipCell {
  node: RepositoryNode;
  x: number;
  y: number;
  width: number;
  height: number;
}

function contentWeight(node: RepositoryNode, lineCountAvailable: boolean) {
  const value = lineCountAvailable ? node.lines : node.sizeBytes;
  return Math.max(1, value);
}

// Support directories every module repeats (tests, fixtures) stay area-honest
// in a chip but render muted so the functional parts carry it.
export function isSupportCell(node: RepositoryNode): boolean {
  return node.kind === "directory" && SUPPORT_DIR_NAMES.has(node.name.toLowerCase());
}

// A chip's contents packed into its extra area, heaviest first. Wrapper
// directories (src, lib) are replaced by their own children so cells name the
// module's actual parts instead of the same src/test pair on every chip.
export function chipContents(
  graph: RepositoryGraph,
  parentId: string,
  width: number,
  height: number,
  cap: number = MAX_CHIP_CELLS,
): ChipCell[] {
  if (width < 8 || height < 8) return [];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<string, RepositoryNode[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    const child = nodeById.get(edge.target);
    if (!child) continue;
    childrenOf.set(edge.source, [...(childrenOf.get(edge.source) ?? []), child]);
  }
  let children = childrenOf.get(parentId) ?? [];
  for (let pass = 0; pass < 3; pass += 1) {
    let changed = false;
    children = children.flatMap((child) => {
      const lifted = isWrapperNode(child) ? (childrenOf.get(child.id) ?? []) : [];
      if (lifted.length === 0) return [child];
      changed = true;
      return lifted;
    });
    if (!changed) break;
  }
  if (children.length === 0) return [];
  const ranked = [...children].sort(
    (left, right) =>
      contentWeight(right, graph.stats.lineCountAvailable) -
        contentWeight(left, graph.stats.lineCountAvailable) ||
      left.path.localeCompare(right.path),
  );
  const kept = ranked.slice(0, cap);
  const weights = kept.map((node) => contentWeight(node, graph.stats.lineCountAvailable));
  const total = weights.reduce((sum, value) => sum + value, 0);
  const boxArea = width * height;
  const items = kept.map((node, index) => ({
    id: node.id,
    area: (weights[index] / total) * boxArea,
  }));
  const cells = packTreemap(items, width, height);
  return kept
    .map((node) => {
      const cell = cells.get(node.id);
      if (!cell) return null;
      return { node, ...cell };
    })
    .filter((cell): cell is ChipCell => cell !== null);
}

function layoutAtDepth(
  graph: RepositoryGraph,
  maxDepth: number,
): Omit<FlowLayout, "effectiveDepth"> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.target, edge.source);
  }

  // Import endpoints lift to the depth the slider selects; the repository root
  // itself is never a chip.
  const visible = new Set(
    graph.nodes.filter((node) => node.id !== "." && node.depth <= maxDepth).map((node) => node.id),
  );
  const flows = aggregateImports(graph, visible, parentOf);

  const weightOf = new Map<string, number>();
  for (const flow of flows) {
    weightOf.set(flow.source, (weightOf.get(flow.source) ?? 0) + flow.weight);
    weightOf.set(flow.target, (weightOf.get(flow.target) ?? 0) + flow.weight);
  }
  const totalModules = weightOf.size;
  const kept = new Set(
    [...weightOf.keys()]
      .sort((a, b) => weightOf.get(b)! - weightOf.get(a)! || a.localeCompare(b))
      .slice(0, MAX_FLOW_NODES),
  );
  const edges = flows.filter((flow) => kept.has(flow.source) && kept.has(flow.target));

  const ids = [...kept].sort();
  const out = new Map<string, string[]>();
  const neighbors = new Map<string, string[]>();
  const fanIn = new Map<string, number>();
  const fanOut = new Map<string, number>();
  for (const edge of edges) {
    out.set(edge.source, [...(out.get(edge.source) ?? []), edge.target]);
    neighbors.set(edge.source, [...(neighbors.get(edge.source) ?? []), edge.target]);
    neighbors.set(edge.target, [...(neighbors.get(edge.target) ?? []), edge.source]);
    fanOut.set(edge.source, (fanOut.get(edge.source) ?? 0) + edge.weight);
    fanIn.set(edge.target, (fanIn.get(edge.target) ?? 0) + edge.weight);
  }

  const componentOf = connectedComponents(ids, out);
  const columnOf = columnByLongestPath(ids, componentOf, edges);

  const columnCount = ids.length ? Math.max(...columnOf.values()) + 1 : 0;
  const columns: string[][] = Array.from({ length: columnCount }, () => []);
  for (const id of ids) columns[columnOf.get(id)!].push(id);
  for (const column of columns) {
    column.sort((a, b) => weightOf.get(b)! - weightOf.get(a)! || a.localeCompare(b));
  }

  // Two barycenter sweeps pull each chip toward its neighbors' rows so edges
  // stay short; a full crossing minimizer is not worth its weight here.
  const rowOf = new Map<string, number>();
  const reindex = () => {
    for (const column of columns) column.forEach((id, row) => rowOf.set(id, row));
  };
  reindex();
  for (const forward of [true, false]) {
    const order = forward ? columns : [...columns].reverse();
    for (const column of order) {
      const columnIndex = column.length ? columnOf.get(column[0])! : 0;
      const score = (id: string) => {
        const adjacent = (neighbors.get(id) ?? []).filter((other) =>
          forward ? columnOf.get(other)! < columnIndex : columnOf.get(other)! > columnIndex,
        );
        if (adjacent.length === 0) return rowOf.get(id)!;
        return adjacent.reduce((sum, other) => sum + rowOf.get(other)!, 0) / adjacent.length;
      };
      column.sort((a, b) => score(a) - score(b) || a.localeCompare(b));
      reindex();
    }
  }

  const chips: FlowChip[] = ids
    .map((id) => ({
      node: nodeById.get(id)!,
      column: columnOf.get(id)!,
      row: rowOf.get(id)!,
      fanIn: fanIn.get(id) ?? 0,
      fanOut: fanOut.get(id) ?? 0,
    }))
    .sort((a, b) => a.column - b.column || a.row - b.row);

  return {
    chips,
    edges,
    columnCount,
    rowCount: Math.max(0, ...columns.map((column) => column.length)),
    totalModules,
  };
}

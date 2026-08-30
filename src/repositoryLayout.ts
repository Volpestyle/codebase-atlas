import type { RepositoryGraph, RepositoryNode } from "./model";

// Three.js stays responsive on large monorepos; the complete graph remains in the UI lists and stats.
export const MAX_RENDERED_NODES = 700;
// Children opened by selecting a district; the rest of the map stays at the depth slider.
const MAX_PEEK_CHILDREN = 80;

export interface LayoutModule {
  node: RepositoryNode;
  x: number;
  y: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface ImportFlow {
  source: string;
  target: string;
  weight: number;
}

export function flowKey(flow: Pick<ImportFlow, "source" | "target">) {
  return `${flow.source}\0${flow.target}`;
}

// Survey-scale transit: only the heaviest routes stay on the map at rest.
export const MAX_ARTERY_ROUTES = 12;

export function arteryKeys(
  flows: ImportFlow[],
  limit: number = MAX_ARTERY_ROUTES,
): Set<string> {
  const ranked = [...flows].sort(
    (left, right) =>
      right.weight - left.weight ||
      left.source.localeCompare(right.source) ||
      left.target.localeCompare(right.target),
  );
  return new Set(ranked.slice(0, limit).map(flowKey));
}

export interface RepositoryLayout {
  modules: LayoutModule[];
  imports: ImportFlow[];
  extent: number;
}

const kindOrder: Record<RepositoryNode["kind"], number> = {
  repository: 0,
  directory: 1,
  config: 2,
  documentation: 3,
  source: 4,
  asset: 5,
};

const PLAT_HEIGHT = 0.2;
const PADDING_RATIO = 0.03;
// A district at the survey limit still opens when its cell is big enough
// to hold a nested treemap — the interior is the label.
const LOD_MIN_SIDE = 5;
const MIN_LOD_CHILDREN = 3;
const LEAF_FILL = 0.92;

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

// Weighted code volume, not raw magnitude: source and documentation count in
// full, config/data lines are discounted (serialized JSON is not code), and
// binary assets contribute only a small presence weight so a folder of images
// cannot dominate the map.
function fileWeight(node: RepositoryNode, lineCountAvailable: boolean): number {
  if (node.kind === "asset") return Math.max(0.5, Math.min(64, node.sizeBytes / 2048));
  const dataDiscount = node.kind === "config" ? 0.25 : 1;
  const value = lineCountAvailable ? node.lines : node.sizeBytes / 64;
  return Math.max(1, value) * dataDiscount;
}

// Every file's weight, accumulated onto itself and each ancestor directory.
function buildWeights(graph: RepositoryGraph, parentOf: Map<string, string>): Map<string, number> {
  const weights = new Map<string, number>();
  for (const node of graph.nodes) {
    if (node.kind === "repository" || node.kind === "directory") continue;
    const weight = fileWeight(node, graph.stats.lineCountAvailable);
    let current: string | undefined = node.id;
    while (current !== undefined) {
      weights.set(current, (weights.get(current) ?? 0) + weight);
      current = parentOf.get(current);
    }
  }
  return weights;
}

function buildingHeight(size: number): number {
  return Math.min(3, 0.28 + Math.log10(size + 1) * 0.58);
}

// Squarified treemap: partitions a rectangle among weighted items, keeping
// cells near-square so districts stay readable.
function squarify(items: { id: string; area: number }[], rect: Rect): Map<string, Rect> {
  const cells = new Map<string, Rect>();
  const remaining = [...items].sort((left, right) => right.area - left.area);
  const free: Rect = { ...rect };

  while (remaining.length > 0) {
    const freeWidth = free.x1 - free.x0;
    const freeDepth = free.z1 - free.z0;
    const shortSide = Math.max(1e-6, Math.min(freeWidth, freeDepth));

    const row: { id: string; area: number }[] = [];
    let rowArea = 0;
    let bestWorst = Number.POSITIVE_INFINITY;
    while (remaining.length > 0) {
      const candidate = remaining[0];
      const nextArea = rowArea + candidate.area;
      const thickness = nextArea / shortSide;
      let worst = 0;
      for (const item of [...row, candidate]) {
        const length = item.area / Math.max(1e-9, thickness);
        worst = Math.max(worst, thickness / Math.max(1e-9, length), length / thickness);
      }
      if (row.length > 0 && worst > bestWorst) break;
      row.push(remaining.shift()!);
      rowArea = nextArea;
      bestWorst = worst;
    }

    const thickness = rowArea / shortSide;
    if (freeWidth >= freeDepth) {
      // Vertical strip against the left edge, items stacked along z.
      let z = free.z0;
      for (const item of row) {
        const length = item.area / Math.max(1e-9, thickness);
        cells.set(item.id, { x0: free.x0, z0: z, x1: free.x0 + thickness, z1: z + length });
        z += length;
      }
      free.x0 += thickness;
    } else {
      // Horizontal strip against the near edge, items laid along x.
      let x = free.x0;
      for (const item of row) {
        const length = item.area / Math.max(1e-9, thickness);
        cells.set(item.id, { x0: x, z0: free.z0, x1: x + length, z1: free.z0 + thickness });
        x += length;
      }
      free.z0 += thickness;
    }
  }
  return cells;
}

export interface TreemapCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

// 2D squarified treemap used by flow chips to draw a module's children.
export function packTreemap(
  items: { id: string; area: number }[],
  width: number,
  height: number,
): Map<string, TreemapCell> {
  const packed = new Map<string, TreemapCell>();
  if (width <= 0 || height <= 0 || items.length === 0) return packed;
  const cells = squarify(items, { x0: 0, z0: 0, x1: width, z1: height });
  for (const [id, cell] of cells) {
    packed.set(id, {
      x: cell.x0,
      y: cell.z0,
      width: cell.x1 - cell.x0,
      height: cell.z1 - cell.z0,
    });
  }
  return packed;
}

function inset(rect: Rect): Rect {
  const short = Math.min(rect.x1 - rect.x0, rect.z1 - rect.z0);
  const pad = Math.min(short * PADDING_RATIO + 0.045, 0.38);
  return { x0: rect.x0 + pad, z0: rect.z0 + pad, x1: rect.x1 - pad, z1: rect.z1 - pad };
}

function minSide(rect: Rect) {
  return Math.min(rect.x1 - rect.x0, rect.z1 - rect.z0);
}

function compareNodes(left: RepositoryNode, right: RepositoryNode) {
  return (
    left.depth - right.depth ||
    kindOrder[left.kind] - kindOrder[right.kind] ||
    left.path.localeCompare(right.path)
  );
}

function containmentMaps(graph: RepositoryGraph) {
  const parentOf = new Map<string, string>();
  const childrenOf = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "contains") continue;
    parentOf.set(edge.target, edge.source);
    const siblings = childrenOf.get(edge.source);
    if (siblings) siblings.push(edge.target);
    else childrenOf.set(edge.source, [edge.target]);
  }
  return { parentOf, childrenOf };
}

// Nodes past the depth slider that a selection should still place: the path to
// the selected module, plus the contents of the district being inspected.
export function revealedForSelection(
  graph: RepositoryGraph,
  selectedId: string | null,
  maxDepth: number,
): Set<string> {
  const revealed = new Set<string>();
  if (!selectedId) return revealed;

  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const selected = nodeById.get(selectedId);
  if (!selected) return revealed;

  const { parentOf, childrenOf } = containmentMaps(graph);
  let current: string | undefined = selectedId;
  while (current !== undefined) {
    const node = nodeById.get(current);
    if (!node) break;
    if (node.depth > maxDepth) revealed.add(current);
    current = parentOf.get(current);
  }

  const peekId =
    selected.kind === "directory" || selected.kind === "repository"
      ? selectedId
      : (parentOf.get(selectedId) ?? null);
  if (!peekId) return revealed;
  for (const childId of childrenOf.get(peekId) ?? []) {
    const child = nodeById.get(childId);
    if (child && child.depth > maxDepth) revealed.add(childId);
  }
  return revealed;
}

// `openedId` is the district deliberately broken open (a second click on the
// selection); plain selection never changes what the field renders.
export function buildRepositoryLayout(
  graph: RepositoryGraph,
  maxDepth: number = Number.POSITIVE_INFINITY,
  openedId: string | null = null,
): RepositoryLayout {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const { parentOf, childrenOf: allChildren } = containmentMaps(graph);
  const extraIds = revealedForSelection(graph, openedId, maxDepth);

  const pinned = new Set<string>();
  if (openedId) {
    let current: string | undefined = openedId;
    while (current !== undefined) {
      const node = nodeById.get(current);
      if (node && node.depth <= maxDepth) pinned.add(current);
      current = parentOf.get(current);
    }
  }

  const pinnedNodes = graph.nodes.filter((node) => pinned.has(node.id)).sort(compareNodes);
  const rest = graph.nodes
    .filter((node) => node.depth <= maxDepth && !pinned.has(node.id))
    .sort(compareNodes);
  const base = [
    ...pinnedNodes,
    ...rest.slice(0, Math.max(0, MAX_RENDERED_NODES - pinnedNodes.length)),
  ];
  const baseIds = new Set(base.map((node) => node.id));

  const extras = graph.nodes.filter((node) => extraIds.has(node.id) && !baseIds.has(node.id));
  const chain = new Set<string>();
  if (openedId) {
    let current: string | undefined = openedId;
    while (current !== undefined) {
      if (extraIds.has(current)) chain.add(current);
      current = parentOf.get(current);
    }
  }
  const chainNodes = extras.filter((node) => chain.has(node.id)).sort(compareNodes);
  const peekChildren = extras
    .filter((node) => !chain.has(node.id))
    .sort(compareNodes)
    .slice(0, MAX_PEEK_CHILDREN);
  const ordered = [...base, ...chainNodes, ...peekChildren];
  const renderedIds = new Set(ordered.map((node) => node.id));
  const placed = new Map(ordered.map((node) => [node.id, node]));
  let remaining = Math.max(0, MAX_RENDERED_NODES - ordered.length);

  const weights = buildWeights(graph, parentOf);
  const weightOf = (id: string) => Math.max(1, weights.get(id) ?? 1);

  function adopt(id: string): RepositoryNode | null {
    const already = placed.get(id);
    if (already) return already;
    if (remaining <= 0) return null;
    const node = nodeById.get(id);
    if (!node) return null;
    placed.set(id, node);
    renderedIds.add(id);
    remaining -= 1;
    return node;
  }

  function shouldOpen(id: string, rect: Rect) {
    const raw = allChildren.get(id) ?? [];
    if (raw.length === 0) return false;
    if (raw.some((childId) => extraIds.has(childId))) return true;
    if (
      raw.some(
        (childId) => (nodeById.get(childId)?.depth ?? Number.POSITIVE_INFINITY) <= maxDepth,
      )
    ) {
      return true;
    }
    const node = nodeById.get(id);
    // Only the survey-limit plate unpacks, and only one extra level — so a
    // large tile shows its districts, not a hairball of every nested file.
    return (
      node !== undefined &&
      node.depth === maxDepth &&
      minSide(rect) >= LOD_MIN_SIDE &&
      raw.length >= MIN_LOD_CHILDREN
    );
  }

  const side = Math.min(110, Math.max(30, Math.sqrt(base.length) * 6));
  const modules: LayoutModule[] = [];
  const root = placed.get(".");

  // Districts: each directory's rectangle contains its children, so position
  // itself encodes the hierarchy; files are buildings sized by line count.
  // Large cells at the survey limit still open one extra level so the
  // interior is readable; place names live on the scene, not in packing.
  function placeChildren(parentId: string, rect: Rect, elevation: number) {
    const raw = allChildren.get(parentId) ?? [];
    if (raw.length === 0) return;
    const inner = inset(rect);
    const innerArea = Math.max(0, (inner.x1 - inner.x0) * (inner.z1 - inner.z0));
    if (innerArea <= 0) return;

    const parent = nodeById.get(parentId);
    const lod =
      parent !== undefined &&
      parent.depth === maxDepth &&
      minSide(rect) >= LOD_MIN_SIDE &&
      raw.length >= MIN_LOD_CHILDREN;
    const ranked = [...raw].sort(
      (left, right) => weightOf(right) - weightOf(left) || left.localeCompare(right),
    );
    const childIds: string[] = [];
    for (const id of ranked) {
      const node = nodeById.get(id);
      if (!node) continue;
      const allowed =
        node.depth <= maxDepth || extraIds.has(id) || extraIds.has(parentId) || lod;
      if (!allowed) continue;
      if (!adopt(id)) break;
      childIds.push(id);
      if (node.depth > maxDepth && childIds.length >= MAX_PEEK_CHILDREN) break;
    }
    if (childIds.length === 0) return;

    const childWeights = childIds.map((id) => ({ id, area: weightOf(id) }));
    const totalWeight = childWeights.reduce((sum, item) => sum + item.area, 0);
    const scaled = childWeights.map((item) => ({
      id: item.id,
      area: (item.area / totalWeight) * innerArea,
    }));

    const cells = squarify(scaled, inner);
    for (const id of childIds) {
      const cell = cells.get(id);
      if (!cell) continue;
      const child = placed.get(id)!;
      const cellWidth = cell.x1 - cell.x0;
      const cellDepth = cell.z1 - cell.z0;
      if (child.kind === "directory" && shouldOpen(id, cell)) {
        modules.push({
          node: child,
          x: (cell.x0 + cell.x1) / 2,
          y: elevation,
          z: (cell.z0 + cell.z1) / 2,
          width: cellWidth,
          depth: cellDepth,
          height: PLAT_HEIGHT,
        });
        placeChildren(id, cell, elevation + PLAT_HEIGHT);
      } else {
        // Leaf building: a file, or a directory whose subtree is too small
        // or too deep to unpack as a nested treemap.
        modules.push({
          node: child,
          x: (cell.x0 + cell.x1) / 2,
          y: elevation,
          z: (cell.z0 + cell.z1) / 2,
          width: cellWidth * LEAF_FILL,
          depth: cellDepth * LEAF_FILL,
          height: buildingHeight(weightOf(id)),
        });
      }
    }
  }

  if (root) {
    const rootRect: Rect = { x0: -side / 2, z0: -side / 2, x1: side / 2, z1: side / 2 };
    modules.push({
      node: root,
      x: 0,
      y: 0,
      z: 0,
      width: side,
      depth: side,
      height: PLAT_HEIGHT,
    });
    placeChildren(".", rootRect, PLAT_HEIGHT);
  }

  const extent = Math.max(16, side / 2 + 3);
  return { modules, imports: aggregateImports(graph, renderedIds, parentOf), extent };
}

// File-level import edges lift to their nearest rendered ancestor so flow stays
// legible beyond the render cap: many file imports become one weighted arc.
// The flow view reuses this with a depth-based node set.
export function aggregateImports(
  graph: RepositoryGraph,
  renderedIds: Set<string>,
  parentOf: Map<string, string>,
): ImportFlow[] {
  const liftToRendered = (id: string): string | null => {
    let current: string | undefined = id;
    while (current !== undefined && !renderedIds.has(current)) current = parentOf.get(current);
    return current ?? null;
  };

  const flows = new Map<string, ImportFlow>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    const source = liftToRendered(edge.source);
    const target = liftToRendered(edge.target);
    if (!source || !target || source === target) continue;
    const key = JSON.stringify([source, target]);
    const flow = flows.get(key);
    if (flow) flow.weight += 1;
    else flows.set(key, { source, target, weight: 1 });
  }
  return [...flows.values()].sort(
    (left, right) =>
      left.source.localeCompare(right.source) || left.target.localeCompare(right.target),
  );
}

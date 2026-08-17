import type { RepositoryEdge, RepositoryGraph, RepositoryNode } from "./model";

// Three.js stays responsive on large monorepos; the complete graph remains in the UI lists and stats.
export const MAX_RENDERED_NODES = 700;

export interface LayoutModule {
  node: RepositoryNode;
  x: number;
  z: number;
  width: number;
  height: number;
  depth: number;
}

export interface RepositoryLayout {
  modules: LayoutModule[];
  edges: RepositoryEdge[];
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

function spiralCell(index: number): [number, number] {
  let x = 0;
  let z = 0;
  let dx = 0;
  let dz = -1;

  for (let step = 0; step <= index; step += 1) {
    if (step === index) return [x, z];
    if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
      [dx, dz] = [-dz, dx];
    }
    x += dx;
    z += dz;
  }

  return [x, z];
}

function dimensions(node: RepositoryNode, lineCountAvailable: boolean) {
  const magnitude = lineCountAvailable ? node.lines : Math.ceil(node.sizeBytes / 64);
  if (node.kind === "repository") {
    return {
      width: 4.2,
      depth: 4.2,
      height: Math.min(4, 1.6 + Math.log10(magnitude + 1) * 0.55),
    };
  }

  if (node.kind === "directory") {
    const footprint = Math.min(3.6, 1.65 + Math.log2(node.childCount + 1) * 0.36);
    return {
      width: footprint,
      depth: footprint,
      height: Math.min(2.4, 0.55 + Math.log2(node.childCount + 1) * 0.28),
    };
  }

  return {
    width: node.kind === "source" ? 1.15 : 1.35,
    depth: node.kind === "source" ? 1.15 : 1.35,
    height: Math.min(3, 0.28 + Math.log10(magnitude + 1) * 0.58),
  };
}

export function buildRepositoryLayout(graph: RepositoryGraph): RepositoryLayout {
  const ordered = [...graph.nodes]
    .sort(
      (left, right) =>
        left.depth - right.depth ||
        kindOrder[left.kind] - kindOrder[right.kind] ||
        left.path.localeCompare(right.path),
    )
    .slice(0, MAX_RENDERED_NODES);

  const modules = ordered.map((node, index) => {
    const [cellX, cellZ] = spiralCell(index);
    return {
      node,
      x: cellX * 4.8,
      z: cellZ * 4.8,
      ...dimensions(node, graph.stats.lineCountAvailable),
    };
  });
  const renderedIds = new Set(modules.map(({ node }) => node.id));
  const edges = graph.edges.filter(
    (edge) => renderedIds.has(edge.source) && renderedIds.has(edge.target),
  );
  const extent = Math.max(
    18,
    ...modules.map(({ x, z }) => Math.max(Math.abs(x), Math.abs(z)) + 7),
  );

  return { modules, edges, extent };
}

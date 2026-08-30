import type { RepositoryGraph, RepositoryNode } from "./model";

// Cartographic grain of the current focus. Function is the next rung: the
// scanner reads declarations into the index, so search and the inspector work
// at that grain, but the survey does not draw them as places yet.
export type NodeScale = "field" | "district" | "folder" | "file";

export interface ScaleRung {
  id: NodeScale | "function";
  label: string;
  surveyed: boolean;
}

export const SCALE_LADDER: ScaleRung[] = [
  { id: "field", label: "Field", surveyed: true },
  { id: "district", label: "District", surveyed: true },
  { id: "folder", label: "Folder", surveyed: true },
  { id: "file", label: "File", surveyed: true },
  { id: "function", label: "Fn", surveyed: false },
];

const SCALE_INDEX: Record<NodeScale | "function", number> = {
  field: 0,
  district: 1,
  folder: 2,
  file: 3,
  function: 4,
};

export function scaleOf(node: RepositoryNode): NodeScale {
  if (node.kind === "repository") return "field";
  if (node.kind === "directory") return node.depth <= 1 ? "district" : "folder";
  return "file";
}

export function scaleIndex(scale: NodeScale | "function") {
  return SCALE_INDEX[scale];
}

export function ancestry(graph: RepositoryGraph, nodeId: string): RepositoryNode[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const parentOf = new Map<string, string>();
  for (const edge of graph.edges) {
    if (edge.kind === "contains") parentOf.set(edge.target, edge.source);
  }

  const chain: RepositoryNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = nodeId;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const node = nodeById.get(current);
    if (!node) break;
    chain.push(node);
    current = parentOf.get(current);
  }
  return chain.reverse();
}

export function ancestorAtScale(
  trail: RepositoryNode[],
  scale: NodeScale,
): RepositoryNode | null {
  const last = (predicate: (node: RepositoryNode) => boolean) =>
    [...trail].reverse().find(predicate) ?? null;

  if (scale === "field") {
    return trail.find((node) => node.kind === "repository") ?? trail[0] ?? null;
  }
  if (scale === "district") {
    return last((node) => node.kind === "directory" && node.depth <= 1);
  }
  if (scale === "folder") {
    return last((node) => node.kind === "directory" && node.depth >= 2);
  }
  return last((node) => node.kind !== "directory" && node.kind !== "repository");
}

// How far the focus sits below the survey slider. Zero means the map's
// default grain already includes this module.
export function surveyOffset(node: RepositoryNode, surveyDepth: number) {
  if (!Number.isFinite(surveyDepth)) return 0;
  return Math.max(0, node.depth - surveyDepth);
}

export function nodeGlyph(node: RepositoryNode) {
  if (node.kind === "repository") return "R";
  if (node.extension) {
    const ext = node.extension.replace(/^\./, "").slice(0, 4).toUpperCase();
    if (ext) return ext;
  }
  return node.kind.slice(0, 1).toUpperCase();
}

export function visibleCrumbs(trail: RepositoryNode[]): (RepositoryNode | "gap")[] {
  if (trail.length <= 4) return trail;
  return [trail[0], "gap", trail[trail.length - 2], trail[trail.length - 1]];
}

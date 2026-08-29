export type RepositoryNodeKind =
  | "repository"
  | "directory"
  | "source"
  | "config"
  | "documentation"
  | "asset";

export interface RepositoryNode {
  id: string;
  name: string;
  path: string;
  kind: RepositoryNodeKind;
  extension: string | null;
  language: string | null;
  sizeBytes: number;
  lines: number;
  depth: number;
  childCount: number;
  description: string | null;
}

export interface RepositoryEdge {
  source: string;
  target: string;
  kind: "contains" | "imports";
}

export interface RepositoryStats {
  files: number;
  directories: number;
  lines: number;
  lineCountAvailable: boolean;
  importsAvailable: boolean;
  bytes: number;
  languages: { name: string; files: number; lines: number }[];
  truncated: boolean;
}

export interface RepositoryGraph {
  root: string;
  name: string;
  branch: string | null;
  source: "local" | "github";
  nodes: RepositoryNode[];
  edges: RepositoryEdge[];
  stats: RepositoryStats;
  warnings: string[];
}

export type LayerName = "structure" | "source" | "config" | "docs" | "imports";

export type LayerVisibility = Record<LayerName, boolean>;

export function layerForNode(node: RepositoryNode): LayerName {
  if (node.kind === "repository" || node.kind === "directory") return "structure";
  if (node.kind === "config") return "config";
  if (node.kind === "documentation") return "docs";
  return "source";
}

/// Parses an exported map file, rejecting anything that is not a graph.
export function parseRepositoryGraph(text: string): RepositoryGraph {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("This file is not a Codebase Atlas map.");
  }
  const graph = value as RepositoryGraph;
  if (
    !graph ||
    typeof graph !== "object" ||
    typeof graph.name !== "string" ||
    !Array.isArray(graph.nodes) ||
    !Array.isArray(graph.edges) ||
    !graph.stats ||
    typeof graph.stats !== "object" ||
    !graph.nodes.every(
      (node) => node && typeof node.id === "string" && typeof node.path === "string",
    )
  ) {
    throw new Error("This file is not a Codebase Atlas map.");
  }
  return graph;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

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
}

export interface RepositoryEdge {
  source: string;
  target: string;
  kind: "contains";
}

export interface RepositoryStats {
  files: number;
  directories: number;
  lines: number;
  lineCountAvailable: boolean;
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

export type LayerName = "structure" | "source" | "config" | "docs";

export type LayerVisibility = Record<LayerName, boolean>;

export function layerForNode(node: RepositoryNode): LayerName {
  if (node.kind === "repository" || node.kind === "directory") return "structure";
  if (node.kind === "config") return "config";
  if (node.kind === "documentation") return "docs";
  return "source";
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

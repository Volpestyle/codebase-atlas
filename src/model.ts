export type RepositoryNodeKind =
  | "repository"
  | "directory"
  | "source"
  | "config"
  | "documentation"
  | "asset";

/** Declaration kinds, normalized across languages by the scanner: every
 *  declaration is a behavior, a shape, or a value. */
export type SymbolKind = "function" | "type" | "constant";

export interface CodeSymbol {
  name: string;
  kind: SymbolKind;
  /** 1-based line of the declaration. */
  line: number;
  exported: boolean;
}

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
  /** Declarations this file makes. Absent for directories, for GitHub sources,
   *  and for languages the scanner does not parse. */
  symbols?: CodeSymbol[];
}

export interface RepositoryEdge {
  source: string;
  target: string;
  kind: "contains" | "imports";
  /** For an import edge, the named bindings that cross it. Absent for
   *  containment, for side-effect and dynamic imports, and `*` for namespace
   *  and glob imports. */
  symbols?: string[];
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

/** Where an actor sits in the telling. The order is the diagram's left-to-right
 *  order: naming a role honestly is what places it, so a story file never
 *  carries coordinates. */
export type ActorRole = "person" | "surface" | "door" | "core" | "store" | "external";

export const ACTOR_ROLES: ActorRole[] = [
  "person",
  "surface",
  "door",
  "core",
  "store",
  "external",
];

/** Column headings, written for someone who has never opened a codebase. */
export const ROLE_HEADINGS: Record<ActorRole, string> = {
  person: "People",
  surface: "Where they arrive",
  door: "The way in",
  core: "What decides",
  store: "What it keeps",
  external: "Outside services",
};

export interface StoryActor {
  id: string;
  name: string;
  role: ActorRole;
  blurb: string;
  /** Scanned paths this actor is made of; empty for people and outside
   *  services, several for a role served by more than one module. */
  modules?: string[];
}

export interface StoryFlow {
  from: string;
  to: string;
  /** What travels, in words. */
  carries: string;
  /** What comes back, when anything does. */
  returns?: string;
}

export interface StoryJourney {
  name: string;
  blurb?: string;
  /** Actor ids in the order data visits them. */
  steps: string[];
}

/** The narrative layer, hand-authored in `.codebase-index/_story.json`. Prose,
 *  not parse output: imports cannot know that a message arrives from Discord. */
export interface Story {
  summary: string;
  actors: StoryActor[];
  flows: StoryFlow[];
  journeys: StoryJourney[];
}

export interface RepositoryGraph {
  root: string;
  name: string;
  branch: string | null;
  source: "local" | "github";
  nodes: RepositoryNode[];
  edges: RepositoryEdge[];
  stats: RepositoryStats;
  /** Present when the repository carries a story file. */
  story?: Story;
  warnings: string[];
}

export type LayerName = "structure" | "source" | "config" | "docs" | "tests" | "imports";

export type LayerVisibility = Record<LayerName, boolean>;

// Directories that hold a module's support material rather than its substance.
// The flow view mutes their chip cells; the map classifies everything under
// them into the tests layer.
export const SUPPORT_DIR_NAMES = new Set([
  "test",
  "tests",
  "__tests__",
  "spec",
  "specs",
  "e2e",
  "fixtures",
  "__mocks__",
]);

const TEST_FILE_PATTERN = /(\.(test|spec)|_test)\.[^.]+$/;

export function isTestNode(node: RepositoryNode): boolean {
  if (node.kind === "repository") return false;
  if (TEST_FILE_PATTERN.test(node.name)) return true;
  return node.path.split("/").some((segment) => SUPPORT_DIR_NAMES.has(segment.toLowerCase()));
}

export function layerForNode(node: RepositoryNode): LayerName {
  if (isTestNode(node)) return "tests";
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

/** Whether any part of a node's declared surface matches a search term. */
export function matchesSymbol(node: RepositoryNode, query: string): boolean {
  return Boolean(node.symbols?.some((symbol) => symbol.name.toLowerCase().includes(query)));
}

// Bindings crossing an import edge, bounded so one wide module cannot push a
// register row into a paragraph.
const MAX_CROSSING_SYMBOLS = 6;

/** Reads the bindings crossing an edge as one line, longest lists elided. */
export function crossingLabel(symbols: Iterable<string>): string | null {
  const names = [...symbols].sort();
  if (names.length === 0) return null;
  if (names.length <= MAX_CROSSING_SYMBOLS) return names.join(", ");
  const shown = names.slice(0, MAX_CROSSING_SYMBOLS).join(", ");
  return `${shown} +${names.length - MAX_CROSSING_SYMBOLS}`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
}

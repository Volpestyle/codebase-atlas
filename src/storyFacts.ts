import type { RepositoryGraph, RepositoryNode, Story, StoryActor } from "./model.ts";
import { isProductSource, isTestPath } from "./sourceScope.ts";

export function isFile(node: RepositoryNode): boolean {
  return node.kind !== "directory" && node.kind !== "repository";
}

/** Most specific module wins; equally specific claims use story order. This
 * partitions files for percentages without counting overlapping claims twice. */
export function ownerForNode(story: Story, path: string): string | null {
  let owner: string | null = null;
  let specificity = -1;
  for (const actor of story.actors) {
    for (const module of actor.modules ?? []) {
      if ((module === "." || path === module || path.startsWith(`${module}/`)) && module.length > specificity) {
        owner = actor.id;
        specificity = module.length;
      }
    }
  }
  return owner;
}

/** Largest scanned files first; byte sizes stand in when lines are unavailable. */
export function filesBySize(graph: RepositoryGraph, files: RepositoryNode[]): RepositoryNode[] {
  return [...files].sort((a, b) => (graph.stats.lineCountAvailable ? b.lines - a.lines : b.sizeBytes - a.sizeBytes) || a.path.localeCompare(b.path));
}

/** A part's substance: the product source its modules own. */
export function filesForActor(graph: RepositoryGraph, actorId: string): RepositoryNode[] {
  return ownedFiles(graph, actorId).filter(isProductSource);
}

/** Files inside a part's modules that are not product source: its tests,
 *  setup, docs and assets. */
export function supportFilesForActor(graph: RepositoryGraph, actorId: string): RepositoryNode[] {
  return ownedFiles(graph, actorId).filter(node => !isProductSource(node));
}

function ownedFiles(graph: RepositoryGraph, actorId: string): RepositoryNode[] {
  if (!graph.story) return [];
  return graph.nodes.filter(node => isFile(node) && ownerForNode(graph.story!, node.id) === actorId)
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The scanner can resolve an import to a directory (a package or module
 *  folder). Expand such a target to the given files inside it, memoized. */
export function importTargetResolver(files: RepositoryNode[]): (target: string) => string[] {
  const ids = new Set(files.map(file => file.id));
  const cache = new Map<string, string[]>();
  return target => {
    let resolved = cache.get(target);
    if (!resolved) {
      resolved = ids.has(target) ? [target] : files.filter(file => target === "." || file.id.startsWith(`${target}/`)).map(file => file.id);
      cache.set(target, resolved);
    }
    return resolved;
  };
}

export interface ProseExchange { who: string; text: string; returning: boolean }
export function actorExchanges(story: Story, actor: StoryActor) {
  const takes: ProseExchange[] = [];
  const gives: ProseExchange[] = [];
  for (const flow of story.flows) {
    if (flow.to === actor.id) {
      takes.push({ who: flow.from, text: flow.carries, returning: false });
      if (flow.returns) gives.push({ who: flow.from, text: flow.returns, returning: true });
    }
    if (flow.from === actor.id) {
      gives.push({ who: flow.to, text: flow.carries, returning: false });
      if (flow.returns) takes.push({ who: flow.to, text: flow.returns, returning: true });
    }
  }
  return { takes, gives };
}

export interface PartCrossing {
  direction: "in" | "out";
  other: string | null;
  names: string[];
  files: string[];
  count: number;
}

/** Import direction is dependency, not the story's data-flow direction. Both
 *  ends must be product source, so tests and setup never read as crossings;
 *  a directory target counts once per owning part it expands into. */
export function partCrossings(graph: RepositoryGraph, actorId: string): PartCrossing[] {
  if (!graph.story || !graph.stats.importsAvailable) return [];
  const product = graph.nodes.filter(isProductSource);
  const productIds = new Set(product.map(file => file.id));
  const resolve = importTargetResolver(product);
  const groups = new Map<string, { direction: "in" | "out"; other: string | null; names: Set<string>; files: Set<string>; count: number }>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports" || !productIds.has(edge.source)) continue;
    const from = ownerForNode(graph.story, edge.source);
    const counted = new Set<string>();
    for (const target of resolve(edge.target)) {
      const to = ownerForNode(graph.story, target);
      if (from === to) continue;
      const direction = from === actorId ? "in" : to === actorId ? "out" : null;
      if (!direction) continue;
      const other = direction === "in" ? to : from;
      const key = `${direction}:${other ?? ""}`;
      let group = groups.get(key);
      if (!group) {
        group = { direction, other, names: new Set(), files: new Set(), count: 0 };
        groups.set(key, group);
      }
      if (!counted.has(key)) {
        counted.add(key);
        group.count += 1;
        for (const name of edge.symbols ?? []) group.names.add(name);
      }
      group.files.add(direction === "in" ? target : edge.source);
    }
  }
  return [...groups.values()].map(group => ({ ...group, names: [...group.names].sort(), files: [...group.files].sort() }))
    .sort((a, b) => b.count - a.count || `${a.direction}:${a.other}`.localeCompare(`${b.direction}:${b.other}`));
}

/** Test files that import this part's product source, directly or through a
 *  directory import. */
export function testsForActor(graph: RepositoryGraph, actorId: string): RepositoryNode[] {
  if (!graph.story) return [];
  const resolve = importTargetResolver(filesForActor(graph, actorId));
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const ids = new Set<string>();
  for (const edge of graph.edges) {
    const source = nodeById.get(edge.source);
    if (edge.kind === "imports" && source && isFile(source) && isTestPath(source.id) && resolve(edge.target).length) ids.add(edge.source);
  }
  return graph.nodes.filter(node => ids.has(node.id)).sort((a, b) => a.path.localeCompare(b.path));
}

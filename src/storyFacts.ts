import { isTestNode, type RepositoryGraph, type RepositoryNode, type Story, type StoryActor } from "./model.ts";

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

export function filesForActor(graph: RepositoryGraph, actorId: string): RepositoryNode[] {
  if (!graph.story) return [];
  return graph.nodes.filter(node => isFile(node) && ownerForNode(graph.story!, node.id) === actorId)
    .sort((a, b) => a.path.localeCompare(b.path));
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

/** Import direction is dependency, not the story's data-flow direction. */
export function partCrossings(graph: RepositoryGraph, actorId: string): PartCrossing[] {
  if (!graph.story || !graph.stats.importsAvailable) return [];
  const groups = new Map<string, { direction: "in" | "out"; other: string | null; names: Set<string>; files: Set<string>; count: number }>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    const from = ownerForNode(graph.story, edge.source);
    const to = ownerForNode(graph.story, edge.target);
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
    group.count += 1;
    for (const name of edge.symbols ?? []) group.names.add(name);
    group.files.add(direction === "in" ? edge.target : edge.source);
  }
  return [...groups.values()].map(group => ({ ...group, names: [...group.names].sort(), files: [...group.files].sort() }))
    .sort((a, b) => b.count - a.count || `${a.direction}:${a.other}`.localeCompare(`${b.direction}:${b.other}`));
}

export function testsForActor(graph: RepositoryGraph, actorId: string): RepositoryNode[] {
  if (!graph.story) return [];
  const nodeById = new Map(graph.nodes.map(node => [node.id, node]));
  const ids = new Set(graph.edges.filter(edge => edge.kind === "imports" && ownerForNode(graph.story!, edge.target) === actorId && (nodeById.has(edge.source) && isTestNode(nodeById.get(edge.source)!))).map(edge => edge.source));
  return graph.nodes.filter(node => ids.has(node.id)).sort((a, b) => a.path.localeCompare(b.path));
}

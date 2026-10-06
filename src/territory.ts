import type { RepositoryGraph, RepositoryNode, StoryJourney } from "./model.ts";
import { excludedSourcePath, isProductSource } from "./sourceScope.ts";
import { isFile, ownerForNode } from "./storyFacts.ts";
import { fileWeight, packTreemap, type TreemapCell } from "./treemap.ts";

export interface PartCoverage { actorId: string | null; lines: number; files: number; percent: number | null }
export function storyCoverage(graph: RepositoryGraph) {
  const parts = new Map<string | null, PartCoverage>();
  for (const actor of graph.story?.actors ?? []) parts.set(actor.id, { actorId: actor.id, lines: 0, files: 0, percent: null });
  parts.set(null, { actorId: null, lines: 0, files: 0, percent: null });
  let total = 0;
  for (const node of graph.nodes.filter(isProductSource)) {
    const owner = graph.story ? ownerForNode(graph.story, node.id) : null;
    const part = parts.get(owner)!;
    part.lines += node.lines; part.files += 1; total += node.lines;
  }
  const available = graph.stats.lineCountAvailable && total > 0;
  for (const part of parts.values()) part.percent = available ? part.lines / total * 100 : null;
  return { total, available, partial: graph.stats.truncated, parts: [...parts.values()], covered: total - parts.get(null)!.lines };
}

export interface GapSuggestion { actorId: string; files: RepositoryNode[]; lines: number }
/** Walk upstream through uncovered product files. A suggestion needs a real
 * owned importer boundary, only one owning part, and no unowned entry root.
 * Cycles terminate; orphan cycles and shared utilities remain unassigned. */
export function exclusiveGapSuggestions(graph: RepositoryGraph): GapSuggestion[] {
  if (!graph.story || !graph.stats.importsAvailable) return [];
  const files = graph.nodes.filter(isProductSource);
  const fileIds = new Set(files.map(file => file.id));
  const owners = new Map(files.map(file => [file.id, ownerForNode(graph.story!, file.id)]));
  const incoming = new Map(files.map(file => [file.id, new Set<string>()]));
  const expanded = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.kind !== "imports" || !fileIds.has(edge.source)) continue;
    let targets = expanded.get(edge.target);
    if (!targets) {
      targets = fileIds.has(edge.target) ? [edge.target] : files.filter(file => edge.target === "." || file.id.startsWith(`${edge.target}/`)).map(file => file.id);
      expanded.set(edge.target, targets);
    }
    for (const target of targets) incoming.get(target)!.add(edge.source);
  }
  const suggestions = new Map<string, GapSuggestion>();
  for (const file of files) {
    if (owners.get(file.id)) continue;
    const queue = [file.id]; const visited = new Set<string>(); const boundary = new Set<string>();
    let unanchored = false;
    for (let index = 0; index < queue.length; index += 1) {
      const current = queue[index];
      if (visited.has(current)) continue;
      visited.add(current);
      const importers = incoming.get(current)!;
      if (!importers.size) unanchored = true;
      for (const importer of importers) {
        const owner = owners.get(importer);
        if (owner) boundary.add(owner); else queue.push(importer);
      }
    }
    if (unanchored || boundary.size !== 1) continue;
    const actorId = [...boundary][0];
    let suggestion = suggestions.get(actorId);
    if (!suggestion) { suggestion = { actorId, files: [], lines: 0 }; suggestions.set(actorId, suggestion); }
    suggestion.files.push(file); suggestion.lines += file.lines;
  }
  return [...suggestions.values()].map(suggestion => ({ ...suggestion, files: suggestion.files.sort((a, b) => b.lines - a.lines || a.id.localeCompare(b.id)) }))
    .sort((a, b) => b.lines - a.lines || a.actorId.localeCompare(b.actorId));
}

export interface TerritoryFile extends TreemapCell { node: RepositoryNode; owner: string | null; product: boolean }
export interface TerritoryArea extends TreemapCell { name: string }
export function buildTerritoryLayout(graph: RepositoryGraph, width: number, height: number) {
  const files = graph.nodes.filter(node => isFile(node) && !excludedSourcePath(node.path));
  const groups = new Map<string, RepositoryNode[]>();
  for (const file of files) {
    const area = file.path.includes("/") ? file.path.split("/")[0] : "Repository";
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area)!.push(file);
  }
  const weights = [...groups].map(([id, nodes]) => ({ id, weight: nodes.reduce((sum, node) => sum + fileWeight(node, graph.stats.lineCountAvailable), 0) }));
  const total = weights.reduce((sum, item) => sum + item.weight, 0);
  const rectangles = packTreemap(weights.map(item => ({ id: item.id, area: width * height * item.weight / total })), width, height);
  const cells: TerritoryFile[] = []; const areas: TerritoryArea[] = [];
  for (const [name, nodes] of groups) {
    const area = rectangles.get(name)!;
    areas.push({ name, ...area });
    const inset = Math.min(4, area.width / 8, area.height / 8);
    const header = Math.min(26, area.height / 4);
    const innerWidth = Math.max(0, area.width - inset * 2);
    const innerHeight = Math.max(0, area.height - header - inset);
    const weight = nodes.reduce((sum, node) => sum + fileWeight(node, graph.stats.lineCountAvailable), 0);
    const tiles = packTreemap(nodes.map(node => ({ id: node.id, area: innerWidth * innerHeight * fileWeight(node, graph.stats.lineCountAvailable) / weight })), innerWidth, innerHeight);
    for (const node of nodes) {
      const tile = tiles.get(node.id)!;
      cells.push({ ...tile, x: tile.x + area.x + inset, y: tile.y + area.y + header, node, owner: graph.story ? ownerForNode(graph.story, node.id) : null, product: isProductSource(node) });
    }
  }
  return { width, height, areas, cells };
}

export function territoryJourney(journey: StoryJourney, cells: TerritoryFile[]) {
  const centers = new Map<string, TerritoryFile>();
  for (const cell of cells) {
    if (!cell.owner) continue;
    const current = centers.get(cell.owner);
    if (!current || cell.width * cell.height > current.width * current.height) centers.set(cell.owner, cell);
  }
  const stops = journey.steps.flatMap((actorId, index) => {
    const cell = centers.get(actorId);
    return cell ? [{ actorId, step: index + 1, x: cell.x + cell.width / 2, y: cell.y + cell.height / 2 }] : [];
  });
  return { stops, path: stops.map((stop, index) => `${index ? "L" : "M"} ${stop.x} ${stop.y}`).join(" "), outside: [...new Set(journey.steps.filter(id => !centers.has(id)))] };
}

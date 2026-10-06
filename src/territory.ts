import type { RepositoryGraph, RepositoryNode, StoryJourney } from "./model.ts";
import { excludedSourcePath, isProductSource } from "./sourceScope.ts";
import { importTargetResolver, isFile, ownerForNode } from "./storyFacts.ts";
import { fileWeight, packTreemap, type TreemapCell } from "./treemap.ts";

export interface PartCoverage { actorId: string | null; lines: number; files: number; percent: number | null }
/** Only parts that own product source get a row, in story order; people and
 *  outside services never read as 0%. The null "Not in the story" row is
 *  always last. */
export function storyCoverage(graph: RepositoryGraph) {
  const parts = new Map<string | null, PartCoverage>();
  for (const actor of graph.story?.actors ?? []) parts.set(actor.id, { actorId: actor.id, lines: 0, files: 0, percent: null });
  const gap: PartCoverage = { actorId: null, lines: 0, files: 0, percent: null };
  parts.set(null, gap);
  let total = 0;
  for (const node of graph.nodes.filter(isProductSource)) {
    const owner = graph.story ? ownerForNode(graph.story, node.id) : null;
    const part = parts.get(owner)!;
    part.lines += node.lines; part.files += 1; total += node.lines;
  }
  const available = graph.stats.lineCountAvailable && total > 0;
  const rows = [...parts.values()].filter(part => part.actorId !== null && part.files > 0);
  rows.push(gap);
  for (const part of rows) part.percent = available ? part.lines / total * 100 : null;
  return { total, available, partial: graph.stats.truncated, parts: rows, covered: total - gap.lines };
}

/** True when the import graph may be missing edges (a truncated scan or the
 *  scanner's import-edge cap), so gap suggestions need a caveat. */
export function importsArePartial(graph: RepositoryGraph): boolean {
  return graph.stats.truncated || graph.warnings.some(warning => warning.startsWith("Import edges limited to"));
}

export interface GapSuggestion { actorId: string; files: RepositoryNode[]; lines: number }
/** Walk upstream through uncovered product files. A suggestion needs a real
 * owned importer boundary, only one owning part, and no unowned entry root.
 * Cycles terminate; orphan cycles and shared utilities remain unassigned.
 * On a partial import graph (importsArePartial) these are best guesses. */
export function exclusiveGapSuggestions(graph: RepositoryGraph): GapSuggestion[] {
  if (!graph.story || !graph.stats.importsAvailable) return [];
  const files = graph.nodes.filter(isProductSource);
  const fileIds = new Set(files.map(file => file.id));
  const owners = new Map(files.map(file => [file.id, ownerForNode(graph.story!, file.id)]));
  const incoming = new Map(files.map(file => [file.id, new Set<string>()]));
  const resolve = importTargetResolver(files);
  for (const edge of graph.edges) {
    if (edge.kind !== "imports" || !fileIds.has(edge.source)) continue;
    for (const target of resolve(edge.target)) incoming.get(target)!.add(edge.source);
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

export interface TerritoryStop {
  actorId: string;
  /** 1-based journey step. */
  step: number;
  /** Earlier visits to this part; each repeat is offset so every step shows. */
  visit: number;
  x: number;
  y: number;
}
const REPEAT_OFFSET = 20;

/** Each stop marks its part's largest file. The path runs through the cell
 *  centres; a part visited again gets its next number beside the last. */
export function territoryJourney(journey: StoryJourney, cells: TerritoryFile[]) {
  const centers = new Map<string, TerritoryFile>();
  for (const cell of cells) {
    if (!cell.owner) continue;
    const current = centers.get(cell.owner);
    if (!current || cell.width * cell.height > current.width * current.height) centers.set(cell.owner, cell);
  }
  const visits = new Map<string, number>();
  const points: string[] = [];
  const stops: TerritoryStop[] = journey.steps.flatMap((actorId, index) => {
    const cell = centers.get(actorId);
    if (!cell) return [];
    const visit = visits.get(actorId) ?? 0;
    visits.set(actorId, visit + 1);
    const x = cell.x + cell.width / 2; const y = cell.y + cell.height / 2;
    points.push(`${points.length ? "L" : "M"} ${x} ${y}`);
    return [{ actorId, step: index + 1, visit, x: x + visit * REPEAT_OFFSET, y }];
  });
  return { stops, path: points.join(" "), outside: [...new Set(journey.steps.filter(id => !centers.has(id)))] };
}

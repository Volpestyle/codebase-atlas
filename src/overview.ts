import type { RepositoryGraph, RepositoryNode, StoryActor } from "./model.ts";
import { isProductSource } from "./sourceScope.ts";
import { importTargetResolver, ownerForNode } from "./storyFacts.ts";
import { fileWeight, packTreemap } from "./treemap.ts";

/* The Overview board: the whole codebase as an isometric plate seen from
 * above. Everything here is pure world geometry: districts, pillars, markers
 * and rails live on a square ground plane (x, y) with z up, and isoProject
 * draws them with Hairline's camera (azimuth 45° + quarter turns, k = 0.5:
 * the 2:1 view). The view only projects, sorts and paints. */

export const BOARD = 1000;
/** Rails may leave the plate to reach people and outside services. */
export const EDGE = 90;
export const GAP_ID = "__gap__";
const STREET = 28;
const MARGIN = 20;
const PITCH = 18;
const PILLAR = 9;
const CRATE = 14;
export const HEIGHT_MAX = 110;
export const MAX_PILLARS = 360;

export type Point = [number, number];
export interface Rect { x: number; y: number; width: number; height: number }

// --- Camera -----------------------------------------------------------------

export interface IsoCamera {
  /** Azimuth in degrees; 45 is Hairline's default and each quarter turn adds 90. */
  az: number;
  /** sin(elevation): 0.5 is the 2:1 view. */
  k: number;
  scale: number;
  ox: number;
  oy: number;
}

export const quarterAzimuth = (turns: number) => 45 + 90 * turns;

/** Hairline's proj(): rotation about the board's centre, then the 2:1 squash. */
export function isoProject(cam: IsoCamera, x: number, y: number, z = 0): Point {
  const a = cam.az * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), zf = Math.sqrt(1 - cam.k * cam.k);
  const wx = x - BOARD / 2, wy = y - BOARD / 2;
  const X = wx * c - wy * s, Y = wx * s + wy * c;
  return [cam.ox + cam.scale * X, cam.oy + cam.scale * (Y * cam.k - z * zf)];
}

/** Larger is nearer the viewer: paint in ascending order. */
export function isoDepth(az: number, x: number, y: number): number {
  const a = az * Math.PI / 180;
  return (x - BOARD / 2) * Math.sin(a) + (y - BOARD / 2) * Math.cos(a);
}

/** Fits what stands on the board into a width. Bounds are the union over all
 *  four quarter turns, so the frame and scale never jump while turning.
 *  `points` are world [x, y, z]; each of `raised` has something standing on
 *  it `rise` screen units tall at scale 1 (a figure on its pad). */
export function fitCamera(width: number, az: number, points: [number, number, number][], raised: Point[] = [], rise = 0, padding = 12): IsoCamera & { height: number } {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (let turn = 0; turn < 4; turn += 1) {
    const unit: IsoCamera = { az: quarterAzimuth(turn), k: 0.5, scale: 1, ox: 0, oy: 0 };
    for (const [x, y, z] of points) {
      const [sx, sy] = isoProject(unit, x, y, z);
      minX = Math.min(minX, sx); maxX = Math.max(maxX, sx);
      minY = Math.min(minY, sy); maxY = Math.max(maxY, sy);
    }
    for (const [x, y] of raised) minY = Math.min(minY, isoProject(unit, x, y, 0)[1] - rise);
  }
  if (!Number.isFinite(minX)) { minX = -BOARD; maxX = BOARD; minY = -BOARD / 2; maxY = BOARD / 2; }
  const scale = Math.max(0.05, (width - padding * 2) / (maxX - minX));
  const height = Math.ceil((maxY - minY) * scale + padding * 2);
  return { az, k: 0.5, scale, ox: width / 2 - (minX + maxX) / 2 * scale, oy: padding - minY * scale, height };
}

/** The points fitCamera needs for a layout: board corners, markers and pillar tops. */
export function layoutBounds(layout: { districts: { pillars: { x: number; y: number; height: number }[] }[]; markers: { x: number; y: number }[] }): [number, number, number][] {
  const points: [number, number, number][] = [[0, 0, -14], [BOARD, 0, -14], [BOARD, BOARD, -14], [0, BOARD, -14], [0, 0, 0], [BOARD, 0, 0], [BOARD, BOARD, 0], [0, BOARD, 0]];
  for (const marker of layout.markers) points.push([marker.x, marker.y, 24]);
  for (const district of layout.districts) for (const pillar of district.pillars) points.push([pillar.x, pillar.y, pillar.height + 3]);
  return points;
}

export function convexHull(points: Point[]): Point[] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (sorted.length < 3) return sorted;
  const cross = (o: Point, a: Point, b: Point) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: Point[] = [];
  for (const p of sorted) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop(); lower.push(p); }
  const upper: Point[] = [];
  for (const p of sorted.reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop(); upper.push(p); }
  return lower.slice(0, -1).concat(upper.slice(0, -1));
}

const r2 = (n: number) => Math.round(n * 100) / 100;
export const closedPath = (points: Point[]) => points.length ? `M${points.map(p => `${r2(p[0])} ${r2(p[1])}`).join("L")}Z` : "";
export const openPath = (points: Point[]) => points.length > 1 ? `M${points.map(p => `${r2(p[0])} ${r2(p[1])}`).join("L")}` : "";

/** A box from z0 to z1 drawn the Hairline way: one silhouette, and one crease
 *  for the top's two near edges. Vertical corners are never drawn. */
export function isoBox(cam: IsoCamera, rect: Rect, z0: number, z1: number) {
  const corners: Point[] = [[rect.x, rect.y], [rect.x + rect.width, rect.y], [rect.x + rect.width, rect.y + rect.height], [rect.x, rect.y + rect.height]];
  const top = corners.map(([x, y]) => isoProject(cam, x, y, z1));
  const base = corners.map(([x, y]) => isoProject(cam, x, y, z0));
  let near = 0;
  corners.forEach(([x, y], i) => { if (isoDepth(cam.az, x, y) > isoDepth(cam.az, corners[near][0], corners[near][1])) near = i; });
  const crease = [top[(near + 3) % 4], top[near], top[(near + 1) % 4]];
  return { silhouette: closedPath(convexHull(top.concat(base))), crease: openPath(crease), top: closedPath(top) };
}

export interface GroundAxes { read: Point; down: Point }

/** World unit vectors for text lying on the ground along one world axis:
 *  `read` runs rightward on screen and `down` runs down it, so a label is
 *  never mirrored or upside down after a quarter turn. */
export function groundAxes(az: number, along: "x" | "y"): GroundAxes {
  const cam: IsoCamera = { az, k: 0.5, scale: 1, ox: 0, oy: 0 };
  const o = isoProject(cam, 0, 0), ex = isoProject(cam, 1, 0), ey = isoProject(cam, 0, 1);
  const sx = Math.sign(ex[0] - o[0]) || 1, sy = Math.sign(ey[0] - o[0]) || 1;
  const dx = Math.sign(ex[1] - o[1]) || 1, dy = Math.sign(ey[1] - o[1]) || 1;
  return along === "x" ? { read: [sx, 0], down: [0, dy] } : { read: [0, sy], down: [dx, 0] };
}

/** An SVG matrix that lays text flat on the ground at (x, y) along `axes`. */
export function groundTextMatrix(cam: IsoCamera, x: number, y: number, axes: GroundAxes): string {
  const { read, down } = axes;
  const o = isoProject(cam, x, y), u = isoProject(cam, x + read[0], y + read[1]), v = isoProject(cam, x + down[0], y + down[1]);
  return `matrix(${r2(u[0] - o[0])} ${r2(u[1] - o[1])} ${r2(v[0] - o[0])} ${r2(v[1] - o[1])} ${r2(o[0])} ${r2(o[1])})`;
}

/** A plate's label: along its longer side, starting at the reading start of
 *  the near edge, its baseline inset into the margin strip. */
export function plateLabel(az: number, plate: Rect, inset = 8, baseline = 7): { axes: GroundAxes; origin: Point; room: number } {
  const along = plate.width >= plate.height ? "x" : "y";
  const axes = groundAxes(az, along);
  const { read, down } = axes;
  // Along the reading axis, its start; across it, the edge `down` points to.
  const edge = (r: number, d: number, lo: number, size: number) => r ? (r > 0 ? lo : lo + size) : (d > 0 ? lo + size : lo);
  const x = edge(read[0], down[0], plate.x, plate.width), y = edge(read[1], down[1], plate.y, plate.height);
  return { axes, origin: [x + read[0] * inset - down[0] * baseline, y + read[1] * inset - down[1] * baseline], room: (along === "x" ? plate.width : plate.height) - inset * 2 };
}

// --- Layout -----------------------------------------------------------------

export interface OverviewPillar {
  id: string;
  district: string;
  /** Files this pillar stands for: one, or the aggregated rest of a district. */
  fileIds: string[];
  x: number;
  y: number;
  size: number;
  height: number;
  weight: number;
  aggregate: boolean;
}

export interface OverviewDistrict {
  id: string;
  actorId: string | null;
  name: string;
  files: number;
  lines: number;
  weight: number;
  lot: Rect;
  plate: Rect;
  /** The figure's footprint: the same size on every district. */
  pad: Rect;
  pillars: OverviewPillar[];
}

export interface OverviewMarker { actorId: string; name: string; role: StoryActor["role"]; x: number; y: number }

export interface OverviewConnection {
  key: string;
  a: string;
  b: string;
  /** Import edges between the two ends' product files (dependency, both ways). */
  imports: number;
  /** Bindings that cross, sorted. */
  names: string[];
  /** Written flows between the two, as "carries" sentences. */
  flows: { from: string; to: string; carries: string }[];
  /** True when the packet should travel a → b. */
  forward: boolean;
  rail: Point[];
}

export interface OverviewLayout {
  districts: OverviewDistrict[];
  markers: OverviewMarker[];
  connections: OverviewConnection[];
  padSize: number;
  /** file id → imported product file ids. */
  fileImports: Map<string, string[]>;
  /** file id → pillar id (aggregated files map to their district's crate). */
  pillarOfFile: Map<string, string>;
  pillars: Map<string, OverviewPillar>;
  totalFiles: number;
  shownFiles: number;
}

/** Floors each share so a small part's lot can still hold its figure, then
 *  shares the rest by weight. Returns areas that sum to `total`. */
export function flooredAreas(weights: number[], total: number, floor: number): number[] {
  const n = weights.length;
  if (!n) return [];
  const minimum = Math.min(floor, total / n);
  const fixed = new Array<boolean>(n).fill(false);
  let areas = new Array<number>(n).fill(0);
  for (let pass = 0; pass <= n; pass += 1) {
    const free = total - fixed.filter(Boolean).length * minimum;
    const sum = weights.reduce((acc, w, i) => acc + (fixed[i] ? 0 : Math.max(0, w)), 0);
    areas = weights.map((w, i) => fixed[i] ? minimum : sum > 0 ? free * Math.max(0, w) / sum : free / (n - fixed.filter(Boolean).length));
    let changed = false;
    areas.forEach((area, i) => { if (!fixed[i] && area < minimum) { fixed[i] = true; changed = true; } });
    if (!changed) break;
  }
  return areas;
}

const inset = (r: Rect, d: number): Rect => ({ x: r.x + d, y: r.y + d, width: Math.max(0, r.width - d * 2), height: Math.max(0, r.height - d * 2) });
export const rectCenter = (r: Rect): Point => [r.x + r.width / 2, r.y + r.height / 2];
const contains = (r: Rect, x: number, y: number) => x >= r.x && x <= r.x + r.width && y >= r.y && y <= r.y + r.height;

export function buildOverviewLayout(graph: RepositoryGraph, maxPillars = MAX_PILLARS): OverviewLayout {
  const story = graph.story;
  const actors = story?.actors ?? [];
  const product = graph.nodes.filter(isProductSource);
  const lineCounts = graph.stats.lineCountAvailable;
  const owner = new Map<string, string>();
  const groups = new Map<string, RepositoryNode[]>();
  for (const actor of actors) groups.set(actor.id, []);
  groups.set(GAP_ID, []);
  for (const file of product) {
    const id = (story && ownerForNode(story, file.id)) || GAP_ID;
    owner.set(file.id, id);
    groups.get(id)!.push(file);
  }
  const districtIds = [...actors.map(actor => actor.id), GAP_ID].filter(id => groups.get(id)!.length > 0);
  const weightOf = (file: RepositoryNode) => fileWeight(file, lineCounts);
  const weights = districtIds.map(id => groups.get(id)!.reduce((sum, file) => sum + weightOf(file), 0));

  // A uniform figure pad, sized so every lot can hold one.
  const n = Math.max(1, districtIds.length);
  const padSize = Math.max(48, Math.min(120, Math.sqrt(BOARD * BOARD / n) * 0.34));
  // Room for the pad, the label strip and two rings of pillars around it.
  const lotFloor = (padSize + MARGIN * 2 + STREET + PITCH * 4) ** 2;
  const areas = flooredAreas(weights, BOARD * BOARD, lotFloor);
  const lots = packTreemap(districtIds.map((id, i) => ({ id, area: areas[i] })), BOARD, BOARD);

  const maxWeight = Math.max(1, ...product.map(weightOf));
  const heightOf = (weight: number) => Math.max(4, HEIGHT_MAX * Math.sqrt(weight / maxWeight));
  const totalFiles = product.length;
  const pillars = new Map<string, OverviewPillar>();
  const pillarOfFile = new Map<string, string>();
  let shownFiles = 0;

  const districts: OverviewDistrict[] = districtIds.map(id => {
    const lot = lots.get(id)!;
    const plate = inset(lot, STREET / 2);
    const [cx, cy] = rectCenter(plate);
    const side = Math.min(padSize, plate.width - MARGIN * 2, plate.height - MARGIN * 2);
    const pad = { x: cx - side / 2, y: cy - side / 2, width: Math.max(0, side), height: Math.max(0, side) };
    const keepOut = inset(pad, -PITCH);
    const field = inset(plate, MARGIN);
    // The block's cells in snake order along its longer side, around a plaza
    // where the figure stands. Shown files go down that path in path order,
    // so neighbouring pillars are neighbouring files, spread evenly over the
    // block when there are fewer files than cells.
    const cells = blockCells(field, keepOut);
    const files = [...groups.get(id)!].sort((a, b) => weightOf(b) - weightOf(a) || a.id.localeCompare(b.id));
    const quota = Math.max(1, Math.round(maxPillars * files.length / Math.max(1, totalFiles)));
    const slots = Math.min(cells.length, quota, files.length);
    const aggregate = files.length > slots && slots > 0;
    const singles = aggregate ? slots - 1 : slots;
    const shown = files.slice(0, singles).sort((a, b) => a.id.localeCompare(b.id));
    const cellAt = (i: number) => cells[Math.min(cells.length - 1, Math.floor((i + 0.5) * cells.length / Math.max(1, slots)))];
    const list: OverviewPillar[] = [];
    shown.forEach((file, i) => {
      const [x, y] = cellAt(i);
      list.push({ id: file.id, district: id, fileIds: [file.id], x, y, size: PILLAR, height: heightOf(weightOf(file)), weight: weightOf(file), aggregate: false });
    });
    if (aggregate || (slots === 0 && files.length)) {
      const rest = files.slice(singles);
      const at = cells.length ? cellAt(singles) : [pad.x + pad.width, pad.y + pad.height];
      const weight = rest.reduce((sum, file) => sum + weightOf(file), 0);
      list.push({ id: `${id}::rest`, district: id, fileIds: rest.map(file => file.id), x: at[0], y: at[1], size: CRATE, height: heightOf(weight / rest.length), weight, aggregate: true });
    }
    for (const pillar of list) {
      pillars.set(pillar.id, pillar);
      for (const file of pillar.fileIds) pillarOfFile.set(file, pillar.id);
      if (!pillar.aggregate) shownFiles += 1;
    }
    const actor = actors.find(each => each.id === id);
    return { id, actorId: actor?.id ?? null, name: actor?.name ?? "Not in the story", files: files.length, lines: files.reduce((sum, file) => sum + file.lines, 0), weight: weights[districtIds.indexOf(id)], lot, plate, pad, pillars: list };
  });

  // Imports: one pass, mirroring partCrossings (product ends only, a directory
  // target counted once per owning part it expands into).
  const resolve = importTargetResolver(product);
  const productIds = new Set(product.map(file => file.id));
  const fileImports = new Map<string, Set<string>>();
  const pairs = new Map<string, { a: string; b: string; imports: number; aImportsB: number; names: Set<string>; flows: OverviewConnection["flows"] }>();
  const pairKey = (x: string, y: string) => x < y ? `${x}\u0000${y}` : `${y}\u0000${x}`;
  const pairFor = (x: string, y: string) => {
    const key = pairKey(x, y);
    let pair = pairs.get(key);
    if (!pair) { const [a, b] = x < y ? [x, y] : [y, x]; pair = { a, b, imports: 0, aImportsB: 0, names: new Set(), flows: [] }; pairs.set(key, pair); }
    return pair;
  };
  if (graph.stats.importsAvailable) {
    for (const edge of graph.edges) {
      if (edge.kind !== "imports" || !productIds.has(edge.source)) continue;
      const from = owner.get(edge.source)!;
      const counted = new Set<string>();
      for (const target of resolve(edge.target)) {
        if (target === edge.source) continue;
        let set = fileImports.get(edge.source);
        if (!set) { set = new Set(); fileImports.set(edge.source, set); }
        set.add(target);
        const to = owner.get(target)!;
        if (to === from || counted.has(to)) continue;
        counted.add(to);
        const pair = pairFor(from, to);
        pair.imports += 1;
        if (pair.a === from) pair.aImportsB += 1;
        for (const name of edge.symbols ?? []) pair.names.add(name);
      }
    }
  }
  const districtSet = new Set(districtIds);
  const markerActors = actors.filter(actor => !districtSet.has(actor.id));
  for (const flow of story?.flows ?? []) {
    if (flow.from === flow.to) continue;
    pairFor(flow.from, flow.to).flows.push({ from: flow.from, to: flow.to, carries: flow.carries });
  }

  const markers = placeMarkers(markerActors, districts, [...pairs.values()]);
  const anchors = new Map<string, { point: Point; plate?: Rect }>();
  for (const district of districts) anchors.set(district.id, { point: rectCenter(district.plate), plate: district.plate });
  for (const marker of markers) anchors.set(marker.actorId, { point: [marker.x, marker.y] });

  const ordered = [...pairs.values()].filter(pair => anchors.has(pair.a) && anchors.has(pair.b))
    .sort((p, q) => (q.imports + q.flows.length * 4) - (p.imports + p.flows.length * 4) || `${p.a}${p.b}`.localeCompare(`${q.a}${q.b}`));
  const router = createRouter(districts.map(district => ({ id: district.id, rect: district.plate })));
  const connections: OverviewConnection[] = ordered.map(pair => {
    const flowForward = pair.flows.filter(flow => flow.from === pair.a).length;
    const forward = pair.flows.length ? flowForward >= pair.flows.length - flowForward : pair.aImportsB * 2 >= pair.imports;
    const rail = router.route(anchors.get(pair.a)!, anchors.get(pair.b)!, pair.a, pair.b);
    return { key: pairKey(pair.a, pair.b), a: pair.a, b: pair.b, imports: pair.imports, names: [...pair.names].sort(), flows: pair.flows, forward, rail };
  });

  return {
    districts, markers, connections, padSize, pillars, pillarOfFile, totalFiles, shownFiles,
    fileImports: new Map([...fileImports].map(([file, targets]) => [file, [...targets].filter(target => productIds.has(target)).sort()])),
  };
}

/** Grid cell centres inside `field`, outside `keepOut`, in snake order with
 *  rows running along the field's longer side. */
export function blockCells(field: Rect, keepOut: Rect): Point[] {
  const across = field.width >= field.height;
  const us: number[] = [], vs: number[] = [];
  const along = across ? field.width : field.height, side = across ? field.height : field.width;
  const u0 = across ? field.x : field.y, v0 = across ? field.y : field.x;
  for (let u = PITCH / 2; u <= along - PITCH / 2 + 1e-6; u += PITCH) us.push(u0 + u);
  for (let v = PITCH / 2; v <= side - PITCH / 2 + 1e-6; v += PITCH) vs.push(v0 + v);
  const cells: Point[] = [];
  vs.forEach((v, row) => {
    for (const u of row % 2 ? [...us].reverse() : us) {
      const [x, y] = across ? [u, v] : [v, u];
      if (!contains(keepOut, x, y)) cells.push([x, y]);
    }
  });
  return cells;
}

/** People and outside services stand just off the plate, on the side nearest
 *  the parts they talk to, spread so no two collide. */
function placeMarkers(actors: StoryActor[], districts: OverviewDistrict[], pairs: { a: string; b: string; flows: unknown[] }[]): OverviewMarker[] {
  const centres = new Map(districts.map(district => [district.id, rectCenter(district.plate)]));
  const perimeter = BOARD * 4;
  const placed = actors.map((actor, order) => {
    const partners = pairs.filter(pair => pair.flows.length && (pair.a === actor.id || pair.b === actor.id))
      .map(pair => centres.get(pair.a === actor.id ? pair.b : pair.a)).filter((point): point is Point => Boolean(point));
    let t: number;
    if (partners.length) {
      const mx = partners.reduce((sum, p) => sum + p[0], 0) / partners.length;
      const my = partners.reduce((sum, p) => sum + p[1], 0) / partners.length;
      t = perimeterParam(mx, my);
    } else t = (order + 0.5) / Math.max(1, actors.length) * perimeter;
    return { actor, t };
  }).sort((p, q) => p.t - q.t || p.actor.id.localeCompare(q.actor.id));
  // Spread along the perimeter, keeping order, at least `gap` apart.
  const gap = Math.min(BOARD * 0.16, perimeter / Math.max(1, placed.length));
  for (let pass = 0; pass < 4; pass += 1)
    for (let i = 1; i < placed.length; i += 1) if (placed[i].t - placed[i - 1].t < gap) placed[i].t = placed[i - 1].t + gap;
  return placed.map(({ actor, t }) => {
    const [x, y] = perimeterPoint(((t % perimeter) + perimeter) % perimeter, EDGE * 0.55);
    return { actorId: actor.id, name: actor.name, role: actor.role, x, y };
  });
}

/** The perimeter of the board, clockwise from the far corner (0, 0): the
 *  parameter of the edge point nearest the direction of (x, y) from centre. */
export function perimeterParam(x: number, y: number): number {
  const dx = x - BOARD / 2, dy = y - BOARD / 2;
  const scale = (BOARD / 2) / Math.max(1e-6, Math.abs(dx), Math.abs(dy));
  const px = BOARD / 2 + dx * scale, py = BOARD / 2 + dy * scale;
  if (Math.abs(py) < 1e-6) return px;
  if (Math.abs(px - BOARD) < 1e-6) return BOARD + py;
  if (Math.abs(py - BOARD) < 1e-6) return BOARD * 2 + (BOARD - px);
  return BOARD * 3 + (BOARD - py);
}

export function perimeterPoint(t: number, out: number): Point {
  const side = Math.floor(t / BOARD) % 4, u = t - Math.floor(t / BOARD) * BOARD;
  // Keep markers clear of the corners so their rails approach square-on.
  const along = Math.max(BOARD * 0.06, Math.min(BOARD * 0.94, u));
  if (side === 0) return [along, -out];
  if (side === 1) return [BOARD + out, along];
  if (side === 2) return [BOARD - along, BOARD + out];
  return [-out, BOARD - along];
}

// --- Rails ------------------------------------------------------------------

const CELL = 14;

/** Rails run on a coarse grid along the iso axes. Streets are cheap, other
 *  districts expensive, turns cost a little, and cells an earlier rail used
 *  cost a little more so parallel connections spread across streets. */
export function createRouter(obstacles: { id: string; rect: Rect }[]) {
  const min = -EDGE, max = BOARD + EDGE;
  const size = Math.ceil((max - min) / CELL);
  const owner = new Array<string | null>(size * size).fill(null);
  const used = new Uint16Array(size * size);
  const center = (i: number): Point => [min + (i + 0.5) * CELL, min + (i + 0.5) * CELL];
  for (let gx = 0; gx < size; gx += 1) for (let gy = 0; gy < size; gy += 1) {
    const x = center(gx)[0], y = center(gy)[0];
    const hit = obstacles.find(each => contains(each.rect, x, y));
    if (hit) owner[gx * size + gy] = hit.id;
  }
  const cellOf = (p: Point) => [Math.max(0, Math.min(size - 1, Math.floor((p[0] - min) / CELL))), Math.max(0, Math.min(size - 1, Math.floor((p[1] - min) / CELL)))];
  const DIRS: Point[] = [[1, 0], [-1, 0], [0, 1], [0, -1]];

  function route(from: { point: Point; plate?: Rect }, to: { point: Point; plate?: Rect }, a: string, b: string): Point[] {
    const [sx, sy] = cellOf(from.point), [tx, ty] = cellOf(to.point);
    const states = size * size * 4;
    const dist = new Float64Array(states).fill(Infinity);
    const prev = new Int32Array(states).fill(-1);
    const heap = new MinHeap();
    for (let d = 0; d < 4; d += 1) { const s = (sx * size + sy) * 4 + d; dist[s] = 0; heap.push(s, 0); }
    let goal = -1;
    while (heap.size) {
      const [state, cost] = heap.pop();
      if (cost > dist[state]) continue;
      const cell = state >> 2, dir = state & 3, gx = Math.floor(cell / size), gy = cell % size;
      if (gx === tx && gy === ty) { goal = state; break; }
      for (let d = 0; d < 4; d += 1) {
        const nx = gx + DIRS[d][0], ny = gy + DIRS[d][1];
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const ni = nx * size + ny;
        const occupant = owner[ni];
        const inside = occupant !== null && occupant !== a && occupant !== b;
        const x = center(nx)[0], y = center(ny)[0];
        const offBoard = x < 0 || y < 0 || x > BOARD || y > BOARD;
        const step = (inside ? 30 : offBoard ? 2 : 1) + Math.min(6, used[ni]) * 0.6 + (d !== dir ? 3 : 0);
        const next = ni * 4 + d;
        if (cost + step < dist[next]) { dist[next] = cost + step; prev[next] = state; heap.push(next, cost + step); }
      }
    }
    const cells: Point[] = [];
    for (let s = goal; s >= 0; s = prev[s]) { const cell = s >> 2; cells.push([Math.floor(cell / size), cell % size]); }
    cells.reverse();
    for (const [gx, gy] of cells) used[gx * size + gy] += 1;
    let points = cells.map(([gx, gy]) => [center(gx)[0], center(gy)[0]] as Point);
    if (points.length < 2) points = [from.point, to.point];
    points = trimToPlate(points, from.plate);
    points = trimToPlate(points.reverse(), to.plate).reverse();
    return simplify(points);
  }
  return { route };
}

/** Drops the run inside a plate and starts the rail at the plate's edge: a
 *  port, so rails live on the streets and stop at the district they serve. */
function trimToPlate(points: Point[], plate?: Rect): Point[] {
  if (!plate) return points;
  let i = 0;
  while (i < points.length - 1 && contains(plate, points[i + 1][0], points[i + 1][1])) i += 1;
  if (i >= points.length - 1) return points;
  const p = points[i], q = points[i + 1];
  let port: Point;
  if (Math.abs(q[0] - p[0]) > Math.abs(q[1] - p[1])) port = [q[0] > p[0] ? plate.x + plate.width : plate.x, p[1]];
  else port = [p[0], q[1] > p[1] ? plate.y + plate.height : plate.y];
  return [port, ...points.slice(i + 1)];
}

/** Removes collinear points; the result alternates axis-aligned segments. */
export function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && out[out.length - 1][0] === p[0] && out[out.length - 1][1] === p[1]) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2], b = out[out.length - 1];
      if ((a[0] === b[0] && b[0] === p[0]) || (a[1] === b[1] && b[1] === p[1])) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** An L-shaped ground path between two points, x first: file imports drawn
 *  along the same iso axes as the rails. */
export function elbow(from: Point, to: Point): Point[] {
  return simplify([from, [to[0], from[1]], to]);
}

export function polylineLength(points: Point[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i += 1) length += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  return length;
}

/** The point a share `t` of the way along a polyline: where a rail's label
 *  sits, pushed toward the far end so labels fan out to their destinations. */
export function pointAlong(points: Point[], t: number): Point {
  if (!points.length) return [0, 0];
  let remaining = polylineLength(points) * Math.max(0, Math.min(1, t));
  for (let i = 1; i < points.length; i += 1) {
    const length = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    if (remaining <= length && length > 0) {
      const f = remaining / length;
      return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * f, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * f];
    }
    remaining -= length;
  }
  return points[points.length - 1];
}

/** A bounded label: at most `max` names, then "+n". */
export function crossingLabel(names: string[], max = 3, chars = 34): string {
  const shown: string[] = [];
  for (const name of names) {
    if (shown.length >= max || [...shown, name].join(", ").length > chars) break;
    shown.push(name);
  }
  const rest = names.length - shown.length;
  if (!shown.length && names.length) return `${names[0].slice(0, chars - 1)}…${rest > 1 ? ` +${rest - 1}` : ""}`;
  return `${shown.join(", ")}${rest > 0 ? ` +${rest}` : ""}`;
}

/** Greedy, order-preserving placement: a box that overlaps an earlier one is
 *  dropped. The caller orders by importance. */
export function placeLabels<T extends { x: number; y: number; width: number; height: number }>(boxes: T[], limit: number): T[] {
  const kept: T[] = [];
  for (const box of boxes) {
    if (kept.length >= limit) break;
    const overlaps = kept.some(other => Math.abs(other.x - box.x) * 2 < other.width + box.width + 6 && Math.abs(other.y - box.y) * 2 < other.height + box.height + 4);
    if (!overlaps) kept.push(box);
  }
  return kept;
}

class MinHeap {
  private keys: number[] = [];
  private values: number[] = [];
  get size() { return this.keys.length; }
  push(key: number, value: number) {
    const keys = this.keys, values = this.values;
    let i = keys.length; keys.push(key); values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (values[parent] <= value) break;
      keys[i] = keys[parent]; values[i] = values[parent]; i = parent;
    }
    keys[i] = key; values[i] = value;
  }
  pop(): [number, number] {
    const keys = this.keys, values = this.values;
    const top: [number, number] = [keys[0], values[0]];
    const lastKey = keys.pop()!, lastValue = values.pop()!;
    if (keys.length) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1, r = l + 1;
        let m = i, mv = lastValue;
        if (l < keys.length && values[l] < mv) { m = l; mv = values[l]; }
        if (r < keys.length && values[r] < mv) { m = r; mv = values[r]; }
        if (m === i) break;
        keys[i] = keys[m]; values[i] = values[m]; i = m;
      }
      keys[i] = lastKey; values[i] = lastValue;
    }
    return top;
  }
}

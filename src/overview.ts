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
/** Blocks sit on a grid like Hairline's Terrain: a 14-unit cell holding an
 *  11-unit rounded block, so neighbours read as one surface, not sticks. */
export const PITCH = 14;
export const BLOCK = 11;
const CRATE = 12;
/** Clear ground between the figure's pad and the first ring of blocks. */
const PLAZA_GAP = 8;
/** Full block height: about a figure's base, never towering over it. */
export const HEIGHT_MAX = 22;
export const HEIGHT_MIN = 3;
/** At rest every block is pressed down to this share of its full height. */
export const REST_SHARE = 0.45;
/** Files under this many lines are too small to read as a block; they join
 *  the part's crate. */
export const SMALL_LINES = 20;
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

/** A rounded rectangle's outline on the ground, counter-clockwise from its
 *  first corner's arc, `steps` segments per corner. */
export function roundedRing(rect: Rect, radius: number, steps = 3): Point[] {
  const r = Math.max(0, Math.min(radius, rect.width / 2, rect.height / 2));
  const x0 = rect.x, y0 = rect.y, x1 = rect.x + rect.width, y1 = rect.y + rect.height;
  const centres: [number, number, number][] = [[x1 - r, y1 - r, 0], [x0 + r, y1 - r, 90], [x0 + r, y0 + r, 180], [x1 - r, y0 + r, 270]];
  const ring: Point[] = [];
  for (const [cx, cy, start] of centres) for (let k = 0; k <= steps; k += 1) {
    const a = (start + 90 * k / steps) * Math.PI / 180;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return ring;
}

/** A Terrain-style block: a rounded prism whose silhouette is the hull of its
 *  top and base, with one crease along the near run of a slightly inset top. */
export function isoBlock(cam: IsoCamera, rect: Rect, z0: number, z1: number, radius = 1.6, bevel = 0.7) {
  const ring = roundedRing(rect, radius);
  const sil = convexHull(ring.map(([x, y]) => isoProject(cam, x, y, z1)).concat(ring.map(([x, y]) => isoProject(cam, x, y, z0))));
  const inner = roundedRing({ x: rect.x + bevel, y: rect.y + bevel, width: rect.width - bevel * 2, height: rect.height - bevel * 2 }, Math.max(0.3, radius - bevel));
  const projected = inner.map(([x, y]) => isoProject(cam, x, y, z1));
  // The near run: from the leftmost to the rightmost screen point, the way
  // round that passes the point nearest the viewer.
  let left = 0, right = 0, near = 0;
  projected.forEach((p, i) => {
    if (p[0] < projected[left][0]) left = i;
    if (p[0] > projected[right][0]) right = i;
    if (isoDepth(cam.az, inner[i][0], inner[i][1]) > isoDepth(cam.az, inner[near][0], inner[near][1])) near = i;
  });
  const n = projected.length, run: Point[] = [];
  const within = (from: number, to: number, i: number) => ((i - from + n) % n) <= ((to - from + n) % n);
  const [a, b] = within(left, right, near) ? [left, right] : [right, left];
  for (let i = a; ; i = (i + 1) % n) { run.push(projected[i]); if (i === b) break; }
  return { silhouette: closedPath(sil), crease: openPath(run) };
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
  /** Full height, shown when its part is pointed at or the board is zoomed in. */
  height: number;
  /** Height at rest: the same order, pressed into a gentle terrain. */
  rest: number;
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
  /** file id → block id (aggregated files map to their district's crate). */
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
  // Room for the pad, the label strip and two rings of blocks around it.
  const lotFloor = (padSize + MARGIN * 2 + STREET + PLAZA_GAP * 2 + PITCH * 4) ** 2;
  const areas = flooredAreas(weights, BOARD * BOARD, lotFloor);
  const lots = packTreemap(districtIds.map((id, i) => ({ id, area: areas[i] })), BOARD, BOARD);

  const maxWeight = Math.max(1, ...product.map(weightOf));
  const heightOf = blockHeight(maxWeight);
  const small = (file: RepositoryNode) => weightOf(file) < SMALL_LINES;
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
    const field = inset(plate, MARGIN);
    // Cells ring the plaza where the figure stands, nearest first. The largest
    // files take the inner rings, so a part reads as one compact rise around
    // its figure that falls away outward: no stragglers at the plate's edge.
    // The hatched lot has no figure: its blocks gather round its centre.
    const cells = plazaCells(field, id === GAP_ID ? { x: cx, y: cy, width: 0, height: 0 } : pad);
    const files = [...groups.get(id)!].sort((a, b) => weightOf(b) - weightOf(a) || a.id.localeCompare(b.id));
    const readable = files.filter(file => !small(file)).length;
    const quota = Math.max(1, Math.round(maxPillars * files.length / Math.max(1, totalFiles)));
    const slots = Math.min(cells.length, quota, files.length);
    const singles = Math.min(readable, files.length > slots ? slots - 1 : slots);
    const shown = files.slice(0, Math.max(0, singles));
    const list: OverviewPillar[] = [];
    const block = (cell: Point, size: number) => ({ x: cell[0], y: cell[1], size });
    shown.forEach((file, i) => {
      const height = heightOf(weightOf(file));
      list.push({ id: file.id, district: id, fileIds: [file.id], ...block(cells[i], BLOCK), height, rest: restHeight(height), weight: weightOf(file), aggregate: false });
    });
    const rest = files.slice(shown.length);
    if (rest.length) {
      // The crate takes the next cell; with no cell free it sits in the
      // field's nearest corner to the plaza, still clear of every edge.
      const at: Point = cells[shown.length] ?? [Math.max(field.x + CRATE / 2, Math.min(field.x + field.width - CRATE / 2, pad.x - CRATE / 2)), Math.max(field.y + CRATE / 2, Math.min(field.y + field.height - CRATE / 2, pad.y - CRATE / 2))];
      const weight = rest.reduce((sum, file) => sum + weightOf(file), 0);
      const height = Math.max(HEIGHT_MIN, heightOf(weight / rest.length));
      list.push({ id: `${id}::rest`, district: id, fileIds: rest.map(file => file.id), ...block(at, CRATE), height, rest: restHeight(height), weight, aggregate: true });
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

/** Full block height for a file's weight: logarithmic from SMALL_LINES
 *  (HEIGHT_MIN) to the largest file (HEIGHT_MAX), so it is monotonic and
 *  capped, and a 5,000-line file stands only a few times a 50-line one. */
export function blockHeight(maxWeight: number): (weight: number) => number {
  const span = Math.log(Math.max(SMALL_LINES * 2, maxWeight) / SMALL_LINES);
  return weight => HEIGHT_MIN + (HEIGHT_MAX - HEIGHT_MIN) * Math.max(0, Math.min(1, Math.log(Math.max(1, weight) / SMALL_LINES) / span));
}

export const restHeight = (height: number) => Math.max(1.5, height * REST_SHARE);

/** Grid cell centres around the plaza, nearest ring first and clockwise
 *  within a ring. The grid is centred on the pad, and a cell is kept only if
 *  its whole block (CRATE, the larger) lies inside `field` and clear of the
 *  pad by PLAZA_GAP. */
export function plazaCells(field: Rect, pad: Rect): Point[] {
  const [cx, cy] = rectCenter(pad);
  const half = CRATE / 2, reachX = pad.width / 2 + PLAZA_GAP, reachY = pad.height / 2 + PLAZA_GAP;
  // Of the two symmetric grids (a cell on the pad's centre line, or a street
  // on it), take the one whose first ring hugs the plaza closest.
  const waste = (o: number) => { const edge = reachX + half - o; return Math.ceil(edge / PITCH - 1e-9) * PITCH - edge; };
  const offset = waste(0) <= waste(PITCH / 2) ? 0 : PITCH / 2;
  const cells: { p: Point; ring: number; angle: number }[] = [];
  const steps = (lo: number, hi: number, c: number) => {
    const out: number[] = [];
    for (let v = c + offset - Math.ceil((c - lo) / PITCH + 1) * PITCH; v <= hi; v += PITCH) if (v - half >= lo - 1e-6 && v + half <= hi + 1e-6) out.push(v);
    return out;
  };
  for (const x of steps(field.x, field.x + field.width, cx)) for (const y of steps(field.y, field.y + field.height, cy)) {
    const dx = Math.abs(x - cx) - reachX - half, dy = Math.abs(y - cy) - reachY - half;
    if (dx < -1e-6 && dy < -1e-6) continue;
    const ring = Math.max(0, Math.floor(Math.max(dx, dy) / PITCH + 1e-6));
    cells.push({ p: [x, y], ring, angle: Math.atan2(y - cy, x - cx) });
  }
  return cells.sort((a, b) => a.ring - b.ring || a.angle - b.angle).map(cell => cell.p);
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

import { ACTOR_ROLES, type Story, type StoryActor, type StoryFlow } from "./model.ts";
import { flowKey, wrapText } from "./journey.ts";

export type Point = [number, number];
export type LabelAnchor = "below" | "above" | "right";
export interface Station {
  actor: StoryActor;
  x: number;
  y: number;
  /** Where the name sits relative to the dot, chosen to keep routes off it. */
  anchor: LabelAnchor;
  /** The name wrapped as the view draws it. */
  lines: string[];
}
/** A flow drawn as a metro line: horizontal, vertical and 45° runs only. */
export interface TransitRoute { flow: StoryFlow; points: Point[]; d: string }
interface Box { left: number; right: number; top: number; bottom: number }

/** Label geometry the view must match: `gap` px from the dot centre to the
 *  label's near edge, `lineHeight` per wrapped line, at most `width` wide. */
export const STATION_LABEL = { chars: 26, maxLines: 3, lineHeight: 18, gap: 14, width: 156, charWidth: 7 } as const;
const COLUMN_GAP = 180;
const ROW_GAP = 108;
const GUTTER = COLUMN_GAP / 2;
const CORNER = 24;
const HEADING_BOTTOM = 36;
const DOT = 10;

export function buildTransitLayout(story: Story) {
  const roles = ACTOR_ROLES.filter(role => story.actors.some(actor => actor.role === role));
  const rows = Math.max(1, ...roles.map(role => story.actors.filter(actor => actor.role === role).length));
  const height = Math.max(380, rows * ROW_GAP + 100);
  const width = Math.max(700, roles.length * COLUMN_GAP + 40);
  const columns = roles.map((role, i) => ({ role, x: 110 + i * COLUMN_GAP }));
  const stations: Station[] = [];
  for (const column of columns) {
    const actors = story.actors.filter(actor => actor.role === column.role);
    for (const [index, actor] of actors.entries()) {
      stations.push({ actor, x: column.x, y: 84 + index * ROW_GAP + (rows - actors.length) * (ROW_GAP / 2), anchor: "below",
        lines: wrapText(actor.name, STATION_LABEL.chars, STATION_LABEL.maxLines) });
    }
  }
  const byId = new Map(stations.map(station => [station.actor.id, station]));
  const bounds: Box = { left: 8, right: width - 8, top: HEADING_BOTTOM + 8, bottom: height - 8 };
  const ys = [...new Set(stations.map(station => station.y))].sort((a, b) => a - b);
  const lanes = [...new Set([...ys, ...ys.slice(1).map((y, i) => (ys[i] + y) / 2), ys[0] - ROW_GAP / 2, ys[ys.length - 1] + ROW_GAP / 2])]
    .filter(y => y >= bounds.top + 12 && y <= bounds.bottom);

  // Two rounds. First every label is assumed below and an end's own label
  // only weighs lightly, since it can still move; labels then move off the
  // routes. Second, routes are laid again against the labels where they now
  // sit, and the labels settle once more. Story order breaks every tie.
  let routes = new Map<string, TransitRoute>();
  for (const settled of [false, true]) {
    routes = new Map();
    const laid: [Point, Point][] = [];
    for (const flow of story.flows) {
      const key = flowKey(flow);
      const a = byId.get(flow.from); const b = byId.get(flow.to);
      if (!a || !b || a === b || routes.has(key)) continue;
      let best: Point[] = []; let bestScore = Number.POSITIVE_INFINITY;
      for (const candidate of routeCandidates(a, b, lanes)) {
        const score = routeScore(candidate, a, b, stations, laid, bounds, settled);
        if (score < bestScore) { best = candidate; bestScore = score; }
      }
      routes.set(key, { flow, points: best, d: pathData(best) });
      laid.push(...segments(best));
    }
    placeLabels(stations, routes, width, height);
  }
  return { width, height, columns, stations, byId, routes };
}
export type TransitLayout = ReturnType<typeof buildTransitLayout>;

/** Each label takes the first anchor (below, above, right) that crosses the
 *  fewest routes, dots and earlier labels and stays inside the field. */
function placeLabels(stations: Station[], routes: Map<string, TransitRoute>, width: number, height: number) {
  const chosen: Box[] = [];
  for (const station of stations) {
    let bestScore = Number.POSITIVE_INFINITY;
    for (const [preference, anchor] of (["below", "above", "right"] as const).entries()) {
      const box = labelBox({ ...station, anchor });
      let score = preference / 10;
      for (const route of routes.values()) if (segments(route.points).some(([p, q]) => segmentHitsBox(p, q, box))) score += 10;
      for (const other of stations) if (other !== station && boxesOverlap(box, dotBox(other))) score += 100;
      for (const placed of chosen) if (boxesOverlap(box, placed)) score += 5;
      if (box.left < 0 || box.right > width || box.top < HEADING_BOTTOM || box.bottom > height) score += 100;
      if (score < bestScore) { bestScore = score; station.anchor = anchor; }
    }
    chosen.push(labelBox(station));
  }
}

/** The drawn route between two stations in the direction travelled: a flow's
 *  own route, or the reverse of the flow running the other way. */
export function transitPath(layout: TransitLayout, from: string, to: string): string | null {
  const forward = layout.routes.get(flowKey({ from, to, carries: "" }));
  if (forward) return forward.d;
  const backward = layout.routes.get(flowKey({ from: to, to: from, carries: "" }));
  return backward ? pathData([...backward.points].reverse()) : null;
}

/** The box a station's label occupies, from the estimated text width. */
export function labelBox(station: Pick<Station, "x" | "y" | "anchor" | "lines">): Box {
  const { gap, lineHeight, width, charWidth } = STATION_LABEL;
  const textWidth = Math.min(width, Math.max(0, ...station.lines.map(line => line.length)) * charWidth);
  const height = station.lines.length * lineHeight;
  if (station.anchor === "right") return { left: station.x + gap, right: station.x + gap + textWidth, top: station.y - height / 2, bottom: station.y + height / 2 };
  const top = station.anchor === "below" ? station.y + gap : station.y - gap - height;
  return { left: station.x - textWidth / 2, right: station.x + textWidth / 2, top, bottom: top + height };
}

function routeCandidates(a: Station, b: Station, lanes: number[]): Point[][] {
  const A: Point = [a.x, a.y]; const B: Point = [b.x, b.y];
  const sy = Math.sign(b.y - a.y); const dy = Math.abs(b.y - a.y);
  const candidates: Point[][] = [];
  if (a.x === b.x) {
    // Same column: straight down the column, or out to a gutter and back.
    candidates.push([A, B]);
    const corner = Math.min(CORNER, dy / 2);
    for (const side of [1, -1]) {
      const g = a.x + side * GUTTER;
      candidates.push([A, [g - side * corner, a.y], [g, a.y + sy * corner], [g, b.y - sy * corner], [g - side * corner, b.y], B]);
    }
    return candidates.map(simplify);
  }
  const sx = Math.sign(b.x - a.x); const dx = Math.abs(b.x - a.x);
  // Diagonal out to a horizontal lane, along it, and diagonal in.
  for (const lane of lanes) {
    const out = Math.abs(lane - a.y); const inward = Math.abs(lane - b.y);
    if (out + inward <= dx) candidates.push([A, [a.x + sx * out, lane], [b.x - sx * inward, lane], B]);
  }
  if (dy <= dx) {
    const mid = (a.x + b.x) / 2;
    candidates.push([A, [mid - sx * dy / 2, a.y], [mid + sx * dy / 2, b.y], B]);
  }
  // Vertical run in the gutter beside either end, for steep or crowded hops.
  if (dy > 0) {
    const corner = Math.min(CORNER, dy / 2);
    for (const g of new Set([a.x + sx * GUTTER, b.x - sx * GUTTER])) {
      candidates.push([A, [g - sx * corner, a.y], [g, a.y + sy * corner], [g, b.y - sy * corner], [g + sx * corner, b.y], B]);
    }
  }
  return candidates.map(simplify);
}

function routeScore(points: Point[], a: Station, b: Station, stations: Station[], laid: [Point, Point][], bounds: Box, settled: boolean): number {
  const own = segments(points);
  let score = own.length * 0.5;
  for (const [p, q] of own) score += Math.hypot(q[0] - p[0], q[1] - p[1]) / 200;
  if (points.some(([x, y]) => x < bounds.left || x > bounds.right || y < bounds.top || y > bounds.bottom)) score += 1000;
  for (const station of stations) {
    const label = labelBox(settled ? station : { ...station, anchor: "below" });
    const hitsLabel = own.some(([p, q]) => segmentHitsBox(p, q, label));
    if (station === a || station === b) { if (hitsLabel) score += settled ? 10 : 2; continue; }
    if (own.some(([p, q]) => segmentHitsBox(p, q, dotBox(station)))) score += 1000;
    if (hitsLabel) score += 10;
  }
  for (const [p, q] of own) {
    for (const [r, s] of laid) {
      if (collinearOverlap(p, q, r, s)) score += 6;
      else if (properCrossing(p, q, r, s)) score += 0.5;
    }
  }
  return score;
}

function pathData(points: Point[]): string {
  return points.map(([x, y], index) => `${index ? "L" : "M"} ${x} ${y}`).join(" ");
}

/** Drops repeated points and merges runs that continue in one direction. */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const point of points) {
    const last = out[out.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1]) continue;
    const before = out[out.length - 2];
    if (before && last && direction(before, last) === direction(last, point)) out[out.length - 1] = point;
    else out.push(point);
  }
  return out;
}

function direction(p: Point, q: Point): string {
  return `${Math.sign(q[0] - p[0])},${Math.sign(q[1] - p[1])}`;
}

function segments(points: Point[]): [Point, Point][] {
  return points.slice(1).map((point, index) => [points[index], point]);
}

function dotBox(station: Station): Box {
  return { left: station.x - DOT, right: station.x + DOT, top: station.y - DOT, bottom: station.y + DOT };
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Liang–Barsky clip: does segment p→q touch the box? */
function segmentHitsBox(p: Point, q: Point, box: Box): boolean {
  const dx = q[0] - p[0]; const dy = q[1] - p[1];
  let t0 = 0; let t1 = 1;
  for (const [edge, distance] of [[-dx, p[0] - box.left], [dx, box.right - p[0]], [-dy, p[1] - box.top], [dy, box.bottom - p[1]]]) {
    if (edge === 0) { if (distance < 0) return false; continue; }
    const t = distance / edge;
    if (edge < 0) { if (t > t1) return false; t0 = Math.max(t0, t); }
    else { if (t < t0) return false; t1 = Math.min(t1, t); }
  }
  return true;
}

function cross(o: Point, p: Point, q: Point): number {
  return (p[0] - o[0]) * (q[1] - o[1]) - (p[1] - o[1]) * (q[0] - o[0]);
}

function collinearOverlap(p: Point, q: Point, r: Point, s: Point): boolean {
  if (Math.abs(cross(p, q, r)) > 1e-6 || Math.abs(cross(p, q, s)) > 1e-6) return false;
  const along = Math.abs(q[0] - p[0]) >= Math.abs(q[1] - p[1]) ? 0 : 1;
  const overlap = Math.min(Math.max(p[along], q[along]), Math.max(r[along], s[along])) - Math.max(Math.min(p[along], q[along]), Math.min(r[along], s[along]));
  return overlap > 2;
}

function properCrossing(p: Point, q: Point, r: Point, s: Point): boolean {
  const d1 = cross(r, s, p); const d2 = cross(r, s, q); const d3 = cross(p, q, r); const d4 = cross(p, q, s);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

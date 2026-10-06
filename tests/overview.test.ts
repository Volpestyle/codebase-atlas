import assert from "node:assert/strict";
import test from "node:test";
import { graph, node, story } from "./story-fixtures.ts";
import {
  BOARD, BLOCK, GAP_ID, HEIGHT_MAX, HEIGHT_MIN, SMALL_LINES, blockHeight, buildOverviewLayout, isoBlock, plazaCells, restHeight, convexHull, crossingLabel, elbow, fitCamera, flooredAreas, groundAxes,
  isoDepth, isoProject, layoutBounds, perimeterParam, perimeterPoint, plateLabel, quarterAzimuth, simplify, connectionGroups, railArrows, spanAt, wrapName,
  type IsoCamera, type OverviewConnection,
} from "../src/overview.ts";

const cam = (az: number): IsoCamera => ({ az, k: 0.5, scale: 1, ox: 0, oy: 0 });
const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

test("the projection is Hairline's 2:1 view: +x runs down-right, +y down-left, z up", () => {
  const c = cam(quarterAzimuth(0));
  const o = isoProject(c, BOARD / 2, BOARD / 2);
  const x = isoProject(c, BOARD / 2 + 10, BOARD / 2), y = isoProject(c, BOARD / 2, BOARD / 2 + 10), z = isoProject(c, BOARD / 2, BOARD / 2, 10);
  assert.ok(x[0] > o[0] && x[1] > o[1]);
  assert.ok(y[0] < o[0] && y[1] > o[1]);
  assert.ok(close(z[0], o[0]) && z[1] < o[1]);
  // 2:1: a ground step moves twice as far across as down.
  assert.ok(close((x[0] - o[0]) / (x[1] - o[1]), 2));
  // The corner with the largest x and y is nearest.
  assert.ok(isoDepth(45, BOARD, BOARD) > isoDepth(45, 0, 0));
});

test("a quarter turn is the board rotated 90° about its centre", () => {
  const p = [120, 340] as const;
  const turned = isoProject(cam(quarterAzimuth(1)), p[0], p[1], 7);
  // Rotating the point by -90° about the centre and viewing at the first pose lands in the same place.
  const c = BOARD / 2;
  const rotated = isoProject(cam(quarterAzimuth(0)), c - (p[1] - c), c + (p[0] - c), 7);
  assert.ok(close(turned[0], rotated[0]) && close(turned[1], rotated[1]));
});

test("fitCamera keeps every pose inside the width and a stable frame across turns", () => {
  const points = layoutBounds({ districts: [{ pillars: [{ x: 500, y: 500, height: 80 }] }], markers: [{ x: -40, y: 300 }] });
  for (let turn = 0; turn < 4; turn += 1) {
    const fitted = fitCamera(800, quarterAzimuth(turn), points);
    for (const [x, y, z] of points) {
      const [sx, sy] = isoProject(fitted, x, y, z);
      assert.ok(sx >= -1e-6 && sx <= 800 + 1e-6, `x in frame at turn ${turn}`);
      assert.ok(sy >= -1e-6 && sy <= fitted.height + 1e-6, `y in frame at turn ${turn}`);
    }
    assert.equal(fitted.scale, fitCamera(800, quarterAzimuth(0), points).scale);
  }
});

test("ground labels read rightward and down the screen after any quarter turn", () => {
  for (let turn = 0; turn < 4; turn += 1) for (const along of ["x", "y"] as const) {
    const az = quarterAzimuth(turn);
    const { read, down } = groundAxes(az, along);
    const o = isoProject(cam(az), 500, 500), r = isoProject(cam(az), 500 + read[0], 500 + read[1]), d = isoProject(cam(az), 500 + down[0], 500 + down[1]);
    assert.ok(r[0] > o[0], "reads rightward");
    assert.ok(d[1] > o[1], "down is down");
    // Not mirrored: the screen basis keeps its orientation.
    assert.ok((r[0] - o[0]) * (d[1] - o[1]) - (r[1] - o[1]) * (d[0] - o[0]) > 0);
  }
  const label = plateLabel(45, { x: 100, y: 100, width: 300, height: 120 });
  assert.equal(label.axes.read[1], 0, "the longer side carries the label");
  assert.equal(label.room, 300 - 16);
});

test("isoBox helpers: hull and simplification", () => {
  assert.deepEqual(convexHull([[0, 0], [2, 0], [1, 1], [2, 2], [0, 2]]).length, 4);
  assert.deepEqual(simplify([[0, 0], [5, 0], [10, 0], [10, 0], [10, 5], [10, 9]]), [[0, 0], [10, 0], [10, 9]]);
  assert.deepEqual(elbow([0, 0], [10, 20]), [[0, 0], [10, 0], [10, 20]]);
});

test("floored areas give small parts room for a figure and still sum to the board", () => {
  const areas = flooredAreas([1000, 10, 1], 100, 20);
  assert.ok(close(areas.reduce((a, b) => a + b, 0), 100));
  assert.ok(areas[1] >= 20 - 1e-9 && areas[2] >= 20 - 1e-9);
  assert.ok(areas[0] > areas[1]);
  assert.deepEqual(flooredAreas([], 100, 10), []);
});

test("plaza cells ring the pad, nearest first, and stay inside the field", () => {
  const field = { x: 0, y: 0, width: 200, height: 140 }, pad = { x: 70, y: 40, width: 60, height: 60 };
  const cells = plazaCells(field, pad);
  assert.ok(cells.length > 20);
  const half = 6;
  const gapTo = ([x, y]: [number, number]) => Math.max(Math.abs(x - 100) - 30, Math.abs(y - 70) - 30) - half;
  for (const [x, y] of cells) {
    assert.ok(x - half >= field.x && x + half <= field.x + field.width && y - half >= field.y && y + half <= field.y + field.height, "inside the field");
    assert.ok(gapTo([x, y]) >= 8 - 1e-6, "clear of the pad");
  }
  // Nearest ring first: the ring index (whole cells beyond the plaza gap) never falls.
  const ring = (p: [number, number]) => Math.floor((gapTo(p) - 8) / 14 + 1e-6);
  for (let i = 1; i < cells.length; i += 1) assert.ok(ring(cells[i]) >= ring(cells[i - 1]));
  assert.ok(gapTo(cells[0]) < 14, "the first ring hugs the plaza");
});

test("block heights are monotonic and capped, and rest lower", () => {
  const height = blockHeight(6000);
  let last = -Infinity;
  for (const w of [1, 10, SMALL_LINES, 30, 80, 200, 900, 3000, 6000, 50000]) {
    const h = height(w);
    assert.ok(h >= last, `monotonic at ${w}`);
    assert.ok(h >= HEIGHT_MIN && h <= HEIGHT_MAX, `capped at ${w}`);
    assert.ok(restHeight(h) < h);
    last = h;
  }
  assert.equal(height(6000), HEIGHT_MAX);
  assert.equal(height(SMALL_LINES), HEIGHT_MIN);
  assert.ok(height(3000) > height(200));
  // Strongly compressed: a hundredfold larger file is not a hundredfold taller.
  assert.ok(height(6000) / height(60) < 4);
  const box = isoBlock(cam(45), { x: 0, y: 0, width: 11, height: 11 }, 0, 10);
  assert.ok(box.silhouette.startsWith("M") && box.crease.startsWith("M"));
});

test("perimeter parameters round-trip to the nearest board edge", () => {
  assert.ok(close(perimeterParam(500, -200), 500));
  assert.ok(close(perimeterParam(1200, 500), 1500));
  const [x, y] = perimeterPoint(1500, 40);
  assert.equal(x, BOARD + 40); assert.equal(y, 500);
});

test("crossing labels are bounded and counted", () => {
  assert.equal(crossingLabel(["a", "b", "c", "d"], 3), "a, b, c +1");
  assert.equal(crossingLabel(["averyveryverylongbindingnamethatoverflows"], 3, 12), "averyveryve…");
});

function fixture() {
  const nodes = [
    ...Array.from({ length: 30 }, (_, i) => node(`src/app/f${String(i).padStart(2, "0")}.ts`, 10 + i * 5)),
    node("src/core.ts", 400), node("src/gap.ts", 50), node("src/gap2.ts", 20), node("tests/app.test.ts", 90),
  ];
  return graph(nodes, [
    { source: "src/app/f00.ts", target: "src/core.ts", kind: "imports", symbols: ["work", "Job"] },
    { source: "src/app/f01.ts", target: "src/core.ts", kind: "imports", symbols: ["work"] },
    { source: "src/core.ts", target: "src/gap.ts", kind: "imports", symbols: ["helper"] },
    { source: "src/app/f02.ts", target: "src/app/f03.ts", kind: "imports" },
    { source: "tests/app.test.ts", target: "src/core.ts", kind: "imports" },
  ]);
}

test("districts are parts that own product source, plus the hatched gap; people stand at the edge", () => {
  const layout = buildOverviewLayout(fixture());
  assert.deepEqual(layout.districts.map(d => d.id), ["app", "core", GAP_ID]);
  assert.deepEqual(layout.markers.map(m => m.actorId), ["user"]);
  const [app, core, gap] = layout.districts;
  assert.equal(app.files, 30); assert.equal(core.files, 1); assert.equal(gap.files, 2);
  assert.equal(layout.totalFiles, 33, "tests are not product source");
  // Lots tile the board without overlap, and the larger part gets more room.
  const area = (r: { width: number; height: number }) => r.width * r.height;
  assert.ok(close(layout.districts.reduce((sum, d) => sum + area(d.lot), 0), BOARD * BOARD, 1e-3));
  assert.ok(area(app.lot) > area(gap.lot));
  // Every figure pad is the same size and sits on its plate.
  for (const d of layout.districts) {
    assert.equal(d.pad.width, layout.padSize);
    assert.ok(d.pad.x >= d.plate.x && d.pad.x + d.pad.width <= d.plate.x + d.plate.width);
  }
  // The person stands off the plate.
  const [m] = layout.markers;
  assert.ok(m.x < 0 || m.y < 0 || m.x > BOARD || m.y > BOARD);
});

test("blocks are capped: the largest files stand, small and overflow files stack in one crate per part", () => {
  const layout = buildOverviewLayout(fixture(), 12);
  const app = layout.districts.find(d => d.id === "app")!;
  const crate = app.pillars.find(p => p.aggregate)!;
  const singles = app.pillars.filter(p => !p.aggregate);
  assert.ok(crate, "a crate holds the rest");
  assert.equal(singles.length + crate.fileIds.length, 30);
  // The shown files are the largest ones.
  const smallestShown = Math.min(...singles.map(p => p.weight));
  assert.ok(crate.fileIds.every(id => Number(id.match(/f(\d+)/)![1]) * 5 + 10 <= smallestShown));
  assert.ok(layout.pillars.size <= 12 + layout.districts.length);
  // Every product file maps to the block that stands for it.
  for (const d of layout.districts) for (const p of d.pillars) for (const f of p.fileIds) assert.equal(layout.pillarOfFile.get(f), p.id);
  const byWeight = [...singles].sort((a, b) => a.weight - b.weight);
  assert.ok(byWeight[0].height <= byWeight[byWeight.length - 1].height);
});

test("files too small to read join the crate, even with room to spare", () => {
  const layout = buildOverviewLayout(fixture());
  const app = layout.districts.find(d => d.id === "app")!;
  const crate = app.pillars.find(p => p.aggregate)!;
  // f00 (10 lines) and f01 (15) are under SMALL_LINES.
  assert.deepEqual([...crate.fileIds].sort(), ["src/app/f00.ts", "src/app/f01.ts"]);
  assert.ok(app.pillars.filter(p => !p.aggregate).every(p => p.weight >= SMALL_LINES));
  // A part of only small files is just its crate.
  const gap = layout.districts.find(d => d.id === GAP_ID)!;
  assert.ok(gap.pillars.every(p => p.aggregate || p.weight >= SMALL_LINES));
});

test("no block leaves its plate's field, touches the pad, or exceeds the cap", () => {
  for (const max of [12, 360]) {
    const layout = buildOverviewLayout(fixture(), max);
    for (const d of layout.districts) for (const p of d.pillars) {
      const half = p.size / 2;
      // Inside the plate with the label margin to spare, so nothing stands on a border.
      assert.ok(p.x - half >= d.plate.x + 20 - 1e-6 && p.x + half <= d.plate.x + d.plate.width - 20 + 1e-6, `${p.id} x inside`);
      assert.ok(p.y - half >= d.plate.y + 20 - 1e-6 && p.y + half <= d.plate.y + d.plate.height - 20 + 1e-6, `${p.id} y inside`);
      const clear = p.x + half <= d.pad.x || p.x - half >= d.pad.x + d.pad.width || p.y + half <= d.pad.y || p.y - half >= d.pad.y + d.pad.height;
      // The hatched lot has no figure, so its blocks may gather on its pad.
      assert.ok(clear || d.id === GAP_ID, `${p.id} off the pad`);
      assert.ok(p.height <= HEIGHT_MAX && p.rest < p.height);
      if (!p.aggregate) assert.equal(p.size, BLOCK);
    }
    // Blocks never overlap one another.
    const all = layout.districts.flatMap(d => d.pillars);
    for (let i = 0; i < all.length; i += 1) for (let j = i + 1; j < all.length; j += 1) {
      const a = all[i], b = all[j];
      assert.ok(Math.abs(a.x - b.x) * 2 >= a.size + b.size - 1e-6 || Math.abs(a.y - b.y) * 2 >= a.size + b.size - 1e-6, `${a.id} vs ${b.id}`);
    }
  }
});

test("connections aggregate product imports between parts and written flows", () => {
  const layout = buildOverviewLayout(fixture());
  const find = (a: string, b: string) => layout.connections.find(c => (c.a === a && c.b === b) || (c.a === b && c.b === a));
  const appCore = find("app", "core")!;
  assert.equal(appCore.imports, 2);
  assert.deepEqual(appCore.names, ["Job", "work"]);
  assert.deepEqual(appCore.flows.map(f => f.carries), ["the work"]);
  // The packet follows the written flow, app → core.
  assert.equal(appCore.forward, appCore.a === "app");
  assert.equal(find("core", GAP_ID)!.imports, 1);
  assert.equal(find("user", "app")!.flows.length, 1);
  // Imports inside one part and from tests are not connections.
  assert.equal(layout.connections.filter(c => c.a === c.b).length, 0);
  assert.equal(layout.fileImports.get("src/app/f02.ts")?.[0], "src/app/f03.ts");
  assert.equal(layout.fileImports.has("tests/app.test.ts"), false);
  // Without imports, only written flows remain.
  const flat = buildOverviewLayout({ ...fixture(), stats: { ...fixture().stats, importsAvailable: false } });
  assert.ok(flat.connections.every(c => c.imports === 0 && c.flows.length > 0));
});

test("rails run along the iso axes, from plate edge to plate edge", () => {
  const layout = buildOverviewLayout(fixture());
  for (const c of layout.connections) {
    assert.ok(c.rail.length >= 2);
    for (let i = 1; i < c.rail.length; i += 1) {
      const [a, b] = [c.rail[i - 1], c.rail[i]];
      assert.ok(close(a[0], b[0]) || close(a[1], b[1]), `axis-aligned segment in ${c.key}`);
    }
  }
  const appCore = layout.connections.find(c => c.a === "app" && c.b === "core" || c.a === "core" && c.b === "app")!;
  const plates = new Map(layout.districts.map(d => [d.id, d.plate]));
  const onEdge = (p: [number, number], r: { x: number; y: number; width: number; height: number }) =>
    (close(p[0], r.x) || close(p[0], r.x + r.width) || close(p[1], r.y) || close(p[1], r.y + r.height))
    && p[0] >= r.x - 1e-6 && p[0] <= r.x + r.width + 1e-6 && p[1] >= r.y - 1e-6 && p[1] <= r.y + r.height + 1e-6;
  assert.ok(onEdge(appCore.rail[0], plates.get(appCore.a)!), "starts at a port");
  assert.ok(onEdge(appCore.rail[appCore.rail.length - 1], plates.get(appCore.b)!), "ends at a port");
});

test("without a story every product file stands in the gap lot", () => {
  const layout = buildOverviewLayout({ ...fixture(), story: undefined as unknown as typeof story });
  assert.deepEqual(layout.districts.map(d => d.id), [GAP_ID]);
  assert.equal(layout.markers.length, 0);
});

test("connections split by direction: what a part takes from and what uses it", () => {
  const layout = buildOverviewLayout(fixture());
  const appCore = layout.connections.find(c => (c.a === "app" && c.b === "core") || (c.a === "core" && c.b === "app"))!;
  const appSide = appCore.a === "app" ? appCore.ab : appCore.ba;
  assert.deepEqual(appSide, { imports: 2, names: ["Job", "work"] }, "app imports core");
  assert.deepEqual((appCore.a === "app" ? appCore.ba : appCore.ab).imports, 0);

  // Core imports the gap and is imported by app; the story's written flow
  // brings the work from app into core. So app appears in both groups.
  const core = connectionGroups(layout.connections, "core");
  assert.deepEqual(core.takes.map(row => [row.other, row.label, row.written]), [["app", "the work", true], [GAP_ID, "helper", false]]);
  assert.deepEqual(core.uses.map(row => [row.other, row.label, row.written]), [["app", "Job, work", false]]);
  assert.ok(core.takes.every(row => row.direction === "in") && core.uses.every(row => row.direction === "out"));
  assert.notEqual(core.takes[0].key, core.uses[0].key, "one row per direction");

  const app = connectionGroups(layout.connections, "app");
  assert.deepEqual(app.takes.map(row => row.other).sort(), ["core", "user"]);
  assert.equal(app.takes.find(row => row.other === "core")!.label, "Job, work");
  assert.equal(app.takes.find(row => row.other === "user")!.label, "a request");
  assert.deepEqual(app.uses.map(row => [row.other, row.label]), [["core", "the work"]]);

  // Rails are oriented the way things travel: into the focused part for
  // "takes from", out of it for "used by".
  const plates = new Map(layout.districts.map(d => [d.id, d.plate]));
  const onPlate = (p: [number, number], id: string) => { const r = plates.get(id)!; return p[0] >= r.x - 1e-6 && p[0] <= r.x + r.width + 1e-6 && p[1] >= r.y - 1e-6 && p[1] <= r.y + r.height + 1e-6; };
  const inbound = core.takes.find(row => row.other === GAP_ID)!.rail;
  assert.ok(onPlate(inbound[inbound.length - 1], "core") && onPlate(inbound[0], GAP_ID));
  const outbound = core.uses[0].rail;
  assert.ok(onPlate(outbound[0], "core") && onPlate(outbound[outbound.length - 1], "app"));
  // A part with no connections has empty groups.
  assert.deepEqual(connectionGroups(layout.connections, "nobody"), { takes: [], uses: [] });
});

test("connection rows bound their crossing names and fall back to the written flow", () => {
  const base: OverviewConnection = { key: "x\u0000y", a: "x", b: "y", imports: 3, names: [], ab: { imports: 3, names: ["Alpha", "Beta", "Gamma", "Delta", "Epsilon"] }, ba: { imports: 0, names: [] }, flows: [{ from: "y", to: "x", carries: "a long sentence about what travels" }], forward: true, rail: [[0, 0], [10, 0]] };
  const x = connectionGroups([base], "x", 3, 40);
  assert.equal(x.takes.length, 1);
  assert.equal(x.takes[0].label, "Alpha, Beta, Gamma +2");
  assert.equal(x.takes[0].written, false);
  assert.deepEqual(x.takes[0].flows, ["a long sentence about what travels"]);
  assert.equal(x.uses.length, 0);
  assert.deepEqual(x.takes[0].rail, [[10, 0], [0, 0]]);
  // Seen from y: x uses y; names, not the flow (which arrives at x), label the row.
  const y = connectionGroups([base], "y", 2, 12);
  assert.equal(y.takes.length, 0, "the flow leaves y");
  assert.equal(y.uses[0].label, "Alpha, Beta +3");
  assert.deepEqual(y.uses[0].flows, ["a long sentence about what travels"]);
  // Imports with no named bindings and no flow: the row stands with no label.
  const bare = connectionGroups([{ ...base, ab: { imports: 1, names: [] }, flows: [] }], "x");
  assert.equal(bare.takes[0].label, "");
});

test("rail chevrons point the way the rail runs and stay off its ends", () => {
  const arrows = railArrows([[0, 0], [100, 0]], 40, 20);
  assert.deepEqual(arrows.map(a => [a.x, a.y, a.angle]), [[20, 0, 0], [60, 0, 0]]);
  const back = railArrows([[100, 0], [0, 0]], 40, 20);
  assert.ok(back.every(a => Math.abs(Math.abs(a.angle) - 180) < 1e-9));
  const turn = railArrows([[0, 0], [10, 0], [10, 50]], 30, 20);
  assert.ok(close(turn[0].x, 10) && close(turn[0].y, 10) && close(turn[0].angle, 90));
  // Too short for the spacing: one chevron at the middle.
  assert.deepEqual(railArrows([[0, 0], [8, 0]], 40).map(a => a.x), [4]);
  assert.deepEqual(railArrows([[0, 0]], 40), []);
});

test("the focused name fits across its plate: span and wrapping", () => {
  const diamond: [number, number][] = [[0, -10], [20, 0], [0, 10], [-20, 0]];
  assert.deepEqual(spanAt(diamond, 0), [-20, 20]);
  assert.deepEqual(spanAt(diamond, 5), [-10, 10]);
  assert.equal(spanAt(diamond, 20), null);
  assert.deepEqual(wrapName("The native-worker connection", 30), ["The native-worker connection"]);
  assert.deepEqual(wrapName("The native-worker connection", 20), ["The native-worker", "connection"]);
  assert.deepEqual(wrapName("The native-worker connection", 10), ["The", "native-wo…"]);
  assert.deepEqual(wrapName("Supercalifragilistic", 8, 1), ["Superca…"]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { graph, node, story } from "./story-fixtures.ts";
import {
  BOARD, GAP_ID, blockCells, buildOverviewLayout, convexHull, crossingLabel, elbow, fitCamera, flooredAreas, groundAxes,
  isoDepth, isoProject, layoutBounds, perimeterParam, perimeterPoint, placeLabels, plateLabel, pointAlong, quarterAzimuth, simplify,
  type IsoCamera,
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
  assert.deepEqual(pointAlong([[0, 0], [10, 0], [10, 10]], 0.75), [10, 5]);
});

test("floored areas give small parts room for a figure and still sum to the board", () => {
  const areas = flooredAreas([1000, 10, 1], 100, 20);
  assert.ok(close(areas.reduce((a, b) => a + b, 0), 100));
  assert.ok(areas[1] >= 20 - 1e-9 && areas[2] >= 20 - 1e-9);
  assert.ok(areas[0] > areas[1]);
  assert.deepEqual(flooredAreas([], 100, 10), []);
});

test("block cells snake along the longer side and skip the plaza", () => {
  const cells = blockCells({ x: 0, y: 0, width: 90, height: 36 }, { x: 30, y: 0, width: 20, height: 36 });
  assert.ok(cells.every(([x]) => x < 30 || x > 50));
  // Row one runs left to right, row two comes back.
  assert.ok(cells[0][0] < cells[1][0]);
  const second = cells.filter(([, y]) => y > 18);
  assert.ok(second[0][0] > second[second.length - 1][0]);
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
  const kept = placeLabels([{ x: 0, y: 0, width: 40, height: 20 }, { x: 10, y: 5, width: 40, height: 20 }, { x: 200, y: 0, width: 40, height: 20 }], 5);
  assert.equal(kept.length, 2);
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

test("pillars are capped: the largest files stand, the rest stack in one crate per part", () => {
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
  // Every product file maps to the pillar that stands for it.
  for (const d of layout.districts) for (const p of d.pillars) for (const f of p.fileIds) assert.equal(layout.pillarOfFile.get(f), p.id);
  // Taller is more lines, and pillars stay inside their plate, off the pad.
  for (const p of singles) {
    assert.ok(p.x > app.plate.x && p.x < app.plate.x + app.plate.width && p.y > app.plate.y && p.y < app.plate.y + app.plate.height);
    assert.ok(!(p.x > app.pad.x && p.x < app.pad.x + app.pad.width && p.y > app.pad.y && p.y < app.pad.y + app.pad.height));
  }
  const byWeight = [...singles].sort((a, b) => a.weight - b.weight);
  assert.ok(byWeight[0].height <= byWeight[byWeight.length - 1].height);
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

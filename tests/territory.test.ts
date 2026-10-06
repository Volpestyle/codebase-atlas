import assert from "node:assert/strict";
import test from "node:test";
import { graph, node } from "./story-fixtures.ts";
import { buildTerritoryLayout, exclusiveGapSuggestions, importsArePartial, storyCoverage, territoryJourney } from "../src/territory.ts";
import { isProductSource } from "../src/sourceScope.ts";

test("coverage mirrors Rust product scope and partitions source once", () => {
  const excluded = [".claude/skills/x.ts", ".github/a.ts", "src/.hidden/a.ts", "src-tauri/gen/apple/a.rs", "vendor/a.ts", "tests/a.ts", "src/a.test.ts", "vite.config.ts", "src/build/a.ts"];
  for (const path of excluded) assert.equal(isProductSource(node(path)), false, path);
  assert.equal(isProductSource(node("src/gen/useful.ts")), true);
  const fixture = graph([node("src/app/a.ts", 60), node("src/core.ts", 20), node("src/gap.ts", 20), ...excluded.map(path => node(path, 100))]);
  const coverage = storyCoverage(fixture);
  assert.equal(coverage.total, 100); assert.equal(coverage.covered, 80);
  assert.deepEqual(coverage.parts.map(part => [part.actorId, part.percent]), [["app", 60], ["core", 20], [null, 20]]);
  assert.ok(storyCoverage({ ...fixture, stats: { ...fixture.stats, lineCountAvailable: false } }).parts.every(part => part.percent === null));
});

test("gap suggestions traverse uncovered chains, ignore tests, reject shared and orphan roots", () => {
  const fixture = graph(["src/app/a.ts", "src/core.ts", "src/chain.ts", "src/leaf.ts", "src/shared.ts", "src/orphan.ts", "tests/test.ts"].map(path => node(path)), [
    { source: "src/app/a.ts", target: "src/chain.ts", kind: "imports" },
    { source: "src/chain.ts", target: "src/leaf.ts", kind: "imports" },
    { source: "tests/test.ts", target: "src/leaf.ts", kind: "imports" },
    { source: "src/app/a.ts", target: "src/shared.ts", kind: "imports" },
    { source: "src/core.ts", target: "src/shared.ts", kind: "imports" },
  ]);
  assert.deepEqual(exclusiveGapSuggestions(fixture).map(hint => [hint.actorId, hint.files.map(file => file.id), hint.lines]), [["app", ["src/chain.ts", "src/leaf.ts"], 20]]);
  const root = { ...fixture, edges: [...fixture.edges, { source: "src/orphan.ts", target: "src/leaf.ts", kind: "imports" as const }] };
  assert.deepEqual(exclusiveGapSuggestions(root)[0].files.map(file => file.id), ["src/chain.ts"]);
  assert.deepEqual(exclusiveGapSuggestions({ ...fixture, stats: { ...fixture.stats, importsAvailable: false } }), []);
});

test("uncovered cycles terminate and need an owned boundary", () => {
  const fixture = graph(["src/app/a.ts", "src/a.ts", "src/b.ts"].map(path => node(path)), [
    { source: "src/a.ts", target: "src/b.ts", kind: "imports" }, { source: "src/b.ts", target: "src/a.ts", kind: "imports" },
  ]);
  assert.deepEqual(exclusiveGapSuggestions(fixture), []);
  fixture.edges.push({ source: "src/app/a.ts", target: "src/a.ts", kind: "imports" });
  assert.equal(exclusiveGapSuggestions(fixture)[0].files.length, 2);
});

test("treemap tiles stay bounded across phone and desktop and hide generated/vendor trees", () => {
  const fixture = graph([node("src/app/a.ts", 100), node("src/gap.ts", 10), node("README.md", 30, "documentation"), node(".claude/a.ts"), node("src-tauri/gen/a.rs")]);
  for (const width of [358, 720, 1012]) {
    const layout = buildTerritoryLayout(fixture, width, 430);
    assert.equal(layout.cells.length, 3);
    for (const cell of layout.cells) {
      assert.ok(cell.x >= 0 && cell.y >= 0 && cell.width > 0 && cell.height > 0);
      assert.ok(cell.x + cell.width <= width + .001 && cell.y + cell.height <= 430 + .001);
    }
    const route = territoryJourney(fixture.story!.journeys[0], layout.cells);
    assert.equal(route.stops.length, 1); assert.deepEqual(route.outside, ["user", "core"]);
  }
  assert.deepEqual(buildTerritoryLayout(graph([]), 358, 430).cells, []);
});

test("coverage rows: no story, nothing scanned, partial scans, and parts without product source", () => {
  const fixture = graph([node("src/app/a.ts", 30), node("src/other.ts", 10)]);
  const none = storyCoverage({ ...fixture, story: undefined });
  assert.deepEqual(none.parts.map(part => [part.actorId, part.percent]), [[null, 100]]);
  assert.equal(none.covered, 0);
  const empty = storyCoverage(graph([]));
  assert.deepEqual([empty.total, empty.available, empty.parts.map(part => [part.actorId, part.percent])], [0, false, [[null, null]]]);
  const zeroLines = storyCoverage(graph([node("src/app/a.ts", 0)]));
  assert.deepEqual([zeroLines.available, zeroLines.parts.map(part => [part.actorId, part.files, part.percent])], [false, [["app", 1, null], [null, 0, null]]]);
  assert.equal(storyCoverage({ ...fixture, stats: { ...fixture.stats, truncated: true } }).partial, true);
  // Only tests inside a module: the part owns no product source, so no row.
  const testsOnly = storyCoverage(graph([node("src/app/a.test.ts"), node("src/core.ts")]));
  assert.deepEqual(testsOnly.parts.map(part => part.actorId), ["core", null]);
});

test("gap suggestions are caveated on truncated scans and capped import graphs", () => {
  const fixture = graph([node("src/app/a.ts")]);
  assert.equal(importsArePartial(fixture), false);
  assert.equal(importsArePartial({ ...fixture, stats: { ...fixture.stats, truncated: true } }), true);
  assert.equal(importsArePartial({ ...fixture, warnings: ["Import edges limited to 20000."] }), true);
});

test("gap suggestions expand directory imports, ignore test-only upstreams, and order by size then part", () => {
  const fixture = graph(["src/app/a.ts", "src/core.ts", "src/lib/x.ts", "src/lib/y.ts", "src/tested.ts", "src/big.ts", "src/small.ts"].map(path => node(path, path === "src/big.ts" ? 50 : 10)), [
    { source: "src/app/a.ts", target: "src/lib", kind: "imports" },
    { source: "src/core.ts", target: "src/big.ts", kind: "imports" },
    { source: "src/app/a.ts", target: "src/small.ts", kind: "imports" },
  ]);
  fixture.nodes.push(node("tests/only.test.ts"));
  fixture.edges.push({ source: "tests/only.test.ts", target: "src/tested.ts", kind: "imports" });
  assert.deepEqual(exclusiveGapSuggestions(fixture).map(hint => [hint.actorId, hint.files.map(file => file.id), hint.lines]), [
    ["core", ["src/big.ts"], 50],
    ["app", ["src/lib/x.ts", "src/lib/y.ts", "src/small.ts"], 30],
  ]);
});

test("a journey that revisits a part gets a distinct, numbered stop for every visit", () => {
  const fixture = graph([node("src/app/a.ts", 100), node("src/core.ts", 50)]);
  const layout = buildTerritoryLayout(fixture, 720, 430);
  const route = territoryJourney({ name: "Back and forth", steps: ["user", "app", "core", "app", "core", "app"] }, layout.cells);
  assert.deepEqual(route.stops.map(stop => [stop.step, stop.actorId, stop.visit]), [[2, "app", 0], [3, "core", 0], [4, "app", 1], [5, "core", 1], [6, "app", 2]]);
  assert.equal(new Set(route.stops.map(stop => `${stop.x},${stop.y}`)).size, route.stops.length);
  assert.equal(route.path.split(/[ML]/).filter(Boolean).length, 5);
  assert.deepEqual(route.outside, ["user"]);
});

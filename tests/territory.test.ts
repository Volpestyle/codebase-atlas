import assert from "node:assert/strict";
import test from "node:test";
import { graph, node } from "./story-fixtures.ts";
import { buildTerritoryLayout, exclusiveGapSuggestions, storyCoverage, territoryJourney } from "../src/territory.ts";
import { isProductSource } from "../src/sourceScope.ts";

test("coverage mirrors Rust product scope and partitions source once", () => {
  const excluded = [".claude/skills/x.ts", ".github/a.ts", "src/.hidden/a.ts", "src-tauri/gen/apple/a.rs", "vendor/a.ts", "tests/a.ts", "src/a.test.ts", "vite.config.ts", "src/build/a.ts"];
  for (const path of excluded) assert.equal(isProductSource(node(path)), false, path);
  assert.equal(isProductSource(node("src/gen/useful.ts")), true);
  const fixture = graph([node("src/app/a.ts", 60), node("src/core.ts", 20), node("src/gap.ts", 20), ...excluded.map(path => node(path, 100))]);
  const coverage = storyCoverage(fixture);
  assert.equal(coverage.total, 100); assert.equal(coverage.covered, 80);
  assert.deepEqual(coverage.parts.map(part => part.percent), [0, 60, 20, 20]);
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

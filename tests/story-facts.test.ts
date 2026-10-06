import assert from "node:assert/strict";
import test from "node:test";
import { actorExchanges, filesForActor, ownerForNode, partCrossings, supportFilesForActor, testsForActor } from "../src/storyFacts.ts";
import { buildTransitLayout, labelBox, transitPath, type Point } from "../src/transitLayout.ts";
import { ACTOR_ROLES } from "../src/model.ts";
import { actorFigure } from "../src/storyFigures.ts";
import type { Story } from "../src/model.ts";

import { node, graph, story } from "./story-fixtures.ts";

test("ownership partitions overlaps by the most specific module, then story order", () => {
  const overlapping: Story = { ...story, actors: [...story.actors, { id: "special", name: "Special", role: "core", blurb: "One file.", modules: ["src/app/special.ts"] }] };
  assert.equal(ownerForNode(overlapping, "src/app/main.ts"), "app");
  assert.equal(ownerForNode(overlapping, "src/app/special.ts"), "special");
  assert.equal(ownerForNode(overlapping, "src/application.ts"), null);
  assert.equal(filesForActor(graph([node("src/app/main.ts"), node("src/core.ts")]), "app").length, 1);
});

test("exchanges include carries and the return direction without inventing flows", () => {
  const exchange = actorExchanges(story, story.actors[1]);
  assert.deepEqual(exchange.takes.map(each => each.text), ["a request"]);
  assert.deepEqual(exchange.gives.map(each => each.text), ["a reply", "the work"]);
  assert.equal(exchange.gives[0].returning, true);
});

test("crossings report real binding names, direction, and files in no part", () => {
  const fixture = graph([node("src/app/main.ts"), node("src/core.ts"), node("src/shared.ts"), node("tests/app.test.ts")], [
    { source: "src/app/main.ts", target: "src/core.ts", kind: "imports", symbols: ["Core", "run"] },
    { source: "src/app/main.ts", target: "src/shared.ts", kind: "imports", symbols: ["shared"] },
    { source: "tests/app.test.ts", target: "src/app/main.ts", kind: "imports", symbols: ["App"] },
  ]);
  const crossings = partCrossings(fixture, "app");
  assert.ok(crossings.some(each => each.direction === "in" && each.other === "core" && each.names.join(",") === "Core,run"));
  assert.ok(crossings.some(each => each.direction === "in" && each.other === null && each.files.join(",") === "src/shared.ts"));
  assert.ok(!crossings.some(each => each.files.includes("tests/app.test.ts")), "tests are not crossings");
  assert.deepEqual(testsForActor(fixture, "app").map(n => n.id), ["tests/app.test.ts"]);
  assert.deepEqual(partCrossings({ ...fixture, stats: { ...fixture.stats, importsAvailable: false } }, "app"), []);
});

test("transit layout collapses unused roles, separates stations, and keeps labels in bounds", () => {
  const layout = buildTransitLayout(story);
  assert.deepEqual(layout.columns.map(column => column.role), ["person", "surface", "core"]);
  for (const station of layout.stations) {
    assert.ok(station.x >= 78 && station.x <= layout.width - 78);
    assert.ok(station.y > 44 && station.y < layout.height - 60);
  }
  const crowded = buildTransitLayout({ ...story, actors: [...story.actors, { ...story.actors[2], id: "extra" }] });
  const core = crowded.stations.filter(station => station.actor.role === "core");
  assert.ok(core[1].y - core[0].y >= 108);
  const path = transitPath(crowded, "app", "core")!;
  assert.ok(path.startsWith("M "));
  assert.equal(transitPath(crowded, "core", "extra"), null);
});

test("people never become code figures and roles have documented defaults", () => {
  assert.equal(actorFigure({ ...story.actors[0], figure: "riffle" }), undefined);
  assert.equal(actorFigure(story.actors[1]), "terminal");
  assert.equal(actorFigure({ ...story.actors[2], figure: "loupe" }), "loupe");
});

test("ownership respects path boundaries, the root module, story order on ties, and files over directories", () => {
  const actors = (...modules: [string, string][]): Story => ({ ...story, actors: modules.map(([id, module]) => ({ id, name: id, role: "core", blurb: "", modules: [module] })) });
  assert.equal(ownerForNode(story, "src/apple.ts"), null);
  assert.equal(ownerForNode(story, "src/app"), "app");
  assert.equal(ownerForNode(actors(["root", "."], ["app", "src/app"]), "README.md"), "root");
  assert.equal(ownerForNode(actors(["root", "."], ["app", "src/app"]), "src/app/a.ts"), "app");
  assert.equal(ownerForNode(actors(["first", "src/app"], ["second", "src/app"]), "src/app/a.ts"), "first");
  assert.equal(ownerForNode(actors(["dir", "src"], ["file", "src/core.ts"]), "src/core.ts"), "file");
});

test("a part's files are product source; its tests and setup are support files", () => {
  const fixture = graph([node("src/app/main.ts"), node("src/app/main.test.ts"), node("src/app/vite.config.ts"), node("src/app/notes.md", 10, "documentation"), node("src/core.ts")]);
  assert.deepEqual(filesForActor(fixture, "app").map(n => n.id), ["src/app/main.ts"]);
  assert.deepEqual(supportFilesForActor(fixture, "app").map(n => n.id), ["src/app/main.test.ts", "src/app/notes.md", "src/app/vite.config.ts"]);
  assert.deepEqual(filesForActor({ ...fixture, story: undefined }, "app"), []);
});

test("directory import targets expand to the files inside, grouped by each file's owner", () => {
  const lib: Story = { ...story, actors: [...story.actors, { id: "lib", name: "Lib", role: "core", blurb: "", modules: ["src/lib/a.ts"] }] };
  const fixture = { ...graph([node("src/app/main.ts"), node("src/lib/a.ts"), node("src/lib/b.ts"), node("src/lib/a.test.ts"), node("tests/lib.test.ts")], [
    { source: "src/app/main.ts", target: "src/lib", kind: "imports" as const, symbols: ["thing"] },
    { source: "tests/lib.test.ts", target: "src/lib", kind: "imports" as const },
  ]), story: lib };
  const crossings = partCrossings(fixture, "app");
  assert.deepEqual(crossings.map(each => [each.direction, each.other, each.files.join(","), each.count, each.names.join(",")]), [
    ["in", "lib", "src/lib/a.ts", 1, "thing"],
    ["in", null, "src/lib/b.ts", 1, "thing"],
  ]);
  assert.deepEqual(partCrossings(fixture, "lib").map(each => [each.direction, each.other, each.files.join(",")]), [["out", "app", "src/app/main.ts"]]);
  assert.deepEqual(testsForActor(fixture, "lib").map(n => n.id), ["tests/lib.test.ts"]);
  assert.deepEqual(testsForActor(fixture, "app"), []);
});

function pointsOf(d: string): Point[] {
  return [...d.matchAll(/[ML] (-?[\d.]+) (-?[\d.]+)/g)].map(match => [Number(match[1]), Number(match[2])] as Point);
}
function octilinear(d: string): boolean {
  const points = pointsOf(d);
  return points.length >= 2 && points.slice(1).every(([x, y], i) => {
    const dx = Math.abs(x - points[i][0]); const dy = Math.abs(y - points[i][1]);
    return dx === 0 || dy === 0 || Math.abs(dx - dy) < 1e-9;
  });
}

test("transit routes are deterministic metro lines that skip other stations", () => {
  const wide: Story = {
    summary: "", journeys: [],
    actors: [
      { id: "p", name: "Person", role: "person", blurb: "" },
      { id: "s", name: "Surface", role: "surface", blurb: "" },
      { id: "c1", name: "Core one", role: "core", blurb: "" },
      { id: "c2", name: "Core two", role: "core", blurb: "" },
      { id: "c3", name: "Core three", role: "core", blurb: "" },
      { id: "k", name: "Kept", role: "store", blurb: "" },
      { id: "x", name: "Outside", role: "external", blurb: "" },
    ],
    flows: [
      { from: "p", to: "s", carries: "a" }, { from: "s", to: "c1", carries: "b" }, { from: "c1", to: "c2", carries: "c" },
      { from: "c1", to: "c3", carries: "d" }, { from: "c3", to: "x", carries: "e" }, { from: "p", to: "x", carries: "f" },
      { from: "k", to: "p", carries: "g" }, { from: "c2", to: "k", carries: "h" },
    ],
  };
  const layout = buildTransitLayout(wide);
  assert.deepEqual(layout.columns.map(column => column.role), ACTOR_ROLES.filter(role => role !== "door"));
  assert.equal(layout.routes.size, wide.flows.length);
  for (const route of layout.routes.values()) {
    assert.ok(octilinear(route.d), route.d);
    assert.ok(!route.d.includes("C"), "no curves");
    for (const [x, y] of route.points) assert.ok(x >= 0 && x <= layout.width && y >= 36 && y <= layout.height, route.d);
    const ends = new Set([route.flow.from, route.flow.to]);
    for (const station of layout.stations) {
      if (ends.has(station.actor.id)) continue;
      for (const [x, y] of route.points) assert.ok(Math.hypot(x - station.x, y - station.y) > 1, `${route.d} passes ${station.actor.id}`);
    }
  }
  // Same column: c1→c3 must not run straight through c2.
  const same = layout.routes.get("c1→c3")!;
  assert.ok(same.points.length > 2 && same.points.some(([x]) => x !== layout.byId.get("c1")!.x), same.d);
  // Adjacent stations in one column share a straight line, and labels move off it.
  assert.deepEqual(layout.routes.get("c1→c2")!.points, [[layout.byId.get("c1")!.x, layout.byId.get("c1")!.y], [layout.byId.get("c2")!.x, layout.byId.get("c2")!.y]]);
  // Reverse travel reverses the drawn route.
  const forward = transitPath(layout, "s", "c1")!; const backward = transitPath(layout, "c1", "s")!;
  assert.deepEqual(pointsOf(backward), pointsOf(forward).reverse());
  assert.deepEqual(buildTransitLayout(wide), layout, "deterministic");
  for (const station of layout.stations) {
    assert.ok(["below", "above", "right"].includes(station.anchor));
    const box = labelBox(station);
    assert.ok(box.left >= 0 && box.right <= layout.width && box.top >= 36 && box.bottom <= layout.height, station.actor.id);
  }
});

test("transit layout handles an empty story and a story with no flows", () => {
  const empty = buildTransitLayout({ summary: "", actors: [], flows: [], journeys: [] });
  assert.deepEqual([empty.columns, empty.stations, empty.routes.size], [[], [], 0]);
  assert.ok(empty.width > 0 && empty.height > 0);
  const lonely = buildTransitLayout({ ...story, flows: [] });
  assert.equal(lonely.routes.size, 0);
  assert.equal(transitPath(lonely, "user", "app"), null);
});

test("figures: unknown names and non-string values from an opened snapshot fall back to the role default", () => {
  assert.equal(actorFigure({ ...story.actors[0], figure: "nonsense" as never }), undefined);
  assert.equal(actorFigure({ ...story.actors[2], figure: "nonsense" as never }), "riffle");
  assert.equal(actorFigure({ ...story.actors[2], figure: 7 as never }), "riffle");
  assert.equal(actorFigure({ ...story.actors[1], figure: null as never }), "terminal");
});

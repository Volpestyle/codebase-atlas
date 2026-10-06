import assert from "node:assert/strict";
import test from "node:test";
import { actorExchanges, filesForActor, ownerForNode, partCrossings, testsForActor } from "../src/storyFacts.ts";
import { buildTransitLayout, transitPath } from "../src/transitLayout.ts";
import { actorFigure } from "../src/storyFigures.ts";
import type { RepositoryGraph, RepositoryNode, Story } from "../src/model.ts";

export function node(path: string, lines = 10, kind: RepositoryNode["kind"] = "source"): RepositoryNode {
  return { id: path, path, name: path.split("/").pop()!, lines, kind, sizeBytes: lines * 64, depth: path.split("/").length, childCount: 0, description: null, language: "TypeScript", extension: "ts" };
}
export const story: Story = {
  summary: "Test story", actors: [
    { id: "user", name: "A person", role: "person", blurb: "Asks." },
    { id: "app", name: "App", role: "surface", blurb: "Shows.", modules: ["src/app"] },
    { id: "core", name: "Core", role: "core", blurb: "Works.", modules: ["src/core.ts"] },
  ], flows: [{ from: "user", to: "app", carries: "a request", returns: "a reply" }, { from: "app", to: "core", carries: "the work" }],
  journeys: [{ name: "Ask", steps: ["user", "app", "core"] }],
};
export function graph(nodes: RepositoryNode[], edges: RepositoryGraph["edges"] = []): RepositoryGraph {
  return { name: "Fixture", root: "/fixture", branch: "main", source: "local", nodes, edges, story, warnings: [], stats: { files: nodes.length, directories: 0, lines: nodes.reduce((sum, n) => sum + n.lines, 0), lineCountAvailable: true, importsAvailable: true, bytes: 0, languages: [], truncated: false } };
}

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
  assert.ok(crossings.some(each => each.direction === "out" && each.other === null && each.files.includes("tests/app.test.ts")));
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
  assert.ok(transitPath(core[0], core[1]).startsWith(`M ${core[0].x} ${core[0].y}`));
});

test("people never become code figures and roles have documented defaults", () => {
  assert.equal(actorFigure({ ...story.actors[0], figure: "riffle" }), undefined);
  assert.equal(actorFigure(story.actors[1]), "terminal");
  assert.equal(actorFigure({ ...story.actors[2], figure: "loupe" }), "loupe");
});

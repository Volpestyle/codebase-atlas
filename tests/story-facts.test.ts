import assert from "node:assert/strict";
import test from "node:test";
import { actorExchanges, filesForActor, ownerForNode, partCrossings, testsForActor } from "../src/storyFacts.ts";
import { buildTransitLayout, transitPath } from "../src/transitLayout.ts";
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

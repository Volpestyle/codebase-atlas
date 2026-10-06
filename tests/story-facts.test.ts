import assert from "node:assert/strict";
import test from "node:test";
import { actorExchanges, filesForActor, ownerForNode, partCrossings, supportFilesForActor, testsForActor } from "../src/storyFacts.ts";
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

test("figures: unknown names and non-string values from an opened snapshot fall back to the role default", () => {
  assert.equal(actorFigure({ ...story.actors[0], figure: "nonsense" as never }), undefined);
  assert.equal(actorFigure({ ...story.actors[2], figure: "nonsense" as never }), "riffle");
  assert.equal(actorFigure({ ...story.actors[2], figure: 7 as never }), "riffle");
  assert.equal(actorFigure({ ...story.actors[1], figure: null as never }), "terminal");
});

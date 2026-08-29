import assert from "node:assert/strict";
import test from "node:test";
import {
  ancestorAtScale,
  ancestry,
  nodeGlyph,
  scaleOf,
  surveyOffset,
  visibleCrumbs,
} from "../src/location.ts";
import type { RepositoryEdge, RepositoryGraph, RepositoryNode } from "../src/model.ts";

function node(overrides: Partial<RepositoryNode> & { id: string }): RepositoryNode {
  const depth = overrides.id === "." ? 0 : overrides.id.split("/").length;
  return {
    name: overrides.id.split("/").pop() ?? overrides.id,
    path: overrides.id,
    kind: "source",
    extension: null,
    language: null,
    sizeBytes: 10,
    lines: 10,
    depth,
    childCount: 0,
    description: null,
    ...overrides,
  };
}

function graphOf(nodes: RepositoryNode[], edges: RepositoryEdge[]): RepositoryGraph {
  return {
    root: "/repo",
    name: "repo",
    branch: "main",
    source: "local",
    nodes,
    edges,
    stats: {
      files: nodes.length,
      directories: 0,
      lines: 0,
      lineCountAvailable: true,
      importsAvailable: true,
      bytes: 0,
      languages: [],
      truncated: false,
    },
    warnings: [],
  };
}

const graph = graphOf(
  [
    node({ id: ".", kind: "repository", name: "repo" }),
    node({ id: "apps", kind: "directory" }),
    node({ id: "apps/clankie", kind: "directory" }),
    node({ id: "apps/clankie/src", kind: "directory" }),
    node({ id: "apps/clankie/src/app.ts", extension: ".ts" }),
  ],
  [
    { source: ".", target: "apps", kind: "contains" },
    { source: "apps", target: "apps/clankie", kind: "contains" },
    { source: "apps/clankie", target: "apps/clankie/src", kind: "contains" },
    { source: "apps/clankie/src", target: "apps/clankie/src/app.ts", kind: "contains" },
  ],
);

test("ancestry walks from the field to the focused module", () => {
  const trail = ancestry(graph, "apps/clankie/src/app.ts");
  assert.deepEqual(
    trail.map((entry) => entry.id),
    [".", "apps", "apps/clankie", "apps/clankie/src", "apps/clankie/src/app.ts"],
  );
});

test("scale names field, district, folder, and file", () => {
  const byId = new Map(graph.nodes.map((entry) => [entry.id, entry]));
  assert.equal(scaleOf(byId.get(".")!), "field");
  assert.equal(scaleOf(byId.get("apps")!), "district");
  assert.equal(scaleOf(byId.get("apps/clankie")!), "folder");
  assert.equal(scaleOf(byId.get("apps/clankie/src/app.ts")!), "file");
});

test("scale rungs jump to the matching ancestor", () => {
  const trail = ancestry(graph, "apps/clankie/src/app.ts");
  assert.equal(ancestorAtScale(trail, "field")?.id, ".");
  assert.equal(ancestorAtScale(trail, "district")?.id, "apps");
  assert.equal(ancestorAtScale(trail, "folder")?.id, "apps/clankie/src");
  assert.equal(ancestorAtScale(trail, "file")?.id, "apps/clankie/src/app.ts");
  assert.equal(ancestorAtScale(ancestry(graph, "."), "district"), null);
});

test("survey offset is how far the focus sits below the slider", () => {
  const file = graph.nodes.find((entry) => entry.id.endsWith("app.ts"))!;
  assert.equal(surveyOffset(file, 2), 2);
  assert.equal(surveyOffset(file, 8), 0);
  assert.equal(surveyOffset(file, Number.POSITIVE_INFINITY), 0);
});

test("file glyphs prefer the extension", () => {
  const file = graph.nodes.find((entry) => entry.id.endsWith("app.ts"))!;
  assert.equal(nodeGlyph(file), "TS");
  assert.equal(nodeGlyph(graph.nodes[0]), "R");
});

test("long trails collapse the middle", () => {
  const trail = ancestry(graph, "apps/clankie/src/app.ts");
  const crumbs = visibleCrumbs(trail);
  assert.equal(crumbs[0] === "gap" ? "gap" : crumbs[0].id, ".");
  assert.equal(crumbs[1], "gap");
  assert.equal(crumbs.at(-1) === "gap" ? "gap" : crumbs.at(-1)!.id, "apps/clankie/src/app.ts");
});

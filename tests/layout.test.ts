import assert from "node:assert/strict";
import test from "node:test";
import {
  arteryKeys,
  buildRepositoryLayout,
  flowKey,
  MAX_RENDERED_NODES,
} from "../src/repositoryLayout.ts";
import {
  framingTargetId,
  framingZoom,
  isMapPlaceName,
  isWrapperNode,
  parentPath,
  poseAlreadyFramed,
  sceneReadout,
  SURVEY_ZOOM,
  type Frameable,
} from "../src/placeNames.ts";
import { parseRepositoryGraph } from "../src/model.ts";
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

test("map files round-trip and junk is rejected", () => {
  const graph = graphOf(
    [node({ id: ".", kind: "repository" }), node({ id: "a.ts" })],
    [{ source: ".", target: "a.ts", kind: "contains" }],
  );
  assert.deepEqual(parseRepositoryGraph(JSON.stringify(graph)), graph);
  assert.throws(() => parseRepositoryGraph("not json"), /not a Codebase Atlas map/);
  assert.throws(() => parseRepositoryGraph('{"name":"x"}'), /not a Codebase Atlas map/);
  assert.throws(
    () => parseRepositoryGraph('{"name":"x","nodes":[{"bad":1}],"edges":[],"stats":{}}'),
    /not a Codebase Atlas map/,
  );
});

test("keeps direct import flows and drops intra-module ones", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "a", kind: "directory" }),
      node({ id: "a/one.ts" }),
      node({ id: "b", kind: "directory" }),
      node({ id: "b/two.ts" }),
    ],
    [
      { source: ".", target: "a", kind: "contains" },
      { source: "a", target: "a/one.ts", kind: "contains" },
      { source: ".", target: "b", kind: "contains" },
      { source: "b", target: "b/two.ts", kind: "contains" },
      { source: "a/one.ts", target: "b/two.ts", kind: "imports" },
    ],
  );

  const layout = buildRepositoryLayout(graph);
  assert.deepEqual(layout.imports, [{ source: "a/one.ts", target: "b/two.ts", weight: 1 }]);
});

test("nests each module inside its parent's district footprint", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "a", kind: "directory", lines: 30 }),
      node({ id: "a/one.ts", lines: 20 }),
      node({ id: "a/two.ts", lines: 10 }),
      node({ id: "b", kind: "directory", lines: 10 }),
      node({ id: "b/three.ts", lines: 10 }),
    ],
    [
      { source: ".", target: "a", kind: "contains" },
      { source: "a", target: "a/one.ts", kind: "contains" },
      { source: "a", target: "a/two.ts", kind: "contains" },
      { source: ".", target: "b", kind: "contains" },
      { source: "b", target: "b/three.ts", kind: "contains" },
    ],
  );

  const layout = buildRepositoryLayout(graph);
  const byId = new Map(layout.modules.map((module) => [module.node.id, module]));
  const contains = (outer: string, inner: string) => {
    const parent = byId.get(outer)!;
    const child = byId.get(inner)!;
    return (
      Math.abs(child.x - parent.x) <= (parent.width - child.width) / 2 + 1e-6 &&
      Math.abs(child.z - parent.z) <= (parent.depth - child.depth) / 2 + 1e-6 &&
      child.y > parent.y
    );
  };
  assert.ok(contains(".", "a"), "a sits inside the root plate");
  assert.ok(contains("a", "a/one.ts"), "files sit inside their directory district");
  assert.ok(contains("a", "a/two.ts"));
  assert.ok(contains("b", "b/three.ts"));
  assert.ok(!contains("b", "a/one.ts"), "foreign files stay outside a district");
  const a = byId.get("a")!;
  const b = byId.get("b")!;
  assert.ok(
    a.width * a.depth > b.width * b.depth,
    "district area tracks subtree size",
  );
});

test("binary assets and data files cannot dominate district area", () => {
  // 15MB of diagrams versus a modest code package: the code district must win.
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "diagrams", kind: "directory", lines: 0, sizeBytes: 15_000_000 }),
      node({ id: "diagrams/big.jpg", kind: "asset", lines: 0, sizeBytes: 15_000_000 }),
      node({ id: "core", kind: "directory", lines: 900, sizeBytes: 30_000 }),
      node({ id: "core/logic.ts", lines: 900, sizeBytes: 30_000 }),
    ],
    [
      { source: ".", target: "diagrams", kind: "contains" },
      { source: "diagrams", target: "diagrams/big.jpg", kind: "contains" },
      { source: ".", target: "core", kind: "contains" },
      { source: "core", target: "core/logic.ts", kind: "contains" },
    ],
  );

  const byId = new Map(
    buildRepositoryLayout(graph).modules.map((module) => [module.node.id, module]),
  );
  const area = (id: string) => byId.get(id)!.width * byId.get(id)!.depth;
  assert.ok(area("core") > area("diagrams"), "code outweighs binary assets");

  // Same repo through the bytes-only fallback (GitHub sources): still true.
  graph.stats.lineCountAvailable = false;
  const fallback = new Map(
    buildRepositoryLayout(graph).modules.map((module) => [module.node.id, module]),
  );
  const fallbackArea = (id: string) => fallback.get(id)!.width * fallback.get(id)!.depth;
  assert.ok(fallbackArea("core") > fallbackArea("diagrams"), "code outweighs assets in byte mode too");
  assert.ok(fallbackArea("diagrams") > 0, "assets still register as presence");
});

test("depth limit coarsens the map and aggregates flows to visible modules", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "a", kind: "directory" }),
      node({ id: "a/one.ts" }),
      node({ id: "b", kind: "directory" }),
      node({ id: "b/two.ts" }),
    ],
    [
      { source: ".", target: "a", kind: "contains" },
      { source: "a", target: "a/one.ts", kind: "contains" },
      { source: ".", target: "b", kind: "contains" },
      { source: "b", target: "b/two.ts", kind: "contains" },
      { source: "a/one.ts", target: "b/two.ts", kind: "imports" },
    ],
  );

  const layout = buildRepositoryLayout(graph, 1);
  assert.deepEqual(
    layout.modules.map((module) => module.node.id),
    [".", "a", "b"],
  );
  assert.deepEqual(layout.imports, [{ source: "a", target: "b", weight: 1 }]);
});

test("selecting a depth-limit district reveals its children without raising depth", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "a", kind: "directory", lines: 30 }),
      node({ id: "a/one.ts", lines: 20 }),
      node({ id: "a/two.ts", lines: 10 }),
      node({ id: "b", kind: "directory", lines: 10 }),
      node({ id: "b/two.ts", lines: 10 }),
    ],
    [
      { source: ".", target: "a", kind: "contains" },
      { source: "a", target: "a/one.ts", kind: "contains" },
      { source: "a", target: "a/two.ts", kind: "contains" },
      { source: ".", target: "b", kind: "contains" },
      { source: "b", target: "b/two.ts", kind: "contains" },
      { source: "a/one.ts", target: "b/two.ts", kind: "imports" },
    ],
  );

  const closed = buildRepositoryLayout(graph, 1);
  const open = buildRepositoryLayout(graph, 1, "a");
  const closedIds = new Set(closed.modules.map((module) => module.node.id));
  const openIds = new Set(open.modules.map((module) => module.node.id));
  const closedById = new Map(closed.modules.map((module) => [module.node.id, module]));
  const openById = new Map(open.modules.map((module) => [module.node.id, module]));

  assert.deepEqual([...closedIds].sort(), [".", "a", "b"]);
  assert.ok(openIds.has("a/one.ts") && openIds.has("a/two.ts"));
  assert.ok(!openIds.has("b/two.ts"), "unselected districts stay closed");
  assert.equal(open.extent, closed.extent, "peeking does not rescale the map");
  assert.equal(openById.get("b")!.width, closedById.get("b")!.width);
  assert.equal(openById.get("b")!.depth, closedById.get("b")!.depth);

  const a = openById.get("a")!;
  const child = openById.get("a/one.ts")!;
  assert.ok(
    Math.abs(child.x - a.x) <= (a.width - child.width) / 2 + 1e-6 &&
      Math.abs(child.z - a.z) <= (a.depth - child.depth) / 2 + 1e-6 &&
      child.y > a.y,
    "peeked files sit inside the selected district",
  );
  assert.deepEqual(open.imports, [{ source: "a/one.ts", target: "b", weight: 1 }]);

  const keep = buildRepositoryLayout(graph, 1, "a/one.ts");
  const keepIds = new Set(keep.modules.map((module) => module.node.id));
  assert.ok(keepIds.has("a/one.ts") && keepIds.has("a/two.ts"), "selecting a peeked file keeps siblings");
  assert.ok(!keepIds.has("b/two.ts"));
});

test("a large district at the depth limit unpacks its children instead of a title block", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "big", kind: "directory", lines: 80 }),
      node({ id: "big/one.ts", lines: 30 }),
      node({ id: "big/two.ts", lines: 20 }),
      node({ id: "big/three.ts", lines: 20 }),
      node({ id: "big/four.ts", lines: 10 }),
      node({ id: "tiny", kind: "directory", lines: 10 }),
      node({ id: "tiny/only.ts", lines: 10 }),
    ],
    [
      { source: ".", target: "big", kind: "contains" },
      { source: "big", target: "big/one.ts", kind: "contains" },
      { source: "big", target: "big/two.ts", kind: "contains" },
      { source: "big", target: "big/three.ts", kind: "contains" },
      { source: "big", target: "big/four.ts", kind: "contains" },
      { source: ".", target: "tiny", kind: "contains" },
      { source: "tiny", target: "tiny/only.ts", kind: "contains" },
    ],
  );

  const layout = buildRepositoryLayout(graph, 1);
  const ids = new Set(layout.modules.map((module) => module.node.id));
  const byId = new Map(layout.modules.map((module) => [module.node.id, module]));
  assert.ok(ids.has("big/one.ts") && ids.has("big/four.ts"), "roomy district shows its files");
  assert.ok(!ids.has("tiny/only.ts"), "a one-child block stays packed");
  const parent = byId.get("big")!;
  const child = byId.get("big/one.ts")!;
  assert.equal(parent.height < child.height, true, "opened district is a plate, not a tower");
  assert.ok(
    Math.abs(child.x - parent.x) <= (parent.width - child.width) / 2 + 1e-6 &&
      Math.abs(child.z - parent.z) <= (parent.depth - child.depth) / 2 + 1e-6,
    "unpacked files fill the district",
  );
});

test("lifts unrendered file imports to their rendered ancestors with weights", () => {
  // Two packages whose files land beyond the render cap: their file-level
  // imports must merge into one weighted package-level arc.
  const filler = Array.from({ length: MAX_RENDERED_NODES }, (_, index) =>
    node({ id: `zz-filler-${String(index).padStart(4, "0")}`, depth: 1 }),
  );
  const nodes = [
    node({ id: ".", kind: "repository" }),
    node({ id: "app", kind: "directory" }),
    node({ id: "lib", kind: "directory" }),
    ...filler,
    node({ id: "app/one.ts", depth: 2 }),
    node({ id: "app/two.ts", depth: 2 }),
    node({ id: "lib/core.ts", depth: 2 }),
  ];
  const edges: RepositoryEdge[] = [
    { source: ".", target: "app", kind: "contains" },
    { source: ".", target: "lib", kind: "contains" },
    { source: "app", target: "app/one.ts", kind: "contains" },
    { source: "app", target: "app/two.ts", kind: "contains" },
    { source: "lib", target: "lib/core.ts", kind: "contains" },
    ...filler.map((entry): RepositoryEdge => ({ source: ".", target: entry.id, kind: "contains" })),
    { source: "app/one.ts", target: "lib/core.ts", kind: "imports" },
    { source: "app/two.ts", target: "lib/core.ts", kind: "imports" },
    { source: "app/one.ts", target: "app/two.ts", kind: "imports" },
  ];

  const layout = buildRepositoryLayout(graphOf(nodes, edges));
  const renderedIds = new Set(layout.modules.map((module) => module.node.id));
  assert.ok(!renderedIds.has("app/one.ts"), "depth-2 files fall beyond the render cap");
  assert.deepEqual(layout.imports, [{ source: "app", target: "lib", weight: 2 }]);
});

test("artery keys keep the heaviest import routes", () => {
  const flows = [
    { source: "a", target: "core", weight: 2 },
    { source: "b", target: "core", weight: 9 },
    { source: "c", target: "core", weight: 4 },
    { source: "d", target: "core", weight: 1 },
    { source: "e", target: "core", weight: 7 },
  ];
  const keys = arteryKeys(flows, 3);
  assert.equal(keys.size, 3);
  assert.ok(keys.has(flowKey({ source: "b", target: "core" })));
  assert.ok(keys.has(flowKey({ source: "e", target: "core" })));
  assert.ok(keys.has(flowKey({ source: "c", target: "core" })));
  assert.ok(!keys.has(flowKey({ source: "a", target: "core" })));
});

test("map place names skip wrappers, support dirs, and the field title", () => {
  assert.equal(isWrapperNode(node({ id: "app/src", kind: "directory" })), true);
  assert.equal(isMapPlaceName(node({ id: ".", kind: "repository" })), false);
  assert.equal(isMapPlaceName(node({ id: "src", kind: "directory" })), false);
  assert.equal(isMapPlaceName(node({ id: "app/test", kind: "directory" })), false);
  assert.equal(isMapPlaceName(node({ id: "app/captain", kind: "directory" })), true);
  assert.equal(parentPath("app/src/captain"), "app/src");
  assert.equal(parentPath("app"), ".");
  assert.equal(parentPath("."), null);
});

test("files and src wrappers frame their named parent district", () => {
  const frame = (
    id: string,
    kind: RepositoryNode["kind"],
    width: number,
    depth: number,
  ): [string, Frameable] => [
    id,
    { node: node({ id, kind }), width, depth },
  ];
  const byId = new Map<string, Frameable>([
    frame(".", "repository", 40, 40),
    frame("app", "directory", 20, 20),
    frame("app/captain", "directory", 12, 12),
    frame("app/captain/src", "directory", 10, 10),
    frame("app/captain/src/main.ts", "source", 2, 2),
    frame("app/captain/src/wide.ts", "source", 8, 8),
    frame("app/captain/test", "directory", 8, 8),
  ]);
  assert.equal(framingTargetId("app/captain/src/main.ts", byId), "app/captain");
  assert.equal(framingTargetId("app/captain/src/wide.ts", byId), "app/captain");
  assert.equal(framingTargetId("app/captain/src", byId), "app/captain");
  assert.equal(framingTargetId("app/captain/test", byId), "app/captain");
  assert.equal(framingTargetId("app/captain", byId), "app/captain");
  assert.equal(framingTargetId(".", byId), ".");
});

test("a second frame is skipped only when the camera is already on the pose", () => {
  const target = { x: 4, y: 0, z: -3 };
  assert.equal(poseAlreadyFramed(target, 2, target, 2), true);
  assert.equal(
    poseAlreadyFramed({ x: 12, y: 0, z: -3 }, 2, target, 2),
    false,
    "a pan off the district must re-frame",
  );
  assert.equal(poseAlreadyFramed(target, 4, target, 2), false, "a zoom off the district must re-frame");
});

test("framing zoom never drops below the survey view", () => {
  assert.equal(framingZoom(50, 200), SURVEY_ZOOM, "a huge district pans, it does not pull back");
  assert.ok(framingZoom(50, 6) > SURVEY_ZOOM, "a small named district zooms in");
  assert.ok(framingZoom(50, 6) <= 8);
  assert.ok(framingZoom(0, 10) >= SURVEY_ZOOM);
});

test("scene readout includes the index summary only when one exists", () => {
  const described = node({
    id: "app/captain",
    kind: "directory",
    description: "The operator console.",
  });
  const bare = node({ id: "app/captain", kind: "directory", description: null });
  const blank = node({ id: "app/captain", kind: "directory", description: "  " });
  assert.equal(sceneReadout(described).summary, "The operator console.");
  assert.equal(sceneReadout(described).title, "app/captain");
  assert.equal(sceneReadout(bare).summary, null);
  assert.equal(sceneReadout(blank).summary, null);
});

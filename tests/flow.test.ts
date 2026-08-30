import assert from "node:assert/strict";
import test from "node:test";
import { buildFlowLayout, chipContents, MAX_FLOW_NODES } from "../src/flowLayout.ts";
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

const importEdge = (source: string, target: string): RepositoryEdge => ({
  source,
  target,
  kind: "imports",
});

const containsChain = (ids: string[]): RepositoryEdge[] =>
  ids.map((id) => ({
    source: id.includes("/") ? id.slice(0, id.lastIndexOf("/")) : ".",
    target: id,
    kind: "contains",
  }));

test("layers modules left to right along the import direction", () => {
  // entry imports core, core imports base: three columns, entry first.
  const ids = ["entry.ts", "core.ts", "base.ts", "quiet.ts"];
  const graph = graphOf(
    [node({ id: ".", kind: "repository" }), ...ids.map((id) => node({ id }))],
    [
      ...containsChain(ids),
      importEdge("entry.ts", "core.ts"),
      importEdge("core.ts", "base.ts"),
    ],
  );

  const layout = buildFlowLayout(graph);
  const columnOf = new Map(layout.chips.map((chip) => [chip.node.id, chip.column]));
  assert.equal(columnOf.get("entry.ts"), 0);
  assert.equal(columnOf.get("core.ts"), 1);
  assert.equal(columnOf.get("base.ts"), 2);
  assert.equal(layout.columnCount, 3);
  assert.ok(!columnOf.has("quiet.ts"), "modules without flow stay out of the diagram");
  assert.ok(!columnOf.has("."), "the repository root is never a chip");
});

test("import cycles collapse into one column instead of breaking the layering", () => {
  const ids = ["entry.ts", "a.ts", "b.ts", "base.ts"];
  const graph = graphOf(
    [node({ id: ".", kind: "repository" }), ...ids.map((id) => node({ id }))],
    [
      ...containsChain(ids),
      importEdge("entry.ts", "a.ts"),
      importEdge("a.ts", "b.ts"),
      importEdge("b.ts", "a.ts"),
      importEdge("b.ts", "base.ts"),
    ],
  );

  const layout = buildFlowLayout(graph);
  const columnOf = new Map(layout.chips.map((chip) => [chip.node.id, chip.column]));
  assert.equal(columnOf.get("a.ts"), columnOf.get("b.ts"), "cycle members share a column");
  assert.ok(columnOf.get("entry.ts")! < columnOf.get("a.ts")!);
  assert.ok(columnOf.get("a.ts")! < columnOf.get("base.ts")!);
});

test("depth limit aggregates file imports into weighted module edges", () => {
  // Enough depth-1 participants that auto-detail stays at the requested level.
  const fillers = Array.from({ length: 10 }, (_, index) => `m${String(index).padStart(2, "0")}`);
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "app", kind: "directory" }),
      node({ id: "app/one.ts" }),
      node({ id: "app/two.ts" }),
      node({ id: "lib", kind: "directory" }),
      node({ id: "lib/core.ts" }),
      ...fillers.flatMap((dir) => [node({ id: dir, kind: "directory" }), node({ id: `${dir}/a.ts` })]),
    ],
    [
      ...containsChain(["app", "app/one.ts", "app/two.ts", "lib", "lib/core.ts"]),
      ...fillers.flatMap((dir) => containsChain([dir, `${dir}/a.ts`])),
      importEdge("app/one.ts", "lib/core.ts"),
      importEdge("app/two.ts", "lib/core.ts"),
      importEdge("app/one.ts", "app/two.ts"),
      ...fillers.map((dir, index) =>
        importEdge(`${dir}/a.ts`, `${fillers[(index + 1) % fillers.length]}/a.ts`),
      ),
    ],
  );

  const layout = buildFlowLayout(graph, 1);
  assert.equal(layout.effectiveDepth, 1, "enough modules at depth 1, no auto-deepening");
  assert.deepEqual(
    layout.edges.find((edge) => edge.source === "app"),
    { source: "app", target: "lib", weight: 2 },
    "intra-module imports drop; cross-module imports merge with weight",
  );
  const app = layout.chips.find((chip) => chip.node.id === "app")!;
  const lib = layout.chips.find((chip) => chip.node.id === "lib")!;
  assert.equal(app.fanOut, 2);
  assert.equal(app.fanIn, 0);
  assert.equal(lib.fanIn, 2);
  assert.ok(app.column < lib.column);
});

test("sparse depth deepens automatically until the diagram has detail", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "app", kind: "directory" }),
      node({ id: "app/one.ts" }),
      node({ id: "lib", kind: "directory" }),
      node({ id: "lib/core.ts" }),
    ],
    [
      ...containsChain(["app", "app/one.ts", "lib", "lib/core.ts"]),
      importEdge("app/one.ts", "lib/core.ts"),
    ],
  );

  const layout = buildFlowLayout(graph, 1);
  assert.equal(layout.effectiveDepth, 2, "two chips at depth 1 deepen to file level");
  assert.deepEqual(
    layout.chips.map((chip) => chip.node.id).sort(),
    ["app/one.ts", "lib/core.ts"],
  );
});

test("caps chips by flow weight and reports the full module count", () => {
  // A hot pair plus more single-import pairs than the cap can hold.
  const pairs = Array.from({ length: MAX_FLOW_NODES }, (_, index) => {
    const tag = String(index).padStart(4, "0");
    return [`from-${tag}.ts`, `to-${tag}.ts`];
  });
  const ids = ["hot-entry.ts", "hot-base.ts", ...pairs.flat()];
  const graph = graphOf(
    [node({ id: ".", kind: "repository" }), ...ids.map((id) => node({ id }))],
    [
      ...containsChain(ids),
      ...Array.from({ length: 5 }, () => importEdge("hot-entry.ts", "hot-base.ts")),
      ...pairs.map(([from, to]) => importEdge(from, to)),
    ],
  );

  const layout = buildFlowLayout(graph);
  assert.equal(layout.chips.length, MAX_FLOW_NODES);
  assert.equal(layout.totalModules, ids.length);
  const kept = new Set(layout.chips.map((chip) => chip.node.id));
  assert.ok(kept.has("hot-entry.ts") && kept.has("hot-base.ts"), "heaviest flow survives the cap");
  for (const edge of layout.edges) {
    assert.ok(kept.has(edge.source) && kept.has(edge.target), "no edges dangle past the cap");
  }
});

test("chip interiors pack children by weight into the extra tile area", () => {
  const graph = graphOf(
    [
      node({ id: ".", kind: "repository" }),
      node({ id: "app", kind: "directory", lines: 90 }),
      node({ id: "app/big.ts", lines: 60 }),
      node({ id: "app/mid.ts", lines: 20 }),
      node({ id: "app/tiny.ts", lines: 10 }),
    ],
    [
      ...containsChain(["app", "app/big.ts", "app/mid.ts", "app/tiny.ts"]),
      importEdge("app/big.ts", "app/mid.ts"),
    ],
  );

  const cells = chipContents(graph, "app", 200, 120);
  assert.equal(cells.length, 3);
  const byId = new Map(cells.map((cell) => [cell.node.id, cell]));
  const big = byId.get("app/big.ts")!;
  const tiny = byId.get("app/tiny.ts")!;
  assert.ok(
    big.width * big.height > tiny.width * tiny.height,
    "heavier children occupy more of the chip",
  );
  for (const cell of cells) {
    assert.ok(cell.x >= -1e-6 && cell.y >= -1e-6);
    assert.ok(cell.x + cell.width <= 200 + 1e-6);
    assert.ok(cell.y + cell.height <= 120 + 1e-6);
  }
  assert.equal(chipContents(graph, "app/big.ts", 200, 120).length, 0, "files have no interior");
});

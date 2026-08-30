import assert from "node:assert/strict";
import test from "node:test";

import { crossingLabel, matchesSymbol, type RepositoryNode } from "../src/model.ts";

function fileNode(symbols: RepositoryNode["symbols"]): RepositoryNode {
  return {
    id: "src/model.ts",
    name: "model.ts",
    path: "src/model.ts",
    kind: "source",
    extension: "ts",
    language: "TypeScript",
    sizeBytes: 100,
    lines: 10,
    depth: 1,
    childCount: 0,
    description: null,
    symbols,
  };
}

test("search reaches declarations inside a file", () => {
  const node = fileNode([
    { name: "layerForNode", kind: "function", line: 77, exported: true },
    { name: "TEST_FILE_PATTERN", kind: "constant", line: 69, exported: false },
  ]);
  assert.equal(matchesSymbol(node, "layerfor"), true, "matching is case-insensitive");
  assert.equal(matchesSymbol(node, "pattern"), true, "internal declarations are searchable");
  assert.equal(matchesSymbol(node, "formatbytes"), false);
  assert.equal(
    matchesSymbol(fileNode(undefined), "anything"),
    false,
    "a node the scanner could not parse matches nothing",
  );
});

test("crossing bindings read as one sorted, bounded line", () => {
  assert.equal(crossingLabel([]), null, "an unannotated edge has no detail line");
  assert.equal(crossingLabel(["b", "a"]), "a, b");
  assert.equal(
    crossingLabel(["g", "f", "e", "d", "c", "b", "a"]),
    "a, b, c, d, e, f +1",
    "a wide edge elides the tail rather than wrapping the row",
  );
});

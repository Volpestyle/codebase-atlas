import assert from "node:assert/strict";
import test from "node:test";
import { graph, node } from "./story-fixtures.ts";
import { partDeclarations } from "../src/partDeclarations.ts";

test("declarations preserve files, sort exports first by line, and do not mutate scanner order", () => {
  const file = { ...node("src/app/z.ts"), symbols: [
    { name: "privateEarly", kind: "function" as const, line: 1, exported: false },
    { name: "late", kind: "constant" as const, line: 40, exported: true },
    { name: "early", kind: "type" as const, line: 10, exported: true },
  ] };
  const rows = partDeclarations(graph([file, node("src/app/a.ts"), node("src/core.ts")]), "app");
  assert.deepEqual(rows.map(row => row.path), ["src/app/a.ts", "src/app/z.ts"]);
  assert.deepEqual(rows[1].declarations.map(symbol => symbol.name), ["early", "late", "privateEarly"]);
  assert.equal(file.symbols[0].name, "privateEarly"); assert.deepEqual(rows[0].declarations, []);
});

test("declarations are empty for unknown parts, parts without files, and graphs without a story; tests are left out", () => {
  const fixture = graph([{ ...node("src/app/a.test.ts"), symbols: [{ name: "spec", kind: "function" as const, line: 1, exported: false }] }, node("src/app/a.ts")]);
  assert.deepEqual(partDeclarations(fixture, "app").map(row => row.path), ["src/app/a.ts"]);
  assert.deepEqual(partDeclarations(fixture, "nobody"), []);
  assert.deepEqual(partDeclarations(fixture, "user"), []);
  assert.deepEqual(partDeclarations({ ...fixture, story: undefined }, "app"), []);
});

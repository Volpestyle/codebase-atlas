import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { isProductSource, isTestPath } from "../src/sourceScope.ts";
import { node } from "./story-fixtures.ts";

// One table for both sides: each row is [path, is product source] as
// src-tauri/src/source_scope.rs decides it for a source file.
const table = JSON.parse(readFileSync(new URL("./source-scope-table.json", import.meta.url), "utf8")) as [string, boolean][];

test("product scope matches the Rust rule on the shared path table", () => {
  for (const [path, product] of table) assert.equal(isProductSource(node(path)), product, path);
});

test("test detection uses the stem before the last dot, or the whole extensionless name", () => {
  assert.equal(isTestPath("src/run_test"), true);
  assert.equal(isTestPath("src/a.test"), false);
  assert.equal(isTestPath("src/a.test.ts"), true);
  assert.equal(isTestPath("src/A.Test.ts"), false);
  assert.equal(isTestPath("SRC/TESTS/a.ts"), true);
});

test("only source files are product source", () => {
  assert.equal(isProductSource(node("src/app.ts", 1, "config")), false);
  assert.equal(isProductSource(node("README.md", 1, "documentation")), false);
});

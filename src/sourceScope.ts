import type { RepositoryNode } from "./model.ts";

// Mirror src-tauri/src/source_scope.rs and scanner.rs exactly. The human
// contract lives in docs/writing-a-story.md#product-source-scope-and-checks.
// tests/source-scope-table.json is the shared path table both sides agree on.
export const GENERATED_DIRECTORY_NAMES = new Set([
  ".git", ".codebase-index", "node_modules", "target", "dist", "build", ".next",
  ".turbo", "coverage", "vendor", "Pods", "DerivedData",
]);
const SUPPORT_SEGMENTS = new Set(["test", "tests", "__tests__", "spec", "specs", "e2e", "fixtures", "__mocks__"]);
const TEST_STEM_SUFFIXES = [".test", ".spec", "_test"];

export function excludedSourcePath(path: string): boolean {
  const directories = path.split("/").slice(0, -1);
  let inTauri = false;
  for (const directory of directories) {
    if (directory.startsWith(".") || GENERATED_DIRECTORY_NAMES.has(directory) || (inTauri && directory === "gen")) return true;
    inTauri ||= directory === "src-tauri";
  }
  return false;
}
export function isConfigSource(path: string): boolean {
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  return dot >= 0 && name.slice(0, dot).endsWith(".config");
}
/** Any segment (the file name included) is a support directory name, or the
 *  stem before the last dot (the whole name when there is none) ends in a
 *  test suffix. Segments compare lowercased; suffixes are case-sensitive. */
export function isTestPath(path: string): boolean {
  if (path.split("/").some(segment => SUPPORT_SEGMENTS.has(segment.toLowerCase()))) return true;
  const name = path.split("/").pop() ?? path;
  const dot = name.lastIndexOf(".");
  const stem = dot >= 0 ? name.slice(0, dot) : name;
  return TEST_STEM_SUFFIXES.some(suffix => stem.endsWith(suffix));
}
export function isProductSource(node: RepositoryNode): boolean {
  return node.kind === "source" && !excludedSourcePath(node.id) && !isConfigSource(node.id) && !isTestPath(node.id);
}

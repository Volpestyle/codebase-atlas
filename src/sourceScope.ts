import { isTestNode, type RepositoryNode } from "./model.ts";

// Mirror src-tauri/src/source_scope.rs and scanner.rs exactly. The human
// contract lives in docs/writing-a-story.md#product-source-scope-and-checks.
export const GENERATED_DIRECTORY_NAMES = new Set([
  ".git", ".codebase-index", "node_modules", "target", "dist", "build", ".next",
  ".turbo", "coverage", "vendor", "Pods", "DerivedData",
]);
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
export function isProductSource(node: RepositoryNode): boolean {
  return node.kind === "source" && !excludedSourcePath(node.path) && !isConfigSource(node.path) && !isTestNode(node);
}

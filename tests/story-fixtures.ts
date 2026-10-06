import type { RepositoryGraph, RepositoryNode, Story } from "../src/model.ts";
export function node(path: string, lines = 10, kind: RepositoryNode["kind"] = "source"): RepositoryNode {
  return { id: path, path, name: path.split("/").pop()!, lines, kind, sizeBytes: lines * 64, depth: path.split("/").length, childCount: 0, description: null, language: "TypeScript", extension: "ts" };
}
export const story: Story = {
  summary: "Test story", actors: [
    { id: "user", name: "A person", role: "person", blurb: "Asks." },
    { id: "app", name: "App", role: "surface", blurb: "Shows.", modules: ["src/app"] },
    { id: "core", name: "Core", role: "core", blurb: "Works.", modules: ["src/core.ts"] },
  ], flows: [{ from: "user", to: "app", carries: "a request", returns: "a reply" }, { from: "app", to: "core", carries: "the work" }],
  journeys: [{ name: "Ask", steps: ["user", "app", "core"] }],
};
export function graph(nodes: RepositoryNode[], edges: RepositoryGraph["edges"] = []): RepositoryGraph {
  return { name: "Fixture", root: "/fixture", branch: "main", source: "local", nodes, edges, story, warnings: [], stats: { files: nodes.length, directories: 0, lines: nodes.reduce((sum, n) => sum + n.lines, 0), lineCountAvailable: true, importsAvailable: true, bytes: 0, languages: [], truncated: false } };
}


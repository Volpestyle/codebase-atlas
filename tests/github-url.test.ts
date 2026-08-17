import assert from "node:assert/strict";
import test from "node:test";
import { githubTreeToGraph } from "../src/github.ts";
import { parseGitHubRepositoryUrl } from "../src/github-url.ts";

test("parses canonical and copied GitHub repository URLs", () => {
  assert.deepEqual(parseGitHubRepositoryUrl("https://github.com/Volpestyle/codebase-atlas"), {
    owner: "Volpestyle",
    repository: "codebase-atlas",
    url: "https://github.com/Volpestyle/codebase-atlas",
  });
  assert.equal(parseGitHubRepositoryUrl("github.com/tauri-apps/tauri.git/tree/dev").repository, "tauri");
});

test("rejects non-GitHub and incomplete URLs", () => {
  assert.throws(() => parseGitHubRepositoryUrl("https://example.com/owner/repo"), /github\.com/);
  assert.throws(() => parseGitHubRepositoryUrl("https://github.com/owner"), /owner\/repository/);
});

test("builds a bounded metadata graph without generated directories", () => {
  const graph = githubTreeToGraph(
    {
      name: "atlas",
      full_name: "example/atlas",
      default_branch: "main",
      html_url: "https://github.com/example/atlas",
    },
    {
      truncated: false,
      tree: [
        { path: "src", type: "tree" },
        { path: "src/main.ts", type: "blob", size: 120 },
        { path: "README.md", type: "blob", size: 40 },
        { path: "node_modules", type: "tree" },
        { path: "node_modules/dependency.js", type: "blob", size: 500 },
      ],
    },
  );

  assert.equal(graph.source, "github");
  assert.equal(graph.stats.files, 2);
  assert.equal(graph.stats.directories, 1);
  assert.equal(graph.stats.bytes, 160);
  assert.equal(graph.stats.lineCountAvailable, false);
  assert.equal(graph.nodes[0].sizeBytes, 160);
  assert.deepEqual(
    graph.nodes.map((node) => node.id),
    [".", "README.md", "src", "src/main.ts"],
  );
});

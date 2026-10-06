import assert from "node:assert/strict";
import test from "node:test";

import { scanGitHubRepository } from "../src/github.ts";
import { MAX_STORY_BYTES, readStory } from "../src/storyValidation.ts";

function good() {
  return {
    summary: "A tiny thing.",
    actors: [
      { id: "user", name: "A person", role: "person", blurb: "Types." },
      { id: "api", name: "The door", role: "door", blurb: "Listens.", modules: ["web"] },
      { id: "brain", name: "The mind", role: "core", blurb: "Decides.", modules: ["gone"] },
    ],
    flows: [
      { from: "user", to: "api", carries: "a request", returns: "an answer" },
      { from: "api", to: "brain", carries: "the work" },
    ],
    journeys: [{ name: "Ask", steps: ["user", "api", "brain", "api", "user"] }],
  };
}

test("reads a story, drops stale paths, and allows journeys in either direction", () => {
  const warnings: string[] = [];
  const story = readStory(JSON.stringify(good()), new Set([".", "web"]), warnings)!;
  assert.equal(story.actors.length, 3);
  assert.deepEqual(story.actors[1].modules, ["web"]);
  assert.equal(story.actors[2].modules, undefined);
  assert.equal(story.journeys.length, 1);
  assert.deepEqual(warnings, ["Story: 1 path(s) are not in this repository and were dropped: gone."]);
});

test("drops a journey at its first unsupported step and silently drops short journeys", () => {
  const body = good();
  body.journeys = [
    { name: "Ask", steps: ["user", "brain", "unknown"] },
    { name: "Short", steps: ["unknown"] },
    { name: "Empty", steps: [] },
  ];
  const warnings: string[] = [];
  const story = readStory(JSON.stringify(body), new Set(["web", "gone"]), warnings)!;
  assert.deepEqual(story.journeys, []);
  assert.deepEqual(warnings, ['Story: journey "Ask" has no flow from user to brain.']);
});

test("drops duplicate actors before modules and dangling flows before journeys", () => {
  const body = good();
  body.actors.push({ ...body.actors[1], modules: ["duplicate-only"] });
  body.flows.push({ from: "brain", to: "missing", carries: "nothing" });
  body.journeys.push({ name: "Missing", steps: ["brain", "missing"] });
  const warnings: string[] = [];
  const story = readStory(JSON.stringify(body), new Set(["web"]), warnings)!;
  assert.equal(story.actors.length, 3);
  assert.equal(story.flows.length, 2);
  assert.equal(story.journeys.length, 1);
  assert.deepEqual(warnings, [
    'Story: actor "api" is defined twice.',
    "Story: 1 path(s) are not in this repository and were dropped: gone.",
    "Story: 1 flow(s) name an actor the story does not define.",
    'Story: journey "Missing" has no flow from brain to missing.',
  ]);
});

test("a missing story is not a warning, and an empty story is not attached", () => {
  const warnings: string[] = [];
  assert.equal(readStory(undefined, new Set(), warnings), undefined);
  assert.equal(readStory('{"summary":"Empty","actors":[],"flows":[]}', new Set(), warnings), undefined);
  assert.deepEqual(warnings, []);
});

test("malformed JSON, unknown roles, and wrong field types reject the whole story", () => {
  for (const body of [
    "{ not json",
    JSON.stringify({ ...good(), actors: [{ ...good().actors[0], role: "mystery" }] }),
    JSON.stringify({ ...good(), summary: null }),
    JSON.stringify({ ...good(), journeys: null }),
    JSON.stringify({ ...good(), actors: [{ ...good().actors[0], modules: null }] }),
    JSON.stringify({ ...good(), flows: [{ from: "user", to: "api" }] }),
  ]) {
    const warnings: string[] = [];
    assert.equal(readStory(body, new Set(), warnings), undefined);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /^The story file could not be read: /);
  }
});

test("serde defaults, optional nulls, and extra fields are accepted", () => {
  const warnings: string[] = [];
  const story = readStory(JSON.stringify({
    summary: "A thing.",
    actors: [good().actors[0]],
    flows: [{ from: "user", to: "user", carries: "a thought", returns: null }],
    extra: true,
  }), new Set(), warnings)!;
  assert.deepEqual(story.journeys, []);
  assert.equal(story.flows[0].returns, undefined);
  assert.deepEqual(warnings, []);
});

test("the size cap counts UTF-8 bytes and allows exactly 256 KiB", () => {
  const minimal = JSON.stringify({ summary: "é", actors: [good().actors[0]], flows: [] });
  const atCap = minimal + " ".repeat(MAX_STORY_BYTES - new TextEncoder().encode(minimal).length);
  const warnings: string[] = [];
  assert.ok(readStory(atCap, new Set(), warnings));
  assert.equal(readStory(atCap + " ", new Set(), warnings), undefined);
  assert.deepEqual(warnings, ["The story file is too large to read."]);
});

test("GitHub attaches a committed story with one extra versioned request on the default branch", async (t) => {
  const calls: { url: string; headers: Headers }[] = [];
  t.mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({ url, headers: new Headers(init.headers) });
    if (calls.length === 1) return Response.json({
      name: "demo", full_name: "owner/demo", default_branch: "feature/story", html_url: "https://github.com/owner/demo",
    });
    if (calls.length === 2) return Response.json({ tree: [
      { path: "web", type: "tree" },
      { path: ".codebase-index", type: "tree" },
      { path: ".codebase-index/_story.json", type: "blob", size: 1000 },
    ], truncated: false });
    return new Response(JSON.stringify(good()));
  });
  const graph = await scanGitHubRepository("https://github.com/owner/demo");
  assert.equal(calls.length, 3);
  assert.equal(calls[2].url, "https://api.github.com/repos/owner/demo/contents/.codebase-index/_story.json?ref=feature%2Fstory");
  assert.equal(calls[2].headers.get("accept"), "application/vnd.github.raw+json");
  assert.equal(calls[2].headers.get("x-github-api-version"), "2026-03-10");
  assert.equal(graph.story?.summary, "A tiny thing.");
  assert.equal(graph.story?.journeys.length, 1);
  assert.ok(graph.nodes.every((node) => !node.id.startsWith(".codebase-index")));
  assert.deepEqual(graph.warnings, ["Story: 1 path(s) are not in this repository and were dropped: gone."]);
});

test("GitHub continues for missing, oversized, malformed, and unreadable stories", async (t) => {
  for (const scenario of ["missing", "large-tree", "large-body", "malformed", "http", "network", "body", "utf8"] as const) {
    let calls = 0;
    const mock = t.mock.method(globalThis, "fetch", async () => {
      calls += 1;
      if (calls === 1) return Response.json({ name: "demo", full_name: "owner/demo", default_branch: "main", html_url: "https://github.com/owner/demo" });
      if (calls === 2) return Response.json({
        tree: scenario === "missing" ? [] : [{ path: ".codebase-index/_story.json", type: "blob", size: scenario === "large-tree" ? MAX_STORY_BYTES + 1 : 1 }],
        truncated: true,
      });
      if (scenario === "network") throw new Error("offline");
      if (scenario === "http") return new Response("Gone", { status: 404 });
      if (scenario === "body") return new Response(new ReadableStream({ start(controller) { controller.error(new Error("interrupted")); } }));
      if (scenario === "utf8") return new Response(new Uint8Array([0xff]));
      return new Response(scenario === "large-body" ? " ".repeat(MAX_STORY_BYTES + 1) : "{ not json");
    });
    try {
      const graph = await scanGitHubRepository("https://github.com/owner/demo");
      assert.equal(graph.story, undefined);
      assert.equal(graph.nodes.length, 1);
      assert.equal(calls, scenario === "missing" || scenario === "large-tree" ? 2 : 3);
      assert.equal(graph.warnings[0], "GitHub returned a partial tree; the map shows the available entries.");
      if (scenario === "missing") assert.equal(graph.warnings.length, 1);
      else if (scenario.startsWith("large")) assert.equal(graph.warnings[1], "The story file is too large to read.");
      else if (scenario === "malformed") assert.match(graph.warnings[1], /^The story file could not be read: /);
      else assert.equal(graph.warnings[1], "Could not read the story file.");
    } finally {
      mock.mock.restore();
    }
  }
});

test("known figures survive and unknown figures warn and use role defaults", () => {
  for (const figure of ["riffle", "loupe", "phone", "unknown", ""]) {
    const body = { ...good(), actors: [{ ...good().actors[1], figure }], flows: [], journeys: [] };
    const warnings: string[] = [];
    const story = readStory(JSON.stringify(body), new Set(["web"]), warnings)!;
    if (figure === "unknown" || figure === "") {
      assert.equal(story.actors[0].figure, undefined);
      assert.deepEqual(warnings, [`Story: actor "api" has unknown figure "${figure}"; using the role default.`]);
    } else {
      assert.equal(story.actors[0].figure, figure);
      assert.deepEqual(warnings, []);
    }
  }
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { journeyIndex, mermaidText, storyMermaid } from "../src/mermaid.ts";
import type { Story } from "../src/model.ts";
const fixture = JSON.parse(fs.readFileSync(new URL("./mermaid-fixture.json", import.meta.url), "utf8"));
const story: Story = fixture.story;
test("Mermaid matches the shared Rust fixture, including return fallback and escaping", () => {
  assert.equal(storyMermaid(story), fixture.flowchart);
  assert.equal(storyMermaid(story, 0), fixture.sequence);
  assert(storyMermaid(story, 0).includes("a2-->>a1: Work"));
  assert.equal(mermaidText('end;\n%%{init: "bad"}%% <x> 🌱'), '#101;nd#59; #37;#37;#123;init#58; #34;bad#34;#125;#37;#37; #60;x#62; #127793;');
  assert.equal(mermaidText(' a\uFEFFb\u0085c '), 'a b c');
  assert.equal(mermaidText('\u0000'), '#0;');
});
test("journey selectors use exact names before 1-based indices and reject missing journeys", () => {
  assert.equal(journeyIndex(story, "1"), 0);
  assert.equal(journeyIndex(story, "Ask [end]"), 0);
  assert.equal(journeyIndex({ ...story, journeys: [{ name: "2", steps: [] }, ...story.journeys] }, "2"), 0);
  for (const selector of ["0", "2", "1.5", "missing", "99999999999999999999"]) assert.throws(() => journeyIndex(story, selector));
  assert.throws(() => storyMermaid(story, 5));
  assert.equal(storyMermaid({ ...story, actors: [], flows: [], journeys: [] }).split("\n")[1], "flowchart LR");
});

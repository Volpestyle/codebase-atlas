import assert from "node:assert/strict";
import test from "node:test";

import type { Story } from "../src/model.ts";
import {
  actorForNode,
  buildStoryLayout,
  journeyHops,
  neighborhood,
  wrapText,
} from "../src/storyLayout.ts";

const story: Story = {
  summary: "A tiny service.",
  actors: [
    { id: "user", name: "A person", role: "person", blurb: "Types things." },
    {
      id: "bot",
      name: "The chat body",
      role: "surface",
      blurb: "Watches chat.",
      modules: ["apps/bot"],
    },
    {
      id: "api",
      name: "The front door",
      role: "door",
      blurb: "Checks the caller.",
      modules: ["src/app.ts"],
    },
    { id: "brain", name: "The mind", role: "core", blurb: "Decides.", modules: ["src/mind"] },
    { id: "notes", name: "Memory", role: "store", blurb: "Remembers." },
    { id: "model", name: "The model", role: "external", blurb: "Writes the words." },
  ],
  flows: [
    { from: "user", to: "bot", carries: "a message", returns: "the reply" },
    { from: "bot", to: "api", carries: "the message and who sent it" },
    { from: "api", to: "brain", carries: "a turn to take", returns: "what to say" },
    { from: "brain", to: "notes", carries: "who is this?", returns: "what we know" },
    { from: "brain", to: "model", carries: "the conversation", returns: "the words" },
  ],
  journeys: [
    {
      name: "Someone asks a question",
      steps: ["user", "bot", "api", "brain", "model", "brain", "api"],
    },
  ],
};

test("role is the column, and empty roles do not leave a gap", () => {
  const layout = buildStoryLayout(story);
  assert.deepEqual(
    layout.columns.map((column) => column.role),
    ["person", "surface", "door", "core", "store", "external"],
  );

  const withoutStores: Story = {
    ...story,
    actors: story.actors.filter((actor) => actor.role !== "store"),
    flows: story.flows.filter((flow) => flow.to !== "notes"),
    journeys: [],
  };
  const collapsed = buildStoryLayout(withoutStores);
  assert.deepEqual(
    collapsed.columns.map((column) => column.role),
    ["person", "surface", "door", "core", "external"],
  );
  // Columns stay evenly spaced rather than leaving a hole where stores were.
  const gaps = collapsed.columns.slice(1).map((column, index) => column.x - collapsed.columns[index].x);
  assert.equal(new Set(gaps).size, 1);
});

test("cards in one column stack without overlapping", () => {
  const crowded: Story = {
    ...story,
    actors: [
      ...story.actors,
      { id: "cli", name: "A terminal", role: "surface", blurb: "Also watches." },
      { id: "phone", name: "A phone", role: "surface", blurb: "Reaches in from away." },
    ],
    journeys: [],
  };
  const layout = buildStoryLayout(crowded);
  const column = layout.cards.filter((card) => card.actor.role === "surface");
  assert.equal(column.length, 3);
  for (let index = 1; index < column.length; index += 1) {
    const above = column[index - 1];
    assert.ok(column[index].y >= above.y + above.height, "cards overlap");
  }
});

test("a journey step against a flow reads as its return text", () => {
  const hops = journeyHops(story.journeys[0], story.flows);
  assert.equal(hops.length, 6);
  assert.deepEqual(
    hops.map((hop) => hop.text),
    [
      "a message",
      "the message and who sent it",
      "a turn to take",
      "the conversation",
      "the words",
      "what to say",
    ],
  );
  assert.deepEqual(
    hops.map((hop) => hop.reversed),
    [false, false, false, false, true, true],
  );
});

test("a hop with no flow behind it is dropped rather than drawn", () => {
  const hops = journeyHops(
    { name: "Impossible", steps: ["user", "model"] },
    story.flows,
  );
  assert.deepEqual(hops, []);
});

test("a reverse hop with no return text falls back to what the flow carries", () => {
  const hops = journeyHops({ name: "Back", steps: ["api", "bot"] }, story.flows);
  assert.equal(hops[0].text, "the message and who sent it");
  assert.equal(hops[0].reversed, true);
});

test("a selection anywhere under a module lands on its actor", () => {
  assert.equal(actorForNode(story, "src/mind/turn.ts"), "brain");
  assert.equal(actorForNode(story, "apps/bot"), "bot");
  assert.equal(actorForNode(story, "src/app.ts"), "api");
  assert.equal(actorForNode(story, "docs/readme.md"), null);
  assert.equal(actorForNode(story, null), null);
});

test("hovering an actor lights only what it touches", () => {
  const near = neighborhood("brain", story.flows);
  assert.deepEqual([...near.actors].sort(), ["api", "brain", "model", "notes"]);
  assert.equal(near.edges.size, 3);
});

test("wrapText breaks on words and elides an overlong blurb", () => {
  assert.deepEqual(wrapText("one two three", 9, 5), ["one two", "three"]);
  const long = wrapText("alpha beta gamma delta epsilon zeta eta theta", 11, 2);
  assert.equal(long.length, 2);
  assert.ok(long[1].endsWith("…"));
});

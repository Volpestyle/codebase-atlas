import test from "node:test";
import assert from "node:assert/strict";
import { buildSequenceLayout } from "../src/sequenceLayout.ts";
import { journeyHops } from "../src/journey.ts";
import { story } from "./story-fixtures.ts";

test("sequence columns follow first visits, repeats get separate rows and returns retain direction", () => {
  const hops = journeyHops({ name: "Round trip", steps: ["user", "app", "core", "app", "user"] }, story.flows);
  const layout = buildSequenceLayout(story.actors, hops, 900);
  assert.deepEqual(layout.columns.map(c => c.actor.id), ["user", "app", "core"]);
  assert.equal(layout.rows.length, 4);
  assert.equal(layout.rows[3].hop.text, "a reply");
  assert(layout.rows[3].x1 > layout.rows[3].x2);
  assert(layout.rows[3].hop.reversed);
  assert(layout.width >= 900);
  for (let i = 1; i < layout.rows.length; i++) assert(layout.rows[i].top >= layout.rows[i - 1].top + layout.rows[i - 1].height);
});

test("long messages grow rows without clipping; narrow diagrams overflow only their container", () => {
  const text = "A very long sentence about what travels between the parts. ".repeat(12).trim();
  const hops = [{ from: "user", to: "app", text, flow: story.flows[0], reversed: false }];
  const layout = buildSequenceLayout(story.actors, hops, 200);
  assert(layout.width >= 320);
  assert(layout.rows[0].height > 82);
  assert.equal(layout.rows[0].lines.join(" "), text);
  assert(layout.rows[0].left + layout.rows[0].labelWidth <= layout.width);
  const self = buildSequenceLayout(story.actors, [{ ...hops[0], to: "user" }], 800);
  assert(self.rows[0].d.includes("v 12"));
  assert.equal(buildSequenceLayout([], [], 800).rows.length, 0);
});

import assert from "node:assert/strict";
import test from "node:test";
import { journeyHops, wrapText } from "../src/journey.ts";
import { story } from "./story-fixtures.ts";

test("journeys resolve forward/return sentences and drop missing connections", () => {
  const hops = journeyHops({name:"Return",steps:["user","app","user","core"]}, story.flows);
  assert.deepEqual(hops.map(hop => [hop.text,hop.reversed]), [["a request",false],["a reply",true]]);
  assert.equal(journeyHops({name:"Back",steps:["core","app"]},story.flows)[0].text,"the work");
});
test("transit label wrapping is bounded and breaks at words", () => {
  assert.deepEqual(wrapText("one two three",9,5),["one two","three"]);
  const result=wrapText("alpha beta gamma delta epsilon zeta",11,2);
  assert.equal(result.length,2); assert.ok(result[1].endsWith("…"));
});

test("journey hops: short journeys have none, forward flows win, missing returns read carries", () => {
  assert.deepEqual(journeyHops({ name: "None", steps: [] }, story.flows), []);
  assert.deepEqual(journeyHops({ name: "One", steps: ["user"] }, story.flows), []);
  const both = [...story.flows, { from: "app", to: "user", carries: "a push" }];
  assert.deepEqual(journeyHops({ name: "Back", steps: ["app", "user"] }, both).map(hop => [hop.text, hop.reversed]), [["a push", false]]);
  assert.deepEqual(journeyHops({ name: "Back", steps: ["app", "user"] }, story.flows).map(hop => [hop.text, hop.reversed]), [["a reply", true]]);
  assert.deepEqual(journeyHops({ name: "Back", steps: ["core", "app"] }, story.flows).map(hop => [hop.text, hop.reversed]), [["the work", true]]);
});
test("wrapping breaks long words, ignores repeated whitespace, and handles empty text", () => {
  assert.deepEqual(wrapText("", 10, 2), []);
  assert.deepEqual(wrapText("   ", 10, 2), []);
  assert.deepEqual(wrapText("a  b", 1, 2), ["a", "b"]);
  assert.deepEqual(wrapText("supercalifragilistic", 8, 3), ["supercal", "ifragili", "stic"]);
  assert.deepEqual(wrapText("supercalifragilistic", 8, 2), ["supercal", "ifragil…"]);
  for (const line of wrapText("a reallyreallyreallylongword here", 10, 3)) assert.ok(line.length <= 10, line);
  assert.deepEqual(wrapText("one two three", 9, 0), []);
  assert.deepEqual(wrapText("one two three", 9, 1), ["one two…"]);
});

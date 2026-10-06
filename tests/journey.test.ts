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

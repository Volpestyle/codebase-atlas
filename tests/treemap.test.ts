import assert from "node:assert/strict";
import test from "node:test";
import { fileWeight, packTreemap } from "../src/treemap.ts";
import { node } from "./story-fixtures.ts";

test("territory retains weighted volume for text, data and bounded assets", () => {
  assert.equal(fileWeight(node("a.ts",10),true),10);
  assert.equal(fileWeight(node("README.md",10,"documentation"),true),10);
  assert.equal(fileWeight(node("a.json",40,"config"),true),10);
  assert.equal(fileWeight({...node("a.png",0,"asset"),sizeBytes:20480},true),10);
  assert.equal(fileWeight({...node("a.png",0,"asset"),sizeBytes:2**30},true),64);
  assert.equal(fileWeight({...node("a.ts",0),sizeBytes:640},false),10);
});
test("squarified cells partition their rectangle without overlap", () => {
  const cells=[...packTreemap([{id:"a",area:5000},{id:"b",area:3000},{id:"c",area:2000}],100,100).values()];
  assert.ok(Math.abs(cells.reduce((sum,c)=>sum+c.width*c.height,0)-10000)<.001);
  for(let i=0;i<cells.length;i++) for(let j=i+1;j<cells.length;j++) {
    const a=cells[i],b=cells[j];
    const overlapX=Math.min(a.x+a.width,b.x+b.width)-Math.max(a.x,b.x);
    const overlapY=Math.min(a.y+a.height,b.y+b.height)-Math.max(a.y,b.y);
    assert.ok(overlapX<.001 || overlapY<.001);
  }
});

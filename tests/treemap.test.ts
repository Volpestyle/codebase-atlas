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

test("treemap edge cases stay finite and inside the rectangle", () => {
  assert.deepEqual([...packTreemap([{ id: "only", area: 1200 }], 40, 30).values()], [{ x: 0, y: 0, width: 40, height: 30 }]);
  assert.equal(packTreemap([{ id: "a", area: 1 }], 0, 30).size, 0);
  assert.equal(packTreemap([], 10, 10).size, 0);
  for (const [width, height, items] of [
    [100, 100, [{ id: "a", area: 10000 }, { id: "zero", area: 0 }, { id: "nan", area: Number.NaN }]],
    [100, 100, [{ id: "a", area: 0 }, { id: "b", area: 0 }]],
    [1000, 1, [{ id: "a", area: 999 }, { id: "b", area: 1 }]],
    [1, 1000, [{ id: "a", area: 1 }, { id: "b", area: 999 }]],
    [300, 200, Array.from({ length: 60 }, (_, i) => ({ id: String(i), area: i === 0 ? 50000 : 10000 / 59 }))],
  ] as const) {
    const cells = packTreemap([...items], width, height);
    assert.equal(cells.size, items.length);
    for (const [id, cell] of cells) {
      for (const value of Object.values(cell)) assert.ok(Number.isFinite(value), id);
      assert.ok(cell.width >= 0 && cell.height >= 0, id);
      assert.ok(cell.x >= -.001 && cell.y >= -.001 && cell.x + cell.width <= width + .001 && cell.y + cell.height <= height + .001, `${id} ${JSON.stringify(cell)}`);
    }
  }
});

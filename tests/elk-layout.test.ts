import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { buildNetworkLayout } from "../src/elkLayout.ts";
import { ACTOR_ROLES, type Story } from "../src/model.ts";
import { story } from "./story-fixtures.ts";

test("ELK is deterministic, places every part and routes orthogonally without crossing part boxes", async () => {
  const atlas: Story = JSON.parse(fs.readFileSync(new URL("../.codebase-index/_story.json", import.meta.url), "utf8"));
  const layout = await buildNetworkLayout(atlas);
  assert.deepEqual(await buildNetworkLayout(atlas), layout);
  assert.equal(layout.parts.length, atlas.actors.length);
  assert.equal(layout.routes.length, atlas.flows.length);
  for (const part of layout.parts) {
    assert(part.x >= 0 && part.y >= 0 && part.x + part.width <= layout.width && part.y + part.height <= layout.height);
    for (const other of layout.parts) if (part !== other) assert(!(part.x < other.x + other.width && part.x + part.width > other.x && part.y < other.y + other.height && part.y + part.height > other.y));
  }
  for (const route of layout.routes) for (let i = 1; i < route.points.length; i++) {
    const a = route.points[i - 1]; const b = route.points[i];
    // ELK can emit the same coordinate with sub-pixel floating-point roundoff.
    const vertical = Math.abs(a.x - b.x) < 1e-6;
    const horizontal = Math.abs(a.y - b.y) < 1e-6;
    assert(vertical || horizontal);
    for (const part of layout.parts) {
      if (part.actor.id === route.flow.from || part.actor.id === route.flow.to) continue;
      assert(!(vertical && a.x > part.x && a.x < part.x + part.width && Math.max(a.y, b.y) > part.y && Math.min(a.y, b.y) < part.y + part.height));
      assert(!(horizontal && a.y > part.y && a.y < part.y + part.height && Math.max(a.x, b.x) > part.x && Math.min(a.x, b.x) < part.x + part.width));
    }
  }
  for (let i = 0; i < ACTOR_ROLES.length - 1; i++) {
    const earlier = layout.parts.filter(part => ACTOR_ROLES.indexOf(part.actor.role) <= i);
    const later = layout.parts.filter(part => ACTOR_ROLES.indexOf(part.actor.role) > i);
    if (earlier.length && later.length) assert(Math.max(...earlier.map(part => part.x)) < Math.min(...later.map(part => part.x)));
  }
});
test("ELK handles isolated actors, no parts, same-role exchanges and cycles", async () => {
  const empty = await buildNetworkLayout({ ...story, actors: [], flows: [] });
  assert.equal(empty.parts.length, 0);
  const isolated = await buildNetworkLayout({ ...story, flows: [] });
  assert.equal(isolated.parts.length, 3);
  const cycle = await buildNetworkLayout({ ...story, actors: story.actors.map(a => ({ ...a, role: "core" })), flows: [...story.flows, { from: "core", to: "user", carries: "Returns." }, { from: "core", to: "core", carries: "Self." }] });
  assert.equal(cycle.routes.length, 4);
});

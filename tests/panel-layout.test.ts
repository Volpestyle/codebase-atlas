import assert from "node:assert/strict";
import test from "node:test";
import {
  clampPanelWidths,
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_RAIL_WIDTH,
  layoutModeForViewport,
  maxInspectorWidth,
  maxRailWidth,
  MIN_INSPECTOR_WIDTH,
  MIN_MAP_WIDTH,
  MIN_RAIL_WIDTH,
  parsePanelWidths,
  resizePanel,
} from "../src/panelLayout.ts";

test("classifies viewport layout modes at the overlay breakpoints", () => {
  assert.equal(layoutModeForViewport(721), "medium");
  assert.equal(layoutModeForViewport(720), "narrow");
  assert.equal(layoutModeForViewport(981), "wide");
  assert.equal(layoutModeForViewport(980), "medium");
});

test("parses finite panel widths and rejects malformed payloads", () => {
  assert.deepEqual(parsePanelWidths({ rail: 300, inspector: 280 }), { rail: 300, inspector: 280 });
  assert.equal(parsePanelWidths({ rail: 300 }), null);
  assert.equal(parsePanelWidths({ rail: "300", inspector: 280 }), null);
  assert.equal(parsePanelWidths({ rail: Number.NaN, inspector: 280 }), null);
});

test("keeps default docked widths on a wide workspace", () => {
  assert.deepEqual(
    clampPanelWidths(
      { rail: DEFAULT_RAIL_WIDTH, inspector: DEFAULT_INSPECTOR_WIDTH },
      1400,
      "wide",
    ),
    { rail: DEFAULT_RAIL_WIDTH, inspector: DEFAULT_INSPECTOR_WIDTH },
  );
});

test("caps a docked rail so the map keeps its minimum width", () => {
  const widths = clampPanelWidths({ rail: 900, inspector: DEFAULT_INSPECTOR_WIDTH }, 1200, "wide");
  assert.equal(widths.rail + widths.inspector + MIN_MAP_WIDTH, 1200);
  assert.ok(widths.rail <= 1200 - MIN_MAP_WIDTH - MIN_INSPECTOR_WIDTH);
  assert.equal(widths.inspector, DEFAULT_INSPECTOR_WIDTH);
});

test("caps a docked inspector without stealing the rail's default width", () => {
  const widths = clampPanelWidths({ rail: DEFAULT_RAIL_WIDTH, inspector: 900 }, 1200, "wide");
  assert.equal(widths.rail, DEFAULT_RAIL_WIDTH);
  assert.equal(widths.inspector, 1200 - MIN_MAP_WIDTH - DEFAULT_RAIL_WIDTH);
});

test("overlay modes resize one panel without shrinking the other", () => {
  const medium = clampPanelWidths({ rail: 500, inspector: 400 }, 900, "medium");
  assert.equal(medium.rail, 500);
  assert.equal(medium.inspector, 400);
  const narrow = clampPanelWidths({ rail: 800, inspector: 800 }, 400, "narrow");
  assert.ok(narrow.rail <= Math.floor(400 * 0.88));
  assert.ok(narrow.inspector <= Math.floor(400 * 0.86));
});

test("drag maxima freeze the opposite docked panel", () => {
  assert.equal(maxRailWidth(1200, 306, "wide"), 1200 - MIN_MAP_WIDTH - 306);
  assert.equal(maxInspectorWidth(1200, 252, "wide"), 1200 - MIN_MAP_WIDTH - 252);
  assert.equal(maxRailWidth(800, 306, "medium"), 800 - MIN_MAP_WIDTH);
  assert.equal(maxInspectorWidth(800, 252, "medium"), Math.floor(800 * 0.86));
});

test("resizePanel clamps to the inclusive min and max", () => {
  assert.equal(resizePanel(252, 40, MIN_RAIL_WIDTH, 300), 292);
  assert.equal(resizePanel(252, 400, MIN_RAIL_WIDTH, 300), 300);
  assert.equal(resizePanel(252, -400, MIN_RAIL_WIDTH, 300), MIN_RAIL_WIDTH);
});

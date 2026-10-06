import type { RepositoryNode } from "./model.ts";

// Weighted code volume, not raw magnitude: source and documentation count in
// full, config/data lines are discounted (serialized JSON is not code), and
// binary assets contribute only a small presence weight so a folder of images
// cannot dominate the map.
export function fileWeight(node: RepositoryNode, lineCountAvailable: boolean): number {
  if (node.kind === "asset") return Math.max(0.5, Math.min(64, node.sizeBytes / 2048));
  const dataDiscount = node.kind === "config" ? 0.25 : 1;
  const value = lineCountAvailable ? node.lines : node.sizeBytes / 64;
  return Math.max(1, value) * dataDiscount;
}

export interface TreemapCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Squarified treemap: partitions a rectangle among weighted items, keeping
// tiles near-square so they stay readable. Areas are normalized by the caller
// to the rectangle before packing; zero, negative and non-finite areas get an
// empty tile rather than NaN.
export function packTreemap(
  items: { id: string; area: number }[],
  width: number,
  height: number,
): Map<string, TreemapCell> {
  const tiles = new Map<string, TreemapCell>();
  if (!(width > 0) || !(height > 0) || items.length === 0) return tiles;
  const remaining = items.map(item => ({ id: item.id, area: Number.isFinite(item.area) ? Math.max(0, item.area) : 0 }))
    .sort((left, right) => right.area - left.area);
  const free = { x: 0, y: 0, width, height };

  while (remaining.length > 0) {
    const shortSide = Math.max(1e-6, Math.min(free.width, free.height));
    const row: { id: string; area: number }[] = [];
    let rowArea = 0;
    let bestWorst = Number.POSITIVE_INFINITY;
    while (remaining.length > 0) {
      const candidate = remaining[0];
      const nextArea = rowArea + candidate.area;
      const thickness = Math.max(1e-9, nextArea / shortSide);
      let worst = 0;
      for (const item of [...row, candidate]) {
        const length = Math.max(1e-9, item.area / thickness);
        worst = Math.max(worst, thickness / length, length / thickness);
      }
      if (row.length > 0 && worst > bestWorst) break;
      row.push(remaining.shift()!);
      rowArea = nextArea;
      bestWorst = worst;
    }

    // Clamp so float drift never pushes a tile past the rectangle.
    const thickness = Math.min(rowArea / shortSide, free.width >= free.height ? free.width : free.height);
    const along = (area: number) => thickness > 0 ? area / thickness : 0;
    if (free.width >= free.height) {
      // A column against the left edge, tiles stacked top to bottom.
      let y = free.y;
      for (const item of row) {
        const length = Math.min(along(item.area), free.y + free.height - y);
        tiles.set(item.id, { x: free.x, y, width: thickness, height: length });
        y += length;
      }
      free.x += thickness; free.width -= thickness;
    } else {
      // A row against the top edge, tiles laid left to right.
      let x = free.x;
      for (const item of row) {
        const length = Math.min(along(item.area), free.x + free.width - x);
        tiles.set(item.id, { x, y: free.y, width: length, height: thickness });
        x += length;
      }
      free.y += thickness; free.height -= thickness;
    }
  }
  return tiles;
}

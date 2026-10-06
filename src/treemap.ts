import type { RepositoryNode } from "./model.ts";

interface Rect {
  x0: number;
  z0: number;
  x1: number;
  z1: number;
}

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

// Squarified treemap: partitions a rectangle among weighted items, keeping
// cells near-square so districts stay readable.
function squarify(items: { id: string; area: number }[], rect: Rect): Map<string, Rect> {
  const cells = new Map<string, Rect>();
  const remaining = [...items].sort((left, right) => right.area - left.area);
  const free: Rect = { ...rect };

  while (remaining.length > 0) {
    const freeWidth = free.x1 - free.x0;
    const freeDepth = free.z1 - free.z0;
    const shortSide = Math.max(1e-6, Math.min(freeWidth, freeDepth));

    const row: { id: string; area: number }[] = [];
    let rowArea = 0;
    let bestWorst = Number.POSITIVE_INFINITY;
    while (remaining.length > 0) {
      const candidate = remaining[0];
      const nextArea = rowArea + candidate.area;
      const thickness = nextArea / shortSide;
      let worst = 0;
      for (const item of [...row, candidate]) {
        const length = item.area / Math.max(1e-9, thickness);
        worst = Math.max(worst, thickness / Math.max(1e-9, length), length / thickness);
      }
      if (row.length > 0 && worst > bestWorst) break;
      row.push(remaining.shift()!);
      rowArea = nextArea;
      bestWorst = worst;
    }

    const thickness = rowArea / shortSide;
    if (freeWidth >= freeDepth) {
      // Vertical strip against the left edge, items stacked along z.
      let z = free.z0;
      for (const item of row) {
        const length = item.area / Math.max(1e-9, thickness);
        cells.set(item.id, { x0: free.x0, z0: z, x1: free.x0 + thickness, z1: z + length });
        z += length;
      }
      free.x0 += thickness;
    } else {
      // Horizontal strip against the near edge, items laid along x.
      let x = free.x0;
      for (const item of row) {
        const length = item.area / Math.max(1e-9, thickness);
        cells.set(item.id, { x0: x, z0: free.z0, x1: x + length, z1: free.z0 + thickness });
        x += length;
      }
      free.z0 += thickness;
    }
  }
  return cells;
}

export interface TreemapCell {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Areas are normalized by the caller to the rectangle before packing.
export function packTreemap(
  items: { id: string; area: number }[],
  width: number,
  height: number,
): Map<string, TreemapCell> {
  const packed = new Map<string, TreemapCell>();
  if (width <= 0 || height <= 0 || items.length === 0) return packed;
  const cells = squarify(items, { x0: 0, z0: 0, x1: width, z1: height });
  for (const [id, cell] of cells) {
    packed.set(id, {
      x: cell.x0,
      y: cell.z0,
      width: cell.x1 - cell.x0,
      height: cell.z1 - cell.z0,
    });
  }
  return packed;
}

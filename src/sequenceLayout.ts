import type { StoryActor } from "./model.ts";
import { wrapText, type JourneyHop } from "./journey.ts";

/** A sequence owns a column per first visit, and a distinct row per exchange,
 *  including repeats. Long sentences grow the row instead of being clipped. */
export function buildSequenceLayout(actors: StoryActor[], hops: JourneyHop[], availableWidth: number) {
  const ids = [...new Set(hops.flatMap(hop => [hop.from, hop.to]))];
  const parts = ids.flatMap(id => actors.find(actor => actor.id === id) ?? []);
  const columnWidth = Math.max(116, Math.min(152, (availableWidth - 48) / Math.max(1, parts.length)));
  const width = Math.max(availableWidth, parts.length * columnWidth + 48, 320);
  const columns = parts.map((actor, index) => ({ actor, x: 24 + columnWidth * (index + 0.5), width: columnWidth, lines: wrapText(actor.name, Math.floor((columnWidth - 16) / 6.5), 1000) }));
  const byId = new Map(columns.map(column => [column.actor.id, column]));
  const headerHeight = Math.max(126, ...columns.map(column => 76 + column.lines.length * 16));
  let top = headerHeight + 12;
  const rows = hops.map((hop, index) => {
    const from = byId.get(hop.from)!; const to = byId.get(hop.to)!;
    const labelWidth = Math.min(400, width - 72);
    const lines = wrapText(hop.text, Math.floor((labelWidth - 44) / 6.5), 10000);
    const height = Math.max(82, lines.length * 19 + 42);
    const x1 = from.x + (from === to ? 0 : Math.sign(to.x - from.x) * 6);
    const x2 = to.x - (from === to ? 0 : Math.sign(to.x - from.x) * 6);
    const y = top + height - 18;
    const left = Math.max(24, Math.min(Math.min(from.x, to.x) - 6, width - labelWidth - 24));
    const d = from === to ? `M ${x1} ${y - 12} h 36 v 12 H ${x2}` : `M ${x1} ${y} H ${x2}`;
    const row = { hop, index, top, height, left, labelWidth, lines, x1, x2, y, d };
    top += height;
    return row;
  });
  return { width, height: top + 16, headerHeight, columns, byId, rows };
}

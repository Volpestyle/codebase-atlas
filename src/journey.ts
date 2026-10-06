import type { StoryFlow, StoryJourney } from "./model.ts";

export const flowKey = (flow: StoryFlow) => `${flow.from}→${flow.to}`;

/** Greedy word wrap to a character budget. A word longer than the budget is
 *  broken across lines; text beyond `maxLines` ends the last line with "…". */
export function wrapText(text: string, chars: number, maxLines: number): string[] {
  const width = Math.max(1, Math.floor(chars));
  if (maxLines < 1) return [];
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= width) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    while (line.length > width) {
      lines.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line) lines.push(line);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  kept[maxLines - 1] = `${kept[maxLines - 1].slice(0, width - 1).trimEnd()}…`;
  return kept;
}

export interface JourneyHop {
  from: string;
  to: string;
  /** The flow this hop rides, and the sentence for this direction of it. */
  flow: StoryFlow;
  text: string;
  /** True when the hop runs against the flow's drawn direction, so the text is
   *  its `returns` rather than its `carries`. */
  reversed: boolean;
}

/** A journey's steps resolved into hops, each carrying the sentence for the
 *  direction actually travelled. Steps with no flow behind them are dropped;
 *  the scanner warns about those, so the view need not. */
export function journeyHops(journey: StoryJourney, flows: StoryFlow[]): JourneyHop[] {
  const hops: JourneyHop[] = [];
  for (let index = 0; index + 1 < journey.steps.length; index += 1) {
    const from = journey.steps[index];
    const to = journey.steps[index + 1];
    const forward = flows.find((flow) => flow.from === from && flow.to === to);
    if (forward) {
      hops.push({ from, to, flow: forward, text: forward.carries, reversed: false });
      continue;
    }
    const backward = flows.find((flow) => flow.from === to && flow.to === from);
    if (backward) {
      hops.push({
        from,
        to,
        flow: backward,
        text: backward.returns ?? backward.carries,
        reversed: true,
      });
    }
  }
  return hops;
}

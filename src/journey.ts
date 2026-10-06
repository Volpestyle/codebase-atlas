import type { StoryFlow, StoryJourney } from "./model.ts";

export const flowKey = (flow: StoryFlow) => `${flow.from}→${flow.to}`;

/** Greedy word wrap to a character budget, longest overflow elided. */
export function wrapText(text: string, chars: number, maxLines: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length <= chars) {
      line = candidate;
      continue;
    }
    if (line) lines.push(line);
    line = word;
    if (lines.length === maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  if (lines.length === maxLines) {
    const last = lines[maxLines - 1];
    const consumed = lines.join(" ").length;
    if (consumed < text.length) {
      lines[maxLines - 1] = `${last.slice(0, Math.max(0, chars - 1))}…`;
    }
  }
  return lines;
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

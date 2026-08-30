import {
  ACTOR_ROLES,
  type ActorRole,
  type Story,
  type StoryActor,
  type StoryFlow,
  type StoryJourney,
} from "./model.ts";
// The .ts extension keeps this importable by the node:test runner, which
// strips types but does not resolve extensionless value imports.
import { parentPath } from "./placeNames.ts";

export const CARD_W = 212;
export const COL_GAP = 76;
export const CARD_GAP = 20;
export const MARGIN_X = 44;
export const HEADING_Y = 40;
export const TOP_Y = 74;
export const MARGIN_BOTTOM = 56;

const CARD_PAD = 14;
const NAME_H = 22;
const BLURB_LINE_H = 16;
// Each module gets its own row so it can be clicked on its own. An actor made
// of five files that opens only the first is a card that lies about itself.
const MODULE_ROW_H = 13;
const MODULES_GAP = 8;

// Characters per line at the blurb's serif size inside a card's padding. The
// story view lays itself out rather than measuring the DOM, so the whole
// diagram stays deterministic the way the map is.
const BLURB_CHARS = 30;
// Beyond this a blurb is an essay, not a caption; the tail is dropped so one
// long-winded actor cannot stretch its whole column.
const MAX_BLURB_LINES = 5;
// Past this an actor is a directory listing, not a role; the tail is counted
// rather than drawn.
export const MAX_CARD_MODULES = 6;

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

export interface ActorCard {
  actor: StoryActor;
  column: number;
  x: number;
  y: number;
  width: number;
  height: number;
  blurbLines: string[];
  /** One clickable row per module this actor is made of, with its baseline. */
  moduleRows: { path: string; y: number }[];
  /** Modules past the cap, counted but not drawn. */
  hiddenModules: number;
}

export interface FlowShape {
  flow: StoryFlow;
  key: string;
  path: string;
  arrow: string;
  /** Where a label for this flow sits, at the arc's midpoint. */
  labelX: number;
  labelY: number;
  /** True when the arrow runs right-to-left or within one column, which the
   *  eye needs drawn differently to stay readable. */
  back: boolean;
}

export interface StoryColumn {
  role: ActorRole;
  x: number;
}

export interface StoryLayout {
  cards: ActorCard[];
  cardById: Map<string, ActorCard>;
  flows: FlowShape[];
  columns: StoryColumn[];
  width: number;
  height: number;
}

export const flowKey = (flow: StoryFlow) => `${flow.from}→${flow.to}`;

function cardHeight(blurbLines: number, moduleCount: number) {
  return (
    CARD_PAD * 2 +
    NAME_H +
    blurbLines * BLURB_LINE_H +
    (moduleCount > 0 ? MODULES_GAP + moduleCount * MODULE_ROW_H : 0)
  );
}

export function buildStoryLayout(story: Story): StoryLayout {
  // Role is the column: the ordering of ACTOR_ROLES is the reading order, so
  // an honest role assignment is the whole layout. Empty roles collapse rather
  // than leaving a gap in a repository that has no outside services.
  const used = ACTOR_ROLES.filter((role) =>
    story.actors.some((actor) => actor.role === role),
  );
  const columns: StoryColumn[] = used.map((role, index) => ({
    role,
    x: MARGIN_X + index * (CARD_W + COL_GAP),
  }));
  const columnOf = new Map(used.map((role, index) => [role, index]));

  const cards: ActorCard[] = [];
  const nextY = used.map(() => TOP_Y);
  for (const actor of story.actors) {
    const column = columnOf.get(actor.role) ?? 0;
    const blurbLines = wrapText(actor.blurb, BLURB_CHARS, MAX_BLURB_LINES);
    const all = actor.modules ?? [];
    const shown = all.slice(0, MAX_CARD_MODULES);
    const height = cardHeight(blurbLines.length, shown.length);
    const top = nextY[column];
    const rowsTop = top + CARD_PAD + NAME_H + blurbLines.length * BLURB_LINE_H + MODULES_GAP;
    cards.push({
      actor,
      column,
      x: columns[column].x,
      y: top,
      width: CARD_W,
      height,
      blurbLines,
      moduleRows: shown.map((path, index) => ({
        path,
        y: rowsTop + index * MODULE_ROW_H,
      })),
      hiddenModules: all.length - shown.length,
    });
    nextY[column] += height + CARD_GAP;
  }

  const cardById = new Map(cards.map((card) => [card.actor.id, card]));
  const flows: FlowShape[] = [];
  for (const flow of story.flows) {
    const from = cardById.get(flow.from);
    const to = cardById.get(flow.to);
    if (!from || !to) continue;
    flows.push(shapeFlow(flow, from, to));
  }

  const height = Math.max(...nextY, TOP_Y) - CARD_GAP + MARGIN_BOTTOM;
  const width = columns.length
    ? columns[columns.length - 1].x + CARD_W + MARGIN_X
    : MARGIN_X * 2;
  return { cards, cardById, flows, columns, width, height };
}

function shapeFlow(flow: StoryFlow, from: ActorCard, to: ActorCard): FlowShape {
  const sy = from.y + from.height / 2;
  const ty = to.y + to.height / 2;
  const back = to.column <= from.column;
  let start: { x: number; y: number };
  let control: { x: number; y: number };
  let end: { x: number; y: number };

  if (!back) {
    // Forward: out the right edge of the sender, into the left edge of the
    // receiver — the direction the whole diagram reads.
    start = { x: from.x + from.width, y: sy };
    end = { x: to.x, y: ty };
    const bend = Math.max(40, (end.x - start.x) * 0.45);
    control = { x: end.x - bend, y: ty };
  } else if (to.column < from.column) {
    // A return path: something in the middle handing back out to a surface.
    start = { x: from.x, y: sy };
    end = { x: to.x + to.width, y: ty };
    control = { x: end.x + 48, y: ty };
  } else {
    // Same column: two things at the same stage talking to each other.
    start = { x: from.x, y: sy };
    end = { x: to.x, y: ty };
    control = { x: end.x - 60, y: ty };
  }
  const c1 = back
    ? { x: start.x - 48, y: sy }
    : { x: start.x + Math.max(40, (end.x - start.x) * 0.45), y: sy };
  const path = `M ${start.x} ${sy} C ${c1.x} ${c1.y}, ${control.x} ${control.y}, ${end.x} ${end.y}`;
  const angle = Math.atan2(end.y - control.y, end.x - control.x);
  const barb = (spread: number) =>
    `${end.x - Math.cos(angle + spread) * 9} ${end.y - Math.sin(angle + spread) * 9}`;
  return {
    flow,
    key: flowKey(flow),
    path,
    arrow: `M ${end.x} ${end.y} L ${barb(0.42)} L ${barb(-0.42)} Z`,
    // Midpoint of the cubic at t = 0.5, where a label sits on the line.
    labelX: (start.x + 3 * c1.x + 3 * control.x + end.x) / 8,
    labelY: (sy + 3 * c1.y + 3 * control.y + end.y) / 8,
    back,
  };
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

/** The actor a scanned node belongs to, so a selection made on the map or in
 *  the flow view lands somewhere in the story. Walks up the path the way the
 *  flow view finds a chip for a file. */
export function actorForNode(story: Story, nodeId: string | null): string | null {
  if (!nodeId) return null;
  const owner = new Map<string, string>();
  for (const actor of story.actors) {
    for (const module of actor.modules ?? []) owner.set(module, actor.id);
  }
  let current: string | null = nodeId;
  while (current) {
    const found = owner.get(current);
    if (found) return found;
    current = parentPath(current);
  }
  return null;
}

/** Everything one actor touches: its flows and the actors on their far side. */
export function neighborhood(id: string, flows: StoryFlow[]) {
  const actors = new Set([id]);
  const edges = new Set<string>();
  for (const flow of flows) {
    if (flow.from !== id && flow.to !== id) continue;
    edges.add(flowKey(flow));
    actors.add(flow.from === id ? flow.to : flow.from);
  }
  return { actors, edges };
}

import { ACTOR_ROLES, ROLE_HEADINGS, type Story } from "./model.ts";
import { journeyHops } from "./journey.ts";

export const MERMAID_INIT = '%%{init: {"theme":"base","themeVariables":{"fontFamily":"Geist, system-ui, sans-serif","fontSize":"13px","primaryColor":"#ffffff","primaryTextColor":"#0a0a0a","primaryBorderColor":"#8a8a8a","lineColor":"#8a8a8a","secondaryColor":"#f4f4f4","tertiaryColor":"#ffffff","actorBkg":"#ffffff","actorBorder":"#8a8a8a","actorTextColor":"#0a0a0a","signalColor":"#0a0a0a","signalTextColor":"#404040"},"flowchart":{"htmlLabels":false},"sequence":{"mirrorActors":false}}}%%';

/** Keep labels as data, never Mermaid syntax, HTML or a second directive.
 *  Decimal Mermaid entities escape punctuation; whitespace becomes one space. */
export function mermaidText(text: string): string {
  const normalized = text.replace(/[\s\u0085]+/gu, " ").trim();
  return normalized.replace(/\bend\b|[^A-Za-z0-9 ,.'?!-]/gu, token => token === "end" ? "#101;nd" : `#${token.codePointAt(0)};`);
}

/** A name is resolved before a 1-based index so numeric journey names work. */
export function journeyIndex(story: Story, selector: string): number {
  const named = story.journeys.findIndex(journey => journey.name === selector);
  if (named >= 0) return named;
  if (/^[0-9]+$/.test(selector)) {
    const index = Number(selector) - 1;
    if (Number.isSafeInteger(index) && index >= 0 && index < story.journeys.length) return index;
  }
  throw new Error(`Journey not found: ${selector}. Use its exact name or a 1-based index.`);
}

export function storyMermaid(story: Story, selectedJourney?: number): string {
  const ids = new Map(story.actors.map((actor, index) => [actor.id, `a${index}`]));
  const lines = [MERMAID_INIT];
  if (selectedJourney !== undefined) {
    const journey = story.journeys[selectedJourney];
    if (!journey) throw new Error("Journey index is out of range.");
    lines.push("sequenceDiagram");
    for (const id of new Set(journey.steps)) {
      const actor = story.actors.find(each => each.id === id);
      if (actor) lines.push(`  participant ${ids.get(id)} as ${mermaidText(actor.name)}`);
    }
    for (const hop of journeyHops(journey, story.flows)) lines.push(`  ${ids.get(hop.from)}${hop.reversed ? "-->>" : "->>"}${ids.get(hop.to)}: ${mermaidText(hop.text)}`);
  } else {
    lines.push("flowchart LR");
    for (const [index, role] of ACTOR_ROLES.entries()) {
      const actors = story.actors.filter(actor => actor.role === role);
      if (!actors.length) continue;
      lines.push(`  subgraph role${index}["${ROLE_HEADINGS[role]}"]`, "    direction TB");
      for (const actor of actors) lines.push(`    ${ids.get(actor.id)}["${mermaidText(actor.name)}"]`);
      lines.push("  end");
    }
    for (const flow of story.flows) if (ids.has(flow.from) && ids.has(flow.to)) lines.push(`  ${ids.get(flow.from)} -->|"${mermaidText(flow.carries)}"| ${ids.get(flow.to)}`);
  }
  return `${lines.join("\n")}\n`;
}

import { ACTOR_ROLES, type ActorRole, type Story } from "./model.ts";

export const MAX_STORY_BYTES = 256 * 1024;

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected an object");
  }
  return value as Record<string, unknown>;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new Error("expected a string");
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("expected an array");
  return value;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : string(value);
}

/** Mirrors story.rs's serde contract: defaults apply to missing fields,
 *  optional strings also accept null, and an unknown role rejects the file. */
function parseStory(value: unknown): Story {
  const body = record(value);
  return {
    summary: string(body.summary),
    actors: array(body.actors).map((value) => {
      const actor = record(value);
      const role = string(actor.role);
      if (!ACTOR_ROLES.includes(role as ActorRole)) {
        throw new Error(`unknown variant \`${role}\`, expected one of ${ACTOR_ROLES.map((role) => `\`${role}\``).join(", ")}`);
      }
      return {
        id: string(actor.id),
        name: string(actor.name),
        role: role as ActorRole,
        blurb: string(actor.blurb),
        modules: array(actor.modules === undefined ? [] : actor.modules).map(string),
      };
    }),
    flows: array(body.flows).map((value) => {
      const flow = record(value);
      return {
        from: string(flow.from),
        to: string(flow.to),
        carries: string(flow.carries),
        returns: optionalString(flow.returns),
      };
    }),
    journeys: array(body.journeys === undefined ? [] : body.journeys).map((value) => {
      const journey = record(value);
      return {
        name: string(journey.name),
        blurb: optionalString(journey.blurb),
        steps: array(journey.steps).map(string),
      };
    }),
  };
}

/** Drops exactly the unsupported pieces a local scan drops. Missing stories
 *  are ordinary; parsing and validation problems belong in scan warnings. */
export function readStory(
  text: string | undefined,
  nodeIds: ReadonlySet<string>,
  warnings: string[],
): Story | undefined {
  if (text === undefined) return undefined;
  if (new TextEncoder().encode(text).byteLength > MAX_STORY_BYTES) {
    warnings.push("The story file is too large to read.");
    return undefined;
  }
  let story: Story;
  try {
    story = parseStory(JSON.parse(text));
  } catch (error) {
    warnings.push(`The story file could not be read: ${error instanceof Error ? error.message : String(error)}.`);
    return undefined;
  }

  const seen = new Set<string>();
  story.actors = story.actors.filter((actor) => {
    if (seen.has(actor.id)) {
      warnings.push(`Story: actor "${actor.id}" is defined twice.`);
      return false;
    }
    seen.add(actor.id);
    return true;
  });

  const unknownModules: string[] = [];
  for (const actor of story.actors) {
    actor.modules = actor.modules?.filter((module) => {
      if (nodeIds.has(module)) return true;
      unknownModules.push(module);
      return false;
    });
    if (!actor.modules?.length) delete actor.modules;
  }
  if (unknownModules.length) {
    warnings.push(`Story: ${unknownModules.length} path(s) are not in this repository and were dropped: ${unknownModules.join(", ")}.`);
  }

  const actors = new Set(story.actors.map((actor) => actor.id));
  const flowCount = story.flows.length;
  story.flows = story.flows.filter((flow) => actors.has(flow.from) && actors.has(flow.to));
  const dangling = flowCount - story.flows.length;
  if (dangling) {
    warnings.push(`Story: ${dangling} flow(s) name an actor the story does not define.`);
  }

  const connected = new Map<string, Set<string>>();
  for (const flow of story.flows) {
    for (const [from, to] of [[flow.from, flow.to], [flow.to, flow.from]]) {
      if (!connected.has(from)) connected.set(from, new Set());
      connected.get(from)!.add(to);
    }
  }
  story.journeys = story.journeys.filter((journey) => {
    for (let index = 1; index < journey.steps.length; index += 1) {
      const from = journey.steps[index - 1];
      const to = journey.steps[index];
      if (!connected.get(from)?.has(to)) {
        warnings.push(`Story: journey "${journey.name}" has no flow from ${from} to ${to}.`);
        return false;
      }
    }
    return journey.steps.length >= 2;
  });
  return story.actors.length ? story : undefined;
}

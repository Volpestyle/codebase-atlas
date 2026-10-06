import type { ActorRole, StoryActor } from "./model.ts";

export const FIGURE_NAMES = [
  "riffle", "terrain", "exploded", "phosphor", "slow", "elevator", "turntable",
  "lockers", "cabinet", "vault", "terminal", "laptop", "phone", "keyboard",
  "branches", "loupe", "padlock", "patch", "dish", "router", "sieve", "rail",
  "plug", "query", "drawer", "basket", "plot",
] as const;
export type FigureName = (typeof FIGURE_NAMES)[number];

export const DEFAULT_FIGURES: Record<ActorRole, FigureName | undefined> = {
  person: undefined, surface: "terminal", door: "padlock", core: "riffle",
  store: "cabinet", external: "branches",
};

export function actorFigure(actor: StoryActor): FigureName | undefined {
  if (actor.role === "person") return undefined;
  return actor.figure && FIGURE_NAMES.includes(actor.figure) ? actor.figure : DEFAULT_FIGURES[actor.role];
}

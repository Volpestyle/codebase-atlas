import * as Hairline from "@lucasmarkes/hairline/react";
import { actorFigure, type FigureName } from "../storyFigures";
import type { StoryActor } from "../model";
import type { Theme } from "./useTheme";

const figures = {
  riffle: Hairline.Riffle, terrain: Hairline.Terrain, exploded: Hairline.Exploded,
  phosphor: Hairline.Phosphor, slow: Hairline.Slow, elevator: Hairline.Elevator,
  turntable: Hairline.Turntable, lockers: Hairline.Lockers, cabinet: Hairline.Cabinet,
  vault: Hairline.Vault, terminal: Hairline.Terminal, laptop: Hairline.Laptop,
  phone: Hairline.Phone, keyboard: Hairline.Keyboard, branches: Hairline.Branches,
  loupe: Hairline.Loupe, padlock: Hairline.Padlock, patch: Hairline.Patch,
  dish: Hairline.Dish, router: Hairline.Router, sieve: Hairline.Sieve,
  rail: Hairline.Rail, plug: Hairline.Plug, query: Hairline.Query,
  drawer: Hairline.Drawer, basket: Hairline.Basket, plot: Hairline.Plot,
} satisfies Record<FigureName, typeof Hairline.Riffle>;

/** Figures are decoration beside a part's name: hidden from assistive tech
 *  and out of the tab order (Hairline keeps attributes the host already has). */
export default function PartFigure({ actor, theme }: { actor: StoryActor; theme: Theme }) {
  const name = actorFigure(actor);
  if (!name) return null;
  const Figure = figures[name];
  return <span className="part-figure-box"><Figure className="part-figure" theme={theme} aria-hidden="true" tabIndex={-1} role="presentation" /></span>;
}

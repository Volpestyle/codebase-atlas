import { ACTOR_ROLES, type Story, type StoryActor } from "./model.ts";

export interface Station { actor: StoryActor; x: number; y: number }
export function buildTransitLayout(story: Story) {
  const roles = ACTOR_ROLES.filter(role => story.actors.some(actor => actor.role === role));
  const rows = Math.max(1, ...roles.map(role => story.actors.filter(actor => actor.role === role).length));
  const height = Math.max(380, rows * 108 + 100);
  const width = Math.max(700, roles.length * 180 + 40);
  const columns = roles.map((role, i) => ({ role, x: 110 + i * 180 }));
  const stations: Station[] = [];
  for (const column of columns) {
    const actors = story.actors.filter(actor => actor.role === column.role);
    for (const [index, actor] of actors.entries()) {
      stations.push({ actor, x: column.x, y: 84 + index * 108 + (rows - actors.length) * 54 });
    }
  }
  return { width, height, columns, stations, byId: new Map(stations.map(station => [station.actor.id, station])) };
}

export function transitPath(from: Station, to: Station): string {
  if (from.x === to.x) {
    const side = from.x + 60;
    return `M ${from.x} ${from.y} C ${side} ${from.y}, ${side} ${to.y}, ${to.x} ${to.y}`;
  }
  const mid = (from.x + to.x) / 2;
  return `M ${from.x} ${from.y} C ${mid} ${from.y}, ${mid} ${to.y}, ${to.x} ${to.y}`;
}

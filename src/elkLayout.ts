import ELK, { type ElkNode } from "elkjs/lib/elk.bundled.js";
import { ACTOR_ROLES, type Story, type StoryActor, type StoryFlow } from "./model.ts";
import { wrapText } from "./journey.ts";

export interface NetworkPart { actor: StoryActor; x: number; y: number; width: number; height: number; lines: string[] }
export interface NetworkRoute { flow: StoryFlow; points: { x: number; y: number }[]; d: string }
export interface NetworkLayout { width: number; height: number; parts: NetworkPart[]; routes: NetworkRoute[] }

/** ELK owns placement and orthogonal routing. Every node gets a role partition;
 *  input order and a fixed seed make the same story produce the same layout. */
export async function buildNetworkLayout(story: Story): Promise<NetworkLayout> {
  if (!story.actors.length) return { width: 320, height: 160, parts: [], routes: [] };
  const ids = new Map(story.actors.map((actor, index) => [actor.id, `part${index}`]));
  const names = story.actors.map(actor => wrapText(actor.name, 22, 1000));
  const graph: ElkNode = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered", "elk.direction": "RIGHT", "elk.edgeRouting": "ORTHOGONAL",
      "elk.partitioning.activate": "true", "elk.randomSeed": "1",
      "elk.layered.considerModelOrder.strategy": "NODES_AND_EDGES",
      "elk.spacing.nodeNode": "40", "elk.layered.spacing.nodeNodeBetweenLayers": "72",
      "elk.spacing.edgeNode": "20", "elk.spacing.edgeEdge": "14",
      "elk.padding": "[top=48,left=24,bottom=24,right=24]",
    },
    children: story.actors.map((actor, index) => ({
      id: ids.get(actor.id)!, width: 156, height: Math.max(72, names[index].length * 18 + 32),
      layoutOptions: { "elk.partitioning.partition": String(ACTOR_ROLES.indexOf(actor.role)) },
    })),
    edges: story.flows.flatMap((flow, index) => {
      const from = ids.get(flow.from); const to = ids.get(flow.to);
      return from && to ? [{ id: `flow${index}`, sources: [from], targets: [to] }] : [];
    }),
  };
  const output = await new ELK().layout(graph);
  const parts = (output.children ?? []).map(node => {
    const index = Number(node.id.slice(4));
    return { actor: story.actors[index], x: node.x!, y: node.y!, width: node.width!, height: node.height!, lines: names[index] };
  });
  const routes = (output.edges ?? []).flatMap(edge => {
    const flow = story.flows[Number(edge.id.slice(4))];
    return (edge.sections ?? []).map(section => {
      const points = [section.startPoint, ...(section.bendPoints ?? []), section.endPoint];
      return { flow, points, d: points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ") };
    });
  });
  return { width: output.width!, height: output.height!, parts, routes };
}

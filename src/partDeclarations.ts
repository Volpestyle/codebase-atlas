import type { CodeSymbol, RepositoryGraph } from "./model.ts";
import { filesForActor } from "./storyFacts.ts";

export function partDeclarations(graph: RepositoryGraph, actorId: string): { path: string; declarations: CodeSymbol[] }[] {
  return filesForActor(graph, actorId).map(file => ({ path: file.path,
    declarations: [...file.symbols ?? []].sort((a, b) => Number(b.exported) - Number(a.exported) || a.line - b.line || a.name.localeCompare(b.name)),
  }));
}

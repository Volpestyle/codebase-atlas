import type { RefObject } from "react";
import type { RepositoryGraph, RepositoryNode } from "./model";
import StoryScene from "./StoryScene";

export interface AtlasWorkspaceProps {
  graph: RepositoryGraph;
  searchQuery: string;
  onSearch: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  results: RepositoryNode[];
  selectedId: string | null;
  onOpenFile: (id: string) => void;
}

export default function AtlasWorkspace(props: AtlasWorkspaceProps) {
  return <div className="atlas-workspace" id="repository-map">
    <aside className="atlas-sidebar">
      <label className="atlas-search"><span className="visually-hidden">Search the code</span>
        <input ref={props.searchRef} type="search" placeholder="Search the code" value={props.searchQuery} onChange={event => props.onSearch(event.currentTarget.value)} /><kbd>/</kbd>
      </label>
      {props.searchQuery && <div className="atlas-search-results" aria-live="polite">
        <p>{props.results.length} results</p>
        {props.results.slice(0, 50).map(node => <button key={node.id} onClick={() => props.onOpenFile(node.id)}>{node.path}</button>)}
      </div>}
      <p className="atlas-kicker">The story</p>
      <p>Parts and journeys are written by hand. Files, imports, and names are read from the code.</p>
    </aside>
    <main className="atlas-main">
      {props.graph.story ? <StoryScene story={props.graph.story} selectedId={props.selectedId} onSelect={props.onOpenFile} /> : <section className="atlas-empty">
        <h1>No story <em>yet</em>.</h1>
        <p>The code map works without a story. Ask your coding agent to read <code>atlas story brief .</code>, write <code>.codebase-index/_story.json</code>, then run <code>atlas story check .</code>.</p>
        <p>Commit the story to share it through the GitHub source.</p>
      </section>}
    </main>
  </div>;
}

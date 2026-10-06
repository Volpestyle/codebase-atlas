import { useState, type RefObject } from "react";
import type { RepositoryGraph, RepositoryNode } from "./model";
import JourneyView from "./JourneyView";
import type { Theme } from "./ui/useTheme";
import { journeyHops } from "./storyLayout";

export interface AtlasWorkspaceProps {
  graph: RepositoryGraph;
  theme: Theme;
  searchQuery: string;
  onSearch: (query: string) => void;
  searchRef: RefObject<HTMLInputElement | null>;
  results: RepositoryNode[];
  selectedId: string | null;
  onOpenFile: (id: string) => void;
}

export default function AtlasWorkspace(props: AtlasWorkspaceProps) {
  const [journeyIndex, setJourneyIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [actorId, setActorId] = useState("reader-engine");
  const actor = props.graph.story?.actors.find(part => part.id === actorId) ?? props.graph.story?.actors.find(part => part.modules?.length) ?? props.graph.story?.actors[0];
  return <div className="atlas-workspace" id="repository-map">
    <aside className="atlas-sidebar">
      <label className="atlas-search"><span className="visually-hidden">Search the code</span>
        <input ref={props.searchRef} type="search" placeholder="Search the code" value={props.searchQuery} onChange={event => props.onSearch(event.currentTarget.value)} /><kbd>/</kbd>
      </label>
      {props.searchQuery && <div className="atlas-search-results" aria-live="polite">
        <p>{props.results.length} results</p>
        {props.results.slice(0, 50).map(node => <button key={node.id} onClick={() => props.onOpenFile(node.id)}>{node.path}</button>)}
      </div>}
      {props.graph.story && <div className="atlas-journeys"><p className="atlas-kicker">Journeys · Written</p>{props.graph.story.journeys.map((journey, index) => <button key={index} aria-pressed={journeyIndex === index} onClick={() => { setJourneyIndex(index); setStep(0); setPlaying(false); }}><span>{journey.name}</span><span className="atlas-mono atlas-muted">{journeyHops(journey, props.graph.story!.flows).length}</span></button>)}</div>}
      <p className="atlas-kicker">The story</p>
      <p>Parts and journeys are written by hand. Files, imports, and names are read from the code.</p>
    </aside>
    <main className="atlas-main">
      {props.graph.story ? <JourneyView key={journeyIndex} graph={props.graph} theme={props.theme} journeyIndex={journeyIndex} step={step} playing={playing} onStep={setStep} onPlaying={setPlaying} actor={actor!} onSelectActor={setActorId} onOpenFile={props.onOpenFile} /> : <section className="atlas-empty">
        <h1>No story <em>yet</em>.</h1>
        <p>The code map works without a story. Ask your coding agent to read <code>atlas story brief .</code>, write <code>.codebase-index/_story.json</code>, then run <code>atlas story check .</code>.</p>
        <p>Commit the story to share it through the GitHub source.</p>
      </section>}
    </main>
  </div>;
}

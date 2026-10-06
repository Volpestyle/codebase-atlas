import { useState, type RefObject } from "react";
import type { RepositoryGraph, RepositoryNode } from "./model";
import PartView from "./PartView";
import { actorExchanges } from "./storyFacts";
import { ExchangeList } from "./PartDetails";
import TerritoryView from "./TerritoryView";
import { storyCoverage } from "./territory";
import JourneyView from "./JourneyView";
import type { Theme } from "./ui/useTheme";
import { journeyHops } from "./storyLayout";

export interface AtlasWorkspaceProps {
  view: "story" | "territory" | "part";
  onNavigate: (view: "story" | "territory" | "part") => void;
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
  const exchanges = actor && props.graph.story ? actorExchanges(props.graph.story, actor) : null;
  const coverage = storyCoverage(props.graph);
  return <div className="atlas-workspace" id="repository-map">
    <aside className="atlas-sidebar">
      <label className="atlas-search"><span className="visually-hidden">Search the code</span>
        <input ref={props.searchRef} type="search" placeholder="Search the code" value={props.searchQuery} onChange={event => props.onSearch(event.currentTarget.value)} /><kbd>/</kbd>
      </label>
      {props.searchQuery && <div className="atlas-search-results" aria-live="polite">
        <p>{props.results.length} results</p>
        {props.results.slice(0, 50).map(node => <button key={node.id} onClick={() => props.onOpenFile(node.id)}>{node.path}</button>)}
      </div>}
      {props.view === "part" && actor && exchanges && <div className="inside-exchanges"><button className="atlas-text-link" onClick={() => props.onNavigate("story")}>← Back to the journey</button><label className="atlas-part-picker">Part<select value={actor.id} onChange={event => setActorId(event.target.value)}>{props.graph.story!.actors.map(part => <option key={part.id} value={part.id}>{part.name}</option>)}</select></label><p className="atlas-kicker">Arrives · Written</p><ExchangeList graph={props.graph} rows={exchanges.takes} direction="from" onSelectActor={setActorId} /><p className="atlas-kicker">Leaves · Written</p><ExchangeList graph={props.graph} rows={exchanges.gives} direction="to" onSelectActor={setActorId} /></div>}
      {props.view === "territory" && <div className="atlas-legend"><p className="atlas-kicker">Product source · Scanned</p>{coverage.parts.map(part => <button key={part.actorId ?? "gap"} aria-pressed={actor?.id === part.actorId} onClick={() => part.actorId && setActorId(part.actorId)} disabled={!part.actorId}><span>{props.graph.story?.actors.find(actor => actor.id === part.actorId)?.name ?? "Not in the story"}</span><span className="atlas-mono">{part.percent === null ? `${part.files} files` : `${part.percent.toFixed(1)}%`}</span></button>)}<p>Source lines only; tests, setup, hidden, vendored and generated trees excluded.{coverage.partial ? " Partial scan." : ""}{!coverage.available ? " Line counts unavailable." : ""}</p></div>}
      {props.view !== "part" && props.graph.story && <div className="atlas-journeys"><p className="atlas-kicker">Journeys · Written</p>{props.graph.story.journeys.map((journey, index) => <button key={index} aria-pressed={journeyIndex === index} onClick={() => { setJourneyIndex(index); setStep(0); setPlaying(false); }}><span>{journey.name}</span><span className="atlas-mono atlas-muted">{journeyHops(journey, props.graph.story!.flows).length}</span></button>)}</div>}
      <p className="atlas-kicker">The story</p>
      <p>Parts and journeys are written by hand. Files, imports, and names are read from the code.</p>
    </aside>
    <main className="atlas-main">
      {props.view === "part" && actor ? <PartView graph={props.graph} actor={actor} theme={props.theme} onSelectActor={setActorId} onOpenFile={props.onOpenFile} /> : props.view === "territory" ? <TerritoryView graph={props.graph} actor={actor} journeyIndex={journeyIndex} onSelectActor={setActorId} onOpenFile={props.onOpenFile} selectedId={props.selectedId} onInside={() => props.onNavigate("part")} /> : props.graph.story ? <JourneyView key={journeyIndex} graph={props.graph} theme={props.theme} journeyIndex={journeyIndex} step={step} playing={playing} onStep={setStep} onPlaying={setPlaying} actor={actor!} onSelectActor={setActorId} onOpenFile={props.onOpenFile} onInside={() => props.onNavigate("part")} /> : <section className="atlas-empty">
        <h1>No story <em>yet</em>.</h1>
        <p>The code map works without a story. Ask your coding agent to read <code>atlas story brief .</code>, write <code>.codebase-index/_story.json</code>, then run <code>atlas story check .</code>.</p>
        <p>Commit the story to share it through the GitHub source.</p>
      </section>}
    </main>
  </div>;
}

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { RepositoryGraph, RepositoryNode, StoryActor } from "./model";
import PartView, { PartHeading } from "./PartView";
import { actorExchanges, ownerForNode } from "./storyFacts";
import { ExchangeList } from "./PartDetails";
import TerritoryView, { TerritoryHeading } from "./TerritoryView";
import { storyCoverage } from "./territory";
import JourneyView, { JourneyHeading } from "./JourneyView";
import type { Theme } from "./ui/useTheme";
import { journeyHops } from "./journey";

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

const NARROW = "(max-width: 800px)";
function useMatchMedia(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== "undefined" && window.matchMedia(query).matches);
  useEffect(() => {
    const media = window.matchMedia(query);
    const update = () => setMatches(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, [query]);
  return matches;
}

const owns = (part?: StoryActor) => Boolean(part?.modules?.length);
/** Whole percentages; a sliver reads "<1%" rather than a misleading 0%. */
const percentLabel = (percent: number) => percent > 0 && percent < 0.5 ? "<1%" : `${Math.round(percent)}%`;

export default function AtlasWorkspace(props: AtlasWorkspaceProps) {
  const story = props.graph.story;
  const actors = story?.actors ?? [];
  const [journeyIndex, setJourneyIndex] = useState(0);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  // An explicit choice of part. Without one the view follows the stepper.
  const [selection, setSelection] = useState<string | null>(null);
  const [gapSelected, setGapSelected] = useState(false);
  const [legendOpen, setLegendOpen] = useState(false);
  const pickerRef = useRef<HTMLDetailsElement>(null);
  const narrow = useMatchMedia(NARROW);
  const journey = story?.journeys[journeyIndex];
  const hops = useMemo(() => journey && story ? journeyHops(journey, story.flows) : [], [journey, story]);
  // The one place the step is clamped: a shorter journey or a reloaded story
  // can leave the stored step past the end.
  const current = Math.min(step, Math.max(0, hops.length - 1));
  const destination = actors.find(part => part.id === hops[current]?.to);
  const actor = actors.find(part => part.id === selection)
    ?? (props.view === "story" || owns(destination) ? destination : undefined)
    ?? actors.find(owns) ?? actors[0];
  function selectActor(id: string) { setSelection(id); setGapSelected(false); if (pickerRef.current) pickerRef.current.open = false; }
  function stepTo(next: number) { setStep(next); setSelection(null); }
  function chooseJourney(index: number) { setJourneyIndex(index); setStep(0); setPlaying(false); setSelection(null); }
  useEffect(() => {
    if (props.selectedId && story) {
      const owner = ownerForNode(story, props.selectedId);
      if (owner) { setSelection(owner); setGapSelected(false); }
    }
  }, [props.selectedId, story]);
  useEffect(() => { setPlaying(false); }, [props.view]);
  const exchanges = actor && story ? actorExchanges(story, actor) : null;
  const coverage = storyCoverage(props.graph);
  const legendSummary = coverage.available ? `${percentLabel(100 - (coverage.parts[coverage.parts.length - 1]?.percent ?? 0))} in the story` : `${coverage.parts.length - 1} parts`;
  const legendRows = <>
    {coverage.parts.map(part => {
      const pressed = part.actorId === null ? gapSelected : !gapSelected && actor?.id === part.actorId;
      return <button key={part.actorId ?? "gap"} className={part.actorId === null ? "is-gap" : undefined} aria-pressed={pressed} onClick={() => part.actorId ? selectActor(part.actorId) : setGapSelected(true)}>
        <span className="legend-swatch" aria-hidden="true" /><span>{actors.find(each => each.id === part.actorId)?.name ?? "Not in the story"}</span><span className="atlas-mono">{part.percent === null ? `${part.files} files` : percentLabel(part.percent)}</span>
      </button>;
    })}
    <p>Source lines only; tests, setup, hidden, vendored and generated trees excluded.{coverage.partial ? " Partial scan." : ""}{!coverage.available ? " Line counts unavailable." : ""}</p>
  </>;
  return <main className="atlas-workspace" id="atlas-main" tabIndex={-1}>
    <div className="atlas-heading">
      {props.view === "part" && actor ? <PartHeading graph={props.graph} actor={actor} />
        : props.view === "territory" ? <TerritoryHeading graph={props.graph} />
        : story ? <JourneyHeading graph={props.graph} /> : null}
    </div>
    <aside className="atlas-sidebar">
      <label className="atlas-search"><span className="visually-hidden">Search the code</span>
        <input ref={props.searchRef} type="search" placeholder="Search the code" value={props.searchQuery} onChange={event => props.onSearch(event.currentTarget.value)} /><kbd>/</kbd>
      </label>
      {props.searchQuery && <div className="atlas-search-results" aria-live="polite">
        <p>{props.results.length} results</p>
        {props.results.slice(0, 50).map(node => <button key={node.id} onClick={() => props.onOpenFile(node.id)}>{node.path}</button>)}
      </div>}
      {props.view === "part" && actor && exchanges && <div className="inside-exchanges">
        <button className="atlas-text-link" onClick={() => props.onNavigate("story")}><span aria-hidden="true">← </span>Back to the journey</button>
        <details className="atlas-part-picker" ref={pickerRef}>
          <summary><span className="atlas-kicker">Part</span><span>{actor.name}</span></summary>
          <ul>{actors.map(part => <li key={part.id}><button aria-pressed={part.id === actor.id} onClick={() => selectActor(part.id)}>{part.name}</button></li>)}</ul>
        </details>
        <p className="atlas-kicker">Arrives · Written</p><ExchangeList graph={props.graph} rows={exchanges.takes} direction="from" onSelectActor={selectActor} />
        <p className="atlas-kicker">Leaves · Written</p><ExchangeList graph={props.graph} rows={exchanges.gives} direction="to" onSelectActor={selectActor} />
      </div>}
      {props.view === "territory" && (narrow
        ? <details className="atlas-legend" open={legendOpen} onToggle={event => setLegendOpen(event.currentTarget.open)}>
          <summary><span>Parts</span><span className="atlas-mono atlas-muted">{legendSummary}</span></summary>{legendRows}
        </details>
        : <div className="atlas-legend"><p className="atlas-kicker">Product source · Scanned</p>{legendRows}</div>)}
      {props.view !== "part" && story && <div className="atlas-journeys"><p className="atlas-kicker">Journeys · Written</p>{story.journeys.map((each, index) => <button key={index} aria-pressed={journeyIndex === index} onClick={() => chooseJourney(index)}><span>{each.name}</span><span className="atlas-mono atlas-muted">{journeyHops(each, story.flows).length}</span></button>)}</div>}
      <p className="atlas-kicker">The story</p>
      <p>Parts and journeys are written by hand. Files, imports, and names are read from the code.</p>
    </aside>
    <div className="atlas-content">
      {props.graph.warnings?.length > 0 && <details className="atlas-warnings"><summary>{props.graph.warnings.length} scan warning{props.graph.warnings.length === 1 ? "" : "s"}</summary><ul>{props.graph.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}
      {props.view === "part" && actor ? <PartView graph={props.graph} actor={actor} theme={props.theme} onSelectActor={selectActor} onOpenFile={props.onOpenFile} />
        : props.view === "territory" ? <TerritoryView graph={props.graph} actor={actor} gap={gapSelected} journeyIndex={journeyIndex} onSelectActor={selectActor} onOpenFile={props.onOpenFile} selectedId={props.selectedId} onInside={() => props.onNavigate("part")} />
        : story && actor ? <JourneyView key={journeyIndex} graph={props.graph} theme={props.theme} journeyIndex={journeyIndex} hops={hops} step={current} playing={playing} onStep={stepTo} onPlaying={setPlaying} actor={actor} onSelectActor={selectActor} onOpenFile={props.onOpenFile} onInside={() => props.onNavigate("part")} />
        : <section className="atlas-empty">
          <h1>No story <em>yet</em>.</h1>
          <p>The code map works without a story. Ask your coding agent to read <code>atlas story brief .</code>, write <code>.codebase-index/_story.json</code>, then run <code>atlas story check .</code>.</p>
          <p>Commit the story to share it through the GitHub source.</p>
        </section>}
    </div>
  </main>;
}

import { useEffect, useMemo, useState } from "react";
import { type RepositoryGraph, type StoryActor, type StoryFlow } from "./model";
import { type JourneyHop } from "./journey";
import { actorFigure } from "./storyFigures";
import PartFigure from "./ui/PartFigure";
import type { Theme } from "./ui/useTheme";
import PartDetails from "./PartDetails";
import SequenceView from "./SequenceView";

export function JourneyHeading({ graph }: { graph: RepositoryGraph }) {
  return <>
    <h1>Follow the data, <em>hop by hop</em>.</h1>
    <p className="atlas-intro">Pick a journey, then follow what travels from part to part. Atlas reads the code; the story explains what it does.</p>
    {graph.story?.summary && <details className="atlas-repo-summary"><summary>About {graph.name}</summary><p>{graph.story.summary}</p></details>}
  </>;
}

export default function JourneyView({ graph, theme, journeyIndex, hops, step, playing, onStep, onPlaying, actor, onSelectActor, onOpenFile, onInside }: {
  graph: RepositoryGraph; theme: Theme; journeyIndex: number; hops: JourneyHop[]; step: number; playing: boolean;
  onStep: (step: number) => void; onPlaying: (playing: boolean) => void;
  actor: StoryActor; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void; onInside?: () => void;
}) {
  const story = graph.story!;
  const journey = story.journeys[journeyIndex];
  const hop = hops[step];
  const [inspectedFlow, setInspectedFlow] = useState<StoryFlow | null>(null);
  useEffect(() => {
    if (!playing || !hops.length) return;
    const timer = window.setTimeout(() => {
      if (step >= hops.length - 1) onPlaying(false);
      else onStep(step + 1);
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [playing, step, hops.length, onPlaying, onStep]);
  const text = inspectedFlow?.carries ?? hop?.text;
  const from = inspectedFlow?.from ?? hop?.from;
  const to = inspectedFlow?.to ?? hop?.to;
  const fromActor = story.actors.find(part => part.id === from);
  const toActor = story.actors.find(part => part.id === to);
  const name = (id: string) => story.actors.find(part => part.id === id)?.name ?? id;
  // A card per part with a figure, in journey order; people have no figure.
  const cards = useMemo(() => {
    const ids = journey ? [...new Set(journey.steps)] : story.actors.map(part => part.id);
    return ids.flatMap(id => {
      const part = story.actors.find(each => each.id === id);
      if (!part || !actorFigure(part)) return [];
      const stops = hops.flatMap((each, index) => each.to === id ? [index + 1] : []);
      return [{ part, tag: stops.length ? `stop ${stops.join(", ")}` : "start" }];
    });
  }, [journey, story, hops]);
  function go(next: number) { setInspectedFlow(null); onPlaying(false); onStep(next); }
  return <>
    <section className="atlas-transit atlas-card" aria-label="Journey sequence">
      <SequenceView story={story} hops={hops} step={step} actor={actor} theme={theme} onStep={go} onSelectActor={onSelectActor} />
      {hops.length ? <>
        <div className="journey-stepper"><span className="atlas-mono atlas-muted">{String(step + 1).padStart(2, "0")} of {String(hops.length).padStart(2, "0")}</span>
          <span className="journey-hop">{name(hop.from)} <span className="atlas-muted">to</span> {name(hop.to)}</span>
          <div className="journey-controls"><button disabled={step === 0} onClick={() => go(step - 1)}>Prev</button><button aria-label={playing ? "Pause journey" : "Play journey"} onClick={() => { setInspectedFlow(null); if (!playing && step >= hops.length - 1) onStep(0); onPlaying(!playing); }}>{playing ? "Pause" : "Play"}</button><button disabled={step >= hops.length - 1} onClick={() => go(step + 1)}>Next</button></div>
        </div>
        <div className="journey-ticks">{hops.map((each, index) => <button key={index} className={index < step ? "is-visited" : index === step ? "is-current" : ""} aria-label={`Step ${index + 1}: ${name(each.from)} to ${name(each.to)}`} aria-current={index === step ? "step" : undefined} onClick={() => go(index)}><span /></button>)}</div>
      </> : <p className="atlas-muted atlas-padding">No journeys written yet. Select a connection to read what travels.</p>}
    </section>
    <section className="what-travels"><span className="atlas-kicker">What travels · Written story</span><p aria-live="polite">“{text ?? "Pick a connection to follow the data"}”</p><span className="atlas-muted">{fromActor?.name}{toActor && ` to ${toActor.name}`}{hop?.reversed && !inspectedFlow ? " · the return trip" : ""}{journey?.blurb ? ` · ${journey.blurb}` : ""}</span>
      {inspectedFlow?.returns && <p className="flow-return">Comes back: {inspectedFlow.returns}</p>}
    </section>
    {cards.length > 0 && <>
      <h2 className="journey-card-heading">On this journey <span className="atlas-mono atlas-muted">{cards.length} parts</span></h2>
      <div className="journey-cards">{cards.map(({ part, tag }) => <button key={part.id} className={`atlas-card part-card${actor.id === part.id ? " is-selected" : ""}`} onClick={() => onSelectActor(part.id)} aria-pressed={actor.id === part.id}>
        <PartFigure actor={part} theme={theme} />
        <span className="part-card-label"><span>{part.name}</span><span className="atlas-mono atlas-muted">{tag}</span></span>
      </button>)}</div>
    </>}
    <PartDetails graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} onInside={onInside} />
    <footer className="atlas-provenance">Parts, flows, and journeys: written by hand, checked against this scan. Files, imports, and names: read from code. <span>Figures: Hairline, MIT © Lucas Marques</span></footer>
  </>;
}

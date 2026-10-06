import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ROLE_HEADINGS, type RepositoryGraph, type StoryActor, type StoryFlow } from "./model";
import { flowKey, type JourneyHop } from "./journey";
import { buildTransitLayout, labelBox, transitPath, STATION_LABEL } from "./transitLayout";
import { useReducedMotion } from "./ui/useReducedMotion";
import { actorFigure } from "./storyFigures";
import PartFigure from "./ui/PartFigure";
import type { Theme } from "./ui/useTheme";
import PartDetails from "./PartDetails";

export function JourneyHeading({ graph }: { graph: RepositoryGraph }) {
  return <>
    <h1>Follow the data, <em>stop by stop</em>.</h1>
    <p className="atlas-intro">Pick a journey, then follow what travels from part to part. Atlas reads the code; the story explains what it does.</p>
    {graph.story?.summary && <details className="atlas-repo-summary"><summary>About {graph.name}</summary><p>{graph.story.summary}</p></details>}
  </>;
}

const FIELD_PADDING = 20;

export default function JourneyView({ graph, theme, journeyIndex, hops, step, playing, onStep, onPlaying, actor, onSelectActor, onOpenFile, onInside }: {
  graph: RepositoryGraph; theme: Theme; journeyIndex: number; hops: JourneyHop[]; step: number; playing: boolean;
  onStep: (step: number) => void; onPlaying: (playing: boolean) => void;
  actor: StoryActor; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void; onInside?: () => void;
}) {
  const story = graph.story!;
  const journey = story.journeys[journeyIndex];
  const layout = useMemo(() => buildTransitLayout(story), [story]);
  const hop = hops[step];
  const [inspectedFlow, setInspectedFlow] = useState<StoryFlow | null>(null);
  const [edges, setEdges] = useState({ left: false, right: false });
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  // The layout reserves room for every label anchor; trim the field to what is drawn.
  const fieldHeight = useMemo(() => {
    const bottoms = [...layout.stations.map(station => labelBox(station).bottom), ...[...layout.routes.values()].flatMap(route => route.points.map(([, y]) => y))];
    return Math.min(layout.height, Math.ceil(Math.max(0, ...bottoms) + FIELD_PADDING));
  }, [layout]);
  useEffect(() => {
    if (!playing || !hops.length) return;
    const timer = window.setTimeout(() => {
      if (step >= hops.length - 1) onPlaying(false);
      else onStep(step + 1);
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [playing, step, hops.length, onPlaying, onStep]);
  const measureEdges = useCallback(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const left = scroll.scrollLeft > 1; const right = scroll.scrollLeft + scroll.clientWidth < scroll.scrollWidth - 1;
    setEdges(prev => prev.left === left && prev.right === right ? prev : { left, right });
  }, []);
  // Keep the current hop centred when the hop changes or the map is resized.
  const centreHop = useCallback((behavior: ScrollBehavior) => {
    const from = hop && layout.byId.get(hop.from);
    const to = hop && layout.byId.get(hop.to);
    const scroll = scrollRef.current;
    if (!scroll) return;
    if (from && to && scroll.scrollWidth > scroll.clientWidth) scroll.scrollTo({ left: Math.max(0, (from.x + to.x) / 2 - scroll.clientWidth / 2), behavior });
    measureEdges();
  }, [hop, layout, measureEdges]);
  useEffect(() => { centreHop(reduced ? "instant" : "smooth"); }, [centreHop, reduced]);
  useLayoutEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;
    const observer = new ResizeObserver(() => centreHop("instant"));
    observer.observe(scroll);
    return () => observer.disconnect();
  }, [centreHop]);
  const flow = inspectedFlow ?? hop?.flow;
  const text = inspectedFlow?.carries ?? hop?.text;
  const from = inspectedFlow?.from ?? hop?.from;
  const to = inspectedFlow?.to ?? hop?.to;
  const fromActor = story.actors.find(part => part.id === from);
  const toActor = story.actors.find(part => part.id === to);
  const visited = new Set(hops.slice(0, step).map(each => flowKey(each.flow)));
  const upcoming = new Set(hops.slice(step + 1).map(each => flowKey(each.flow)));
  const current = flow && flowKey(flow);
  const currentPath = from !== undefined && to !== undefined ? transitPath(layout, from, to) : null;
  const packetStart = from !== undefined ? layout.byId.get(from) : undefined;
  const onJourney = new Set(journey?.steps ?? []);
  // A pair of flows running both ways gets one hit target, not two stacked.
  const hitTargets = useMemo(() => {
    const seen = new Set<string>();
    return story.flows.flatMap(each => {
      const pair = [each.from, each.to].sort().join("\u0000");
      if (seen.has(pair) || !layout.routes.has(flowKey(each))) return [];
      seen.add(pair);
      const back = story.flows.find(other => other.from === each.to && other.to === each.from);
      return [{ flow: each, back }];
    });
  }, [story, layout]);
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
  function inspect(each: StoryFlow) { setInspectedFlow(each); onPlaying(false); }
  return <>
    <section className="atlas-transit atlas-card" aria-label="Journey transit map">
      <div className={`atlas-transit-scroll${edges.left ? " fade-left" : ""}${edges.right ? " fade-right" : ""}`} ref={scrollRef} onScroll={measureEdges}>
        <div className="atlas-transit-field" style={{ width: layout.width, height: fieldHeight }}>
          {layout.columns.map(column => <span key={column.role} className="transit-heading" style={{ left: column.x }} aria-hidden="true">{ROLE_HEADINGS[column.role]}</span>)}
          {layout.stations.map(station => {
            const id = station.actor.id;
            const isTo = id === to; const isFrom = id === from; const selected = id === actor.id;
            const box = labelBox(station);
            const state = `${isTo ? " is-to" : ""}${isFrom ? " is-from" : ""}${selected ? " is-selected" : ""}${onJourney.has(id) ? " is-on" : ""}`;
            return <div key={id} className={`transit-station${state}`}>
              <button style={{ left: station.x - 22, top: station.y - 22 }} onClick={() => onSelectActor(id)} aria-label={`${station.actor.name}${isTo ? ", current stop" : ""}`} aria-pressed={selected}><span /></button>
              <span className={`transit-name is-${station.anchor}`} aria-hidden="true" style={station.anchor === "right"
                ? { left: box.left, top: box.top }
                : { left: station.x - STATION_LABEL.width / 2, top: box.top, width: STATION_LABEL.width }}>
                {station.lines.map((line, i) => <span key={i}>{line}</span>)}
              </span>
            </div>;
          })}
          <svg width={layout.width} height={fieldHeight} aria-label="Written connections" role="group">
            {story.flows.map((each, index) => {
              const key = flowKey(each); const d = layout.routes.get(key)?.d;
              if (!d) return null;
              const state = key === current ? "current" : visited.has(key) ? "visited" : upcoming.has(key) ? "upcoming" : "base";
              return <path key={index} d={d} className={`transit-route is-${state}`} />;
            })}
            {hitTargets.map(({ flow: each, back }) => {
              const d = layout.routes.get(flowKey(each))!.d;
              const label = back ? `What travels between ${name(each.from)} and ${name(each.to)}: ${each.carries}; ${back.carries}` : `What travels from ${name(each.from)} to ${name(each.to)}: ${each.carries}`;
              return <path key={flowKey(each)} d={d} className="transit-route-hit" role="button" tabIndex={0} aria-label={label}
                onClick={() => inspect(each)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); inspect(each); } }} />;
            })}
            {currentPath && packetStart && <circle key={currentPath} className="transit-packet" r="3.5" cx={reduced ? packetStart.x : 0} cy={reduced ? packetStart.y : 0}>
              {!reduced && <animateMotion dur="1.8s" repeatCount="indefinite" path={currentPath} />}
            </circle>}
          </svg>
        </div>
      </div>
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

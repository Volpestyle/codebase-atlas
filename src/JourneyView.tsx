import { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_HEADINGS, type RepositoryGraph, type StoryActor, type StoryFlow } from "./model";
import { journeyHops, flowKey, wrapText } from "./journey";
import { buildTransitLayout, transitPath } from "./transitLayout";
import { useReducedMotion } from "./ui/useReducedMotion";
import PartFigure from "./ui/PartFigure";
import type { Theme } from "./ui/useTheme";
import PartDetails from "./PartDetails";

export default function JourneyView({ graph, theme, journeyIndex, step, playing, onStep, onPlaying, actor, onSelectActor, onOpenFile, onInside }: {
  graph: RepositoryGraph; theme: Theme; journeyIndex: number; step: number; playing: boolean;
  onStep: (step: number) => void; onPlaying: (playing: boolean) => void;
  actor: StoryActor; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void; onInside?: () => void;
}) {
  const story = graph.story!;
  const layout = useMemo(() => buildTransitLayout(story), [story]);
  const hops = useMemo(() => story.journeys[journeyIndex] ? journeyHops(story.journeys[journeyIndex], story.flows) : [], [story, journeyIndex]);
  const hop = hops[Math.min(step, hops.length - 1)];
  const [inspectedFlow, setInspectedFlow] = useState<StoryFlow | null>(null);
  const reduced = useReducedMotion();
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!playing || !hops.length) return;
    const timer = window.setTimeout(() => {
      if (step >= hops.length - 1) onPlaying(false);
      else onStep(step + 1);
    }, 2600);
    return () => window.clearTimeout(timer);
  }, [playing, step, hops.length, onPlaying, onStep]);
  useEffect(() => {
    const from = hop && layout.byId.get(hop.from);
    const to = hop && layout.byId.get(hop.to);
    const scroll = scrollRef.current;
    if (from && to && scroll) scroll.scrollTo({ left: Math.max(0, (from.x + to.x) / 2 - scroll.clientWidth / 2), behavior: reduced ? "instant" : "smooth" });
  }, [hop, layout, reduced]);
  const flow = inspectedFlow ?? hop?.flow;
  const text = inspectedFlow?.carries ?? hop?.text;
  const from = inspectedFlow?.from ?? hop?.from;
  const to = inspectedFlow?.to ?? hop?.to;
  const fromActor = story.actors.find(part => part.id === from);
  const toActor = story.actors.find(part => part.id === to);
  const visited = new Set(hops.slice(0, step).map(each => flowKey(each.flow)));
  const upcoming = new Set(hops.slice(step + 1).map(each => flowKey(each.flow)));
  const current = flow && flowKey(flow);
  const stationsFrom = from !== undefined ? layout.byId.get(from) : undefined;
  const stationsTo = to !== undefined ? layout.byId.get(to) : undefined;
  const currentPath = stationsFrom && stationsTo ? transitPath(stationsFrom, stationsTo) : null;
  const partIds = new Set(hops.flatMap(each => [each.from, each.to]));
  const cards = hops.length ? story.actors.filter(part => partIds.has(part.id)) : story.actors;
  function go(next: number) { setInspectedFlow(null); onPlaying(false); onStep(next); }
  return <>
    <h1>Follow the data, <em>stop by stop</em>.</h1>
    <p className="atlas-intro">Pick a journey, then follow what travels from part to part. Atlas reads the code; the story explains what it does.</p>
    <details className="atlas-repo-summary"><summary>About {graph.name}</summary><p>{story.summary}</p></details>
    <section className="atlas-transit atlas-card" aria-label="Journey transit map">
      <div className="atlas-transit-scroll" ref={scrollRef}>
        <div className="atlas-transit-field" style={{ width: layout.width, height: layout.height }}>
          <svg width={layout.width} height={layout.height} aria-label="Parts and written connections" role="group">
            {layout.columns.map(column => <text key={column.role} x={column.x} y={28} textAnchor="middle" className="transit-heading">{ROLE_HEADINGS[column.role]}</text>)}
            {story.flows.map((each, index) => {
              const a = layout.byId.get(each.from); const b = layout.byId.get(each.to);
              if (!a || !b) return null;
              const path = transitPath(a, b); const key = flowKey(each);
              const state = key === current ? "current" : visited.has(key) ? "visited" : upcoming.has(key) ? "upcoming" : "base";
              return <g key={index}><path d={path} className={`transit-route is-${state}`} />
                <path d={path} className="transit-route-hit" role="button" tabIndex={0} aria-label={`What travels: ${each.carries}`} onClick={() => { setInspectedFlow(each); onPlaying(false); }} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setInspectedFlow(each); onPlaying(false); } }} />
              </g>;
            })}
            {currentPath && <circle key={currentPath} className="transit-packet" r="4" cx={reduced ? stationsFrom!.x : 0} cy={reduced ? stationsFrom!.y : 0}>
              {!reduced && <animateMotion dur="1.8s" repeatCount="indefinite" path={currentPath} />}
            </circle>}
          </svg>
          {layout.stations.map(station => <div className={`transit-station${actor.id === station.actor.id ? " is-selected" : ""}${from === station.actor.id || to === station.actor.id ? " is-current" : ""}`} key={station.actor.id} style={{ left: station.x, top: station.y }}>
            <button onClick={() => onSelectActor(station.actor.id)} aria-label={`Select part: ${station.actor.name}`} aria-pressed={actor.id === station.actor.id}><span /></button>
            <span className="transit-name">{wrapText(station.actor.name, 26, 3).map((line, i) => <span key={i}>{line}</span>)}</span>
          </div>)}
        </div>
      </div>
      {hops.length ? <>
        <div className="journey-stepper"><span className="atlas-mono">{String(step + 1).padStart(2, "0")} of {String(hops.length).padStart(2, "0")}</span>
          <span>{fromActor?.name} <span className="atlas-muted">→</span> {toActor?.name}</span>
          <div className="journey-controls"><button disabled={step === 0} onClick={() => go(step - 1)}>Prev</button><button aria-label={playing ? "Pause journey" : "Play journey"} onClick={() => { setInspectedFlow(null); if (step === hops.length - 1) onStep(0); onPlaying(!playing); }}>{playing ? "Pause" : "Play"}</button><button disabled={step >= hops.length - 1} onClick={() => go(step + 1)}>Next</button></div>
        </div>
        <div className="journey-ticks">{hops.map((each, index) => <button key={index} className={index <= step ? "is-visited" : ""} aria-label={`Step ${index + 1}: ${each.text}`} aria-current={index === step ? "step" : undefined} onClick={() => go(index)}><span /></button>)}</div>
      </> : <p className="atlas-muted atlas-padding">No journeys written yet. Select a connection to read what travels.</p>}
    </section>
    <section className="what-travels" aria-live="polite"><span className="atlas-kicker">What travels · Written story</span><p>“{text ?? "Pick a connection to follow the data"}”</p><span className="atlas-muted">{fromActor?.name}{toActor && ` → ${toActor.name}`}{hop?.reversed && !inspectedFlow ? " · the return trip" : ""}{story.journeys[journeyIndex]?.blurb ? ` · ${story.journeys[journeyIndex].blurb}` : ""}</span>
      {inspectedFlow?.returns && <p className="flow-return">Comes back: {inspectedFlow.returns}</p>}
    </section>
    <h2 className="journey-card-heading">On this journey <span className="atlas-mono atlas-muted">{cards.length} parts</span></h2>
    <div className="journey-cards">{cards.map(part => <article className={`atlas-card part-card${actor.id === part.id ? " is-selected" : ""}${part.role === "person" ? " is-person" : ""}`} key={part.id}>
      {part.role === "person" ? <p>{part.blurb}</p> : <PartFigure actor={part} theme={theme} />}
      <button onClick={() => onSelectActor(part.id)} aria-pressed={actor.id === part.id}><span>{part.name}</span><span className="atlas-mono atlas-muted">{part.role}</span></button>
    </article>)}</div>
    <PartDetails graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} onInside={onInside} />
    <footer className="atlas-provenance">Parts, flows, and journeys: written by hand, checked against this scan. Files, imports, and names: read from code. <span>Figures: Hairline, MIT © Lucas Marques</span></footer>
  </>;
}

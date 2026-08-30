import { useEffect, useMemo, useRef, useState } from "react";
import { ROLE_HEADINGS, type Story, type StoryActor } from "./model";
import {
  actorForNode,
  buildStoryLayout,
  flowKey,
  journeyHops,
  neighborhood,
  type ActorCard,
} from "./storyLayout";

interface StorySceneProps {
  story: Story;
  selectedId: string | null;
  onSelect: (id: string) => void;
}

// One beat per hop when a journey plays itself. Long enough to read the
// sentence, short enough that the whole trip lands in under half a minute.
const STEP_MS = 2600;

function shortPath(path: string) {
  const parts = path.split("/");
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join("/")}`;
}

function ActorCardShape({
  card,
  state,
  onEnter,
  onLeave,
  onPick,
}: {
  card: ActorCard;
  state: "on" | "off" | "rest";
  onEnter: () => void;
  onLeave: () => void;
  onPick: (module: string | null) => void;
}) {
  const { actor } = card;
  const modulePath = actor.modules?.[0] ?? null;
  return (
    <g
      className={`story-card story-role-${actor.role} is-${state}`}
      onPointerEnter={onEnter}
      onPointerLeave={onLeave}
      onClick={() => onPick(modulePath)}
      role="button"
      tabIndex={0}
      aria-label={`${actor.name}. ${actor.blurb}`}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPick(modulePath);
        }
      }}
    >
      <rect
        className="story-card-plate"
        x={card.x}
        y={card.y}
        width={card.width}
        height={card.height}
        rx={3}
      />
      <text className="story-card-name" x={card.x + 14} y={card.y + 20}>
        {actor.name}
      </text>
      {card.blurbLines.map((line, index) => (
        <text
          key={index}
          className="story-card-blurb"
          x={card.x + 14}
          y={card.y + 40 + index * 16}
        >
          {line}
        </text>
      ))}
      {card.modules.length > 0 ? (
        <text
          className="story-card-modules"
          x={card.x + 14}
          y={card.y + card.height - 10}
        >
          {card.modules.map(shortPath).join(" · ")}
          {card.hiddenModules > 0 ? ` +${card.hiddenModules}` : ""}
        </text>
      ) : null}
    </g>
  );
}

function StoryScene({ story, selectedId, onSelect }: StorySceneProps) {
  const [hovered, setHovered] = useState<string | null>(null);
  const [hoveredFlow, setHoveredFlow] = useState<string | null>(null);
  const [journeyIndex, setJourneyIndex] = useState<number | null>(null);
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const layout = useMemo(() => buildStoryLayout(story), [story]);
  const journey = journeyIndex === null ? null : (story.journeys[journeyIndex] ?? null);
  const hops = useMemo(
    () => (journey ? journeyHops(journey, story.flows) : []),
    [journey, story.flows],
  );

  useEffect(() => {
    if (!playing || hops.length === 0) return;
    const timer = window.setTimeout(() => {
      setStep((current) => {
        if (current + 1 >= hops.length) {
          setPlaying(false);
          return current;
        }
        return current + 1;
      });
    }, STEP_MS);
    return () => window.clearTimeout(timer);
  }, [playing, step, hops.length]);

  const hopKey = hops[step] ? `${hops[step].from}->${hops[step].to}` : null;
  useEffect(() => {
    const scroll = scrollRef.current;
    const current = hops[step];
    if (!scroll || !current) return;
    const from = layout.cardById.get(current.from);
    const to = layout.cardById.get(current.to);
    if (!from || !to) return;
    const left = Math.min(from.x, to.x);
    const right = Math.max(from.x + from.width, to.x + to.width);
    const top = Math.min(from.y, to.y);
    const bottom = Math.max(from.y + from.height, to.y + to.height);
    scroll.scrollTo({
      left: Math.max(0, (left + right) / 2 - scroll.clientWidth / 2),
      top: Math.max(0, (top + bottom) / 2 - scroll.clientHeight / 2),
      behavior: "smooth",
    });
    // hopKey stands in for the hop itself so a re-render with the same step
    // does not re-scroll while the reader is dragging.
  }, [hopKey, layout]); // eslint-disable-line react-hooks/exhaustive-deps

  const startJourney = (index: number) => {
    if (journeyIndex === index) {
      setPlaying((current) => !current);
      return;
    }
    setJourneyIndex(index);
    setStep(0);
    setPlaying(true);
  };

  const stopJourney = () => {
    setJourneyIndex(null);
    setPlaying(false);
    setStep(0);
  };

  // What is lit: a playing journey wins, then a hovered actor, then whatever
  // the rest of the app has selected. At rest nothing is dimmed — the diagram
  // should say something before it is touched.
  const selectedActor = useMemo(
    () => actorForNode(story, selectedId),
    [story, selectedId],
  );
  const hop = hops[step] ?? null;
  const focusActor = hovered ?? (journey ? null : selectedActor);

  let liveActors: Set<string> | null = null;
  let liveFlows: Set<string> | null = null;
  const pointedFlow = !hop && hoveredFlow
    ? (story.flows.find((flow) => flowKey(flow) === hoveredFlow) ?? null)
    : null;
  if (hop) {
    liveActors = new Set([hop.from, hop.to]);
    liveFlows = new Set([flowKey(hop.flow)]);
  } else if (pointedFlow) {
    // One line asked about directly: light just its two ends.
    liveActors = new Set([pointedFlow.from, pointedFlow.to]);
    liveFlows = new Set([hoveredFlow!]);
  } else if (focusActor) {
    const near = neighborhood(focusActor, story.flows);
    liveActors = near.actors;
    liveFlows = near.edges;
  }

  // Everywhere a journey has already been, so a trip reads as a path and not
  // as one lit box at a time.
  const visited = useMemo(() => {
    if (!journey) return new Set<string>();
    return new Set(hops.slice(0, step + 1).flatMap((each) => [each.from, each.to]));
  }, [journey, hops, step]);

  const stateOf = (actor: StoryActor): "on" | "off" | "rest" => {
    if (!liveActors) return "rest";
    if (liveActors.has(actor.id)) return "on";
    return visited.has(actor.id) ? "rest" : "off";
  };

  return (
    <div className="story-mount">
      <div className="story-brief">
        <p className="story-summary">{story.summary}</p>
        {story.journeys.length > 0 ? (
          <div className="story-journeys">
            <span className="section-index">Follow the data</span>
            <ul>
              {story.journeys.map((each, index) => (
                <li key={each.name}>
                  <button
                    type="button"
                    className={journeyIndex === index ? "is-active" : undefined}
                    aria-pressed={journeyIndex === index}
                    onClick={() => startJourney(index)}
                  >
                    <span className="story-journey-play" aria-hidden="true">
                      {journeyIndex === index && playing ? "❙❙" : "▶"}
                    </span>
                    {each.name}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </div>

      <div className="story-scroll" ref={scrollRef}>
        <svg
          className="story-diagram"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={story.summary}
        >
          {layout.columns.map((column) => (
            <text
              key={column.role}
              className="story-column-heading"
              x={column.x}
              y={HEADING_BASELINE}
            >
              {ROLE_HEADINGS[column.role].toUpperCase()}
            </text>
          ))}

          <g className="story-flows">
            {layout.flows.map((shape) => {
              const live = liveFlows?.has(shape.key) ?? false;
              const dim = liveFlows !== null && !live;
              return (
                <g
                  key={shape.key}
                  className={`story-flow${shape.back ? " is-back" : ""}${
                    live ? " is-live" : ""
                  }${dim ? " is-dim" : ""}`}
                >
                  <path
                    className="story-flow-hit"
                    d={shape.path}
                    onPointerEnter={() => setHoveredFlow(shape.key)}
                    onPointerLeave={() => setHoveredFlow(null)}
                  >
                    <title>
                      {shape.flow.carries}
                      {shape.flow.returns ? ` · back: ${shape.flow.returns}` : ""}
                    </title>
                  </path>
                  <path className="story-flow-line" d={shape.path} />
                  <path className="story-flow-arrow" d={shape.arrow} />
                  {live ? <path className="story-flow-pulse" d={shape.path} /> : null}
                </g>
              );
            })}
          </g>

          {layout.cards.map((card) => (
            <ActorCardShape
              key={card.actor.id}
              card={card}
              state={stateOf(card.actor)}
              onEnter={() => setHovered(card.actor.id)}
              onLeave={() => setHovered(null)}
              onPick={(module) => {
                if (module) onSelect(module);
              }}
            />
          ))}

        </svg>
      </div>

      {journey || pointedFlow ? (
        <div className="story-caption" role="status">
          <div className="story-caption-head">
            <span className="section-index">
              {journey
                ? `${journey.name} · step ${Math.min(step + 1, hops.length)} of ${hops.length}`
                : "What travels here"}
            </span>
            {journey ? (
            <div className="story-caption-controls">
              <button
                type="button"
                onClick={() => setStep((current) => Math.max(0, current - 1))}
                disabled={step === 0}
                aria-label="Previous step"
              >
                ‹
              </button>
              <button
                type="button"
                onClick={() => setPlaying((current) => !current)}
                aria-label={playing ? "Pause" : "Play"}
              >
                {playing ? "❙❙" : "▶"}
              </button>
              <button
                type="button"
                onClick={() =>
                  setStep((current) => Math.min(hops.length - 1, current + 1))
                }
                disabled={step >= hops.length - 1}
                aria-label="Next step"
              >
                ›
              </button>
              <button type="button" onClick={stopJourney} aria-label="Close journey">
                ✕
              </button>
            </div>
            ) : null}
          </div>
          {hop ? (
            <p className="story-caption-text">
              <strong>{layout.cardById.get(hop.from)?.actor.name ?? hop.from}</strong>
              <span aria-hidden="true"> → </span>
              <strong>{layout.cardById.get(hop.to)?.actor.name ?? hop.to}</strong>
              <span className="story-caption-carries">{hop.text}</span>
            </p>
          ) : pointedFlow ? (
            <p className="story-caption-text">
              <strong>
                {layout.cardById.get(pointedFlow.from)?.actor.name ?? pointedFlow.from}
              </strong>
              <span aria-hidden="true"> → </span>
              <strong>
                {layout.cardById.get(pointedFlow.to)?.actor.name ?? pointedFlow.to}
              </strong>
              <span className="story-caption-carries">{pointedFlow.carries}</span>
              {pointedFlow.returns ? (
                <span className="story-caption-returns">
                  and back: {pointedFlow.returns}
                </span>
              ) : null}
            </p>
          ) : null}
          {journey?.blurb ? <p className="story-caption-note">{journey.blurb}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const HEADING_BASELINE = 40;

export default StoryScene;

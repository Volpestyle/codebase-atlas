import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JourneyHop } from "./journey";
import type { Story, StoryActor } from "./model";
import { buildSequenceLayout } from "./sequenceLayout";
import PartFigure from "./ui/PartFigure";
import type { Theme } from "./ui/useTheme";
import { useReducedMotion } from "./ui/useReducedMotion";

export default function SequenceView({ story, hops, step, actor, theme, onStep, onSelectActor }: {
  story: Story; hops: JourneyHop[]; step: number; actor: StoryActor; theme: Theme;
  onStep: (step: number) => void; onSelectActor: (id: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const [width, setWidth] = useState(800);
  const [edges, setEdges] = useState({ left: false, right: false });
  const reduced = useReducedMotion();
  const marker = useId().replace(/:/g, "");
  const layout = useMemo(() => buildSequenceLayout(story.actors, hops, width), [story, hops, width]);
  const current = layout.rows[step];
  const name = (id: string) => story.actors.find(part => part.id === id)?.name ?? id;
  function measureEdges() {
    const el = scrollRef.current;
    if (!el) return;
    const left = el.scrollLeft > 1; const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges(prev => prev.left === left && prev.right === right ? prev : { left, right });
  }
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => { setWidth(el.clientWidth); measureEdges(); });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !current) return;
    const behavior = reduced ? "instant" : "smooth";
    // Move only when needed, leaving room for the sticky participant headers.
    const target = Math.max(0, current.top - layout.headerHeight - 32);
    const top = current.top < el.scrollTop + layout.headerHeight || current.top + current.height > el.scrollTop + el.clientHeight ? target : el.scrollTop;
    const centered = (current.x1 + current.x2) / 2 - el.clientWidth / 2;
    const left = Math.max(0, current.left + current.labelWidth - el.clientWidth + 16, Math.min(centered, current.left - 16));
    el.scrollTo({ left, top, behavior });
    const list = listRef.current;
    const row = list?.children[step] as HTMLElement | undefined;
    if (list && row && (row.offsetTop < list.scrollTop || row.offsetTop + row.offsetHeight > list.scrollTop + list.clientHeight)) list.scrollTo({ top: row.offsetTop - 16, behavior });
    measureEdges();
  }, [current, layout.headerHeight, reduced, step]);
  return <>
    <div className={`sequence-scroll atlas-transit-scroll${edges.left ? " fade-left" : ""}${edges.right ? " fade-right" : ""}`} ref={scrollRef} onScroll={measureEdges} tabIndex={0} role="region" aria-label="Journey sequence; scroll to explore">
      <div className="sequence-field" style={{ width: layout.width, height: layout.height }}>
        <div className="sequence-heads" style={{ height: layout.headerHeight }}>
          {layout.columns.map(column => <button key={column.actor.id} className={`sequence-part${column.actor.id === actor.id ? " is-selected" : ""}${column.actor.id === current?.hop.from || column.actor.id === current?.hop.to ? " is-current" : ""}`} style={{ left: column.x - column.width / 2, width: column.width }} onClick={() => onSelectActor(column.actor.id)} aria-label={`Select part: ${column.actor.name}`} aria-pressed={column.actor.id === actor.id}>
            {column.actor.role === "person" ? <span className="sequence-person" aria-hidden="true"><span /></span> : <PartFigure actor={column.actor} theme={theme} />}
            <span>{column.lines.map((line, i) => <span key={i}>{line}</span>)}</span>
          </button>)}
        </div>
        <svg width={layout.width} height={layout.height} aria-hidden="true">
          <defs>{["ink", "graphic"].map(tone => <marker key={tone} id={`${marker}-${tone}`} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke={`var(--${tone})`} strokeWidth="1.2" /></marker>)}</defs>
          {layout.columns.map(column => <path key={column.actor.id} d={`M ${column.x} ${layout.headerHeight - 8} V ${layout.height - 12}`} className="sequence-lifeline" />)}
          {layout.rows.map(row => <g key={row.index}>
            <path d={row.d} className={`sequence-arrow${row.index <= step ? " is-visited" : ""}${row.index === step ? " is-current" : ""}${row.hop.reversed ? " is-return" : ""}`} markerEnd={`url(#${marker}-${row.index <= step ? "ink" : "graphic"})`} />
            <path d={row.d} className="transit-route-hit" onClick={() => onStep(row.index)} />
          </g>)}
          {current && <circle key={current.index} className="transit-packet" r="3.5" cx={reduced ? current.x1 : 0} cy={reduced ? current.y : 0}>
            {!reduced && <animateMotion dur="1.8s" repeatCount="indefinite" path={current.d} />}
          </circle>}
        </svg>
        {layout.rows.map(row => <button key={row.index} className={`sequence-label${row.index < step ? " is-visited" : ""}${row.index === step ? " is-current" : ""}`} style={{ left: row.left, top: row.top, width: row.labelWidth }} aria-label={`Hop ${row.index + 1}: ${name(row.hop.from)} to ${name(row.hop.to)}. ${row.hop.text}`} aria-current={row.index === step ? "step" : undefined} onClick={() => onStep(row.index)}>
          <span className="atlas-mono atlas-muted">{String(row.index + 1).padStart(2, "0")}</span><span>{row.lines.map((line, i) => <span key={i}>{line}</span>)}</span>
        </button>)}
      </div>
    </div>
    <ol className="sequence-list" ref={listRef} aria-label="Journey exchanges">
      {hops.map((hop, i) => <li key={i}><button className={i === step ? "is-current" : i < step ? "is-visited" : undefined} aria-current={i === step ? "step" : undefined} onClick={() => onStep(i)}>
        <span className="atlas-mono atlas-muted">{String(i + 1).padStart(2, "0")}</span><span><span className="sequence-pair">{name(hop.from)} <span aria-label={hop.reversed ? "returns to" : "to"}>{hop.reversed ? "⇢" : "→"}</span> {name(hop.to)}</span><span className="sequence-sentence">{hop.text}</span></span>
      </button></li>)}
    </ol>
    {!hops.length && <p className="atlas-padding atlas-muted">No journeys written yet. Choose All parts to inspect the written connections.</p>}
  </>;
}

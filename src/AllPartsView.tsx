import { useEffect, useId, useRef, useState } from "react";
import { ACTOR_ROLES, ROLE_HEADINGS, type Story, type StoryFlow } from "./model";
import { buildNetworkLayout, type NetworkLayout } from "./elkLayout";

export default function AllPartsView({ story, selectedId, currentFlow, onSelectActor, onInspect }: {
  story: Story; selectedId: string; currentFlow?: StoryFlow; onSelectActor: (id: string) => void; onInspect: (flow: StoryFlow) => void;
}) {
  const [result, setResult] = useState<{ story: Story; layout?: NetworkLayout; error?: string }>();
  const [edges, setEdges] = useState({ left: false, right: false });
  const scrollRef = useRef<HTMLDivElement>(null);
  const marker = useId().replace(/:/g, "");
  useEffect(() => {
    let active = true;
    buildNetworkLayout(story).then(layout => { if (active) setResult({ story, layout }); }, () => { if (active) setResult({ story, error: "The layout could not be prepared. Switch to This journey, or try again." }); });
    return () => { active = false; };
  }, [story]);
  const layout = result?.story === story ? result.layout : undefined;
  function measureEdges() {
    const el = scrollRef.current;
    if (el) setEdges({ left: el.scrollLeft > 1, right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1 });
  }
  useEffect(() => {
    if (!layout || !scrollRef.current) return;
    const observer = new ResizeObserver(measureEdges);
    observer.observe(scrollRef.current);
    return () => observer.disconnect();
  }, [layout]);
  if (result?.story === story && result.error) return <p role="alert" className="atlas-padding">{result.error}</p>;
  if (!layout) return <p role="status" className="atlas-padding atlas-muted">Laying out all parts…</p>;
  return <div className={`all-parts-scroll atlas-transit-scroll${edges.left ? " fade-left" : ""}${edges.right ? " fade-right" : ""}`} ref={scrollRef} onScroll={measureEdges} tabIndex={0} role="region" aria-label="All parts; scroll to explore">
    <div className="all-parts-field" style={{ width: layout.width, height: layout.height }}>
      {ACTOR_ROLES.map(role => {
        const parts = layout.parts.filter(part => part.actor.role === role);
        if (!parts.length) return null;
        const left = Math.min(...parts.map(part => part.x));
        return <span key={role} className="all-parts-role" style={{ left, top: 16 }}>{ROLE_HEADINGS[role]}</span>;
      })}
      <svg width={layout.width} height={layout.height} role="group" aria-label="Written connections">
        <defs><marker id={marker} viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto" markerUnits="userSpaceOnUse"><path d="M 0 1 L 7 4 L 0 7" fill="none" stroke="var(--graphic)" strokeWidth="1.2" /></marker></defs>
        {layout.routes.map((route, i) => <g key={i}>
          <path d={route.d} className={`network-route${currentFlow === route.flow ? " is-current" : ""}`} markerEnd={`url(#${marker})`} />
          <path d={route.d} className="transit-route-hit" tabIndex={0} role="button" aria-label={`What travels from ${story.actors.find(a => a.id === route.flow.from)?.name} to ${story.actors.find(a => a.id === route.flow.to)?.name}: ${route.flow.carries}`} onClick={() => onInspect(route.flow)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onInspect(route.flow); } }} />
        </g>)}
      </svg>
      {layout.parts.map(part => <button key={part.actor.id} className={`network-part${part.actor.id === selectedId ? " is-selected" : ""}`} style={{ left: part.x, top: part.y, width: part.width, height: part.height }} aria-label={`Select part: ${part.actor.name}`} aria-pressed={part.actor.id === selectedId} onClick={() => onSelectActor(part.actor.id)}>{part.lines.map((line, i) => <span key={i}>{line}</span>)}</button>)}
    </div>
  </div>;
}

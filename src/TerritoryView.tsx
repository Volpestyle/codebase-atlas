import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RepositoryGraph, StoryActor } from "./model";
import { buildTerritoryLayout, exclusiveGapSuggestions, territoryJourney } from "./territory";
import PartDetails, { FileList } from "./PartDetails";

export function GapHints({ graph, actorId, onOpenFile }: { graph: RepositoryGraph; actorId?: string; onOpenFile: (id: string) => void }) {
  const hints = useMemo(() => exclusiveGapSuggestions(graph), [graph]).filter(hint => !actorId || hint.actorId === actorId);
  return <section className="atlas-gap"><h2>Not in the <em>story</em> <small className="atlas-kicker">Derived from imports</small></h2>
    {!graph.stats.importsAvailable ? <p className="atlas-muted">Import suggestions need a local scan. GitHub trees have no import graph.</p> : hints.length ? hints.map(hint => <details key={hint.actorId}><summary>{hint.files.length} files{graph.stats.lineCountAvailable ? ` (${hint.lines.toLocaleString()} lines)` : ""} are used only by {graph.story?.actors.find(part => part.id === hint.actorId)?.name}</summary><p className="atlas-muted">Every upstream product importer reaches this part. Tests are ignored. Review these files before changing the written story.</p><FileList graph={graph} files={hint.files} onOpenFile={onOpenFile} /></details>) : <p className="atlas-muted">No uncovered files have a single owning part among their upstream importers.</p>}
  </section>;
}

export default function TerritoryView({ graph, actor, journeyIndex, onSelectActor, onOpenFile, selectedId, onInside }: {
  graph: RepositoryGraph; actor?: StoryActor; journeyIndex: number; onSelectActor: (id: string) => void;
  onOpenFile: (id: string) => void; selectedId: string | null; onInside?: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [trace, setTrace] = useState(false);
  const pattern = useId();
  useEffect(() => {
    const observer = new ResizeObserver(entries => setWidth(Math.max(1, entries[0].contentRect.width)));
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  const layout = useMemo(() => buildTerritoryLayout(graph, width, Math.max(430, width * .6)), [graph, width]);
  const journey = graph.story?.journeys[journeyIndex];
  const route = journey && territoryJourney(journey, layout.cells);
  const selected = graph.nodes.find(node => node.id === selectedId && node.kind !== "repository" && node.kind !== "directory");
  return <>
    <h1>Where it <em>lives</em>.</h1><p className="atlas-intro">Files read from the code. Parts written by hand. Select a part to see its territory.</p>
    <div className="atlas-card" ref={container}>
      <div className="territory-toolbar"><span className="atlas-kicker">Scanned files · weighted volume</span>{journey && <label><input type="checkbox" checked={trace} onChange={event => setTrace(event.target.checked)} />Trace {journey.name}</label>}</div>
      <svg className="territory-map" width="100%" height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} aria-label="Files grouped by top-level area">
        <defs><pattern id={pattern} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--card)" /><path d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5" stroke="var(--line)" /></pattern></defs>
        {layout.areas.map(area => <g key={area.name}><rect {...area} fill="var(--pill)" /><text x={area.x + 6} y={area.y + Math.min(18, area.height / 5)} className="territory-area">{area.width > 75 ? area.name : ""}</text></g>)}
        {layout.cells.map(cell => {
          const target = cell.width >= 46 && cell.height >= 46;
          const active = cell.owner === actor?.id;
          const fill = !cell.product ? "var(--pill)" : active ? "var(--ink)" : cell.owner ? "var(--line)" : `url(#${pattern})`;
          return <g key={cell.node.id} role={target ? "button" : undefined} tabIndex={target ? 0 : undefined} aria-label={target ? cell.node.path : undefined} onClick={target ? () => onOpenFile(cell.node.id) : undefined} onKeyDown={target ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenFile(cell.node.id); } } : undefined} className={target ? "territory-target" : undefined}>
            <title>{cell.node.path}{graph.stats.lineCountAvailable ? ` · ${cell.node.lines} lines` : ""}</title><rect x={cell.x + 1} y={cell.y + 1} width={Math.max(0, cell.width - 2)} height={Math.max(0, cell.height - 2)} fill={fill} stroke={selectedId === cell.node.id ? "var(--ink)" : "var(--card)"} strokeWidth={selectedId === cell.node.id ? 3 : 1} />
            {cell.width > 110 && cell.height > 32 && <text x={cell.x + 8} y={cell.y + 21} fill={active && cell.product ? "var(--bg)" : "var(--muted)"} className="territory-file">{cell.node.name.length * 6 > cell.width - 16 ? `${cell.node.name.slice(0, Math.max(3, Math.floor((cell.width - 24) / 6)))}…` : cell.node.name}</text>}
          </g>;
        })}
        {trace && route && <g className="territory-trace" aria-label="Journey across code parts"><path d={route.path} /><g>{route.stops.map(stop => <g key={stop.step}><circle cx={stop.x} cy={stop.y} r="11" /><text x={stop.x} y={stop.y + 4}>{stop.step}</text></g>)}</g></g>}
      </svg>
      <div className="territory-key atlas-muted"><span>■ Selected part</span><span>□ Other parts</span><span>▧ Not in the story</span><span>Tests / setup muted</span></div>
      {trace && route && <p className="atlas-padding atlas-muted">{route.outside.length ? `Outside the files: ${route.outside.map(id => graph.story?.actors.find(part => part.id === id)?.name).join(", ")}. ` : ""}Numbers follow the written journey; each stop marks the part’s largest file.</p>}
    </div>
    {selected && <section className="atlas-file-detail"><h2 className="atlas-mono">{selected.path}</h2><p>{selected.description ?? "No file summary in the scan."}</p><p className="atlas-muted">{selected.language ?? selected.kind}{graph.stats.lineCountAvailable ? ` · ${selected.lines.toLocaleString()} lines` : " · line counts unavailable"} · Scanned</p></section>}
    <details className="atlas-browse"><summary>Browse all {layout.cells.length} files</summary><FileList graph={graph} files={layout.cells.map(cell => cell.node).sort((a,b) => a.path.localeCompare(b.path))} onOpenFile={onOpenFile} /></details>
    {actor && <PartDetails graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} onInside={onInside} />}
    <GapHints graph={graph} onOpenFile={onOpenFile} />
  </>;
}

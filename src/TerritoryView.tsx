import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { RepositoryGraph, StoryActor } from "./model";
import { buildTerritoryLayout, exclusiveGapSuggestions, importsArePartial, storyCoverage, territoryJourney, type TerritoryArea, type TerritoryFile } from "./territory";
import { isTestPath } from "./sourceScope";
import PartDetails, { FileList } from "./PartDetails";

export function GapHints({ graph, actorId, onOpenFile }: { graph: RepositoryGraph; actorId?: string; onOpenFile: (id: string) => void }) {
  const hints = useMemo(() => exclusiveGapSuggestions(graph), [graph]).filter(hint => !actorId || hint.actorId === actorId);
  const partial = importsArePartial(graph);
  return <section className="atlas-gap"><h2>Not in the <em>story</em> <small className="atlas-kicker">Derived from imports</small></h2>
    {!graph.stats.importsAvailable ? <p className="atlas-muted">Import suggestions need a local scan. GitHub trees have no import graph.</p> : <>
      {partial && <p className="atlas-caveat">This scan is partial, so some imports are missing. Treat these suggestions as guesses.</p>}
      {hints.length ? hints.map(hint => <details key={hint.actorId}><summary>{hint.files.length} files{graph.stats.lineCountAvailable ? ` (${hint.lines.toLocaleString()} lines)` : ""} are used only by {graph.story?.actors.find(part => part.id === hint.actorId)?.name}</summary><p className="atlas-muted">Every upstream product importer reaches this part. Tests are ignored. Review these files before changing the written story.</p><FileList graph={graph} files={hint.files} onOpenFile={onOpenFile} /></details>) : <p className="atlas-muted">No uncovered files have a single owning part among their upstream importers.</p>}
    </>}
  </section>;
}

export function TerritoryHeading({ graph }: { graph: RepositoryGraph }) {
  const coverage = storyCoverage(graph);
  const covered = coverage.available && graph.story ? Math.round(coverage.covered / coverage.total * 100) : null;
  return <>
    <h1>Where it <em>lives</em>.</h1>
    <p className="atlas-intro">Every rectangle is a file, sized by its lines. Parts are written by hand; select one to see its territory.{covered !== null ? ` The story covers ${covered}% of the product code; the hatched rest belongs to no part yet.` : ""}</p>
  </>;
}

const TILE_GAP = 1.5;
const LABEL = { minWidth: 74, minHeight: 38, charWidth: 6.4 };

function clip(text: string, width: number) {
  const fits = Math.floor((width - 16) / LABEL.charWidth);
  return text.length <= fits ? text : `${text.slice(0, Math.max(1, fits - 1))}…`;
}

/** "Title · path/": the part owning most (60%+) of an area's product lines, else
 *  what the area holds. Story names are written; paths are scanned. */
function areaLabel(area: TerritoryArea, cells: TerritoryFile[], graph: RepositoryGraph) {
  const lines = new Map<string | null, number>();
  for (const cell of cells) if (cell.product) lines.set(cell.owner, (lines.get(cell.owner) ?? 0) + Math.max(1, cell.node.lines));
  const total = [...lines.values()].reduce((sum, value) => sum + value, 0);
  const top = [...lines].sort((a, b) => b[1] - a[1])[0];
  // Name a part only when it holds most of the area; otherwise say it is shared.
  const title = top ? top[1] / total < .6 ? "Several parts" : top[0] ? graph.story?.actors.find(part => part.id === top[0])?.name ?? top[0] : "Not in the story"
    : cells.every(cell => isTestPath(cell.node.id)) ? "Tests" : "Setup";
  return `${title} · ${area.name === "Repository" ? "root files" : `${area.name}/`}`;
}

export default function TerritoryView({ graph, actor, gap, journeyIndex, onSelectActor, onOpenFile, selectedId, onInside }: {
  graph: RepositoryGraph; actor?: StoryActor; gap: boolean; journeyIndex: number; onSelectActor: (id: string) => void;
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
  const labels = useMemo(() => new Map(layout.areas.map(area => [area.name, areaLabel(area, layout.cells.filter(cell => (cell.node.path.includes("/") ? cell.node.path.split("/")[0] : "Repository") === area.name), graph)])), [layout, graph]);
  const coverage = useMemo(() => storyCoverage(graph), [graph]);
  const journey = graph.story?.journeys[journeyIndex];
  const route = journey && territoryJourney(journey, layout.cells);
  const selected = graph.nodes.find(node => node.id === selectedId && node.kind !== "repository" && node.kind !== "directory");
  const gapRow = coverage.parts.find(part => part.actorId === null);
  return <>
    <div className="atlas-card territory-card">
      <div ref={container}>
        <svg className="territory-map" width="100%" height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="group" aria-label="Files grouped by top-level area">
          <defs><pattern id={pattern} width="6" height="6" patternUnits="userSpaceOnUse"><rect width="6" height="6" fill="var(--card)" /><path d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5" stroke="var(--graphic)" strokeWidth=".75" /></pattern></defs>
          {layout.areas.map(area => <text key={area.name} x={area.x + 6} y={area.y + Math.min(17, area.height / 5)} className="territory-area">{area.width > 60 ? clip(labels.get(area.name) ?? area.name, area.width) : ""}</text>)}
          {layout.cells.map(cell => {
            const target = cell.width >= 46 && cell.height >= 46;
            const kind = !cell.product ? "support" : gap ? (cell.owner ? "other" : "active") : cell.owner === actor?.id ? "active" : cell.owner ? "other" : "gap";
            const fill = kind === "active" ? "var(--ink)" : kind === "other" ? "var(--graphic)" : kind === "gap" ? `url(#${pattern})` : "transparent";
            const ink = kind === "active" ? "var(--bg)" : kind === "other" ? "var(--ink)" : kind === "gap" ? "var(--body)" : "var(--muted)";
            const w = Math.max(0, cell.width - TILE_GAP * 2); const h = Math.max(0, cell.height - TILE_GAP * 2);
            const isSelected = selectedId === cell.node.id;
            return <g key={cell.node.id} role={target ? "button" : undefined} tabIndex={target ? 0 : undefined} aria-label={target ? `${cell.node.path}${graph.stats.lineCountAvailable ? `, ${cell.node.lines} lines` : ""}` : undefined} onClick={target ? () => onOpenFile(cell.node.id) : undefined} onKeyDown={target ? event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onOpenFile(cell.node.id); } } : undefined} className={`territory-cell is-${kind}${target ? " territory-target" : ""}`}>
              <title>{cell.node.path}{graph.stats.lineCountAvailable ? ` · ${cell.node.lines} lines` : ""}</title>
              <rect x={cell.x + TILE_GAP} y={cell.y + TILE_GAP} width={w} height={h} rx={Math.min(6, w / 2, h / 2)} fill={fill} stroke={isSelected ? "var(--ink)" : kind === "support" ? "var(--line)" : "none"} strokeWidth={isSelected ? 3 : 1} />
              {w > LABEL.minWidth && h > LABEL.minHeight && <text x={cell.x + TILE_GAP + 8} y={cell.y + TILE_GAP + 18} fill={ink} className="territory-file">
                {clip(cell.node.name, w)}
                {graph.stats.lineCountAvailable && <tspan x={cell.x + TILE_GAP + 8} dy="15" className="territory-lines">{cell.node.lines.toLocaleString()}</tspan>}
              </text>}
            </g>;
          })}
          {trace && route && <g className="territory-trace" aria-label={`${journey?.name}, traced across the code`}><path className="territory-trace-under" d={route.path} /><path d={route.path} /><g>{route.stops.map(stop => <g key={stop.step}><circle cx={stop.x} cy={stop.y} r="10" /><text x={stop.x} y={stop.y + 3.5}>{stop.step}</text></g>)}</g></g>}
        </svg>
      </div>
      <div className="territory-bar">
        <div className="territory-key atlas-muted">
          <span><i className="key-swatch is-active" aria-hidden="true" />{gap ? "Not in the story" : "Selected part"}</span>
          <span><i className="key-swatch is-other" aria-hidden="true" />Other parts</span>
          {!gap && <span><i className="key-swatch is-gap" aria-hidden="true" />Not in the story</span>}
          <span><i className="key-swatch is-support" aria-hidden="true" />Tests and setup</span>
          <span>Area is lines; config counts at a quarter.</span>
        </div>
        {journey && <button className="atlas-pill-button" aria-pressed={trace} onClick={() => setTrace(!trace)}>{trace ? "Hide journey" : `Trace “${journey.name}”`}</button>}
      </div>
      {trace && route && <p className="atlas-padding atlas-muted territory-trace-note">{route.outside.length ? `Outside the files: ${route.outside.map(id => graph.story?.actors.find(part => part.id === id)?.name).join(", ")}. ` : ""}Numbers follow the written journey; each stop marks the part’s largest file.</p>}
    </div>
    <div aria-live="polite">{selected && <section className="atlas-file-detail"><h2 className="atlas-mono">{selected.path}</h2><p>{selected.description ?? "No file summary in the scan."}</p><p className="atlas-muted">{selected.language ?? selected.kind}{graph.stats.lineCountAvailable ? ` · ${selected.lines.toLocaleString()} lines` : " · line counts unavailable"} · Scanned</p></section>}</div>
    <details className="atlas-browse"><summary>Browse all {layout.cells.length} files</summary><FileList graph={graph} files={layout.cells.map(cell => cell.node).sort((a,b) => a.path.localeCompare(b.path))} onOpenFile={onOpenFile} /></details>
    {gap ? <section className="atlas-part-details atlas-gap-details">
      <div><span className="atlas-kicker">Gap in the story · Scanned</span><h2>Not in the story yet</h2><p className="atlas-muted">{gapRow ? `${graph.stats.lineCountAvailable ? `${gapRow.lines.toLocaleString()} lines in ` : ""}${gapRow.files} product file${gapRow.files === 1 ? "" : "s"} belong to no part. Someone following a journey never passes through them.` : "Every product file belongs to a part."}</p></div>
      <GapHints graph={graph} onOpenFile={onOpenFile} />
    </section> : <>
      {actor && <PartDetails graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} onInside={onInside} />}
      <GapHints graph={graph} onOpenFile={onOpenFile} />
    </>}
  </>;
}

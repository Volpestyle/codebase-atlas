import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import type { RepositoryGraph, StoryActor } from "./model";
import {
  BOARD, GAP_ID, buildOverviewLayout, crossingLabel, elbow, fitCamera, layoutBounds, groundTextMatrix, isoBlock, isoBox, isoDepth, isoProject,
  openPath, pointAlong, placeLabels, plateLabel, quarterAzimuth, rectCenter,
  type IsoCamera, type OverviewLayout, type Point,
} from "./overview";
import { actorFigure } from "./storyFigures";
import PartFigure from "./ui/PartFigure";
import type { Theme } from "./ui/useTheme";
import { useReducedMotion } from "./ui/useReducedMotion";

export function OverviewHeading({ graph }: { graph: RepositoryGraph }) {
  return <>
    <h1>The whole codebase, <em>from above</em>.</h1>
    <p className="atlas-intro">Each part of the story is a district; each block a file, taller for more lines. Rails join parts that import each other or exchange data in the story. Point at a part to see its connections.{graph.story ? "" : " This repository has no story yet, so every file sits in the hatched lot."}</p>
  </>;
}

const TURN_MS = 700;
const ease = (t: number) => {
  // cubic-bezier(.32, .72, 0, 1): Hairline's discrete clock.
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 18; i += 1) {
    u = (lo + hi) / 2;
    const x = 3 * (1 - u) ** 2 * u * .32 + 3 * (1 - u) * u * u * 0 + u ** 3;
    if (x < t) lo = u; else hi = u;
  }
  return 3 * (1 - u) ** 2 * u * .72 + 3 * (1 - u) * u * u + u ** 3;
};
const LABEL_FONT = 17;
/** Past this zoom every part's blocks stand at full height. */
const DETAIL_ZOOM = 1.8;
const FIGURE = 1.45;
/** How far above its pad centre a figure's box starts, as a share of its width:
 *  Hairline draws a figure's foot at about two thirds of its 5:4 box. */
const FIGURE_LIFT = .8 * .66;
const MONO_CHAR = 6.6;
const fmt = (n: number) => n.toLocaleString();
const cssValue = (value: string) => typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : value.replace(/["\\]/g, "\\$&");

// Laying out Clankie-sized maps takes ~100 ms; keep one per loaded graph so
// returning to the Overview is only a render.
const layouts = new WeakMap<RepositoryGraph, OverviewLayout>();
function cachedLayout(graph: RepositoryGraph): OverviewLayout {
  let layout = layouts.get(graph);
  if (!layout) { layout = buildOverviewLayout(graph); layouts.set(graph, layout); }
  return layout;
}

type Hover = { kind: "part"; id: string } | { kind: "file"; id: string } | null;

/** The static board: ground, plates, rails, blocks and markers, painted back
 *  to front for one azimuth. Highlight is a stylesheet over its data
 *  attributes; the board repaints only when the raised part changes (blocks
 *  rest pressed down and rise to full height for the part in focus, or for
 *  every part once zoomed in). */
const Board = memo(function Board({ layout, cam, hatch, names, raised, detail }: { layout: OverviewLayout; cam: IsoCamera; hatch: string; names: Map<string, string>; raised: string | null; detail: boolean }) {
  const ground = isoBox(cam, { x: 0, y: 0, width: BOARD, height: BOARD }, -14, 0);
  const showLabels = cam.scale * LABEL_FONT >= 7;
  const items: { depth: number; node: ReactNode }[] = [];
  for (const district of layout.districts) for (const pillar of district.pillars) {
    const half = pillar.size / 2;
    const height = detail || district.id === raised ? pillar.height : pillar.rest;
    const box = isoBlock(cam, { x: pillar.x - half, y: pillar.y - half, width: pillar.size, height: pillar.size }, 3, 3 + height);
    const top = isoProject(cam, pillar.x, pillar.y, 3 + height);
    items.push({ depth: isoDepth(cam.az, pillar.x + half, pillar.y + half), node: <g key={pillar.id} className={`ov-pillar${pillar.aggregate ? " is-crate" : ""}`} data-part={district.id} data-pillar={pillar.id}>
      <path className="ov-sil" d={box.silhouette} /><path className="ov-crease" d={box.crease} />
      {pillar.aggregate && <ellipse className="ov-dot" cx={top[0]} cy={top[1]} rx={Math.max(1, cam.scale * 2.4)} ry={Math.max(.5, cam.scale * 1.2)} />}
    </g> });
  }
  for (const marker of layout.markers) {
    const size = 16;
    const box = isoBox(cam, { x: marker.x - size / 2, y: marker.y - size / 2, width: size, height: size }, 0, 10);
    const top = isoProject(cam, marker.x, marker.y, 10);
    items.push({ depth: isoDepth(cam.az, marker.x, marker.y), node: <g key={`m:${marker.actorId}`} className="ov-marker" data-part={marker.actorId}>
      <path className="ov-sil" d={box.silhouette} /><path className="ov-crease" d={box.crease} />
      {marker.role === "person"
        ? <circle className="ov-dot" cx={top[0]} cy={top[1] - Math.max(3, cam.scale * 7)} r={Math.max(2, cam.scale * 4.5)} />
        : <ellipse className="ov-ring" cx={top[0]} cy={top[1]} rx={Math.max(2.5, cam.scale * 6)} ry={Math.max(1.25, cam.scale * 3)} />}
    </g> });
  }
  items.sort((a, b) => a.depth - b.depth);
  return <>
    <path className="ov-ground" d={ground.silhouette} /><path className="ov-ground-top" d={ground.top} /><path className="ov-crease" d={ground.crease} />
    {layout.districts.map(district => {
      const plate = isoBox(cam, district.plate, 0, 3);
      return <g key={district.id} className={`ov-district${district.id === GAP_ID ? " is-gap" : ""}`} data-part={district.id}>
        <path className="ov-plate" d={plate.silhouette} /><path className="ov-plate-top" d={plate.top} style={district.id === GAP_ID ? { fill: `url(#${hatch})` } : undefined} /><path className="ov-crease" d={plate.crease} />
      </g>;
    })}
    {layout.connections.map(connection => <path key={connection.key} className="ov-rail" data-a={connection.a} data-b={connection.b} d={openPath(connection.rail.map(([x, y]) => isoProject(cam, x, y, 0)))} />)}
    {items.map(item => item.node)}
    {/* Names lie flat on each plate's near edge, painted last with a halo so a
        block in front never cuts through them: an annotation, not a solid. */}
    {showLabels && layout.districts.map(district => {
      const { axes, origin, room } = plateLabel(cam.az, district.plate);
      const name = names.get(district.id) ?? district.name;
      const fits = Math.floor(room / (LABEL_FONT * .56));
      if (fits < 4) return null;
      const text = name.length <= fits ? name : `${name.slice(0, Math.max(1, fits - 1))}…`;
      return <text key={district.id} className="ov-plate-label" data-part={district.id} transform={groundTextMatrix(cam, origin[0], origin[1], axes)} fontSize={LABEL_FONT}>{text}</text>;
    })}
  </>;
});

export default function OverviewView({ graph, theme, pickedId, onSelectActor, onNavigate, onFollowJourney }: {
  graph: RepositoryGraph; theme: Theme; pickedId: string | null;
  onSelectActor: (id: string) => void; onNavigate: (view: "territory" | "part") => void; onFollowJourney: (index: number) => void;
}) {
  const story = graph.story;
  const actors = story?.actors ?? [];
  const container = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(900);
  const [turns, setTurns] = useState(0);
  const [az, setAz] = useState(quarterAzimuth(0));
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 });
  const [hover, setHover] = useState<Hover>(null);
  const [keyFocus, setKeyFocus] = useState<string | null>(null);
  const reduced = useReducedMotion();
  const hatch = useId().replace(/:/g, "");
  const layout = useMemo(() => cachedLayout(graph), [graph]);
  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const observer = new ResizeObserver(entries => setWidth(Math.max(280, Math.round(entries[0].contentRect.width))));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Quarter turns: the azimuth eases to the next multiple of 90 + 45.
  useEffect(() => {
    const target = quarterAzimuth(turns);
    if (reduced) { setAz(target); return; }
    let frame = 0;
    const from = az, start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / TURN_MS);
      setAz(from + (target - from) * ease(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [turns, reduced]);

  // A figure's box, in screen units at scale 1: wider than its pad so the
  // drawing (not the box) matches the pad, and the same on every district.
  const figureSpan = layout.padSize * Math.SQRT2 * FIGURE;
  const bounds = useMemo(() => layoutBounds(layout), [layout]);
  const raised = useMemo(() => layout.districts.filter(district => {
    const actor = actors.find(each => each.id === district.actorId);
    return actor && actorFigure(actor);
  }).map(district => rectCenter(district.pad)), [layout, actors]);
  const camera = useMemo(() => fitCamera(width, az, bounds, raised, figureSpan * FIGURE_LIFT), [width, az, bounds, raised, figureSpan]);
  const cam: IsoCamera = useMemo(() => ({ az: camera.az, k: camera.k, scale: camera.scale, ox: camera.ox, oy: camera.oy }), [camera]);
  const names = useMemo(() => new Map([...actors.map(actor => [actor.id, actor.name] as const), [GAP_ID, "Not in the story"] as const]), [actors]);
  const nameOf = (id: string) => names.get(id) ?? id;
  const narrow = width < 640;

  const focusPart = hover?.kind === "part" ? hover.id : hover?.kind === "file" ? null : keyFocus ?? pickedId;
  const focusFile = hover?.kind === "file" ? hover.id : null;
  // The part whose blocks rise: the one in focus, or the one whose block is pointed at.
  const raisedPart = focusPart ?? (focusFile ? layout.pillars.get(focusFile)?.district ?? null : null);
  const detail = view.zoom >= DETAIL_ZOOM;
  const links = useMemo(() => focusPart ? layout.connections.filter(each => each.a === focusPart || each.b === focusPart) : [], [layout, focusPart]);
  const related = useMemo(() => new Set(focusPart ? [focusPart, ...links.map(each => each.a === focusPart ? each.b : each.a)] : []), [focusPart, links]);

  // Hovering a file: its imports, as elbows along the same axes as the rails.
  const filePillar = focusFile ? layout.pillars.get(focusFile) : undefined;
  const fileTargets = useMemo(() => {
    if (!filePillar) return [];
    const targets = new Set<string>();
    for (const file of filePillar.fileIds) for (const target of layout.fileImports.get(file) ?? []) {
      const pillar = layout.pillarOfFile.get(target);
      if (pillar && pillar !== filePillar.id) targets.add(pillar);
    }
    return [...targets].slice(0, 32).map(id => layout.pillars.get(id)!);
  }, [filePillar, layout]);

  const focusStyle = useMemo(() => {
    if (focusPart) {
      const keep = [...related].map(id => `[data-part="${cssValue(id)}"]`).join(",");
      const own = `[data-a="${cssValue(focusPart)}"],[data-b="${cssValue(focusPart)}"]`;
      return `.ov-stage [data-part]:not(${keep}){opacity:.2}.ov-stage .ov-rail:not(${own}){opacity:.15}.ov-stage .ov-rail:is(${own}){stroke:var(--ink);stroke-width:2;opacity:1}.ov-stage [data-part="${cssValue(focusPart)}"] .ov-plate,.ov-stage [data-part="${cssValue(focusPart)}"] .ov-plate-top{stroke:var(--ink)}.ov-stage .ov-pillar[data-part="${cssValue(focusPart)}"] .ov-sil{stroke:var(--ink)}`;
    }
    if (filePillar) {
      const keep = [filePillar, ...fileTargets].map(pillar => `[data-pillar="${cssValue(pillar.id)}"]`).join(",");
      return `.ov-stage .ov-pillar:not(${keep}),.ov-stage .ov-marker,.ov-stage .ov-figure{opacity:.25}.ov-stage .ov-rail{opacity:.15}.ov-stage :is(${keep}) .ov-sil{stroke:var(--ink)}`;
    }
    return "";
  }, [focusPart, related, filePillar, fileTargets]);

  // Rail labels and packets for the focused part, bounded and de-overlapped.
  const railMarks = useMemo(() => {
    if (!focusPart) return { labels: [], packets: [] };
    const ordered = [...links].sort((p, q) => (q.imports + q.flows.length * 4) - (p.imports + p.flows.length * 4));
    const packets = ordered.slice(0, 14).map(link => {
      const points = (link.forward ? link.rail : [...link.rail].reverse()).map(([x, y]) => isoProject(cam, x, y, 0));
      return { key: link.key, d: openPath(points), at: points[Math.floor(points.length / 2)] ?? points[0] };
    }).filter(each => each.d);
    const candidates = ordered.map(link => {
      const text = link.names.length ? crossingLabel(link.names, narrow ? 2 : 3, narrow ? 22 : 34)
        : link.flows[0] ? `“${link.flows[0].carries.length > (narrow ? 22 : 34) ? `${link.flows[0].carries.slice(0, narrow ? 21 : 33)}…` : link.flows[0].carries}”` : "";
      const anchor = pointAlong(link.a === focusPart ? link.rail : [...link.rail].reverse(), .62);
      const [x, y] = isoProject(cam, anchor[0], anchor[1], 0);
      return { key: link.key, text, written: !link.names.length, x, y, width: text.length * MONO_CHAR + 12, height: 20 };
    }).filter(each => each.text);
    return { labels: placeLabels(candidates, narrow ? 4 : 9), packets };
  }, [focusPart, links, cam, narrow]);

  // Figures stand on their pads at one scale everywhere.
  const figureWidth = figureSpan * cam.scale;
  const figures = layout.districts.flatMap(district => {
    const actor = actors.find(each => each.id === district.actorId);
    if (!actor || !actorFigure(actor)) return [];
    const [x, y] = rectCenter(district.pad);
    const [sx, sy] = isoProject(cam, x, y, 3);
    return [{ actor, district, sx, sy, depth: isoDepth(cam.az, x, y) }];
  }).sort((a, b) => a.depth - b.depth);

  // Pan and zoom: drag to pan, pinch or Ctrl/⌘-scroll to zoom, buttons too.
  const pointers = useRef(new Map<number, Point>());
  const drag = useRef<{ start: Point; view: typeof view; moved: boolean; pinch?: { distance: number; mid: Point } } | null>(null);
  const suppressClick = useRef(false);
  function zoomAt(factor: number, at?: Point) {
    setView(current => {
      const zoom = Math.max(.6, Math.min(5, current.zoom * factor));
      const rect = viewport.current?.getBoundingClientRect();
      const [px, py] = at ?? (rect ? [rect.width / 2, rect.height / 2] : [0, 0]);
      const ratio = zoom / current.zoom;
      return { zoom, x: px - (px - current.x) * ratio, y: py - (py - current.y) * ratio };
    });
  }
  useEffect(() => {
    const el = viewport.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      zoomAt(Math.exp(-event.deltaY * .01), [event.clientX - rect.left, event.clientY - rect.top]);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);
  function local(event: ReactPointerEvent): Point {
    const rect = viewport.current!.getBoundingClientRect();
    return [event.clientX - rect.left, event.clientY - rect.top];
  }
  function onPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.current.set(event.pointerId, local(event));
    const points = [...pointers.current.values()];
    if (points.length === 2) {
      const mid: Point = [(points[0][0] + points[1][0]) / 2, (points[0][1] + points[1][1]) / 2];
      drag.current = { start: mid, view, moved: true, pinch: { distance: Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]), mid } };
    } else drag.current = { start: local(event), view, moved: false };
  }
  function onPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const state = drag.current;
    if (!state || !pointers.current.has(event.pointerId)) return;
    pointers.current.set(event.pointerId, local(event));
    const points = [...pointers.current.values()];
    if (state.pinch && points.length === 2) {
      const distance = Math.hypot(points[0][0] - points[1][0], points[0][1] - points[1][1]);
      const zoom = Math.max(.6, Math.min(5, state.view.zoom * distance / Math.max(1, state.pinch.distance)));
      const ratio = zoom / state.view.zoom;
      const [px, py] = state.pinch.mid;
      setView({ zoom, x: px - (px - state.view.x) * ratio, y: py - (py - state.view.y) * ratio });
      return;
    }
    const [x, y] = local(event);
    const dx = x - state.start[0], dy = y - state.start[1];
    if (!state.moved && Math.hypot(dx, dy) < 5) return;
    if (!state.moved) { state.moved = true; viewport.current?.setPointerCapture(event.pointerId); }
    setView({ ...state.view, x: state.view.x + dx, y: state.view.y + dy });
  }
  function onPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    pointers.current.delete(event.pointerId);
    if (drag.current?.moved) suppressClick.current = true;
    if (!pointers.current.size) drag.current = null;
  }

  function hoverFrom(target: EventTarget | null): Hover {
    const el = target instanceof Element ? target : null;
    const pillar = el?.closest<SVGElement | HTMLElement>("[data-pillar]");
    if (pillar) return { kind: "file", id: pillar.dataset.pillar! };
    const part = el?.closest<SVGElement | HTMLElement>("[data-part]");
    return part ? { kind: "part", id: part.dataset.part! } : null;
  }
  // The workspace turns a pick of the hatched lot into Where it lives' gap view.
  const pick = (id: string) => onSelectActor(id);
  function onClick(event: ReactMouseEvent) {
    if (suppressClick.current) { suppressClick.current = false; return; }
    const target = hoverFrom(event.target);
    if (!target) return;
    const id = target.kind === "part" ? target.id : layout.pillars.get(target.id)?.district;
    if (id) pick(id);
  }

  // The read-out: Hairline puts names in a corner, never inside the drawing.
  const readout = (() => {
    if (filePillar) {
      const imports = fileTargets.length;
      return filePillar.aggregate
        ? `${filePillar.fileIds.length} smaller files in ${nameOf(filePillar.district)} · ${fmt(Math.round(filePillar.weight))} lines · import ${imports} shown files`
        : `${filePillar.id} · ${fmt(graph.nodes.find(node => node.id === filePillar.id)?.lines ?? 0)} lines · imports ${imports} file${imports === 1 ? "" : "s"} on the board`;
    }
    if (focusPart) {
      const district = layout.districts.find(each => each.id === focusPart);
      const parts = links.length;
      const facts = district ? `${fmt(district.files)} files${graph.stats.lineCountAvailable ? ` · ${fmt(district.lines)} lines` : ""}` : (actors.find(each => each.id === focusPart)?.role === "person" ? "a person" : "outside the code");
      return `${nameOf(focusPart)} · ${facts} · ${parts} connection${parts === 1 ? "" : "s"}`;
    }
    return `rest · ${fmt(layout.totalFiles)} product files · ${layout.shownFiles === layout.totalFiles ? "every file shown" : `${fmt(layout.shownFiles)} largest shown, the rest stacked per part`}`;
  })();

  const picked = actors.find(each => each.id === pickedId);
  const pickedLinks = picked ? layout.connections.filter(each => each.a === picked.id || each.b === picked.id)
    .sort((p, q) => (q.imports + q.flows.length * 4) - (p.imports + p.flows.length * 4)) : [];
  const pickedDistrict = picked && layout.districts.find(each => each.id === picked.id);
  const journeys = picked ? (story?.journeys ?? []).flatMap((journey, index) => journey.steps.includes(picked.id) ? [{ journey, index }] : []) : [];
  const stageStyle: CSSProperties = { transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})`, width, height: camera.height };
  const chips = [...layout.districts.map(each => each.id), ...layout.markers.map(each => each.actorId)];

  return <>
    <section className="atlas-card overview-card" aria-label="Codebase overview board">
      <div className="overview-bar">
        <span className="atlas-mono atlas-muted overview-readout" aria-live="polite">{readout}</span>
        <div className="overview-camera" role="group" aria-label="Camera">
          <button onClick={() => setTurns(turns - 1)} aria-label="Turn the board left">↺</button>
          <button onClick={() => setTurns(turns + 1)} aria-label="Turn the board right">↻</button>
          <button onClick={() => zoomAt(1 / 1.3)} aria-label="Zoom out">−</button>
          <button onClick={() => zoomAt(1.3)} aria-label="Zoom in">+</button>
          <button onClick={() => { setView({ x: 0, y: 0, zoom: 1 }); setTurns(Math.round(turns / 4) * 4); }} disabled={view.zoom === 1 && view.x === 0 && view.y === 0 && turns % 4 === 0}>Reset</button>
        </div>
      </div>
      <div ref={container} className="overview-measure">
        <div ref={viewport} className="overview-viewport" style={{ height: camera.height }}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={onPointerUp}
          onPointerOver={event => setHover(hoverFrom(event.target))} onPointerLeave={() => setHover(null)} onClick={onClick}>
          <style>{focusStyle}</style>
          <div className={`ov-stage${focusPart || filePillar ? " is-focus" : ""}`} style={stageStyle}>
            <svg className="ov-board" width={width} height={camera.height} viewBox={`0 0 ${width} ${camera.height}`} aria-hidden="true">
              <defs><pattern id={hatch} width="6" height="6" patternUnits="userSpaceOnUse"><path d="M-1 1 L1 -1 M0 6 L6 0 M5 7 L7 5" stroke="var(--graphic)" strokeWidth=".6" /></pattern></defs>
              <Board layout={layout} cam={cam} hatch={hatch} names={names} raised={raisedPart} detail={detail} />
            </svg>
            <div className="ov-figures" aria-hidden="true">
              {figures.map(({ actor, district, sx, sy }) => <div key={district.id} className="ov-figure" data-part={district.id} style={{ left: sx - figureWidth / 2, top: sy - figureWidth * FIGURE_LIFT, width: figureWidth }}>
                <PartFigure actor={actor} theme={theme} />
              </div>)}
            </div>
            <svg className="ov-overlay" width={width} height={camera.height} viewBox={`0 0 ${width} ${camera.height}`} aria-hidden="true">
              {filePillar && fileTargets.map(target => {
                const points = elbow([filePillar.x, filePillar.y], [target.x, target.y]).map(([x, y]) => isoProject(cam, x, y, 3));
                return <path key={target.id} className="ov-import" d={openPath(points)} />;
              })}
              {filePillar && (() => {
                const [x, y] = isoProject(cam, filePillar.x, filePillar.y, 3);
                return <ellipse className="ov-source" cx={x} cy={y} rx={Math.max(5, cam.scale * 14)} ry={Math.max(2.5, cam.scale * 7)} />;
              })()}
              {railMarks.packets.map(packet => <circle key={packet.key} className="ov-packet" r={2.6} cx={reduced ? packet.at[0] : 0} cy={reduced ? packet.at[1] : 0}>
                {!reduced && <animateMotion dur="2.4s" repeatCount="indefinite" path={packet.d} />}
              </circle>)}
              {railMarks.labels.map(label => <g key={label.key} className={`ov-rail-label${label.written ? " is-written" : ""}`}>
                <rect x={label.x - label.width / 2} y={label.y - label.height / 2} width={label.width} height={label.height} rx={6} />
                <text x={label.x} y={label.y + 4}>{label.text}</text>
              </g>)}
            </svg>
          </div>
        </div>
      </div>
      <div className="overview-foot">
        {(() => {
          const list = <div className="overview-parts" role="group" aria-label="Parts on the board">
            {chips.map(id => <button key={id} aria-pressed={id === pickedId} className={id === GAP_ID ? "is-gap" : layout.markers.some(each => each.actorId === id) ? "is-edge" : undefined}
              onFocus={() => setKeyFocus(id)} onBlur={() => setKeyFocus(null)} onPointerEnter={event => { if (event.pointerType === "mouse") setHover({ kind: "part", id }); }} onPointerLeave={() => setHover(null)}
              onClick={() => pick(id)}>{nameOf(id)}</button>)}
          </div>;
          return narrow ? <details className="overview-parts-fold"><summary>Parts on the board <span className="atlas-mono atlas-muted">{chips.length}</span></summary>{list}</details> : list;
        })()}
        <p className="atlas-muted overview-key">Blocks rest low; point at a part or zoom in and its blocks rise to full height, log of lines, capped. Rails: imports and written flows between parts. Drag to pan; pinch or Ctrl/⌘-scroll to zoom.</p>
      </div>
    </section>
    {picked && <OverviewPick actor={picked} district={pickedDistrict} links={pickedLinks} nameOf={nameOf} graph={graph} journeys={journeys} onNavigate={onNavigate} onFollowJourney={onFollowJourney} onSelectActor={onSelectActor} />}
    <footer className="atlas-provenance">Districts and flows: written by hand. Files, lines and imports: read from code. <span>Figures: Hairline, MIT © Lucas Marques</span></footer>
  </>;
}

function OverviewPick({ actor, district, links, nameOf, graph, journeys, onNavigate, onFollowJourney, onSelectActor }: {
  actor: StoryActor; district?: OverviewLayout["districts"][number]; links: OverviewLayout["connections"]; nameOf: (id: string) => string;
  graph: RepositoryGraph; journeys: { journey: { name: string }; index: number }[];
  onNavigate: (view: "territory" | "part") => void; onFollowJourney: (index: number) => void; onSelectActor: (id: string) => void;
}) {
  return <section className="overview-pick" aria-live="polite">
    <div>
      <span className="atlas-kicker">Selected part · Written</span>
      <h2>{actor.name}</h2>
      <p>{actor.blurb}</p>
      <p className="atlas-muted atlas-mono">{district ? `${fmt(district.files)} product files${graph.stats.lineCountAvailable ? ` · ${fmt(district.lines)} lines` : ""} · Scanned` : "No files: a person or outside service"}</p>
      <div className="overview-actions">
        {district && <button className="atlas-pill-button" onClick={() => onNavigate("part")}>Inside a part</button>}
        {district && <button className="atlas-pill-button" onClick={() => onNavigate("territory")}>Where it lives</button>}
        {journeys.map(({ journey, index }) => <button key={index} className="atlas-text-link" onClick={() => onFollowJourney(index)}>Follow “{journey.name}” →</button>)}
      </div>
    </div>
    <div>
      <span className="atlas-kicker">Connections · {links.length}</span>
      <ul className="overview-links">{links.slice(0, 12).map(link => {
        const other = link.a === actor.id ? link.b : link.a;
        return <li key={link.key}>
          <button className="atlas-text-link" onClick={() => other !== GAP_ID && onSelectActor(other)}>{nameOf(other)}</button>
          <span className="atlas-muted atlas-mono">{link.imports ? `${link.imports} import${link.imports === 1 ? "" : "s"}` : ""}{link.imports && link.flows.length ? " · " : ""}{link.flows.length ? `${link.flows.length} written flow${link.flows.length === 1 ? "" : "s"}` : ""}</span>
          {link.names.length > 0 && <span className="atlas-mono overview-names">{crossingLabel(link.names, 6, 80)}</span>}
          {link.flows[0] && <span className="overview-flow">“{link.flows[0].carries}”</span>}
        </li>;
      })}</ul>
      {links.length > 12 && <p className="atlas-muted">{links.length - 12} more on the board.</p>}
    </div>
  </section>;
}

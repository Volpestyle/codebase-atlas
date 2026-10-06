import { crossingLabel, formatBytes, ROLE_HEADINGS, type RepositoryGraph, type RepositoryNode, type StoryActor } from "./model";
import { actorExchanges, filesForActor, partCrossings, type ProseExchange } from "./storyFacts";

export function FileList({ graph, files, onOpenFile }: { graph: RepositoryGraph; files: RepositoryNode[]; onOpenFile: (id: string) => void }) {
  return files.length ? <ul className="atlas-files">{files.map(file => <li key={file.id}>
    <button onClick={() => onOpenFile(file.id)} title={`Open ${file.path} in Where it lives`}><span>{file.path}</span><span>{graph.stats.lineCountAvailable ? `${file.lines.toLocaleString()} lines` : formatBytes(file.sizeBytes)}</span></button>
  </li>)}</ul> : <p className="atlas-muted">No files in this repository. This part is a person or an outside system.</p>;
}

export function ExchangeList({ graph, rows, direction, onSelectActor }: { graph: RepositoryGraph; rows: ProseExchange[]; direction: "from" | "to"; onSelectActor: (id: string) => void }) {
  return rows.length ? <ul className="atlas-exchanges">{rows.map((row, i) => <li key={i}>{row.text}<br /><span className="atlas-muted">{row.returning ? "Back " : ""}{direction} </span><button onClick={() => onSelectActor(row.who)}>{graph.story?.actors.find(actor => actor.id === row.who)?.name ?? row.who}</button></li>)}</ul> : <p className="atlas-muted">No {direction === "from" ? "incoming" : "outgoing"} flow in the story.</p>;
}

export function Crossings({ graph, actor, onSelectActor, onOpenFile }: { graph: RepositoryGraph; actor: StoryActor; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void }) {
  const crossings = partCrossings(graph, actor.id);
  if (!graph.stats.importsAvailable) return <p className="atlas-muted">GitHub trees do not include imports. Scan locally or open an exported map to see the names crossing these boundaries.</p>;
  return crossings.length ? <ul className="atlas-crossings">{crossings.map(crossing => <li key={`${crossing.direction}:${crossing.other}`}>
    <span className="atlas-muted">{crossing.direction === "in" ? "Takes from" : "Used by"} </span>
    {crossing.other ? <button onClick={() => onSelectActor(crossing.other!)}>{graph.story?.actors.find(part => part.id === crossing.other)?.name}</button> : <span>{crossing.files.length} file{crossing.files.length === 1 ? "" : "s"} in no part</span>}
    <p className="atlas-mono">{crossingLabel(crossing.names) ?? "Whole module / no named bindings"}</p>
    <details><summary>{crossing.count} import edge{crossing.count === 1 ? "" : "s"} · names and files</summary><p className="atlas-mono">{crossing.names.length ? crossing.names.join(", ") : "No named bindings recorded"}</p><ul>{crossing.files.map(path => <li key={path}><button className="atlas-mono" onClick={() => onOpenFile(path)}>{path}</button></li>)}</ul></details>
  </li>)}</ul> : <p className="atlas-muted">No imports cross this part’s boundary in the scan.</p>;
}

export default function PartDetails({ graph, actor, onSelectActor, onOpenFile, onInside }: { graph: RepositoryGraph; actor: StoryActor; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void; onInside?: () => void }) {
  const { takes, gives } = actorExchanges(graph.story!, actor);
  const files = filesForActor(graph, actor.id);
  return <section className="atlas-part-details">
    <div><span className="atlas-kicker">{ROLE_HEADINGS[actor.role]} · Written story</span><h2>{actor.name}</h2><p className="atlas-muted">{actor.blurb}</p>{onInside && <button className="atlas-text-link" onClick={onInside}>Look inside {actor.name} →</button>}</div>
    <dl>
      <div><dt>Takes in <small>Written</small></dt><dd><ExchangeList graph={graph} rows={takes} direction="from" onSelectActor={onSelectActor} /></dd></div>
      <div><dt>Hands on <small>Written</small></dt><dd><ExchangeList graph={graph} rows={gives} direction="to" onSelectActor={onSelectActor} /></dd></div>
      <div><dt>Files <small>Scanned</small></dt><dd><FileList graph={graph} files={files} onOpenFile={onOpenFile} /></dd></div>
      <div><dt>In the code <small>Scanned</small></dt><dd><Crossings graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} /></dd></div>
    </dl>
  </section>;
}

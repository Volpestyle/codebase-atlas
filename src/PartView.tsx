import type { RepositoryGraph, StoryActor } from "./model";
import { ROLE_HEADINGS } from "./model";
import type { Theme } from "./ui/useTheme";
import PartFigure from "./ui/PartFigure";
import { filesForActor, supportFilesForActor, testsForActor } from "./storyFacts";
import { partDeclarations } from "./partDeclarations";
import { Crossings, FileList } from "./PartDetails";
import { GapHints } from "./TerritoryView";

const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

export function PartHeading({ graph, actor }: { graph: RepositoryGraph; actor: StoryActor }) {
  const files = filesForActor(graph, actor.id);
  const lines = files.reduce((sum, file) => sum + file.lines, 0);
  const size = graph.stats.lineCountAvailable ? `, ${plural(lines, "line")}` : "";
  return <>
    <span className="atlas-kicker">{ROLE_HEADINGS[actor.role]} · Written story</span>
    <h1>{actor.name}, <em>inside</em>.</h1>
    <p className="atlas-intro">{actor.blurb}{" "}
      {files.length === 1 ? <>One file: <span className="atlas-mono atlas-body">{files[0].path}</span>{size}.</>
        : files.length ? `${plural(files.length, "file")}${size}.` : "No files in this repository: it is a person or an outside system in the story."}
    </p>
  </>;
}

export default function PartView({ graph, actor, theme, onSelectActor, onOpenFile }: {
  graph: RepositoryGraph; actor: StoryActor; theme: Theme; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void;
}) {
  const declarations = partDeclarations(graph, actor.id);
  const files = filesForActor(graph, actor.id);
  const support = supportFilesForActor(graph, actor.id);
  const tests = testsForActor(graph, actor.id);
  const lines = new Map(files.map(file => [file.path, file.lines]));
  const ids = new Map(files.map(file => [file.path, file.id]));
  return <>
    <div className="atlas-inside">
      <div>
        {files.length ? <>
          <h2>Declarations <small className="atlas-kicker">Scanned</small></h2>
          <p className="atlas-muted">Files in path order; exported declarations first, then line order. Atlas does not trace execution or calls.</p>
          <div className="atlas-card declaration-files">{declarations.map(file => <details key={file.path} open={declarations.length === 1}>
            <summary><span className="atlas-mono">{file.path}</span><span className="atlas-muted">{plural(file.declarations.length, "name")}{graph.stats.lineCountAvailable ? ` · ${plural(lines.get(file.path) ?? 0, "line")}` : ""}</span></summary>
            <button className="atlas-text-link declaration-open" onClick={() => onOpenFile(ids.get(file.path) ?? file.path)}>Show in Where it lives</button>
            {file.declarations.length ? <ol>{file.declarations.map((symbol, index) => <li key={`${symbol.line}:${symbol.name}:${index}`}><span className="atlas-mono">{symbol.name}</span><span className="atlas-muted">{symbol.exported ? "exported" : "private"} {symbol.kind} · line {symbol.line}</span></li>)}</ol> : <p className="atlas-padding atlas-muted">No declarations recorded. GitHub sources and unsupported languages have no declaration scan.</p>}
          </details>)}</div>
          <section className="atlas-file-detail"><h2>In the <em>code</em> <small className="atlas-kicker">Scanned imports</small></h2><Crossings graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} /></section>
        </> : <p className="atlas-muted atlas-no-files">{actor.name} has no files in this repository, so there are no declarations or imports to read. Its exchanges with other parts are written in the story.</p>}
      </div>
      <aside className="inside-facts">
        <div className="atlas-card"><PartFigure actor={actor} theme={theme} /><div className="part-card-label"><span>{actor.name}</span><span className="atlas-mono atlas-muted">{plural(files.length, "file")}</span></div></div>
        {support.length > 0 && <section><h2>Also in its folders <small className="atlas-kicker">Scanned · tests, setup, docs</small></h2><FileList graph={graph} files={support} onOpenFile={onOpenFile} /></section>}
        {files.length > 0 && <section><h2>Checked by <small className="atlas-kicker">Scanned imports</small></h2>{!graph.stats.importsAvailable ? <p className="atlas-muted">Tests need a local import scan.</p> : tests.length ? <FileList graph={graph} files={tests} onOpenFile={onOpenFile} /> : <p className="atlas-muted">No test files import this part in the scan. Inline tests are not separate import edges.</p>}</section>}
      </aside>
    </div>
    {files.length > 0 && <GapHints graph={graph} actorId={actor.id} onOpenFile={onOpenFile} />}
    <footer className="atlas-provenance">Declarations, files and imports: read from code. Part, blurb and exchanges: written by hand. <span>Figures: Hairline, MIT © Lucas Marques</span></footer>
  </>;
}

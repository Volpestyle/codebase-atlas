import type { RepositoryGraph, StoryActor } from "./model";
import { ROLE_HEADINGS } from "./model";
import type { Theme } from "./ui/useTheme";
import PartFigure from "./ui/PartFigure";
import { filesForActor, testsForActor } from "./storyFacts";
import { partDeclarations } from "./partDeclarations";
import { Crossings, FileList } from "./PartDetails";
import { GapHints } from "./TerritoryView";

export default function PartView({ graph, actor, theme, onSelectActor, onOpenFile }: {
  graph: RepositoryGraph; actor: StoryActor; theme: Theme; onSelectActor: (id: string) => void; onOpenFile: (id: string) => void;
}) {
  const declarations = partDeclarations(graph, actor.id);
  const files = filesForActor(graph, actor.id);
  const tests = testsForActor(graph, actor.id);
  return <>
    <span className="atlas-kicker">{ROLE_HEADINGS[actor.role]} · Written story</span>
    <h1>{actor.name}, <em>inside</em>.</h1><p className="atlas-intro">{actor.blurb}</p>
    <div className="atlas-inside">
      <div>
        <h2>Declarations <small className="atlas-kicker">Scanned</small></h2>
        <p className="atlas-muted">Files in path order; exported declarations first, then line order. Atlas does not trace execution or calls.</p>
        <div className="atlas-card declaration-files">{declarations.map(file => <details key={file.path} open={declarations.length === 1}>
          <summary><span className="atlas-mono">{file.path}</span><span className="atlas-muted">{file.declarations.length} names</span></summary>
          {file.declarations.length ? <ol>{file.declarations.map((symbol, index) => <li key={`${symbol.line}:${symbol.name}:${index}`}><span className="atlas-mono">{symbol.name}</span><span className="atlas-muted">{symbol.exported ? "exported" : "private"} {symbol.kind} · line {symbol.line}</span></li>)}</ol> : <p className="atlas-padding atlas-muted">No declarations recorded. GitHub sources and unsupported languages have no declaration scan.</p>}
        </details>)}</div>
        {!files.length && <p className="atlas-muted">This part has no files in this repository.</p>}
        <section className="atlas-file-detail"><h2>In the <em>code</em> <small className="atlas-kicker">Scanned imports</small></h2><Crossings graph={graph} actor={actor} onSelectActor={onSelectActor} onOpenFile={onOpenFile} /></section>
      </div>
      <aside className="inside-facts">
        <div className="atlas-card"><PartFigure actor={actor} theme={theme} /><div className="atlas-padding">{actor.name}<span className="atlas-muted"> · {files.length} files</span></div></div>
        <section><h2>Its files <small className="atlas-kicker">Scanned</small></h2><FileList graph={graph} files={files} onOpenFile={onOpenFile} /></section>
        <section><h2>Checked by <small className="atlas-kicker">Scanned imports</small></h2>{!graph.stats.importsAvailable ? <p className="atlas-muted">Tests need a local import scan.</p> : tests.length ? <FileList graph={graph} files={tests} onOpenFile={onOpenFile} /> : <p className="atlas-muted">No test files import this part in the scan. Inline tests are not separate import edges.</p>}</section>
      </aside>
    </div>
    <GapHints graph={graph} actorId={actor.id} onOpenFile={onOpenFile} />
  </>;
}

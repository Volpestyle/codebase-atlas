import type { RepositoryNodeKind, SymbolKind } from "../model";

/** 7px swatch identifying a node or symbol kind; colors come from the kind
 *  tokens. */
function KindMark({ kind }: { kind: RepositoryNodeKind | SymbolKind }) {
  return <span className={`kind-mark kind-${kind}`} aria-hidden="true" />;
}

export default KindMark;

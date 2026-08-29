import type { RepositoryNodeKind } from "../model";

/** 7px swatch identifying a node kind; colors come from the kind tokens. */
function KindMark({ kind }: { kind: RepositoryNodeKind }) {
  return <span className={`kind-mark kind-${kind}`} aria-hidden="true" />;
}

export default KindMark;

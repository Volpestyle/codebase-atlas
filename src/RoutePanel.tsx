export interface RouteEnd {
  /** Node id, for selecting the module this end of the route sits on. */
  id: string;
  label: string;
}

interface RoutePanelProps {
  source: RouteEnd;
  target: RouteEnd;
  /** File-level imports this route merges. */
  weight: number;
  /** Bindings that cross it, already bounded by the aggregation. */
  symbols: string[];
  onSelect: (id: string) => void;
  onClose: () => void;
}

/** What one import route means, in the same shape wherever a route is drawn.
 *  A route's weight says how much crosses it; only its bindings say what, so
 *  the two views that draw routes ask the question the same way. */
function RoutePanel({ source, target, weight, symbols, onSelect, onClose }: RoutePanelProps) {
  return (
    <aside className="route-panel" aria-label="Selected import route">
      <div className="route-panel-head">
        <span className="section-index">
          Route · {weight === 1 ? "1 import" : `${weight} imports`}
        </span>
        <button type="button" onClick={onClose} aria-label="Close route">
          ✕
        </button>
      </div>
      <p className="route-panel-pair">
        <button type="button" onClick={() => onSelect(source.id)}>
          {source.label}
        </button>
        <span aria-hidden="true"> → </span>
        <button type="button" onClick={() => onSelect(target.id)}>
          {target.label}
        </button>
      </p>
      {symbols.length > 0 ? (
        <>
          <span className="section-index">What crosses</span>
          <ul className="route-panel-symbols">
            {symbols.map((symbol) => (
              <li key={symbol}>{symbol}</li>
            ))}
          </ul>
        </>
      ) : (
        <p className="route-panel-empty">
          Nothing named crosses this route — side-effect or dynamic imports only.
        </p>
      )}
    </aside>
  );
}

export default RoutePanel;

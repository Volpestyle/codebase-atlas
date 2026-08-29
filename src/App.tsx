import { useEffect, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import RepositoryScene, { type RepositorySceneHandle } from "./RepositoryScene";
import FlowScene from "./FlowScene";
import { scanGitHubRepository } from "./github";
import {
  formatBytes,
  layerForNode,
  parseRepositoryGraph,
  type LayerName,
  type LayerVisibility,
  type RepositoryGraph,
  type RepositoryNode,
  type RepositoryNodeKind,
} from "./model";
import "./App.css";

const LAST_SOURCE_KEY = "codebase-atlas:last-source";
const isTauriRuntime = "__TAURI_INTERNALS__" in window;
// Folder pickers and save dialogs exist on desktop only; touch devices load
// exported map files or GitHub URLs instead.
const isDesktopRuntime = isTauriRuntime && navigator.maxTouchPoints < 2;

// Granularity slider range; the top stop renders every depth.
const MAX_MAP_DEPTH = 8;
const DEFAULT_MAP_DEPTH = 2;

type SavedSource =
  | { kind: "local"; value: string }
  | { kind: "github"; value: string };

const kindDescriptions: Record<RepositoryNodeKind, string> = {
  repository: "The repository root and coordinate origin for this code map.",
  directory: "A structural boundary that groups related modules and resources.",
  source: "Executable or declarative source that contributes to the product behavior.",
  config: "Configuration that controls tooling, builds, automation, or runtime behavior.",
  documentation: "Human-readable context describing the system, its use, or its decisions.",
  asset: "A non-code resource consumed by the application or its documentation.",
};

const defaultLayers: LayerVisibility = {
  structure: true,
  source: true,
  config: true,
  docs: true,
  imports: true,
};

// Import partners of the selected node, including everything beneath it, so a
// directory shows the aggregate flow of its subtree.
function flowPartners(graph: RepositoryGraph, selected: RepositoryNode) {
  const imports = new Map<string, number>();
  const importers = new Map<string, number>();
  if (selected.id === ".") return { imports, importers };
  const prefix = `${selected.id}/`;
  const inScope = (id: string) => id === selected.id || id.startsWith(prefix);
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    const fromSelection = inScope(edge.source);
    const intoSelection = inScope(edge.target);
    if (fromSelection && !intoSelection) {
      imports.set(edge.target, (imports.get(edge.target) ?? 0) + 1);
    } else if (intoSelection && !fromSelection) {
      importers.set(edge.source, (importers.get(edge.source) ?? 0) + 1);
    }
  }
  return { imports, importers };
}

function topFlows(flows: Map<string, number>) {
  return [...flows]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, 6);
}

function childNodes(graph: RepositoryGraph, parentId: string) {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges
    .filter((edge) => edge.kind === "contains" && edge.source === parentId)
    .map((edge) => nodeById.get(edge.target))
    .filter((node): node is RepositoryNode => Boolean(node))
    .sort((left, right) => {
      const leftRank = left.kind === "directory" || left.kind === "repository" ? 0 : 1;
      const rightRank = right.kind === "directory" || right.kind === "repository" ? 0 : 1;
      return leftRank - rightRank || left.name.localeCompare(right.name);
    });
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The repository scanner returned an unknown error.";
}

function readSavedSource(): SavedSource | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_SOURCE_KEY) ?? "null");
    if (
      saved &&
      typeof saved === "object" &&
      "kind" in saved &&
      "value" in saved &&
      (saved.kind === "local" || saved.kind === "github") &&
      typeof saved.value === "string"
    ) {
      return { kind: saved.kind, value: saved.value };
    }
  } catch {
    localStorage.removeItem(LAST_SOURCE_KEY);
  }
  return null;
}

function saveSource(source: SavedSource) {
  localStorage.setItem(LAST_SOURCE_KEY, JSON.stringify(source));
}

function App() {
  const [graph, setGraph] = useState<RepositoryGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [layers, setLayers] = useState<LayerVisibility>(defaultLayers);
  const [depth, setDepth] = useState(DEFAULT_MAP_DEPTH);
  const [view, setView] = useState<"map" | "flow">("map");
  const [inspectorTab, setInspectorTab] = useState<"overview" | "details">("overview");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [githubDialogOpen, setGitHubDialogOpen] = useState(false);
  const [githubUrl, setGitHubUrl] = useState("");
  const initialScanStarted = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const githubDialogRef = useRef<HTMLDialogElement>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const githubInputRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<RepositorySceneHandle>(null);

  function showGraph(nextGraph: RepositoryGraph) {
    setGraph(nextGraph);
    setSelectedId(
      nextGraph.nodes.find((node) => node.kind === "repository")?.id ??
        nextGraph.nodes[0]?.id ??
        null,
    );
    setSearchQuery("");
    setInspectorTab("overview");
    setInspectorOpen(false);
    setRailOpen(false);
  }

  async function scanPath(path: string) {
    setLoading(true);
    setError(null);
    try {
      const nextGraph = await invoke<RepositoryGraph>("scan_repository", { path });
      showGraph(nextGraph);
      saveSource({ kind: "local", value: path });
    } catch (scanError) {
      if (isTauriRuntime) setError(errorMessage(scanError));
    } finally {
      setLoading(false);
    }
  }

  async function scanGitHub(url: string) {
    setLoading(true);
    setError(null);
    try {
      const nextGraph = await scanGitHubRepository(url);
      showGraph(nextGraph);
      saveSource({ kind: "github", value: nextGraph.root });
      setGitHubUrl(nextGraph.root);
      setGitHubDialogOpen(false);
    } catch (scanError) {
      setError(errorMessage(scanError));
    } finally {
      setLoading(false);
    }
  }

  // A map bundled into the build at maps/default.atlas.json — how mobile
  // builds ship a full-fidelity map of a private repository.
  async function loadBundledMap(): Promise<boolean> {
    try {
      const response = await fetch("maps/default.atlas.json");
      if (!response.ok) return false;
      showGraph(parseRepositoryGraph(await response.text()));
      return true;
    } catch {
      return false;
    }
  }

  useEffect(() => {
    if (initialScanStarted.current) return;
    initialScanStarted.current = true;
    void (async () => {
      // Mobile builds exist to carry their bundled map; it wins at launch.
      if (!isDesktopRuntime && (await loadBundledMap())) return;
      const savedSource = readSavedSource();
      if (savedSource?.kind === "github") {
        setGitHubUrl(savedSource.value);
        await scanGitHub(savedSource.value);
      } else if (savedSource?.kind === "local" && isDesktopRuntime) {
        await scanPath(savedSource.value);
      } else if (isDesktopRuntime && import.meta.env.DEV) {
        await scanPath("..");
      } else {
        await loadBundledMap();
      }
    })();
  }, []);

  useEffect(() => {
    const dialog = githubDialogRef.current;
    if (!dialog) return;
    if (githubDialogOpen && !dialog.open) {
      dialog.showModal();
      githubInputRef.current?.focus();
    } else if (!githubDialogOpen && dialog.open) {
      dialog.close();
    }
  }, [githubDialogOpen]);

  useEffect(() => {
    function handleKeyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        setRailOpen(false);
        setInspectorOpen(false);
        setGitHubDialogOpen(false);
        return;
      }

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        (target.matches("input, textarea, select") || target.isContentEditable)
      ) {
        return;
      }

      if (event.key.toLowerCase() === "g") {
        event.preventDefault();
        openGitHubDialog();
      } else if (event.key === "/") {
        event.preventDefault();
        searchRef.current?.focus();
      } else if (event.key === "0") {
        sceneRef.current?.resetCamera();
      } else if (event.key === "+" || event.key === "=") {
        sceneRef.current?.zoomIn();
      } else if (event.key === "-") {
        sceneRef.current?.zoomOut();
      }
    }

    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, []);

  function openMapFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;
    setError(null);
    const reader = new FileReader();
    reader.onload = () => {
      try {
        showGraph(parseRepositoryGraph(String(reader.result)));
      } catch (parseError) {
        setError(errorMessage(parseError));
      }
    };
    reader.onerror = () => setError("Could not read the selected map file.");
    reader.readAsText(file);
  }

  async function exportMap() {
    if (!graph || !isDesktopRuntime) return;
    setError(null);
    try {
      const path = await save({
        defaultPath: `${graph.name}.atlas.json`,
        filters: [{ name: "Codebase Atlas map", extensions: ["json"] }],
      });
      if (path) await invoke("save_map", { path, contents: JSON.stringify(graph) });
    } catch (saveError) {
      setError(errorMessage(saveError));
    }
  }

  async function chooseRepository() {
    if (!isDesktopRuntime) return;
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (path) await scanPath(path);
    } catch (dialogError) {
      setError(errorMessage(dialogError));
    }
  }

  function openGitHubDialog() {
    setError(null);
    setGitHubDialogOpen(true);
  }

  function submitGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void scanGitHub(githubUrl);
  }

  function selectNode(id: string | null) {
    setSelectedId(id);
    setInspectorTab("overview");
    setInspectorOpen(Boolean(id));
  }

  function toggleLayer(layer: LayerName) {
    setLayers((current) => ({ ...current, [layer]: !current[layer] }));
  }

  const normalizedSearch = searchQuery.trim().toLowerCase();
  const filteredNodes =
    graph?.nodes.filter(
      (node) =>
        !normalizedSearch ||
        node.name.toLowerCase().includes(normalizedSearch) ||
        node.path.toLowerCase().includes(normalizedSearch) ||
        node.language?.toLowerCase().includes(normalizedSearch) ||
        node.description?.toLowerCase().includes(normalizedSearch),
    ) ?? [];
  const moduleGroups: { key: LayerName; label: string; nodes: RepositoryNode[] }[] = [
    {
      key: "structure",
      label: "Structure",
      nodes: filteredNodes.filter((node) => layerForNode(node) === "structure"),
    },
    {
      key: "source",
      label: "Source + assets",
      nodes: filteredNodes.filter((node) => layerForNode(node) === "source"),
    },
    {
      key: "config",
      label: "Configuration",
      nodes: filteredNodes.filter((node) => layerForNode(node) === "config"),
    },
    {
      key: "docs",
      label: "Documentation",
      nodes: filteredNodes.filter((node) => layerForNode(node) === "docs"),
    },
  ];
  const selectedNode = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  const parentEdge = graph?.edges.find(
    (edge) => edge.kind === "contains" && edge.target === selectedNode?.id,
  );
  const parentNode = graph?.nodes.find((node) => node.id === parentEdge?.source) ?? null;
  const visibleLayerCount = Object.values(layers).filter(Boolean).length;
  const layerCount = Object.keys(layers).length;
  const importEdgeCount =
    graph?.edges.reduce((count, edge) => count + (edge.kind === "imports" ? 1 : 0), 0) ?? 0;
  const flows =
    graph && selectedNode && graph.stats.importsAvailable
      ? flowPartners(graph, selectedNode)
      : null;
  const contained = graph && selectedNode ? childNodes(graph, selectedNode.id) : [];

  return (
    <div className="app-shell">
      <a className="skip-link" href="#repository-map">
        Skip to code map
      </a>

      <dialog
        ref={githubDialogRef}
        className="source-dialog"
        aria-labelledby="github-dialog-title"
        aria-describedby="github-dialog-description"
        onClose={() => setGitHubDialogOpen(false)}
        onCancel={() => setGitHubDialogOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setGitHubDialogOpen(false);
        }}
      >
        <form onSubmit={submitGitHub}>
          <header>
            <div>
              <span className="section-index">SOURCE / GITHUB</span>
              <h2 id="github-dialog-title">Map a public repository</h2>
            </div>
            <button
              type="button"
              onClick={() => setGitHubDialogOpen(false)}
              aria-label="Close GitHub URL dialog"
            >
              ×
            </button>
          </header>
          <p id="github-dialog-description">
            Enter a public GitHub repository URL. Codebase Atlas reads its default branch tree through GitHub’s API.
          </p>
          <label>
            <span>Repository URL</span>
            <input
              ref={githubInputRef}
              type="url"
              value={githubUrl}
              onChange={(event) => setGitHubUrl(event.currentTarget.value)}
              placeholder="https://github.com/owner/repository"
              autoComplete="url"
              spellCheck={false}
              required
            />
          </label>
          {error ? (
            <p className="source-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer>
            <small>Public repositories only · GitHub rate limits unauthenticated requests</small>
            <button type="submit" disabled={loading}>
              {loading ? "Reading tree" : "Map repository"}
            </button>
          </footer>
        </form>
      </dialog>

      <header className="instrument-bar">
        <div className="brand-block" aria-label="Codebase Atlas">
          <span className="brand-index">CA / 01</span>
          <strong>CODEBASE ATLAS</strong>
        </div>

        <button
          className="mobile-rail-button"
          type="button"
          onClick={() => setRailOpen(true)}
          aria-controls="module-rail"
          aria-expanded={railOpen}
        >
          Modules
        </button>

        <div className="instrument-readings" aria-label="Repository summary">
          <div className="instrument-reading repository-reading">
            <span>Repository</span>
            <strong title={graph?.root}>{graph?.name ?? "No source"}</strong>
          </div>
          <div className="instrument-reading branch-reading">
            <span>Branch</span>
            <strong>{graph?.branch ?? "--"}</strong>
          </div>
          <div className="instrument-reading metric-reading">
            <span>Files</span>
            <strong>{graph ? graph.stats.files.toLocaleString() : "--"}</strong>
          </div>
          <div className="instrument-reading metric-reading">
            <span>Lines</span>
            <strong>
              {graph?.stats.lineCountAvailable ? graph.stats.lines.toLocaleString() : "--"}
            </strong>
          </div>
          <div className="instrument-reading metric-reading">
            <span>Imports</span>
            <strong>
              {graph?.stats.importsAvailable ? importEdgeCount.toLocaleString() : "--"}
            </strong>
          </div>
          <div className="instrument-reading metric-reading languages-reading">
            <span>Languages</span>
            <strong>{graph ? graph.stats.languages.length : "--"}</strong>
          </div>
        </div>

        <div className="source-actions">
          <input
            ref={mapFileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={openMapFile}
          />
          <button
            className="github-button"
            type="button"
            onClick={() => mapFileInputRef.current?.click()}
            disabled={loading}
            aria-label="Open an exported Codebase Atlas map file"
          >
            <span aria-hidden="true">[ ⇣ ]</span>
            <b>Open map</b>
          </button>
          {isDesktopRuntime ? (
            <button
              className="github-button"
              type="button"
              onClick={() => void exportMap()}
              disabled={loading || !graph}
              aria-label="Save the current map to a file"
            >
              <span aria-hidden="true">[ ⇡ ]</span>
              <b>Save map</b>
            </button>
          ) : null}
          <button
            className="github-button"
            type="button"
            onClick={openGitHubDialog}
            disabled={loading}
            aria-label="Load a public GitHub repository URL"
            aria-keyshortcuts="g"
          >
            <span aria-hidden="true">[ GH ]</span>
            <b>GitHub URL</b>
          </button>
          {isDesktopRuntime || !isTauriRuntime ? (
            <button
              className="scan-button"
              type="button"
              onClick={() => void chooseRepository()}
              disabled={loading || !isDesktopRuntime}
              aria-label="Choose a repository directory to scan"
              title={isDesktopRuntime ? undefined : "Local directory scanning is available in the desktop app"}
            >
              <span aria-hidden="true">[ + ]</span>
              <b>{loading ? "Scanning" : "Scan directory"}</b>
            </button>
          ) : null}
        </div>
      </header>

      <div className="workspace">
        <button
          className={`workspace-curtain ${railOpen || inspectorOpen ? "is-active" : ""}`}
          type="button"
          aria-label="Close side panels"
          onClick={() => {
            setRailOpen(false);
            setInspectorOpen(false);
          }}
        />

        <nav
          id="module-rail"
          className={`module-rail ${railOpen ? "is-open" : ""}`}
          aria-label="Repository modules"
        >
          <div className="rail-heading">
            <div>
              <span className="section-index">A.01</span>
              <h2>Modules</h2>
            </div>
            <button className="panel-close" type="button" onClick={() => setRailOpen(false)}>
              Close
            </button>
          </div>

          <label className="search-field">
            <span className="visually-hidden">Search repository modules</span>
            <span aria-hidden="true">⌕</span>
            <input
              ref={searchRef}
              type="search"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.currentTarget.value)}
              placeholder="Search path or language"
              aria-keyshortcuts="/"
            />
            {searchQuery ? (
              <button type="button" onClick={() => setSearchQuery("")} aria-label="Clear search">
                ×
              </button>
            ) : (
              <kbd>/</kbd>
            )}
          </label>

          <p className="result-count" aria-live="polite">
            {filteredNodes.length.toLocaleString()} of {graph?.nodes.length.toLocaleString() ?? 0} modules
          </p>

          <div className="module-groups">
            {moduleGroups.map((group) =>
              group.nodes.length ? (
                <section className="module-group" key={group.key}>
                  <h3>
                    <span>{group.label}</span>
                    <b>{group.nodes.length}</b>
                  </h3>
                  <ul>
                    {group.nodes.map((node) => (
                      <li key={node.id}>
                        <button
                          type="button"
                          className={selectedNode?.id === node.id ? "is-selected" : ""}
                          onClick={() => {
                            selectNode(node.id);
                            setRailOpen(false);
                          }}
                          title={node.path}
                          aria-current={selectedNode?.id === node.id ? "true" : undefined}
                        >
                          <span className={`kind-mark kind-${node.kind}`} aria-hidden="true" />
                          <span className="module-name">{node.name}</span>
                          <span className="module-meta">
                            {node.kind === "directory" || node.kind === "repository"
                              ? node.childCount
                              : graph?.stats.lineCountAvailable
                                ? node.lines.toLocaleString()
                                : formatBytes(node.sizeBytes)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null,
            )}
            {graph && filteredNodes.length === 0 ? (
              <p className="no-results">No module matches “{searchQuery}”.</p>
            ) : null}
            {!graph ? (
              <p className="rail-empty">Load a local directory or GitHub repository to populate the module index.</p>
            ) : null}
          </div>
        </nav>

        <main id="repository-map" className="map-panel" tabIndex={-1}>
          <div className="map-header">
            <div>
              <span className="section-index">
              {view === "map" ? "B.02 / Orthographic projection" : "B.02 / Import flow"}
            </span>
              <h1>{graph ? graph.name : "Repository field"}</h1>
            </div>
            <button
              className="mobile-inspector-button"
              type="button"
              onClick={() => setInspectorOpen(true)}
              disabled={!selectedNode}
              aria-controls="node-inspector"
              aria-expanded={inspectorOpen}
            >
              Inspect
            </button>
          </div>

          {graph ? (
            <>
              <div className="scene-toolbar" aria-label="Map controls">
                <div className="toolbar-cluster">
                  <div className="view-controls" role="group" aria-label="Visualization mode">
                    {(["map", "flow"] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={view === mode}
                        onClick={() => setView(mode)}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  {view === "map" ? (
                    <div className="layer-controls" aria-label="Visible map layers">
                      {(Object.keys(layers) as LayerName[]).map((layer) => (
                        <button
                          key={layer}
                          type="button"
                          aria-pressed={layers[layer]}
                          onClick={() => toggleLayer(layer)}
                        >
                          <span aria-hidden="true">{layers[layer] ? "■" : "□"}</span>
                          {layer}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
                <label className="depth-controls" title="How many directory levels the map renders; imports aggregate to the visible level. Select a district to look inside without raising this.">
                  <span>
                    Depth {depth >= MAX_MAP_DEPTH ? "all" : depth}
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={MAX_MAP_DEPTH}
                    step={1}
                    value={depth}
                    onChange={(event) => setDepth(Number(event.currentTarget.value))}
                    aria-label="Map granularity: directory levels rendered"
                  />
                </label>
                {view === "map" ? (
                  <div className="camera-controls">
                    <button
                      type="button"
                      onClick={() => sceneRef.current?.zoomOut()}
                      aria-label="Zoom map out"
                      aria-keyshortcuts="-"
                    >
                      −
                    </button>
                    <button
                      type="button"
                      onClick={() => sceneRef.current?.resetCamera()}
                      aria-label="Reset map camera"
                      aria-keyshortcuts="0"
                    >
                      Reset
                    </button>
                    <button
                      type="button"
                      onClick={() => sceneRef.current?.zoomIn()}
                      aria-label="Zoom map in"
                      aria-keyshortcuts="+"
                    >
                      +
                    </button>
                  </div>
                ) : null}
              </div>
              {view === "map" ? (
                <>
                  <RepositoryScene
                    ref={sceneRef}
                    graph={graph}
                    selectedId={selectedId}
                    searchQuery={searchQuery}
                    layers={layers}
                    maxDepth={depth >= MAX_MAP_DEPTH ? Number.POSITIVE_INFINITY : depth}
                    onSelect={selectNode}
                  />
                  <div className="axis-key" aria-hidden="true">
                    <span>Y + area / code volume</span>
                    <span>X-Z / containment</span>
                  </div>
                </>
              ) : (
                <FlowScene
                  graph={graph}
                  selectedId={selectedId}
                  searchQuery={searchQuery}
                  maxDepth={depth >= MAX_MAP_DEPTH ? Number.POSITIVE_INFINITY : depth}
                  onSelect={selectNode}
                />
              )}
            </>
          ) : (
            <section className="empty-state" aria-labelledby="empty-title">
              <div className="empty-diagram" aria-hidden="true">
                <span className="empty-box empty-box-root">00</span>
                <span className="empty-box empty-box-one">01</span>
                <span className="empty-box empty-box-two">02</span>
                <span className="empty-line empty-line-one" />
                <span className="empty-line empty-line-two" />
              </div>
              <span className="section-index">Awaiting coordinates</span>
              <h2 id="empty-title">Map a codebase</h2>
              <p>
                Select a local directory or enter a public GitHub URL to inspect its structure, languages, and modules.
              </p>
              <div className="empty-actions">
                <button
                  type="button"
                  onClick={() => mapFileInputRef.current?.click()}
                  disabled={loading}
                >
                  Map file
                </button>
                <button type="button" onClick={openGitHubDialog} disabled={loading}>
                  GitHub repository
                </button>
                {isDesktopRuntime ? (
                  <button
                    type="button"
                    onClick={() => void chooseRepository()}
                    disabled={loading}
                  >
                    Local directory
                  </button>
                ) : null}
              </div>
              {!isDesktopRuntime ? (
                <small>
                  Local scanning happens in the desktop app — export a map there and open it here.
                </small>
              ) : null}
            </section>
          )}

          {loading ? (
            <div className="loading-plate" role="status" aria-live="polite">
              <span className="scan-line" aria-hidden="true" />
              <strong>Surveying repository</strong>
              <span>Reading structure, languages, and repository metadata…</span>
            </div>
          ) : null}

          {error && !githubDialogOpen ? (
            <div className="error-plate" role="alert">
              <div>
                <strong>Scan interrupted</strong>
                <span>{error}</span>
              </div>
              <button type="button" onClick={() => setError(null)} aria-label="Dismiss scan error">
                ×
              </button>
            </div>
          ) : null}
        </main>

        <aside
          id="node-inspector"
          className={`node-inspector ${inspectorOpen ? "is-open" : ""}`}
          aria-label="Module inspector"
        >
          <div className="inspector-heading">
            <div>
              <span className="section-index">C.03</span>
              <h2>Inspector</h2>
            </div>
            <button className="panel-close" type="button" onClick={() => setInspectorOpen(false)}>
              Close
            </button>
          </div>

          <div className="inspector-tabs" role="tablist" aria-label="Inspector views">
            <button
              id="overview-tab"
              type="button"
              role="tab"
              aria-selected={inspectorTab === "overview"}
              aria-controls="overview-panel"
              onClick={() => setInspectorTab("overview")}
            >
              What it is
            </button>
            <button
              id="details-tab"
              type="button"
              role="tab"
              aria-selected={inspectorTab === "details"}
              aria-controls="details-panel"
              onClick={() => setInspectorTab("details")}
            >
              Details
            </button>
          </div>

          {selectedNode ? (
            <div className="inspector-content">
              <div className="node-identity">
                <span className={`node-glyph kind-${selectedNode.kind}`} aria-hidden="true">
                  {selectedNode.kind === "repository" ? "R" : selectedNode.kind.slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <span>{selectedNode.kind}</span>
                  <h3>{selectedNode.name}</h3>
                </div>
              </div>

              {inspectorTab === "overview" ? (
                <div
                  id="overview-panel"
                  role="tabpanel"
                  aria-labelledby="overview-tab"
                  className="inspector-panel"
                >
                  <p className="node-description">
                    {selectedNode.description ?? kindDescriptions[selectedNode.kind]}
                  </p>
                  <section>
                    <h4>Placement</h4>
                    <dl className="detail-list">
                      <div>
                        <dt>Parent</dt>
                        <dd>
                          {parentNode ? (
                            <button
                              type="button"
                              onClick={() => selectNode(parentNode.id)}
                              title={parentNode.path}
                            >
                              {parentNode.name}
                            </button>
                          ) : (
                            "Coordinate origin"
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Depth</dt>
                        <dd>{selectedNode.depth}</dd>
                      </div>
                      <div>
                        <dt>Layer</dt>
                        <dd>{layerForNode(selectedNode)}</dd>
                      </div>
                    </dl>
                  </section>
                  <section>
                    <h4>Signal</h4>
                    <div className="signal-grid">
                      <div>
                        <strong>
                          {graph?.stats.lineCountAvailable ? selectedNode.lines.toLocaleString() : "--"}
                        </strong>
                        <span>Lines</span>
                      </div>
                      <div>
                        <strong>{formatBytes(selectedNode.sizeBytes)}</strong>
                        <span>Size</span>
                      </div>
                      <div>
                        <strong>{selectedNode.childCount.toLocaleString()}</strong>
                        <span>Children</span>
                      </div>
                    </div>
                  </section>
                  {contained.length ? (
                    <section>
                      <h4>
                        Contains / {contained.length}
                      </h4>
                      <ol className="flow-register">
                        {contained.map((child) => (
                          <li key={child.id}>
                            <button type="button" onClick={() => selectNode(child.id)} title={child.path}>
                              <span>{child.name}</span>
                              <b>
                                {child.kind === "directory" || child.kind === "repository"
                                  ? child.childCount.toLocaleString()
                                  : graph?.stats.lineCountAvailable
                                    ? child.lines.toLocaleString()
                                    : formatBytes(child.sizeBytes)}
                              </b>
                            </button>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}
                  {flows
                    ? [
                        {
                          label: "Imports",
                          entries: topFlows(flows.imports),
                          total: flows.imports.size,
                        },
                        {
                          label: "Imported by",
                          entries: topFlows(flows.importers),
                          total: flows.importers.size,
                        },
                      ].map((group) =>
                        group.entries.length ? (
                          <section key={group.label}>
                            <h4>
                              {group.label} / {group.total}
                            </h4>
                            <ol className="flow-register">
                              {group.entries.map(([id, count]) => (
                                <li key={id}>
                                  <button type="button" onClick={() => selectNode(id)} title={id}>
                                    <span>{id.split("/").pop()}</span>
                                    <b>{count}</b>
                                  </button>
                                </li>
                              ))}
                            </ol>
                          </section>
                        ) : null,
                      )
                    : null}
                  {graph && !graph.stats.importsAvailable ? (
                    <section>
                      <h4>Flow</h4>
                      <p className="node-description">
                        Import edges are unavailable for GitHub sources. Scan a local directory to
                        map flow.
                      </p>
                    </section>
                  ) : null}
                  {selectedNode.kind === "repository" && graph?.stats.languages.length ? (
                    <section>
                      <h4>Language register</h4>
                      <ol className="language-register">
                        {graph.stats.languages.slice(0, 8).map((language) => (
                          <li key={language.name}>
                            <span>{language.name}</span>
                            <b>
                              {graph.stats.lineCountAvailable
                                ? language.lines.toLocaleString()
                                : `${language.files.toLocaleString()} files`}
                            </b>
                          </li>
                        ))}
                      </ol>
                    </section>
                  ) : null}
                </div>
              ) : (
                <div
                  id="details-panel"
                  role="tabpanel"
                  aria-labelledby="details-tab"
                  className="inspector-panel"
                >
                  <dl className="detail-list full-details">
                    <div>
                      <dt>Path</dt>
                      <dd>{selectedNode.path}</dd>
                    </div>
                    <div>
                      <dt>Language</dt>
                      <dd>{selectedNode.language ?? "Not classified"}</dd>
                    </div>
                    <div>
                      <dt>Extension</dt>
                      <dd>{selectedNode.extension ?? "--"}</dd>
                    </div>
                    <div>
                      <dt>Lines</dt>
                      <dd>
                        {graph?.stats.lineCountAvailable
                          ? selectedNode.lines.toLocaleString()
                          : "Unavailable"}
                      </dd>
                    </div>
                    <div>
                      <dt>Bytes</dt>
                      <dd>{selectedNode.sizeBytes.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Children</dt>
                      <dd>{selectedNode.childCount.toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>Node ID</dt>
                      <dd>{selectedNode.id}</dd>
                    </div>
                  </dl>
                </div>
              )}
            </div>
          ) : (
            <p className="inspector-empty">Select a module in the map or index to inspect its coordinates.</p>
          )}

          {graph?.warnings.length ? (
            <section className="warning-register" aria-label="Scanner warnings">
              <h4>Field notes / {graph.warnings.length}</h4>
              {graph.warnings.map((warning, index) => (
                <p key={`${index}-${warning}`}>{warning}</p>
              ))}
            </section>
          ) : null}
        </aside>
      </div>

      <footer className="status-strip">
        <div>
          <span className={`status-dot ${loading ? "is-loading" : graph ? "is-ready" : ""}`} />
          {loading ? "Scanning" : graph ? "Map ready" : "Awaiting source"}
        </div>
        <p>
          {view === "map" ? (
            <>
              Drag to orbit · click a district to look inside · scroll to zoom · <kbd>G</kbd> GitHub · <kbd>/</kbd> search · <kbd>0</kbd> reset
            </>
          ) : (
            <>
              Click a module to trace its flow · hover to preview · <kbd>G</kbd> GitHub · <kbd>/</kbd> search
            </>
          )}
        </p>
        <div className="status-path" title={graph?.root}>
          {graph
            ? `${graph.source.toUpperCase()} · ${visibleLayerCount}/${layerCount} layers · ${graph.root}`
            : "LOCAL OR GITHUB / READ ONLY"}
        </div>
      </footer>
    </div>
  );
}

export default App;

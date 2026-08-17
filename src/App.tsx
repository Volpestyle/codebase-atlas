import { useEffect, useRef, useState, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import RepositoryScene, { type RepositorySceneHandle } from "./RepositoryScene";
import { scanGitHubRepository } from "./github";
import {
  formatBytes,
  layerForNode,
  type LayerName,
  type LayerVisibility,
  type RepositoryGraph,
  type RepositoryNode,
  type RepositoryNodeKind,
} from "./model";
import "./App.css";

const LAST_SOURCE_KEY = "codebase-atlas:last-source";
const isTauriRuntime = "__TAURI_INTERNALS__" in window;

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
};

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
  const [inspectorTab, setInspectorTab] = useState<"overview" | "details">("overview");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [githubDialogOpen, setGitHubDialogOpen] = useState(false);
  const [githubUrl, setGitHubUrl] = useState("");
  const initialScanStarted = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const githubDialogRef = useRef<HTMLDialogElement>(null);
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

  useEffect(() => {
    if (initialScanStarted.current) return;
    initialScanStarted.current = true;
    const savedSource = readSavedSource();
    if (savedSource?.kind === "github") {
      setGitHubUrl(savedSource.value);
      void scanGitHub(savedSource.value);
    } else if (savedSource?.kind === "local" && isTauriRuntime) {
      void scanPath(savedSource.value);
    } else if (isTauriRuntime && import.meta.env.DEV) {
      void scanPath("..");
    }
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

  async function chooseRepository() {
    if (!isTauriRuntime) return;
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
        node.language?.toLowerCase().includes(normalizedSearch),
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
  const parentEdge = graph?.edges.find((edge) => edge.target === selectedNode?.id);
  const parentNode = graph?.nodes.find((node) => node.id === parentEdge?.source) ?? null;
  const visibleLayerCount = Object.values(layers).filter(Boolean).length;

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
          <div className="instrument-reading metric-reading languages-reading">
            <span>Languages</span>
            <strong>{graph ? graph.stats.languages.length : "--"}</strong>
          </div>
        </div>

        <div className="source-actions">
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
          <button
            className="scan-button"
            type="button"
            onClick={() => void chooseRepository()}
            disabled={loading || !isTauriRuntime}
            aria-label="Choose a repository directory to scan"
            title={isTauriRuntime ? undefined : "Local directory scanning is available in the desktop app"}
          >
            <span aria-hidden="true">[ + ]</span>
            <b>{loading ? "Scanning" : "Scan directory"}</b>
          </button>
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
              <span className="section-index">B.02 / Orthographic projection</span>
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
              </div>
              <RepositoryScene
                ref={sceneRef}
                graph={graph}
                selectedId={selectedId}
                searchQuery={searchQuery}
                layers={layers}
                onSelect={selectNode}
              />
              <div className="axis-key" aria-hidden="true">
                <span>Y / {graph.stats.lineCountAvailable ? "lines" : "size"}</span>
                <span>X-Z / modules</span>
              </div>
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
                <button type="button" onClick={openGitHubDialog} disabled={loading}>
                  GitHub repository
                </button>
                <button
                  type="button"
                  onClick={() => void chooseRepository()}
                  disabled={!isTauriRuntime || loading}
                >
                  Local directory
                </button>
              </div>
              {!isTauriRuntime ? (
                <small>Local directory access remains inside the desktop app.</small>
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
                  <p className="node-description">{kindDescriptions[selectedNode.kind]}</p>
                  <section>
                    <h4>Placement</h4>
                    <dl className="detail-list">
                      <div>
                        <dt>Parent</dt>
                        <dd>{parentNode?.name ?? "Coordinate origin"}</dd>
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
          Drag to orbit · secondary drag to pan · scroll to zoom · <kbd>G</kbd> GitHub · <kbd>/</kbd> search · <kbd>0</kbd> reset
        </p>
        <div className="status-path" title={graph?.root}>
          {graph
            ? `${graph.source.toUpperCase()} · ${visibleLayerCount}/4 layers · ${graph.root}`
            : "LOCAL OR GITHUB / READ ONLY"}
        </div>
      </footer>
    </div>
  );
}

export default App;

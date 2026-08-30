import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { PanelResizeHandle, usePanelLayout } from "./PanelResizeHandle";
import KindMark from "./ui/KindMark";
import Register from "./ui/Register";
import SectionHeading from "./ui/SectionHeading";
import Seg from "./ui/Seg";
import Stat from "./ui/Stat";
import RepositoryScene, { type RepositorySceneHandle } from "./RepositoryScene";
import FlowScene from "./FlowScene";
import StoryScene from "./StoryScene";
import { scanGitHubRepository } from "./github";
import {
  connectPairing,
  fetchCompanionCatalog,
  isPairingUrl,
  parseCompanionOrigin,
  parsePairingUrl,
  pairingUrlFromStatus,
  scanCompanionRepository,
  type CompanionCatalog,
  type CompanionStatus,
} from "./companion";
import PairingScanner from "./PairingScanner";
import { pairingQrSvg } from "./pairingQr";
import {
  DEFAULT_INSPECTOR_WIDTH,
  DEFAULT_RAIL_WIDTH,
  MIN_INSPECTOR_WIDTH,
  MIN_RAIL_WIDTH,
} from "./panelLayout";
import {
  crossingLabel,
  formatBytes,
  layerForNode,
  matchesSymbol,
  parseRepositoryGraph,
  type LayerName,
  type LayerVisibility,
  type RepositoryGraph,
  type RepositoryNode,
  type RepositoryNodeKind,
} from "./model";
import {
  SCALE_LADDER,
  ancestorAtScale,
  ancestry,
  nodeGlyph,
  scaleIndex,
  scaleOf,
  surveyOffset,
  visibleCrumbs,
  type NodeScale,
} from "./location";
import "./App.css";

const LAST_SOURCE_KEY = "codebase-atlas:last-source";
const LAST_COMPANION_KEY = "codebase-atlas:companion";
const isTauriRuntime = "__TAURI_INTERNALS__" in window;
// Folder pickers and the Share host run on desktop Tauri. iPad and the
// browser load GitHub URLs, exported maps, or a live companion over the
// LAN / Tailscale.
const isDesktopRuntime = isTauriRuntime && navigator.maxTouchPoints < 2;

// Granularity slider range; the top stop renders every depth.
// Story first: it is the only view that opens with sentences instead of 987
// modules, so it is what a reader meets before the reference views.
const VIEW_MODES = ["story", "map", "flow"] as const;
type ViewMode = (typeof VIEW_MODES)[number];

const VIEW_INDEX: Record<ViewMode, string> = {
  story: "B.02 / How it works",
  map: "B.02 / Orthographic",
  flow: "B.02 / Import flow",
};

const MAX_MAP_DEPTH = 8;
const DEFAULT_MAP_DEPTH = 2;

type SavedSource =
  | { kind: "local"; value: string }
  | { kind: "github"; value: string }
  | { kind: "companion"; host: string; token: string; path: string };

type SavedCompanion = { host: string; token: string };

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
  // Test files and directories are scaffolding around the story the map
  // tells; the layer exists but starts hidden.
  tests: false,
  imports: true,
};

// One import partner: how many edges reach it, and the named bindings that
// cross them — what the selection actually takes from that module.
interface PartnerFlow {
  count: number;
  symbols: Set<string>;
}

// Import partners of the selected node, including everything beneath it, so a
// directory shows the aggregate flow of its subtree.
function flowPartners(graph: RepositoryGraph, selected: RepositoryNode) {
  const imports = new Map<string, PartnerFlow>();
  const importers = new Map<string, PartnerFlow>();
  if (selected.id === ".") return { imports, importers };
  const prefix = `${selected.id}/`;
  const inScope = (id: string) => id === selected.id || id.startsWith(prefix);
  const record = (partners: Map<string, PartnerFlow>, id: string, symbols?: string[]) => {
    let flow = partners.get(id);
    if (!flow) {
      flow = { count: 0, symbols: new Set() };
      partners.set(id, flow);
    }
    flow.count += 1;
    for (const symbol of symbols ?? []) flow.symbols.add(symbol);
  };
  for (const edge of graph.edges) {
    if (edge.kind !== "imports") continue;
    const fromSelection = inScope(edge.source);
    const intoSelection = inScope(edge.target);
    if (fromSelection && !intoSelection) {
      record(imports, edge.target, edge.symbols);
    } else if (intoSelection && !fromSelection) {
      record(importers, edge.source, edge.symbols);
    }
  }
  return { imports, importers };
}

function topFlows(flows: Map<string, PartnerFlow>) {
  return [...flows]
    .sort(
      (left, right) => right[1].count - left[1].count || left[0].localeCompare(right[0]),
    )
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

function LocationTrail({
  trail,
  onSelect,
  compact = false,
}: {
  trail: RepositoryNode[];
  onSelect: (id: string) => void;
  compact?: boolean;
}) {
  if (trail.length === 0) return null;
  const crumbs = compact ? visibleCrumbs(trail) : trail;
  const currentId = trail[trail.length - 1]?.id;
  const gapTarget = trail.length > 4 ? trail[trail.length - 3] : null;
  return (
    <nav className={`location-trail${compact ? " is-compact" : ""}`} aria-label="Focus path">
      <ol>
        {crumbs.map((crumb) => {
          if (crumb === "gap") {
            return (
              <li key="gap">
                <button
                  type="button"
                  onClick={() => {
                    if (gapTarget) onSelect(gapTarget.id);
                  }}
                  title={gapTarget?.path}
                  aria-label="Show omitted ancestor"
                >
                  …
                </button>
              </li>
            );
          }
          const current = crumb.id === currentId;
          return (
            <li key={crumb.id}>
              {current ? (
                <span aria-current="location">{crumb.name}</span>
              ) : (
                <button type="button" onClick={() => onSelect(crumb.id)} title={crumb.path}>
                  {crumb.name}
                </button>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

function ScaleLadder({
  current,
  trail,
  onSelect,
}: {
  current: NodeScale;
  trail: RepositoryNode[];
  onSelect: (id: string) => void;
}) {
  const currentIndex = scaleIndex(current);
  return (
    <Seg plate className="scale-ladder" role="group" aria-label="Focus scale">
      {SCALE_LADDER.map((rung) => {
        const index = scaleIndex(rung.id);
        const locked = !rung.surveyed;
        const reached = !locked && index <= currentIndex;
        const isCurrent = rung.id === current;
        const target =
          locked || rung.id === "function" ? null : ancestorAtScale(trail, rung.id);
        const disabled = locked || !target;
        return (
          <button
            key={rung.id}
            type="button"
            className={[
              reached ? "is-reached" : "",
              isCurrent ? "is-current" : "",
              locked ? "is-locked" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            disabled={disabled}
            aria-current={isCurrent ? "true" : undefined}
            aria-label={
              locked ? "Function scale is not in this survey" : `${rung.label} scale`
            }
            title={
              locked
                ? "Functions are not in this survey yet"
                : target
                  ? target.path
                  : undefined
            }
            onClick={() => {
              if (target && target.id !== currentId(trail)) onSelect(target.id);
            }}
          >
            {rung.label}
          </button>
        );
      })}
    </Seg>
  );
}

function currentId(trail: RepositoryNode[]) {
  return trail[trail.length - 1]?.id;
}

function errorMessage(error: unknown) {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "The repository scanner returned an unknown error.";
}

function readSavedSource(): SavedSource | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_SOURCE_KEY) ?? "null");
    if (!saved || typeof saved !== "object" || !("kind" in saved)) return null;
    if (
      (saved.kind === "local" || saved.kind === "github") &&
      "value" in saved &&
      typeof saved.value === "string"
    ) {
      return { kind: saved.kind, value: saved.value };
    }
    if (
      saved.kind === "companion" &&
      "host" in saved &&
      "token" in saved &&
      "path" in saved &&
      typeof saved.host === "string" &&
      typeof saved.token === "string" &&
      typeof saved.path === "string"
    ) {
      return { kind: "companion", host: saved.host, token: saved.token, path: saved.path };
    }
  } catch {
    localStorage.removeItem(LAST_SOURCE_KEY);
  }
  return null;
}

function saveSource(source: SavedSource) {
  localStorage.setItem(LAST_SOURCE_KEY, JSON.stringify(source));
}

function readSavedCompanion(): SavedCompanion | null {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(LAST_COMPANION_KEY) ?? "null");
    if (
      saved &&
      typeof saved === "object" &&
      "host" in saved &&
      "token" in saved &&
      typeof saved.host === "string" &&
      typeof saved.token === "string"
    ) {
      return { host: saved.host, token: saved.token };
    }
  } catch {
    localStorage.removeItem(LAST_COMPANION_KEY);
  }
  return null;
}

function saveCompanionConnection(host: string, token: string) {
  localStorage.setItem(LAST_COMPANION_KEY, JSON.stringify({ host, token }));
}

function App() {
  const [graph, setGraph] = useState<RepositoryGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // The district deliberately broken open (second click on the selection);
  // selection alone never changes what the map renders.
  const [openedId, setOpenedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [layers, setLayers] = useState<LayerVisibility>(defaultLayers);
  const [depth, setDepth] = useState(DEFAULT_MAP_DEPTH);
  const [view, setView] = useState<ViewMode>("story");
  const [inspectorTab, setInspectorTab] = useState<"overview" | "details">("overview");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [railOpen, setRailOpen] = useState(false);
  const [githubDialogOpen, setGitHubDialogOpen] = useState(false);
  const [githubUrl, setGitHubUrl] = useState("");
  const [computerDialogOpen, setComputerDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [companionHost, setCompanionHost] = useState("");
  const [companionToken, setCompanionToken] = useState("");
  const [companionCatalog, setCompanionCatalog] = useState<CompanionCatalog | null>(null);
  const [shareStatus, setShareStatus] = useState<CompanionStatus | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const {
    shellRef,
    workspaceRef,
    widths,
    layoutMode,
    railMax,
    inspectorMax,
    previewRail,
    previewInspector,
    commitRail,
    commitInspector,
    style: panelStyle,
  } = usePanelLayout();
  const initialScanStarted = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const githubDialogRef = useRef<HTMLDialogElement>(null);
  const computerDialogRef = useRef<HTMLDialogElement>(null);
  const shareDialogRef = useRef<HTMLDialogElement>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const githubInputRef = useRef<HTMLInputElement>(null);
  const companionHostRef = useRef<HTMLInputElement>(null);
  const sceneRef = useRef<RepositorySceneHandle>(null);

  function showGraph(nextGraph: RepositoryGraph) {
    setGraph(nextGraph);
    setSelectedId(
      nextGraph.nodes.find((node) => node.kind === "repository")?.id ??
        nextGraph.nodes[0]?.id ??
        null,
    );
    setOpenedId(null);
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

  async function connectCompanion(host: string, token: string) {
    const origin = parseCompanionOrigin(host);
    const catalog = await fetchCompanionCatalog(origin, token);
    setCompanionHost(host);
    setCompanionToken(token);
    setCompanionCatalog(catalog);
    saveCompanionConnection(host, token);
    return { origin, catalog };
  }

  async function applyPairingText(text: string) {
    setScannerOpen(false);
    setComputerDialogOpen(true);
    setLoading(true);
    setError(null);
    try {
      const payload = parsePairingUrl(text);
      setCompanionToken(payload.token);
      const { origin, catalog } = await connectPairing(payload);
      const host = origin.replace(/^https?:\/\//, "");
      setCompanionHost(host);
      setCompanionCatalog(catalog);
      saveCompanionConnection(host, payload.token);
      if (catalog.repositories.length === 1) {
        await scanCompanion(host, payload.token, catalog.repositories[0].path);
      }
    } catch (pairError) {
      setError(errorMessage(pairError));
    } finally {
      setLoading(false);
    }
  }

  async function scanCompanion(host: string, token: string, path: string) {
    setLoading(true);
    setError(null);
    try {
      const origin = parseCompanionOrigin(host);
      const nextGraph = await scanCompanionRepository(origin, token, path);
      setCompanionHost(host);
      setCompanionToken(token);
      saveCompanionConnection(host, token);
      showGraph(nextGraph);
      saveSource({ kind: "companion", host, token, path });
      setComputerDialogOpen(false);
    } catch (scanError) {
      setError(errorMessage(scanError));
    } finally {
      setLoading(false);
    }
  }

  async function submitComputer(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isPairingUrl(companionHost)) {
      await applyPairingText(companionHost);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const { catalog } = await connectCompanion(companionHost, companionToken);
      if (catalog.repositories.length === 1) {
        await scanCompanion(companionHost, companionToken, catalog.repositories[0].path);
        return;
      }
    } catch (scanError) {
      setError(errorMessage(scanError));
    } finally {
      setLoading(false);
    }
  }

  async function refreshShareStatus() {
    if (!isDesktopRuntime) return null;
    try {
      const status = await invoke<CompanionStatus>("companion_status");
      setShareStatus(status);
      return status;
    } catch (statusError) {
      setError(errorMessage(statusError));
      return null;
    }
  }

  async function toggleSharing() {
    if (!isDesktopRuntime) return;
    setError(null);
    try {
      const status = shareStatus?.enabled
        ? await invoke<CompanionStatus>("stop_companion")
        : await invoke<CompanionStatus>("start_companion", {
            extra_root: graph?.root ?? null,
          });
      setShareStatus(status);
    } catch (shareError) {
      setError(errorMessage(shareError));
      await refreshShareStatus();
    }
  }

  async function shareFolder() {
    if (!isDesktopRuntime) return;
    setError(null);
    try {
      const selected = await open({ directory: true, multiple: false });
      const path = Array.isArray(selected) ? selected[0] : selected;
      if (!path) return;
      setShareStatus(await invoke<CompanionStatus>("share_companion_root", { path }));
    } catch (dialogError) {
      setError(errorMessage(dialogError));
    }
  }

  async function unshareFolder(path: string) {
    if (!isDesktopRuntime) return;
    try {
      setShareStatus(await invoke<CompanionStatus>("unshare_companion_root", { path }));
    } catch (shareError) {
      setError(errorMessage(shareError));
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
    if (isDesktopRuntime) void refreshShareStatus();
  }, []);

  useEffect(() => {
    if (!isTauriRuntime) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        const { onOpenUrl } = await import("@tauri-apps/plugin-deep-link");
        unlisten = await onOpenUrl((urls) => {
          const next = urls.find((url) => isPairingUrl(url));
          if (next) void applyPairingText(next);
        });
      } catch {
        // Deep links only exist in the native app.
      }
    })();
    return () => unlisten?.();
  }, []);

  useEffect(() => {
    if (initialScanStarted.current) return;
    initialScanStarted.current = true;
    const remembered = readSavedCompanion();
    if (remembered) {
      setCompanionHost(remembered.host);
      setCompanionToken(remembered.token);
    }
    void (async () => {
      if (isTauriRuntime) {
        try {
          const { getCurrent } = await import("@tauri-apps/plugin-deep-link");
          const current = await getCurrent();
          const pairing = current?.find((url) => isPairingUrl(url));
          if (pairing) {
            await applyPairingText(pairing);
            return;
          }
        } catch {
          // Continue with a saved source when deep links are unavailable.
        }
      }
      const savedSource = readSavedSource();
      if (savedSource?.kind === "companion") {
        setCompanionHost(savedSource.host);
        setCompanionToken(savedSource.token);
        await scanCompanion(savedSource.host, savedSource.token, savedSource.path);
        return;
      }
      if (savedSource?.kind === "github") {
        setGitHubUrl(savedSource.value);
        await scanGitHub(savedSource.value);
        return;
      }
      if (savedSource?.kind === "local" && isDesktopRuntime) {
        await scanPath(savedSource.value);
        return;
      }
      if (isDesktopRuntime && import.meta.env.DEV) {
        await scanPath("..");
        return;
      }
      await loadBundledMap();
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
    const dialog = computerDialogRef.current;
    if (!dialog) return;
    if (computerDialogOpen && !dialog.open) {
      dialog.showModal();
      companionHostRef.current?.focus();
    } else if (!computerDialogOpen && dialog.open) {
      dialog.close();
    }
  }, [computerDialogOpen]);

  useEffect(() => {
    const dialog = shareDialogRef.current;
    if (!dialog) return;
    if (shareDialogOpen && !dialog.open) dialog.showModal();
    else if (!shareDialogOpen && dialog.open) dialog.close();
  }, [shareDialogOpen]);

  useEffect(() => {
    function handleKeyboard(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") {
        // Each press peels one layer: dialog, mobile rail, then the opened
        // district backs out to its closed slab.
        if (githubDialogOpen) {
          setGitHubDialogOpen(false);
          return;
        }
        if (computerDialogOpen) {
          setComputerDialogOpen(false);
          return;
        }
        if (shareDialogOpen) {
          setShareDialogOpen(false);
          return;
        }
        if (railOpen) {
          setRailOpen(false);
          return;
        }
        if (openedId) {
          closeOpened();
          return;
        }
        setInspectorOpen(false);
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
      } else if (event.key.toLowerCase() === "c") {
        event.preventDefault();
        if (isDesktopRuntime) openShareDialog();
        else openComputerDialog();
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
  });

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
    if (!graph) return;
    setError(null);
    if (isDesktopRuntime) {
      try {
        const path = await save({
          defaultPath: `${graph.name}.atlas.json`,
          filters: [{ name: "Codebase Atlas map", extensions: ["json"] }],
        });
        if (path) await invoke("save_map", { path, contents: JSON.stringify(graph) });
      } catch (saveError) {
        setError(errorMessage(saveError));
      }
      return;
    }
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(graph)], { type: "application/json" }),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${graph.name}.atlas.json`;
    document.body.append(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
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

  function openComputerDialog() {
    setError(null);
    setComputerDialogOpen(true);
  }

  function openShareDialog() {
    setError(null);
    setShareDialogOpen(true);
    void refreshShareStatus();
  }

  function submitGitHub(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void scanGitHub(githubUrl);
  }

  function selectNode(id: string | null) {
    // Progressive disclosure: the first click on a module selects it and
    // lights its connections at the current survey grain; a
    // second click on the same module breaks it open. Selecting anything
    // outside the opened district (an ancestor, a sibling, empty ground)
    // closes it again: one district decomposed at a time.
    if (id !== null && id === selectedId) {
      setOpenedId(id);
    } else {
      setSelectedId(id);
      const inside =
        id !== null && openedId !== null && (id === openedId || id.startsWith(`${openedId}/`));
      if (!inside) setOpenedId(null);
    }
    setInspectorTab("overview");
    setInspectorOpen(Boolean(id));
  }

  function closeOpened() {
    // Backing out lifts the selection to the district that just closed, so
    // the inspector lands on the whole rather than a hidden child.
    setSelectedId(openedId);
    setOpenedId(null);
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
        node.description?.toLowerCase().includes(normalizedSearch) ||
        matchesSymbol(node, normalizedSearch),
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
    {
      key: "tests",
      label: "Tests",
      nodes: filteredNodes.filter((node) => layerForNode(node) === "tests"),
    },
  ];
  const selectedNode = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  const openedNode = graph?.nodes.find((node) => node.id === openedId) ?? null;
  const trail = graph && selectedNode ? ancestry(graph, selectedNode.id) : [];
  const focusScale = selectedNode ? scaleOf(selectedNode) : null;
  const surveyDepth = depth >= MAX_MAP_DEPTH ? Number.POSITIVE_INFINITY : depth;
  const focusOffset = selectedNode ? surveyOffset(selectedNode, surveyDepth) : 0;
  const visibleLayerCount = Object.values(layers).filter(Boolean).length;
  const layerCount = Object.keys(layers).length;
  const importEdgeCount =
    graph?.edges.reduce((count, edge) => count + (edge.kind === "imports" ? 1 : 0), 0) ?? 0;
  const sharePairingUrl =
    shareStatus?.enabled && shareStatus.token ? pairingUrlFromStatus(shareStatus) : null;
  const shareQrSvg = useMemo(
    () => (sharePairingUrl ? pairingQrSvg(sharePairingUrl) : null),
    [sharePairingUrl],
  );
  const flows =
    graph && selectedNode && graph.stats.importsAvailable
      ? flowPartners(graph, selectedNode)
      : null;
  const contained = graph && selectedNode ? childNodes(graph, selectedNode.id) : [];

  return (
    <div className="app-shell" ref={shellRef} style={panelStyle}>
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
          <SectionHeading
            index="SOURCE / GITHUB"
            title="Map a public repository"
            titleId="github-dialog-title"
            action={
              <button
                type="button"
                onClick={() => setGitHubDialogOpen(false)}
                aria-label="Close GitHub URL dialog"
              >
                ×
              </button>
            }
          />
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
            <button type="submit" className="btn-ink" disabled={loading}>
              {loading ? "Reading tree" : "Map repository"}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={computerDialogRef}
        className="source-dialog"
        aria-labelledby="computer-dialog-title"
        aria-describedby="computer-dialog-description"
        onClose={() => setComputerDialogOpen(false)}
        onCancel={() => setComputerDialogOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setComputerDialogOpen(false);
        }}
      >
        <form onSubmit={submitComputer}>
          <SectionHeading
            index="SOURCE / COMPUTER"
            title="Map a computer’s repositories"
            titleId="computer-dialog-title"
            action={
              <button
                type="button"
                onClick={() => setComputerDialogOpen(false)}
                aria-label="Close computer dialog"
              >
                ×
              </button>
            }
          />
          <p id="computer-dialog-description">
            Scan the QR code on the computer, or enter a host and pairing code. Same Wi-Fi or Tailscale;
            the computer scans and this device never clones the repo.
          </p>
          {!isDesktopRuntime ? (
            <div className="pairing-scan-action">
              {isTauriRuntime ? (
                <small>
                  Open the Camera app and point it at the QR code on the computer. iOS will offer to
                  open Codebase Atlas already paired.
                </small>
              ) : (
                <>
                  <button
                    type="button"
                    className="btn-ink"
                    onClick={() => {
                      setError(null);
                      setScannerOpen(true);
                    }}
                  >
                    Scan pairing code
                  </button>
                  <small>Or point the iOS Camera app at the computer’s QR code</small>
                </>
              )}
            </div>
          ) : null}
          <label>
            <span>Host</span>
            <input
              ref={companionHostRef}
              type="text"
              value={companionHost}
              onChange={(event) => {
                setCompanionHost(event.currentTarget.value);
                setCompanionCatalog(null);
              }}
              placeholder="macbook.local or 100.x.x.x"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          <label>
            <span>Pairing code</span>
            <input
              type="text"
              value={companionToken}
              onChange={(event) => setCompanionToken(event.currentTarget.value)}
              placeholder="K7M2-Q9XP"
              autoComplete="off"
              spellCheck={false}
              required
            />
          </label>
          {companionCatalog ? (
            <div className="catalog-list">
              <p>
                {companionCatalog.repositories.length
                  ? `${companionCatalog.name} · ${companionCatalog.repositories.length} shared`
                  : `${companionCatalog.name} is sharing, but no folders are listed yet. Add a folder on the computer.`}
              </p>
              <ul>
                {companionCatalog.repositories.map((repository) => (
                  <li key={repository.path}>
                    <button
                      type="button"
                      onClick={() =>
                        void scanCompanion(companionHost, companionToken, repository.path)
                      }
                      disabled={loading}
                    >
                      <span>{repository.name}</span>
                      <small>{repository.path}</small>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {error ? (
            <p className="source-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer>
            <small>Needs the desktop app’s Share toggle, or `serve` on that machine</small>
            <button type="submit" className="btn-ink" disabled={loading}>
              {loading ? "Connecting" : companionCatalog ? "Refresh list" : "Connect"}
            </button>
          </footer>
        </form>
      </dialog>

      <dialog
        ref={shareDialogRef}
        className="source-dialog"
        aria-labelledby="share-dialog-title"
        aria-describedby="share-dialog-description"
        onClose={() => setShareDialogOpen(false)}
        onCancel={() => setShareDialogOpen(false)}
        onClick={(event) => {
          if (event.target === event.currentTarget) setShareDialogOpen(false);
        }}
      >
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void toggleSharing();
          }}
        >
          <SectionHeading
            index="SOURCE / SHARE"
            title="Share with devices"
            titleId="share-dialog-title"
            action={
              <button
                type="button"
                onClick={() => setShareDialogOpen(false)}
                aria-label="Close share dialog"
              >
                ×
              </button>
            }
          />
          <p id="share-dialog-description">
            iPhone and iPad scan this QR code to pair — Camera app or Scan inside Codebase Atlas.
            They receive the graph, not source files.
          </p>
          {shareStatus?.enabled ? (
            <>
              {shareQrSvg && sharePairingUrl ? (
                <div className="pairing-qr-block">
                  <div
                    className="pairing-qr"
                    aria-hidden="true"
                    dangerouslySetInnerHTML={{ __html: shareQrSvg }}
                  />
                  <button
                    type="button"
                    className="btn-ghost"
                    onClick={() => void navigator.clipboard.writeText(sharePairingUrl)}
                  >
                    Copy pairing link
                  </button>
                </div>
              ) : null}
              <div className="pairing-block">
                <span>Pairing code</span>
                <strong className="pairing-code">{shareStatus.token}</strong>
                <button
                  type="button"
                  className="btn-ghost"
                  onClick={() => void navigator.clipboard.writeText(shareStatus.token)}
                >
                  Copy
                </button>
              </div>
              <ul className="address-list">
                {shareStatus.addresses.map((address) => (
                    <li key={address.url}>
                      <button
                        type="button"
                        onClick={() => void navigator.clipboard.writeText(address.url)}
                        title="Copy address"
                      >
                        <span>{address.label}</span>
                        <small>{address.url.replace(/^https?:\/\//, "")}</small>
                      </button>
                    </li>
                  ))}
              </ul>
              <div className="catalog-list">
                <p>
                  {shareStatus.roots.length
                    ? "Shared folders"
                    : "Scan a directory or add a folder — that is what devices will see."}
                </p>
                <ul>
                  {shareStatus.roots.map((root) => (
                    <li key={root.path}>
                      <span className="shared-root">
                        <b>{root.name}</b>
                        <small>{root.path}</small>
                      </span>
                      <button type="button" className="btn-ghost" onClick={() => void unshareFolder(root.path)}>
                        Remove
                      </button>
                    </li>
                  ))}
                </ul>
                <button type="button" className="btn-ghost share-add" onClick={() => void shareFolder()}>
                  Share folder
                </button>
              </div>
            </>
          ) : null}
          {error ? (
            <p className="source-dialog-error" role="alert">
              {error}
            </p>
          ) : null}
          {shareStatus?.error ? (
            <p className="source-dialog-error" role="alert">
              {shareStatus.error}
            </p>
          ) : null}
          <footer>
            <small>
              {shareStatus?.enabled
                ? "On iPhone, open Camera and scan this code — or Scan inside the app"
                : "Starts a local HTTP companion on port 7420"}
            </small>
            <button type="submit" className="btn-ink">
              {shareStatus?.enabled ? "Stop sharing" : "Start sharing"}
            </button>
          </footer>
        </form>
      </dialog>

      <PairingScanner
        open={scannerOpen}
        onClose={() => setScannerOpen(false)}
        onDetect={(text) => void applyPairingText(text)}
      />

      <header className="instrument-bar">
        <div className="brand-block" aria-label="Codebase Atlas">
          <span className="section-index brand-index">CA / 01</span>
          <strong>CODEBASE ATLAS</strong>
          <PanelResizeHandle
            label="Resize modules panel"
            controlsId="module-rail"
            edge="end"
            value={widths.rail}
            min={MIN_RAIL_WIDTH}
            max={railMax}
            defaultValue={DEFAULT_RAIL_WIDTH}
            tabIndex={-1}
            onChange={previewRail}
            onCommit={commitRail}
          />
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
          <Stat
            className="instrument-reading repository-reading"
            label="Repository"
            value={graph?.name ?? "No source"}
            title={graph?.root}
          />
          <Stat
            className="instrument-reading branch-reading"
            label="Branch"
            value={graph?.branch ?? "--"}
          />
          <Stat
            className="instrument-reading metric-reading"
            label="Files"
            value={graph ? graph.stats.files.toLocaleString() : "--"}
          />
          <Stat
            className="instrument-reading metric-reading"
            label="Lines"
            value={graph?.stats.lineCountAvailable ? graph.stats.lines.toLocaleString() : "--"}
          />
          <Stat
            className="instrument-reading metric-reading"
            label="Imports"
            value={graph?.stats.importsAvailable ? importEdgeCount.toLocaleString() : "--"}
          />
          <Stat
            className="instrument-reading metric-reading languages-reading"
            label="Languages"
            value={graph ? graph.stats.languages.length : "--"}
          />
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
          {isDesktopRuntime ? (
            <button
              className="github-button"
              type="button"
              onClick={openShareDialog}
              disabled={loading}
              aria-label="Share local repositories with devices on this network"
              aria-keyshortcuts="c"
            >
              <span aria-hidden="true">[ NET ]</span>
              <b>{shareStatus?.enabled ? "Sharing" : "Share"}</b>
            </button>
          ) : (
            <button
              className="github-button"
              type="button"
              onClick={openComputerDialog}
              disabled={loading}
              aria-label="Connect to a computer on this network or Tailscale"
              aria-keyshortcuts="c"
            >
              <span aria-hidden="true">[ NET ]</span>
              <b>Computer</b>
            </button>
          )}
          {isDesktopRuntime ? (
            <button
              className="scan-button"
              type="button"
              onClick={() => void chooseRepository()}
              disabled={loading}
              aria-label="Choose a repository directory to scan"
            >
              <span aria-hidden="true">[ + ]</span>
              <b>{loading ? "Scanning" : "Scan directory"}</b>
            </button>
          ) : null}
        </div>
      </header>

      <div className="workspace" ref={workspaceRef}>
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
          <SectionHeading
            index="A.01"
            title="Modules"
            action={
              <button
                className="panel-close btn-ghost"
                type="button"
                onClick={() => setRailOpen(false)}
              >
                Close
              </button>
            }
          />

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
                          <KindMark kind={node.kind} />
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
          {layoutMode !== "narrow" || railOpen ? (
            <PanelResizeHandle
              label="Resize modules panel"
              controlsId="module-rail"
              edge="end"
              value={widths.rail}
              min={MIN_RAIL_WIDTH}
              max={railMax}
              defaultValue={DEFAULT_RAIL_WIDTH}
              onChange={previewRail}
              onCommit={commitRail}
            />
          ) : null}
        </nav>

        <main id="repository-map" className="map-panel" tabIndex={-1}>
          <div className="map-header">
            <div className="location-block">
              <span className="section-index">
                {VIEW_INDEX[view]}
                {focusScale ? ` · ${focusScale}` : ""}
                {focusOffset ? ` · +${focusOffset}` : ""}
              </span>
              <h1 className="visually-hidden">
                {selectedNode?.path ?? graph?.name ?? "Repository field"}
              </h1>
              {trail.length ? (
                <LocationTrail trail={trail} onSelect={selectNode} compact />
              ) : (
                <p className="location-fallback">{graph ? graph.name : "Repository field"}</p>
              )}
            </div>
            <button
              className="mobile-inspector-button btn-ghost"
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
                  <Seg plate className="view-controls" role="group" aria-label="Visualization mode">
                    {VIEW_MODES.map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        aria-pressed={view === mode}
                        onClick={() => setView(mode)}
                      >
                        {mode}
                      </button>
                    ))}
                  </Seg>
                  {view === "map" ? (
                    <Seg
                      plate
                      variant="strike"
                      className="layer-controls"
                      aria-label="Visible map layers"
                    >
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
                    </Seg>
                  ) : null}
                </div>
                {view === "story" ? null : (
                <div className="altitude-controls">
                  <label
                    className="depth-controls plate"
                    title="Default grain of the whole field. Opening a district looks deeper locally without moving this."
                  >
                    <span>
                      Survey {depth >= MAX_MAP_DEPTH ? "all" : depth}
                    </span>
                    <input
                      type="range"
                      min={1}
                      max={MAX_MAP_DEPTH}
                      step={1}
                      value={depth}
                      onChange={(event) => setDepth(Number(event.currentTarget.value))}
                      aria-label="Survey depth: directory levels rendered across the map"
                    />
                  </label>
                  {focusScale ? (
                    <ScaleLadder current={focusScale} trail={trail} onSelect={selectNode} />
                  ) : null}
                  {openedNode ? (
                    <Seg plate className="close-opened">
                      <button
                        type="button"
                        onClick={closeOpened}
                        title={`Close ${openedNode.path} and back out (Esc)`}
                      >
                        ✕ close {openedNode.name}
                      </button>
                    </Seg>
                  ) : null}
                </div>
                )}
                {view === "map" ? (
                  <Seg plate className="camera-controls">
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
                  </Seg>
                ) : null}
              </div>
              {view === "story" ? (
                graph.story ? (
                  <StoryScene
                    story={graph.story}
                    selectedId={selectedId}
                    onSelect={selectNode}
                  />
                ) : (
                  <section className="story-empty">
                    <span className="section-index">Story / not written</span>
                    <h2>No story for this repository</h2>
                    <p>
                      The map and flow views are read from the code itself. This view is
                      not: it needs a short, hand-written account of what the parts are
                      and what travels between them, because no parse can recover that a
                      message arrives from a chat server or that a model writes the reply.
                    </p>
                    <p>
                      Add <code>.codebase-index/_story.json</code> to the repository —
                      actors with a plain-English blurb, the flows between them, and the
                      journeys data takes. The map and flow views work without it.
                    </p>
                  </section>
                )
              ) : view === "map" ? (
                <>
                  <RepositoryScene
                    ref={sceneRef}
                    graph={graph}
                    selectedId={selectedId}
                    openedId={openedId}
                    searchQuery={searchQuery}
                    layers={layers}
                    maxDepth={depth >= MAX_MAP_DEPTH ? Number.POSITIVE_INFINITY : depth}
                    onSelect={selectNode}
                  />
                  <div className="axis-key" aria-hidden="true">
                    <span>Y + area / code volume</span>
                    <span>X-Z / containment</span>
                    <span>Arcs / major import routes</span>
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
                {isDesktopRuntime
                  ? "Select a local directory, share with devices on this network, or enter a public GitHub URL."
                  : "Connect to your computer over Wi-Fi or Tailscale, open an exported map, or enter a public GitHub URL."}
              </p>
              <div className="empty-actions">
                <button
                  className="btn-ink"
                  type="button"
                  onClick={() => mapFileInputRef.current?.click()}
                  disabled={loading}
                >
                  Map file
                </button>
                <button
                  className="btn-ghost"
                  type="button"
                  onClick={openGitHubDialog}
                  disabled={loading}
                >
                  GitHub repository
                </button>
                {isDesktopRuntime ? (
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={() => void chooseRepository()}
                    disabled={loading}
                  >
                    Local directory
                  </button>
                ) : (
                  <button
                    className="btn-ghost"
                    type="button"
                    onClick={openComputerDialog}
                    disabled={loading}
                  >
                    Computer
                  </button>
                )}
              </div>
              {!isDesktopRuntime ? (
                <small>
                  On the computer, start Share — then scan the QR code here.
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

          {error && !githubDialogOpen && !computerDialogOpen && !shareDialogOpen ? (
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
          <SectionHeading
            index="C.03"
            title="Inspector"
            action={
              <button
                className="panel-close btn-ghost"
                type="button"
                onClick={() => setInspectorOpen(false)}
              >
                Close
              </button>
            }
          />

          <Seg className="inspector-tabs" role="tablist" aria-label="Inspector views">
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
          </Seg>

          {selectedNode ? (
            <div className="inspector-content">
              <div className="node-identity">
                <span className={`node-glyph kind-${selectedNode.kind}`} aria-hidden="true">
                  {nodeGlyph(selectedNode)}
                </span>
                <div>
                  <span>
                    {focusScale} · {selectedNode.kind}
                  </span>
                  <h3>{selectedNode.name}</h3>
                </div>
              </div>
              <LocationTrail trail={trail} onSelect={selectNode} />

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
                        <dt>Scale</dt>
                        <dd>
                          {focusScale}
                          {focusOffset ? ` · +${focusOffset} below survey` : " · at survey"}
                        </dd>
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
                      <Stat
                        label="Lines"
                        value={
                          graph?.stats.lineCountAvailable
                            ? selectedNode.lines.toLocaleString()
                            : "--"
                        }
                      />
                      <Stat label="Size" value={formatBytes(selectedNode.sizeBytes)} />
                      <Stat label="Children" value={selectedNode.childCount.toLocaleString()} />
                    </div>
                  </section>
                  {contained.length ? (
                    <section>
                      <h4>
                        Contains / {contained.length}
                      </h4>
                      <Register
                        onSelect={selectNode}
                        items={contained.map((child) => ({
                          id: child.id,
                          label: child.name,
                          kind: child.kind,
                          title: child.path,
                          value:
                            child.kind === "directory" || child.kind === "repository"
                              ? child.childCount.toLocaleString()
                              : graph?.stats.lineCountAvailable
                                ? child.lines.toLocaleString()
                                : formatBytes(child.sizeBytes),
                        }))}
                      />
                    </section>
                  ) : null}
                  {selectedNode.symbols?.length ? (
                    <section>
                      <h4>Declares / {selectedNode.symbols.length}</h4>
                      <Register
                        items={selectedNode.symbols.map((symbol) => ({
                          id: `${selectedNode.id}#${symbol.name}`,
                          label: symbol.name,
                          kind: symbol.kind,
                          title: `${symbol.exported ? "Exported" : "Internal"} ${symbol.kind} at line ${symbol.line}`,
                          value: symbol.line,
                        }))}
                      />
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
                            <Register
                              onSelect={selectNode}
                              items={group.entries.map(([id, flow]) => ({
                                id,
                                label: id.split("/").pop() ?? id,
                                title: id,
                                value: flow.count,
                                detail: crossingLabel(flow.symbols),
                              }))}
                            />
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
                      <Register
                        items={graph.stats.languages.slice(0, 8).map((language) => ({
                          id: language.name,
                          label: language.name,
                          value: graph.stats.lineCountAvailable
                            ? language.lines.toLocaleString()
                            : `${language.files.toLocaleString()} files`,
                        }))}
                      />
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
          {layoutMode === "wide" || inspectorOpen ? (
            <PanelResizeHandle
              label="Resize inspector panel"
              controlsId="node-inspector"
              edge="start"
              value={widths.inspector}
              min={MIN_INSPECTOR_WIDTH}
              max={inspectorMax}
              defaultValue={DEFAULT_INSPECTOR_WIDTH}
              onChange={previewInspector}
              onCommit={commitInspector}
            />
          ) : null}
        </aside>
      </div>

      <footer className="status-strip">
        <div>
          <span className={`status-dot ${loading ? "is-loading" : graph ? "is-ready" : ""}`} />
          {loading ? "Scanning" : graph ? "Map ready" : "Awaiting source"}
        </div>
        <p>
          {view === "story" ? (
            <>
              Pick a journey to follow the data · hover a part to see what it touches · click a part to keep it lit, or a file on it to open that file
            </>
          ) : view === "map" ? (
            <>
              Drag to orbit · click a district to go there · click it again to look inside · <kbd>esc</kbd> backs out · <kbd>/</kbd> search · <kbd>0</kbd> reset
            </>
          ) : (
            <>
              Click a module to trace its flow · click a route to see what crosses it · <kbd>G</kbd> GitHub · <kbd>/</kbd> search
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

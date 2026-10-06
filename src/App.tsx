import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import AtlasWorkspace, { type AtlasView } from "./AtlasWorkspace";
import { useTheme } from "./ui/useTheme";
import "./Atlas.css";
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
import { matchesSymbol, parseRepositoryGraph, type RepositoryGraph } from "./model";
import "./App.css";

const LAST_SOURCE_KEY = "codebase-atlas:last-source";
const LAST_COMPANION_KEY = "codebase-atlas:companion";
const isTauriRuntime = "__TAURI_INTERNALS__" in window;
// Folder pickers and the Share host run on desktop Tauri. iPad and the
// browser load GitHub URLs, exported maps, or a live companion over the
// LAN / Tailscale.
const isDesktopRuntime = isTauriRuntime && navigator.maxTouchPoints < 2;

type ViewMode = AtlasView;

type SavedSource =
  | { kind: "local"; value: string }
  | { kind: "github"; value: string }
  | { kind: "companion"; host: string; token: string; path: string };

type SavedCompanion = { host: string; token: string };

function SourceDialogHeading({ index, title, titleId, action }: { index: string; title: string; titleId: string; action: ReactNode }) {
  return <header className="source-dialog-heading"><div><span className="source-dialog-index">{index}</span><h2 id={titleId}>{title}</h2></div>{action}</header>;
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
    try { localStorage.removeItem(LAST_SOURCE_KEY); } catch { /* Storage unavailable. */ }
  }
  return null;
}

function saveSource(source: SavedSource) {
  try { localStorage.setItem(LAST_SOURCE_KEY, JSON.stringify(source)); } catch { /* Storage unavailable. */ }
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
    try { localStorage.removeItem(LAST_COMPANION_KEY); } catch { /* Storage unavailable. */ }
  }
  return null;
}

function saveCompanionConnection(host: string, token: string) {
  try { localStorage.setItem(LAST_COMPANION_KEY, JSON.stringify({ host, token })); } catch { /* Storage unavailable. */ }
}

function App() {
  const { theme, toggleTheme } = useTheme();

  const [graph, setGraph] = useState<RepositoryGraph | null>(null);
  // Bumped per loaded graph so a reload of the same root resets workspace state.
  const [graphLoad, setGraphLoad] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [view, setView] = useState<ViewMode>("overview");
  const [githubDialogOpen, setGitHubDialogOpen] = useState(false);
  const [githubUrl, setGitHubUrl] = useState("");
  const [computerDialogOpen, setComputerDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const [companionHost, setCompanionHost] = useState("");
  const [companionToken, setCompanionToken] = useState("");
  const [companionCatalog, setCompanionCatalog] = useState<CompanionCatalog | null>(null);
  const [shareStatus, setShareStatus] = useState<CompanionStatus | null>(null);
  const [scannerOpen, setScannerOpen] = useState(false);
  const initialScanStarted = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const githubDialogRef = useRef<HTMLDialogElement>(null);
  const computerDialogRef = useRef<HTMLDialogElement>(null);
  const shareDialogRef = useRef<HTMLDialogElement>(null);
  const mapFileInputRef = useRef<HTMLInputElement>(null);
  const githubInputRef = useRef<HTMLInputElement>(null);
  const companionHostRef = useRef<HTMLInputElement>(null);
  const sourceMenuRef = useRef<HTMLDetailsElement>(null);

  function showGraph(nextGraph: RepositoryGraph) {
    setGraph(nextGraph);
    setGraphLoad((count) => count + 1);
    setSelectedId(null);
    setSearchQuery("");
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
        setGitHubDialogOpen(false);
        setComputerDialogOpen(false);
        setShareDialogOpen(false);
        setScannerOpen(false);
        const sourceMenu = sourceMenuRef.current;
        if (sourceMenu?.open) {
          sourceMenu.open = false;
          sourceMenu.querySelector("summary")?.focus();
        }
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;

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

  function selectNode(id: string) {
    setSelectedId(id);
    setView("territory");
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
  const sharePairingUrl =
    shareStatus?.enabled && shareStatus.token ? pairingUrlFromStatus(shareStatus) : null;
  const shareQrSvg = useMemo(
    () => (sharePairingUrl ? pairingQrSvg(sharePairingUrl) : null),
    [sharePairingUrl],
  );

  return (
    <div className="app-shell atlas-shell">
      <a className="skip-link" href="#atlas-main">
        Skip to repository
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
          <SourceDialogHeading
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
          <SourceDialogHeading
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
          <SourceDialogHeading
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

      <header className="atlas-header">
        <div className="atlas-brand"><strong>atlas</strong><span>{graph?.name ?? "No source"} · {graph?.branch ?? "—"}</span></div>
        <nav className="atlas-nav" aria-label="Lens">
          <button aria-current={view === "overview" ? "page" : undefined} onClick={() => setView("overview")}>Overview</button>
          <button aria-current={view === "story" ? "page" : undefined} onClick={() => setView("story")}>How it works</button>
          <button aria-current={view === "territory" ? "page" : undefined} onClick={() => setView("territory")}>Where it lives</button>
          <button aria-current={view === "part" ? "page" : undefined} onClick={() => setView("part")}>Inside a part</button>
          <button className="theme-toggle" onClick={toggleTheme} aria-label={`Switch to ${theme === "light" ? "dark" : "light"} mode`}>{theme === "light" ? "Dark" : "Light"}</button>
        </nav>
        <details ref={sourceMenuRef} className="source-menu"><summary>Source</summary>
        <div className="source-actions">
          <input
            ref={mapFileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={openMapFile}
          />
          <button
            type="button"
            onClick={() => mapFileInputRef.current?.click()}
            disabled={loading}
            aria-label="Open an exported Codebase Atlas map file"
          >
            <b>Open map</b>
          </button>
          <button
            type="button"
            onClick={() => void exportMap()}
            disabled={loading || !graph}
            aria-label="Save the current map to a file"
          >
            <b>Save map</b>
          </button>
          <button
            type="button"
            onClick={openGitHubDialog}
            disabled={loading}
            aria-label="Load a public GitHub repository URL"
            aria-keyshortcuts="g"
          >
            <b>GitHub URL</b>
          </button>
          {isDesktopRuntime ? (
            <button
                type="button"
              onClick={openShareDialog}
              disabled={loading}
              aria-label="Share local repositories with devices on this network"
              aria-keyshortcuts="c"
            >
              <b>{shareStatus?.enabled ? "Sharing" : "Share"}</b>
            </button>
          ) : (
            <button
                type="button"
              onClick={openComputerDialog}
              disabled={loading}
              aria-label="Connect to a computer on this network or Tailscale"
              aria-keyshortcuts="c"
            >
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
              <b>{loading ? "Scanning" : "Scan directory"}</b>
            </button>
          ) : null}
        </div></details>
      </header>

      {loading && <p className="atlas-feedback" role="status">Reading the repository…</p>}
      {error && !githubDialogOpen && !computerDialogOpen && !shareDialogOpen && <p className="atlas-feedback" role="alert">{error}</p>}
      {graph ? <AtlasWorkspace view={view} onNavigate={setView} key={graphLoad} theme={theme} graph={graph} searchQuery={searchQuery} onSearch={setSearchQuery} searchRef={searchRef} results={filteredNodes} selectedId={selectedId} onOpenFile={selectNode} /> : <main id="atlas-main" className="atlas-welcome"><h1>Read a <em>codebase</em>.</h1><p>Choose a source to explore its files and written story.</p><button className="btn-ink" onClick={openGitHubDialog}>Open a GitHub repository</button><button className="btn-ghost" onClick={() => mapFileInputRef.current?.click()}>Open a saved map</button></main>}
      <footer className="atlas-status">
        <span>{loading ? "Reading repository" : graph ? `${graph.stats.files.toLocaleString()} files · ${graph.stats.lineCountAvailable ? `${graph.stats.lines.toLocaleString()} lines` : "line counts unavailable"}` : "Awaiting source"}</span>
        <span>{graph ? `${graph.source} · ${graph.stats.truncated ? "partial scan" : "read only"}` : "Read only"} · <kbd>/</kbd> search · <kbd>G</kbd> GitHub · <kbd>C</kbd> computer</span>
      </footer>
    </div>
  );
}

export default App;

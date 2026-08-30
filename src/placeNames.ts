// The .ts extension keeps this importable by the node:test runner, which
// strips types but does not resolve extensionless value imports.
import { SUPPORT_DIR_NAMES, type RepositoryNode } from "./model.ts";
import { scaleOf } from "./location.ts";

// Wrapper directories every module repeats say nothing about what the
// module is; map tags and flow cells look through them to the children that do.
export const WRAPPER_DIRS = new Set(["src", "lib", "source", "sources"]);

export function isWrapperNode(node: RepositoryNode) {
  return node.kind === "directory" && WRAPPER_DIRS.has(node.name.toLowerCase());
}

export function isSupportNode(node: RepositoryNode) {
  return node.kind === "directory" && SUPPORT_DIR_NAMES.has(node.name.toLowerCase());
}

// Names that belong on the map: skip the field title (the chrome already
// names the repository), wrappers, and support dirs.
export function isMapPlaceName(node: RepositoryNode) {
  if (node.kind !== "directory") return false;
  return !isWrapperNode(node) && !isSupportNode(node);
}

export function parentPath(id: string): string | null {
  if (id === ".") return null;
  const slash = id.lastIndexOf("/");
  return slash === -1 ? "." : id.slice(0, slash);
}

// Named directories are camera targets; files, wrappers, and support dirs
// always walk to their named parent. Survey zoom is 1: framing never pulls
// back past the whole-field view.
export const FRAME_MIN_SPAN = 6;
export const FRAME_PADDING = 2.7;
export const SURVEY_ZOOM = 1;
export const FRAME_TARGET_EPS = 0.15;
export const FRAME_ZOOM_EPS = 0.04;

export interface Frameable {
  node: RepositoryNode;
  width: number;
  depth: number;
}

export function framingTargetId(
  id: string | null,
  byId: Map<string, Frameable>,
): string {
  if (!id || id === ".") return ".";
  let current: string | null = id;
  while (current) {
    const entry = byId.get(current);
    if (entry && isMapPlaceName(entry.node)) return current;
    current = parentPath(current);
  }
  return ".";
}

export function poseAlreadyFramed(
  current: { x: number; y: number; z: number },
  currentZoom: number,
  target: { x: number; y: number; z: number },
  zoom: number,
): boolean {
  const dx = current.x - target.x;
  const dy = current.y - target.y;
  const dz = current.z - target.z;
  return Math.hypot(dx, dy, dz) < FRAME_TARGET_EPS && Math.abs(currentZoom - zoom) < FRAME_ZOOM_EPS;
}

export function framingZoom(
  viewHeight: number,
  span: number,
  maxZoom: number = 8,
): number {
  const used = Math.max(span, FRAME_MIN_SPAN);
  const zoom = viewHeight / (used * FRAME_PADDING);
  if (!Number.isFinite(zoom) || zoom < SURVEY_ZOOM) return SURVEY_ZOOM;
  return Math.min(maxZoom, zoom);
}

export interface SceneReadout {
  kicker: string;
  title: string;
  /** Codebase-index summary; null when the node has none. */
  summary: string | null;
}

export function sceneReadout(node: RepositoryNode): SceneReadout {
  const summary = node.description?.trim() ? node.description : null;
  return {
    kicker: `${scaleOf(node)} · ${node.kind}`,
    title: node.path === "." ? node.name : node.path,
    summary,
  };
}

export const PANEL_WIDTHS_KEY = "codebase-atlas:panel-widths";

export const DEFAULT_RAIL_WIDTH = 252;
export const DEFAULT_INSPECTOR_WIDTH = 306;
export const MIN_RAIL_WIDTH = 220;
export const MIN_INSPECTOR_WIDTH = 220;
export const MIN_MAP_WIDTH = 280;
export const RAIL_OVERLAY_MAX_WIDTH = 720;
export const INSPECTOR_OVERLAY_MAX_WIDTH = 980;
export const OVERLAY_RAIL_RATIO = 0.88;
export const OVERLAY_INSPECTOR_RATIO = 0.86;

export type LayoutMode = "wide" | "medium" | "narrow";

export interface PanelWidths {
  rail: number;
  inspector: number;
}

export const defaultPanelWidths: PanelWidths = {
  rail: DEFAULT_RAIL_WIDTH,
  inspector: DEFAULT_INSPECTOR_WIDTH,
};

export function layoutModeForViewport(width: number): LayoutMode {
  if (width <= RAIL_OVERLAY_MAX_WIDTH) return "narrow";
  if (width <= INSPECTOR_OVERLAY_MAX_WIDTH) return "medium";
  return "wide";
}

export function resizePanel(current: number, delta: number, min: number, max: number) {
  if (max <= min) return Math.round(min);
  return Math.round(Math.min(max, Math.max(min, current + delta)));
}

export function overlayRailMax(workspaceWidth: number) {
  return Math.max(MIN_RAIL_WIDTH, Math.floor(workspaceWidth * OVERLAY_RAIL_RATIO));
}

export function overlayInspectorMax(workspaceWidth: number) {
  return Math.max(MIN_INSPECTOR_WIDTH, Math.floor(workspaceWidth * OVERLAY_INSPECTOR_RATIO));
}

export function maxRailWidth(workspaceWidth: number, inspectorWidth: number, mode: LayoutMode) {
  if (mode === "narrow") return overlayRailMax(workspaceWidth);
  const reserved = MIN_MAP_WIDTH + (mode === "wide" ? inspectorWidth : 0);
  return Math.max(MIN_RAIL_WIDTH, Math.floor(workspaceWidth - reserved));
}

export function maxInspectorWidth(workspaceWidth: number, railWidth: number, mode: LayoutMode) {
  if (mode !== "wide") return overlayInspectorMax(workspaceWidth);
  return Math.max(MIN_INSPECTOR_WIDTH, Math.floor(workspaceWidth - MIN_MAP_WIDTH - railWidth));
}

export function clampPanelWidths(
  requested: PanelWidths,
  workspaceWidth: number,
  mode: LayoutMode,
): PanelWidths {
  if (mode === "narrow") {
    return {
      rail: resizePanel(requested.rail, 0, MIN_RAIL_WIDTH, overlayRailMax(workspaceWidth)),
      inspector: resizePanel(
        requested.inspector,
        0,
        MIN_INSPECTOR_WIDTH,
        overlayInspectorMax(workspaceWidth),
      ),
    };
  }

  if (mode === "medium") {
    return {
      rail: resizePanel(
        requested.rail,
        0,
        MIN_RAIL_WIDTH,
        Math.max(MIN_RAIL_WIDTH, Math.floor(workspaceWidth - MIN_MAP_WIDTH)),
      ),
      inspector: resizePanel(
        requested.inspector,
        0,
        MIN_INSPECTOR_WIDTH,
        overlayInspectorMax(workspaceWidth),
      ),
    };
  }

  const railCap = Math.max(
    MIN_RAIL_WIDTH,
    Math.floor(workspaceWidth - MIN_MAP_WIDTH - MIN_INSPECTOR_WIDTH),
  );
  const inspectorCap = Math.max(
    MIN_INSPECTOR_WIDTH,
    Math.floor(workspaceWidth - MIN_MAP_WIDTH - MIN_RAIL_WIDTH),
  );
  let rail = resizePanel(requested.rail, 0, MIN_RAIL_WIDTH, railCap);
  let inspector = resizePanel(requested.inspector, 0, MIN_INSPECTOR_WIDTH, inspectorCap);
  const overflow = rail + inspector + MIN_MAP_WIDTH - workspaceWidth;
  if (overflow <= 0) return { rail, inspector };

  const railAboveDefault = Math.max(0, rail - DEFAULT_RAIL_WIDTH);
  const inspectorAboveDefault = Math.max(0, inspector - DEFAULT_INSPECTOR_WIDTH);
  const aboveDefault = railAboveDefault + inspectorAboveDefault;
  if (aboveDefault >= overflow) {
    const railCut = aboveDefault === 0 ? 0 : overflow * (railAboveDefault / aboveDefault);
    rail = Math.max(MIN_RAIL_WIDTH, Math.round(rail - railCut));
    inspector = Math.max(MIN_INSPECTOR_WIDTH, workspaceWidth - MIN_MAP_WIDTH - rail);
    return { rail, inspector };
  }

  rail -= railAboveDefault;
  inspector -= inspectorAboveDefault;
  const remaining = overflow - aboveDefault;
  const railSlack = rail - MIN_RAIL_WIDTH;
  const inspectorSlack = inspector - MIN_INSPECTOR_WIDTH;
  const slack = railSlack + inspectorSlack;
  if (slack <= 0) return { rail: MIN_RAIL_WIDTH, inspector: MIN_INSPECTOR_WIDTH };
  rail = Math.max(MIN_RAIL_WIDTH, Math.round(rail - remaining * (railSlack / slack)));
  inspector = Math.max(MIN_INSPECTOR_WIDTH, workspaceWidth - MIN_MAP_WIDTH - rail);
  return { rail, inspector };
}

export function parsePanelWidths(value: unknown): PanelWidths | null {
  if (!value || typeof value !== "object") return null;
  if (!("rail" in value) || !("inspector" in value)) return null;
  if (typeof value.rail !== "number" || typeof value.inspector !== "number") return null;
  if (!Number.isFinite(value.rail) || !Number.isFinite(value.inspector)) return null;
  return { rail: value.rail, inspector: value.inspector };
}

export function readSavedPanelWidths(): PanelWidths {
  try {
    return parsePanelWidths(JSON.parse(localStorage.getItem(PANEL_WIDTHS_KEY) ?? "null")) ?? {
      ...defaultPanelWidths,
    };
  } catch {
    localStorage.removeItem(PANEL_WIDTHS_KEY);
    return { ...defaultPanelWidths };
  }
}

export function savePanelWidths(widths: PanelWidths) {
  localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
}

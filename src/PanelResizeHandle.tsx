import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import {
  clampPanelWidths,
  layoutModeForViewport,
  maxInspectorWidth,
  maxRailWidth,
  readSavedPanelWidths,
  resizePanel,
  savePanelWidths,
  type PanelWidths,
} from "./panelLayout";

const KEY_STEP = 8;
const KEY_STEP_LARGE = 32;

interface PanelResizeHandleProps {
  label: string;
  controlsId: string;
  edge: "start" | "end";
  value: number;
  min: number;
  max: number;
  defaultValue: number;
  tabIndex?: number;
  onChange: (width: number) => void;
  onCommit: (width: number) => void;
}

export function PanelResizeHandle({
  label,
  controlsId,
  edge,
  value,
  min,
  max,
  defaultValue,
  tabIndex = 0,
  onChange,
  onCommit,
}: PanelResizeHandleProps) {
  const [dragging, setDragging] = useState(false);
  const originX = useRef(0);
  const originValue = useRef(value);
  const moved = useRef(false);
  const active = useRef(false);

  useEffect(() => {
    return () => document.body.classList.remove("is-resizing-panels");
  }, []);

  if (max <= min) return null;

  function widthFromPointer(clientX: number) {
    const delta = edge === "end" ? clientX - originX.current : originX.current - clientX;
    return resizePanel(originValue.current, delta, min, max);
  }

  function startDrag(event: PointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    originX.current = event.clientX;
    originValue.current = value;
    moved.current = false;
    active.current = true;
    setDragging(true);
    document.body.classList.add("is-resizing-panels");
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>) {
    if (!active.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const next = widthFromPointer(event.clientX);
    if (next === originValue.current && !moved.current) return;
    moved.current = next !== originValue.current;
    event.currentTarget.setAttribute("aria-valuenow", String(next));
    event.currentTarget.setAttribute("aria-valuetext", `${next} pixels`);
    onChange(next);
  }

  function endDrag(event: PointerEvent<HTMLDivElement>, commit: boolean) {
    if (!active.current) return;
    active.current = false;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
    document.body.classList.remove("is-resizing-panels");
    if (commit && moved.current) onCommit(widthFromPointer(event.clientX));
    else onChange(originValue.current);
  }

  function handleKey(event: KeyboardEvent<HTMLDivElement>) {
    const step = event.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
    let next: number | null = null;
    if (event.key === "ArrowLeft") next = resizePanel(value, edge === "end" ? -step : step, min, max);
    else if (event.key === "ArrowRight") next = resizePanel(value, edge === "end" ? step : -step, min, max);
    else if (event.key === "Home") next = min;
    else if (event.key === "End") next = max;
    if (next === null) return;
    event.preventDefault();
    onCommit(next);
  }

  return (
    <div
      className={`panel-resize ${dragging ? "is-dragging" : ""}`}
      data-edge={edge}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-controls={controlsId}
      aria-valuemin={min}
      aria-valuemax={max}
      aria-valuenow={value}
      aria-valuetext={`${value} pixels`}
      aria-hidden={tabIndex < 0 ? true : undefined}
      title="Drag to resize. Double-click to restore the default width."
      tabIndex={tabIndex}
      onPointerDown={startDrag}
      onPointerMove={moveDrag}
      onPointerUp={(event) => endDrag(event, true)}
      onPointerCancel={(event) => endDrag(event, false)}
      onDoubleClick={() => onCommit(resizePanel(defaultValue, 0, min, max))}
      onKeyDown={handleKey}
    />
  );
}

export function usePanelLayout() {
  const [chosen, setChosen] = useState<PanelWidths>(readSavedPanelWidths);
  const [workspaceWidth, setWorkspaceWidth] = useState(() => window.innerWidth);
  const layoutMode = layoutModeForViewport(workspaceWidth);
  const shellRef = useRef<HTMLDivElement>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const chosenRef = useRef(chosen);
  const layoutRef = useRef({ workspaceWidth, layoutMode });
  chosenRef.current = chosen;
  layoutRef.current = { workspaceWidth, layoutMode };

  const widths = clampPanelWidths(chosen, workspaceWidth, layoutMode);

  useEffect(() => {
    const node = workspaceRef.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width;
      if (width) setWorkspaceWidth(width);
    });
    observer.observe(node);
    setWorkspaceWidth(node.getBoundingClientRect().width);
    return () => observer.disconnect();
  }, []);

  function apply(nextChosen: PanelWidths) {
    const { workspaceWidth: width, layoutMode: mode } = layoutRef.current;
    const clamped = clampPanelWidths(nextChosen, width, mode);
    const shell = shellRef.current;
    if (shell) {
      shell.style.setProperty("--rail-width", `${clamped.rail}px`);
      shell.style.setProperty("--inspector-width", `${clamped.inspector}px`);
    }
    return clamped;
  }

  function previewRail(rail: number) {
    apply({ ...chosenRef.current, rail });
  }

  function previewInspector(inspector: number) {
    apply({ ...chosenRef.current, inspector });
  }

  function commit(next: PanelWidths) {
    chosenRef.current = next;
    setChosen(next);
    savePanelWidths(next);
    apply(next);
  }

  return {
    shellRef,
    workspaceRef,
    widths,
    layoutMode,
    railMax: maxRailWidth(workspaceWidth, widths.inspector, layoutMode),
    inspectorMax: maxInspectorWidth(workspaceWidth, widths.rail, layoutMode),
    previewRail,
    previewInspector,
    commitRail: (rail: number) => commit({ ...chosenRef.current, rail }),
    commitInspector: (inspector: number) => commit({ ...chosenRef.current, inspector }),
    style: {
      "--rail-width": `${widths.rail}px`,
      "--inspector-width": `${widths.inspector}px`,
    } as CSSProperties,
  };
}

import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  LayerVisibility,
  RepositoryGraph,
  RepositoryNode,
} from "./model";
import { layerForNode } from "./model";
import {
  arteryKeys,
  buildRepositoryLayout,
  flowKey,
  revealedForSelection,
  type LayoutModule,
  type RepositoryLayout,
} from "./repositoryLayout";
import {
  framingTargetId,
  framingZoom,
  isMapPlaceName,
  parentPath,
  poseAlreadyFramed,
  sceneReadout,
  SURVEY_ZOOM,
  type Frameable,
} from "./placeNames";
import { nodeGlyph } from "./location";
import { mapPalette, type MapPalette } from "./ui/theme";

const MAX_FILE_LABELS = 48;
const MAX_DISTRICT_LABELS = 48;
const FLY_MS = 420;

type LabelMode = "region" | "slab" | "file";

export interface RepositorySceneHandle {
  resetCamera: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

interface RepositorySceneProps {
  graph: RepositoryGraph;
  selectedId: string | null;
  /** The district deliberately broken open; selection alone reveals nothing. */
  openedId?: string | null;
  searchQuery: string;
  layers: LayerVisibility;
  maxDepth: number;
  onSelect: (id: string | null) => void;
  /** The flow inset snaps to the selection; the main map eases there. */
  animateCamera?: boolean;
}

interface SceneVisual {
  node: RepositoryNode;
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  fill: THREE.MeshStandardMaterial;
  wire: THREE.LineBasicMaterial;
  label: THREE.SpriteMaterial | null;
  baseColor: number;
  width: number;
  depth: number;
  height: number;
}

interface ImportVisual {
  source: string;
  target: string;
  weight: number;
  /** This arc's weight relative to the heaviest arc in the layout, 0..1. */
  weightRatio: number;
  artery: boolean;
  group: THREE.Group;
  materials: THREE.MeshBasicMaterial[];
  baseOpacity: number;
}

interface HoveredFlow {
  source: RepositoryNode;
  target: RepositoryNode;
  weight: number;
}

interface SceneEngine {
  scene: THREE.Scene;
  camera: THREE.OrthographicCamera;
  renderer: THREE.WebGLRenderer;
  controls: OrbitControls;
  host: HTMLDivElement;
  modulesGroup: THREE.Group;
  importsGroup: THREE.Group;
  visuals: Map<string, SceneVisual>;
  hitTargets: THREE.Mesh[];
  arcTargets: THREE.Mesh[];
  importVisuals: ImportVisual[];
  hoveredId: string | null;
  hoveredFlowIndex: number | null;
  render: () => void;
  updateVisuals: () => void;
  frameSelection: (id: string | null) => void;
}

function createLabel(palette: MapPalette, text: string, kind: "district" | "file" = "district") {
  const compact = kind === "file";
  const canvas = document.createElement("canvas");
  canvas.width = compact ? 160 : 384;
  canvas.height = compact ? 48 : 72;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.font = `${compact ? "700 20px" : "600 24px"} ${palette.fontMono}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const max = compact ? 6 : 27;
  const label = (text.length > max ? `${text.slice(0, max - 2)}..` : text).toUpperCase();
  if (!compact) {
    // District names ride on a paper tag so they stay legible over rooftops
    // of the same olive family.
    const plateWidth = Math.min(canvas.width - 4, context.measureText(label).width + 30);
    const plateHeight = 46;
    const plateX = (canvas.width - plateWidth) / 2;
    const plateY = (canvas.height - plateHeight) / 2;
    context.fillStyle = palette.paperCss;
    context.fillRect(plateX, plateY, plateWidth, plateHeight);
    context.lineWidth = 3;
    context.strokeStyle = palette.ink;
    context.strokeRect(plateX, plateY, plateWidth, plateHeight);
  }
  context.fillStyle = palette.ink;
  context.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(compact ? 2.2 : 5.4, compact ? 0.46 : 1.02, 1);
  sprite.renderOrder = 4;
  return { sprite, material };
}

function disposeObject(object: THREE.Object3D) {
  object.traverse((child) => {
    const renderable = child as THREE.Object3D & {
      geometry?: THREE.BufferGeometry;
      material?: THREE.Material | THREE.Material[];
    };
    renderable.geometry?.dispose();
    const materials = Array.isArray(renderable.material)
      ? renderable.material
      : [renderable.material];
    for (const material of materials) {
      if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
      material?.dispose();
    }
  });
}

function clearGroup(group: THREE.Group) {
  const children = [...group.children];
  for (const child of children) {
    group.remove(child);
    disposeObject(child);
  }
}

function populateLayout(engine: SceneEngine, layout: RepositoryLayout) {
  clearGroup(engine.modulesGroup);
  clearGroup(engine.importsGroup);
  engine.visuals.clear();
  engine.hitTargets.length = 0;
  engine.arcTargets.length = 0;
  engine.importVisuals.length = 0;
  engine.hoveredId = null;
  engine.hoveredFlowIndex = null;

  const palette = mapPalette();
  const modulesById = new Map(layout.modules.map((module) => [module.node.id, module]));
  const fileIds = layout.modules
    .filter((module) => module.node.kind !== "directory" && module.node.kind !== "repository")
    .sort((left, right) => right.node.depth - left.node.depth)
    .slice(0, MAX_FILE_LABELS)
    .map((module) => module.node.id);

  // District name tags orient the whole field: platforms whose children are
  // rendered get a floating region tag, unpacked leaf districts get a tag on
  // their slab; tiny footprints stay quiet so tags never outnumber shapes.
  const renderedParents = new Set<string>();
  for (const module of layout.modules) {
    const id = module.node.id;
    const slash = id.lastIndexOf("/");
    renderedParents.add(slash === -1 ? "." : id.slice(0, slash));
  }
  const labelModes = new Map<string, LabelMode>();
  for (const module of layout.modules) {
    if (!isMapPlaceName(module.node)) continue;
    if (renderedParents.has(module.node.id)) {
      if (module.width >= 5) labelModes.set(module.node.id, "region");
    }
  }
  const slabIds = layout.modules
    .filter(
      (module) =>
        isMapPlaceName(module.node) &&
        !renderedParents.has(module.node.id) &&
        module.width >= 3.2,
    )
    .sort((left, right) => right.width - left.width)
    .slice(0, MAX_DISTRICT_LABELS)
    .map((module) => module.node.id);
  for (const id of slabIds) labelModes.set(id, "slab");
  for (const id of fileIds) labelModes.set(id, "file");

  for (const module of layout.modules) {
    const visual = createModuleVisual(palette, module, labelModes.get(module.node.id) ?? null);
    engine.modulesGroup.add(visual.group);
    engine.hitTargets.push(visual.mesh);
    engine.visuals.set(module.node.id, visual);
  }

  const maxImportWeight = Math.max(1, ...layout.imports.map((flow) => flow.weight));
  // Emphasis normalizes against the 85th-percentile weight, not the maximum:
  // one outlier flow must not flatten the rest of the top tier into the tail.
  const sortedWeights = layout.imports.map((flow) => flow.weight).sort((a, b) => a - b);
  const emphasisScale = Math.max(
    1,
    sortedWeights[Math.min(sortedWeights.length - 1, Math.floor(sortedWeights.length * 0.85))] ??
      1,
  );
  const arteries = arteryKeys(layout.imports);
  const importSourceColor = new THREE.Color(palette.importSource);
  const importTargetColor = new THREE.Color(palette.importTarget);
  for (const flow of layout.imports) {
    const source = modulesById.get(flow.source);
    const target = modulesById.get(flow.target);
    if (!source || !target) continue;

    const from = new THREE.Vector3(source.x, source.y + source.height + 0.1, source.z);
    const to = new THREE.Vector3(target.x, target.y + target.height + 0.1, target.z);
    const mid = from.clone().add(to).multiplyScalar(0.5);
    mid.y += 1.1 + from.distanceTo(to) * 0.16;
    const curve = new THREE.QuadraticBezierCurve3(from, mid, to);

    // Girth carries import count; WebGL ignores line width, so tubes, not lines.
    const radius = 0.05 + 0.24 * Math.sqrt(flow.weight / maxImportWeight);
    const tubularSegments = 24;
    const radialSegments = 6;
    const geometry = new THREE.TubeGeometry(curve, tubularSegments, radius, radialSegments, false);
    const vertexCount = geometry.attributes.position.count;
    const ringSize = radialSegments + 1;
    const colors = new Float32Array(vertexCount * 3);
    const ringColor = new THREE.Color();
    for (let index = 0; index < vertexCount; index += 1) {
      const progress = Math.min(1, Math.floor(index / ringSize) / tubularSegments);
      ringColor.copy(importSourceColor).lerp(importTargetColor, progress);
      colors.set([ringColor.r, ringColor.g, ringColor.b], index * 3);
    }
    geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

    // Quiet by default, but not flat: the squared weight curve keeps the long
    // tail of light arcs as faint context while the top tier of flows stays
    // boldly readable with no hover — the field's main story at rest.
    const weightRatio = Math.min(1, flow.weight / emphasisScale);
    const baseOpacity = 0.15 + 0.55 * weightRatio * weightRatio;
    const tubeMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: baseOpacity,
    });
    const tube = new THREE.Mesh(geometry, tubeMaterial);
    tube.renderOrder = 1;

    // Arrowhead lands on the imported module, giving each arc a direction.
    const headMaterial = new THREE.MeshBasicMaterial({
      color: importTargetColor,
      transparent: true,
      opacity: baseOpacity,
    });
    const headHeight = Math.min(1.1, radius * 6);
    const head = new THREE.Mesh(
      new THREE.ConeGeometry(radius * 2.4, headHeight, 8),
      headMaterial,
    );
    const tangent = curve.getTangent(1).normalize();
    head.position.copy(to).addScaledVector(tangent, -headHeight / 2);
    head.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), tangent);
    head.renderOrder = 1;

    const flowIndex = engine.importVisuals.length;
    tube.userData.flowIndex = flowIndex;
    head.userData.flowIndex = flowIndex;
    const arc = new THREE.Group();
    arc.add(tube, head);
    engine.importsGroup.add(arc);
    engine.arcTargets.push(tube, head);
    engine.importVisuals.push({
      source: flow.source,
      target: flow.target,
      weight: flow.weight,
      weightRatio,
      artery: arteries.has(flowKey(flow)),
      group: arc,
      materials: [tubeMaterial, headMaterial],
      baseOpacity,
    });
  }
}

function createModuleVisual(
  palette: MapPalette,
  module: LayoutModule,
  labelMode: LabelMode | null,
): SceneVisual {
  const geometry = new THREE.BoxGeometry(module.width, module.height, module.depth);
  const baseColor =
    module.node.kind === "directory" || module.node.kind === "repository"
      ? module.node.depth % 2 === 0
        ? palette.kind[module.node.kind]
        : palette.directoryAlt
      : palette.kind[module.node.kind];
  const fill = new THREE.MeshStandardMaterial({
    color: baseColor,
    roughness: 1,
    metalness: 0,
    transparent: true,
  });
  const mesh = new THREE.Mesh(geometry, fill);
  mesh.position.y = module.height / 2;
  mesh.userData.nodeId = module.node.id;

  const wire = new THREE.LineBasicMaterial({
    color: palette.outline,
    transparent: true,
    opacity: 0.8,
  });
  const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), wire);
  outline.position.copy(mesh.position);

  const group = new THREE.Group();
  group.position.set(module.x, module.y, module.z);
  group.add(mesh, outline);

  let label = null;
  if (
    labelMode === "file" &&
    module.node.kind !== "repository" &&
    module.node.kind !== "directory"
  ) {
    label = createLabel(palette, nodeGlyph(module.node), "file");
    if (label) {
      const width = Math.max(1.4, Math.min(2.8, module.width * 0.9));
      label.sprite.scale.set(width, width * 0.21, 1);
      label.sprite.position.set(0, module.height + 0.34, 0);
      group.add(label.sprite);
    }
  } else if (labelMode === "region" || labelMode === "slab") {
    label = createLabel(palette, module.node.name, "district");
    if (label) {
      // Region tags float above their platform's towers; slab tags sit just
      // over the slab's roof. Both scale with the footprint they name.
      const width =
        labelMode === "region"
          ? THREE.MathUtils.clamp(module.width * 0.5, 3.4, 8.5)
          : THREE.MathUtils.clamp(module.width * 0.7, 2.4, 4.6);
      label.sprite.scale.set(width, width * 0.1875, 1);
      label.sprite.position.set(0, module.height + (labelMode === "region" ? 2.3 : 0.45), 0);
      group.add(label.sprite);
    }
  }

  return {
    node: module.node,
    group,
    mesh,
    fill,
    wire,
    label: label?.material ?? null,
    baseColor,
    width: module.width,
    depth: module.depth,
    height: module.height,
  };
}

const RepositoryScene = forwardRef<RepositorySceneHandle, RepositorySceneProps>(
  function RepositoryScene(
    { graph, selectedId, openedId = null, searchQuery, layers, maxDepth, onSelect, animateCamera = true },
    ref,
  ) {
    const mountRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<SceneEngine | null>(null);
    const sceneControlsRef = useRef<RepositorySceneHandle | null>(null);
    const syncVisualsRef = useRef<(() => void) | null>(null);
    const selectedIdRef = useRef(selectedId);
    const searchQueryRef = useRef(searchQuery);
    const layersRef = useRef(layers);
    const onSelectRef = useRef(onSelect);
    const animateCameraRef = useRef(animateCamera);
    const [hoveredNode, setHoveredNode] = useState<RepositoryNode | null>(null);
    const [hoveredFlow, setHoveredFlow] = useState<HoveredFlow | null>(null);
    const [sceneError, setSceneError] = useState<string | null>(null);

    const revealedKey = useMemo(
      () => [...revealedForSelection(graph, openedId, maxDepth)].sort().join("\0"),
      [graph, openedId, maxDepth],
    );
    const layout = useMemo(
      () => buildRepositoryLayout(graph, maxDepth, openedId),
      // Only opening a district rebuilds the field; selection never does.
      [graph, maxDepth, revealedKey],
    );
    const layoutRef = useRef(layout);
    layoutRef.current = layout;

    useImperativeHandle(
      ref,
      () => ({
        resetCamera: () => sceneControlsRef.current?.resetCamera(),
        zoomIn: () => sceneControlsRef.current?.zoomIn(),
        zoomOut: () => sceneControlsRef.current?.zoomOut(),
      }),
      [],
    );

    useEffect(() => {
      onSelectRef.current = onSelect;
      animateCameraRef.current = animateCamera;
    }, [onSelect, animateCamera]);

    useEffect(() => {
      const mount = mountRef.current;
      if (!mount) return;
      const host: HTMLDivElement = mount;

      setSceneError(null);
      const palette = mapPalette();
      const world = buildRepositoryLayout(graph, maxDepth);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(palette.paper);

      let renderer: THREE.WebGLRenderer;
      try {
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
      } catch {
        setSceneError("The 3D map could not start on this display.");
        return;
      }

      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      renderer.domElement.className = "repository-canvas";
      renderer.domElement.setAttribute("role", "img");
      renderer.domElement.setAttribute(
        "aria-label",
        `Interactive 3D map of ${graph.name}. Use the module list for keyboard selection.`,
      );
      host.appendChild(renderer.domElement);

      const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.1, 5000);
      const controls = new OrbitControls(camera, renderer.domElement);
      controls.enableDamping = false;
      controls.screenSpacePanning = true;
      controls.minZoom = 0.35;
      controls.maxZoom = 8;
      // The field has no underside: stop the orbit just above the horizon so
      // a vertical drag can never flip the map to its unlit belly.
      controls.maxPolarAngle = Math.PI * 0.47;

      const cameraPosition = new THREE.Vector3(
        world.extent * 1.25,
        world.extent * 1.55,
        world.extent * 1.25,
      );
      camera.position.copy(cameraPosition);
      controls.target.set(0, 0, 0);
      camera.lookAt(controls.target);

      const gridSize = Math.ceil((world.extent * 2) / 10) * 10;
      const grid = new THREE.GridHelper(
        gridSize,
        Math.max(12, Math.round(gridSize / 4.8)),
        palette.gridMajor,
        palette.gridMinor,
      );
      grid.position.y = -0.035;
      const gridMaterials = Array.isArray(grid.material) ? grid.material : [grid.material];
      for (const material of gridMaterials) {
        material.transparent = true;
        material.opacity = 0.34;
      }
      scene.add(grid);

      scene.add(new THREE.HemisphereLight(0xeee6b8, 0x4c4b37, 2.2));
      const keyLight = new THREE.DirectionalLight(0xfff8ce, 2.4);
      keyLight.position.set(20, 40, 18);
      scene.add(keyLight);

      const modulesGroup = new THREE.Group();
      const importsGroup = new THREE.Group();
      scene.add(modulesGroup, importsGroup);

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let pointerDown = { x: 0, y: 0 };

      const engine: SceneEngine = {
        scene,
        camera,
        renderer,
        controls,
        host,
        modulesGroup,
        importsGroup,
        visuals: new Map(),
        hitTargets: [],
        arcTargets: [],
        importVisuals: [],
        hoveredId: null,
        hoveredFlowIndex: null,
        render: () => {
          renderer.render(scene, camera);
        },
        updateVisuals: () => undefined,
        frameSelection: () => undefined,
      };

      function render() {
        renderer.render(scene, camera);
      }

      function updateVisuals() {
        const query = searchQueryRef.current.trim().toLowerCase();

        for (const [id, visual] of engine.visuals) {
          const visible = layersRef.current[layerForNode(visual.node)];
          const matches =
            !query ||
            visual.node.name.toLowerCase().includes(query) ||
            visual.node.path.toLowerCase().includes(query) ||
            visual.node.language?.toLowerCase().includes(query) ||
            visual.node.description?.toLowerCase().includes(query);
          const selected = id === selectedIdRef.current;
          const hovered = id === engine.hoveredId;

          visual.group.visible = visible;
          visual.mesh.visible = visible;
          visual.fill.color.setHex(
            selected
              ? palette.outline
              : hovered
                ? palette.hover
                : matches && query
                  ? palette.searchHit
                  : visual.baseColor,
          );
          visual.fill.opacity = query && !matches ? 0.18 : 1;
          visual.wire.color.setHex(
            selected ? palette.glow : matches && query ? palette.rust : palette.outline,
          );
          visual.wire.opacity = query && !matches ? 0.16 : selected ? 1 : 0.8;
          if (visual.label) visual.label.opacity = query && !matches ? 0.22 : 1;
        }

        // A selection deeper than the rendered grain (picked from the index,
        // or inside a still-closed district) lights its nearest rendered
        // ancestor's arcs instead of nothing.
        let selected = selectedIdRef.current;
        while (selected && selected !== "." && !engine.visuals.has(selected)) {
          selected = parentPath(selected);
        }
        // A focused district's arcs attach to its revealed children, so an
        // endpoint inside the anchor counts (ids are paths). The root is
        // everything's ancestor; emphasizing all arcs would emphasize none.
        const under = (id: string, anchor: string | null) =>
          anchor !== null &&
          anchor !== "." &&
          (id === anchor || id.startsWith(`${anchor}/`));
        const focused = selected !== null && selected !== ".";
        const hoverAnchor =
          engine.hoveredId && engine.hoveredId !== "." ? engine.hoveredId : null;
        // Survey scale is a transit map: only arteries stay on. A hover or
        // selection reveals the streets that cross that district; inner
        // wiring of a selection stays at base; unrelated arteries drop to
        // faint city context; everything else is off.
        for (const [index, flow] of engine.importVisuals.entries()) {
          const source = engine.visuals.get(flow.source);
          const target = engine.visuals.get(flow.target);
          const endpointsOn = Boolean(source?.group.visible && target?.group.visible);
          const sourceSelected = under(flow.source, selected);
          const targetSelected = under(flow.target, selected);
          const sourceHover = under(flow.source, hoverAnchor);
          const targetHover = under(flow.target, hoverAnchor);
          const inner = focused && sourceSelected && targetSelected;
          const hot =
            index === engine.hoveredFlowIndex ||
            (focused && sourceSelected !== targetSelected) ||
            (hoverAnchor !== null && sourceHover !== targetHover);
          const show = layersRef.current.imports && endpointsOn && (hot || inner || flow.artery);
          flow.group.visible = show;
          if (!show) continue;
          const opacity =
            index === engine.hoveredFlowIndex
              ? 1
              : hot
                ? 0.55 + 0.45 * flow.weightRatio
                : inner
                  ? flow.baseOpacity
                  : focused
                    ? flow.baseOpacity * 0.22
                    : flow.baseOpacity;
          for (const material of flow.materials) material.opacity = opacity;
          for (const child of flow.group.children) child.renderOrder = hot ? 3 : inner ? 2 : 1;
        }
        render();
      }

      engine.render = render;
      engine.updateVisuals = updateVisuals;
      engineRef.current = engine;
      syncVisualsRef.current = updateVisuals;

      controls.addEventListener("change", render);

      function pointFromEvent(event: PointerEvent) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        return raycaster
          .intersectObjects(engine.hitTargets, false)
          .find((hit) => hit.object.parent?.visible);
      }

      function handlePointerMove(event: PointerEvent) {
        const hit = pointFromEvent(event);
        const arcHit = raycaster
          .intersectObjects(engine.arcTargets, false)
          .find((candidate) => candidate.object.parent?.visible);
        // Whichever is nearer the camera wins: arcs fly in front of rooftops.
        const arcWins = arcHit && (!hit || arcHit.distance < hit.distance);
        const nextId = arcWins ? null : (hit?.object.userData.nodeId ?? null);
        const nextFlowIndex = arcWins ? (arcHit.object.userData.flowIndex as number) : null;
        if (nextId === engine.hoveredId && nextFlowIndex === engine.hoveredFlowIndex) return;
        engine.hoveredId = nextId;
        engine.hoveredFlowIndex = nextFlowIndex;
        renderer.domElement.style.cursor = nextId ? "pointer" : "grab";
        setHoveredNode(nextId ? (engine.visuals.get(nextId)?.node ?? null) : null);
        const flow = nextFlowIndex !== null ? engine.importVisuals[nextFlowIndex] : null;
        const flowSource = flow ? engine.visuals.get(flow.source)?.node : null;
        const flowTarget = flow ? engine.visuals.get(flow.target)?.node : null;
        setHoveredFlow(
          flow && flowSource && flowTarget
            ? { source: flowSource, target: flowTarget, weight: flow.weight }
            : null,
        );
        updateVisuals();
      }

      let viewHeight = world.extent * 1.46;
      let flyRaf = 0;
      const surveyTarget = new THREE.Vector3(0, 0, 0);

      function cancelFly() {
        if (flyRaf) {
          cancelAnimationFrame(flyRaf);
          flyRaf = 0;
        }
      }

      // Framing pans and zooms but never reorients: the offset comes from the
      // camera's live pose, so the user's orbit angle survives every flight.
      // Only an explicit reset restores the canonical survey angle.
      function applyPose(target: THREE.Vector3, zoom: number) {
        const offset = camera.position.clone().sub(controls.target);
        controls.target.copy(target);
        camera.position.copy(target).add(offset);
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
        controls.update();
        render();
      }

      function framingPose(id: string | null): { id: string; target: THREE.Vector3; zoom: number } {
        const byId = new Map<string, Frameable>();
        for (const [visualId, visual] of engine.visuals) {
          byId.set(visualId, { node: visual.node, width: visual.width, depth: visual.depth });
        }
        const chosenId = framingTargetId(id, byId);
        if (chosenId === ".") {
          return { id: ".", target: surveyTarget.clone(), zoom: SURVEY_ZOOM };
        }
        const visual = engine.visuals.get(chosenId);
        if (!visual) {
          return { id: ".", target: surveyTarget.clone(), zoom: SURVEY_ZOOM };
        }
        return {
          id: chosenId,
          target: new THREE.Vector3(visual.group.position.x, 0, visual.group.position.z),
          zoom: framingZoom(viewHeight, Math.max(visual.width, visual.depth), controls.maxZoom),
        };
      }

      function frameSelection(id: string | null) {
        const pose = framingPose(id);
        const fromTarget = controls.target.clone();
        const fromZoom = camera.zoom;
        if (poseAlreadyFramed(fromTarget, fromZoom, pose.target, pose.zoom)) {
          applyPose(pose.target, pose.zoom);
          return;
        }
        cancelFly();
        const reduced =
          !animateCameraRef.current ||
          window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        if (reduced) {
          applyPose(pose.target, pose.zoom);
          return;
        }
        const fromPos = camera.position.clone();
        const toPos = pose.target.clone().add(fromPos.clone().sub(fromTarget));
        const start = performance.now();
        function step(now: number) {
          const t = Math.min(1, (now - start) / FLY_MS);
          const ease = 1 - (1 - t) ** 3;
          controls.target.lerpVectors(fromTarget, pose.target, ease);
          camera.position.lerpVectors(fromPos, toPos, ease);
          camera.zoom = fromZoom + (pose.zoom - fromZoom) * ease;
          camera.updateProjectionMatrix();
          controls.update();
          render();
          if (t < 1) flyRaf = requestAnimationFrame(step);
          else flyRaf = 0;
        }
        flyRaf = requestAnimationFrame(step);
      }

      engine.frameSelection = frameSelection;

      function handlePointerDown(event: PointerEvent) {
        cancelFly();
        pointerDown = { x: event.clientX, y: event.clientY };
      }

      function handlePointerUp(event: PointerEvent) {
        if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
        const hit = pointFromEvent(event);
        const nextId = hit?.object.userData.nodeId ?? null;
        if (nextId) {
          engine.frameSelection(nextId);
          onSelectRef.current(nextId);
        }
      }

      function handlePointerLeave() {
        engine.hoveredId = null;
        engine.hoveredFlowIndex = null;
        setHoveredNode(null);
        setHoveredFlow(null);
        updateVisuals();
      }

      function resize() {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const aspect = width / height;
        viewHeight = world.extent * 1.46 * (aspect < 1 ? 1 / aspect : 1);
        camera.left = (-viewHeight * aspect) / 2;
        camera.right = (viewHeight * aspect) / 2;
        camera.top = viewHeight / 2;
        camera.bottom = -viewHeight / 2;
        camera.updateProjectionMatrix();
        renderer.setSize(width, height, false);
        render();
      }

      function changeZoom(factor: number) {
        camera.zoom = THREE.MathUtils.clamp(camera.zoom * factor, controls.minZoom, controls.maxZoom);
        camera.updateProjectionMatrix();
        render();
      }

      sceneControlsRef.current = {
        resetCamera: () => {
          cancelFly();
          camera.position.copy(cameraPosition);
          camera.zoom = SURVEY_ZOOM;
          controls.target.set(0, 0, 0);
          controls.update();
          camera.updateProjectionMatrix();
          render();
        },
        zoomIn: () => changeZoom(1.25),
        zoomOut: () => changeZoom(0.8),
      };

      renderer.domElement.addEventListener("pointermove", handlePointerMove);
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
      renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

      populateLayout(engine, layoutRef.current);
      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      updateVisuals();

      return () => {
        cancelFly();
        syncVisualsRef.current = null;
        sceneControlsRef.current = null;
        engineRef.current = null;
        resizeObserver.disconnect();
        controls.removeEventListener("change", render);
        controls.dispose();
        renderer.domElement.removeEventListener("pointermove", handlePointerMove);
        renderer.domElement.removeEventListener("pointerdown", handlePointerDown);
        renderer.domElement.removeEventListener("pointerup", handlePointerUp);
        renderer.domElement.removeEventListener("pointerleave", handlePointerLeave);
        scene.traverse((object) => {
          const renderable = object as THREE.Object3D & {
            geometry?: THREE.BufferGeometry;
            material?: THREE.Material | THREE.Material[];
          };
          renderable.geometry?.dispose();
          const materials = Array.isArray(renderable.material)
            ? renderable.material
            : [renderable.material];
          for (const material of materials) {
            if (material instanceof THREE.SpriteMaterial) material.map?.dispose();
            material?.dispose();
          }
        });
        renderer.dispose();
        renderer.domElement.remove();
      };
    }, [graph, maxDepth]);

    useEffect(() => {
      const engine = engineRef.current;
      if (!engine) return;
      populateLayout(engine, layout);
      setHoveredNode(null);
      setHoveredFlow(null);
      engine.updateVisuals();
      return () => {
        const current = engineRef.current;
        if (!current) return;
        clearGroup(current.modulesGroup);
        clearGroup(current.importsGroup);
        current.visuals.clear();
        current.hitTargets.length = 0;
        current.arcTargets.length = 0;
        current.importVisuals.length = 0;
      };
    }, [layout]);

    useEffect(() => {
      searchQueryRef.current = searchQuery;
      layersRef.current = layers;
      syncVisualsRef.current?.();
    }, [
      layers.config,
      layers.docs,
      layers.imports,
      layers.source,
      layers.structure,
      layers.tests,
      searchQuery,
    ]);

    useEffect(() => {
      selectedIdRef.current = selectedId;
      syncVisualsRef.current?.();
      engineRef.current?.frameSelection(selectedId);
    }, [selectedId]);

    const hoverReadout = hoveredNode ? sceneReadout(hoveredNode) : null;

    return (
      <div className="scene-mount" ref={mountRef}>
        {sceneError ? <p className="scene-error">{sceneError}</p> : null}
        {hoverReadout ? (
          <div className="scene-readout" aria-hidden="true">
            <span>{hoverReadout.kicker}</span>
            <strong>{hoverReadout.title}</strong>
            {hoverReadout.summary ? (
              <p className="scene-readout-summary">{hoverReadout.summary}</p>
            ) : null}
          </div>
        ) : hoveredFlow ? (
          <div className="scene-readout" aria-hidden="true">
            <span>
              {hoveredFlow.weight === 1 ? "1 import" : `${hoveredFlow.weight} imports`}
            </span>
            <strong>
              {hoveredFlow.source.name} → {hoveredFlow.target.name}
            </strong>
          </div>
        ) : null}
        {layout.modules.length < graph.nodes.length ? (
          <p className="render-cap" title="The complete repository remains available in the module list.">
            MAP {layout.modules.length}/{graph.nodes.length}
          </p>
        ) : null}
      </div>
    );
  },
);

export default RepositoryScene;

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
  buildRepositoryLayout,
  revealedForSelection,
  type LayoutModule,
  type RepositoryLayout,
} from "./repositoryLayout";
import { nodeGlyph, scaleOf } from "./location";
import { mapPalette, type MapPalette } from "./ui/theme";

const MAX_FILE_LABELS = 48;

export interface RepositorySceneHandle {
  resetCamera: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
}

interface RepositorySceneProps {
  graph: RepositoryGraph;
  selectedId: string | null;
  searchQuery: string;
  layers: LayerVisibility;
  maxDepth: number;
  onSelect: (id: string | null) => void;
}

interface SceneVisual {
  node: RepositoryNode;
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  fill: THREE.MeshStandardMaterial;
  wire: THREE.LineBasicMaterial;
  label: THREE.SpriteMaterial | null;
  baseColor: number;
}

interface ImportVisual {
  source: string;
  target: string;
  weight: number;
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
}

function createLabel(palette: MapPalette, text: string, kind: "district" | "file" = "district") {
  const compact = kind === "file";
  const canvas = document.createElement("canvas");
  canvas.width = compact ? 160 : 384;
  canvas.height = compact ? 48 : 72;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = palette.ink;
  context.font = `${compact ? "700 20px" : "600 24px"} ${palette.fontMono}`;
  context.textAlign = "center";
  context.textBaseline = "middle";
  const max = compact ? 6 : 27;
  const label = text.length > max ? `${text.slice(0, max - 2)}..` : text;
  context.fillText(label.toUpperCase(), canvas.width / 2, canvas.height / 2);

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
  const labelFiles = new Set(fileIds);

  for (const module of layout.modules) {
    const visual = createModuleVisual(palette, module, labelFiles.has(module.node.id));
    engine.modulesGroup.add(visual.group);
    engine.hitTargets.push(visual.mesh);
    engine.visuals.set(module.node.id, visual);
  }

  const maxImportWeight = Math.max(1, ...layout.imports.map((flow) => flow.weight));
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

    const baseOpacity = 0.55 + 0.35 * (flow.weight / maxImportWeight);
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
      group: arc,
      materials: [tubeMaterial, headMaterial],
      baseOpacity,
    });
  }
}

function createModuleVisual(
  palette: MapPalette,
  module: LayoutModule,
  labelFile = false,
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
    labelFile &&
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
  }

  return {
    node: module.node,
    group,
    mesh,
    fill,
    wire,
    label: label?.material ?? null,
    baseColor,
  };
}

const RepositoryScene = forwardRef<RepositorySceneHandle, RepositorySceneProps>(
  function RepositoryScene({ graph, selectedId, searchQuery, layers, maxDepth, onSelect }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const engineRef = useRef<SceneEngine | null>(null);
    const sceneControlsRef = useRef<RepositorySceneHandle | null>(null);
    const syncVisualsRef = useRef<(() => void) | null>(null);
    const selectedIdRef = useRef(selectedId);
    const searchQueryRef = useRef(searchQuery);
    const layersRef = useRef(layers);
    const onSelectRef = useRef(onSelect);
    const [hoveredNode, setHoveredNode] = useState<RepositoryNode | null>(null);
    const [hoveredFlow, setHoveredFlow] = useState<HoveredFlow | null>(null);
    const [sceneError, setSceneError] = useState<string | null>(null);

    const revealedKey = useMemo(
      () => [...revealedForSelection(graph, selectedId, maxDepth)].sort().join("\0"),
      [graph, selectedId, maxDepth],
    );
    const layout = useMemo(
      () => buildRepositoryLayout(graph, maxDepth, selectedId),
      // A selection that does not open hidden children must not rebuild the field.
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
    }, [onSelect]);

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

        const selected = selectedIdRef.current;
        // A selected district's arcs attach to its revealed children, so an
        // endpoint inside the selection counts (ids are paths). The root is
        // everything's ancestor; emphasizing all arcs would emphasize none.
        const inSelection = (id: string) =>
          selected !== null &&
          selected !== "." &&
          (id === selected || id.startsWith(`${selected}/`));
        const selectionHasFlow = engine.importVisuals.some(
          (flow) => inSelection(flow.source) || inSelection(flow.target),
        );
        for (const [index, flow] of engine.importVisuals.entries()) {
          const source = engine.visuals.get(flow.source);
          const target = engine.visuals.get(flow.target);
          flow.group.visible =
            layersRef.current.imports && Boolean(source?.group.visible && target?.group.visible);
          const touchesSelection = inSelection(flow.source) || inSelection(flow.target);
          const hot = index === engine.hoveredFlowIndex || touchesSelection;
          // A selection's flow must dominate: unrelated arcs drop to a faint
          // context layer and hot arcs draw over rooftops and dim arcs alike.
          const opacity = hot ? 1 : selectionHasFlow ? flow.baseOpacity * 0.12 : flow.baseOpacity;
          for (const material of flow.materials) material.opacity = opacity;
          for (const child of flow.group.children) child.renderOrder = hot ? 3 : 1;
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

      function handlePointerDown(event: PointerEvent) {
        pointerDown = { x: event.clientX, y: event.clientY };
      }

      function handlePointerUp(event: PointerEvent) {
        if (Math.hypot(event.clientX - pointerDown.x, event.clientY - pointerDown.y) > 5) return;
        const hit = pointFromEvent(event);
        const nextId = hit?.object.userData.nodeId ?? null;
        if (nextId) onSelectRef.current(nextId);
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
        const fittedHeight = world.extent * 1.46 * (aspect < 1 ? 1 / aspect : 1);
        camera.left = (-fittedHeight * aspect) / 2;
        camera.right = (fittedHeight * aspect) / 2;
        camera.top = fittedHeight / 2;
        camera.bottom = -fittedHeight / 2;
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
          camera.position.copy(cameraPosition);
          camera.zoom = 1;
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
      selectedIdRef.current = selectedId;
      searchQueryRef.current = searchQuery;
      layersRef.current = layers;
      syncVisualsRef.current?.();
    }, [layers.config, layers.docs, layers.imports, layers.source, layers.structure, searchQuery, selectedId]);

    return (
      <div className="scene-mount" ref={mountRef}>
        {sceneError ? <p className="scene-error">{sceneError}</p> : null}
        {hoveredNode ? (
          <div className="scene-readout" aria-hidden="true">
            <span>
              {scaleOf(hoveredNode)} · {hoveredNode.kind}
            </span>
            <strong>{hoveredNode.path === "." ? hoveredNode.name : hoveredNode.path}</strong>
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

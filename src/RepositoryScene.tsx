import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type {
  LayerVisibility,
  RepositoryGraph,
  RepositoryNode,
  RepositoryNodeKind,
} from "./model";
import { layerForNode } from "./model";
import { buildRepositoryLayout, MAX_RENDERED_NODES } from "./repositoryLayout";

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
  onSelect: (id: string | null) => void;
}

interface SceneVisual {
  node: RepositoryNode;
  group: THREE.Group;
  mesh: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>;
  fill: THREE.MeshStandardMaterial;
  wire: THREE.LineBasicMaterial;
  label: THREE.SpriteMaterial | null;
}

const moduleColors: Record<RepositoryNodeKind, number> = {
  repository: 0x8e8552,
  directory: 0xb0a873,
  source: 0xc8c08c,
  config: 0x978d58,
  documentation: 0xb8ad72,
  asset: 0xa39a68,
};

function createLabel(text: string) {
  const canvas = document.createElement("canvas");
  canvas.width = 384;
  canvas.height = 72;
  const context = canvas.getContext("2d");
  if (!context) return null;

  context.clearRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = "#14150f";
  context.font = "600 24px ui-monospace, SFMono-Regular, Menlo, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  const label = text.length > 27 ? `${text.slice(0, 25)}..` : text;
  context.fillText(label.toUpperCase(), canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const material = new THREE.SpriteMaterial({
    map: texture,
    transparent: true,
    depthTest: false,
  });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(5.4, 1.02, 1);
  sprite.renderOrder = 4;
  return { sprite, material };
}

const RepositoryScene = forwardRef<RepositorySceneHandle, RepositorySceneProps>(
  function RepositoryScene({ graph, selectedId, searchQuery, layers, onSelect }, ref) {
    const mountRef = useRef<HTMLDivElement>(null);
    const sceneControlsRef = useRef<RepositorySceneHandle | null>(null);
    const syncVisualsRef = useRef<(() => void) | null>(null);
    const selectedIdRef = useRef(selectedId);
    const searchQueryRef = useRef(searchQuery);
    const layersRef = useRef(layers);
    const onSelectRef = useRef(onSelect);
    const [hoveredNode, setHoveredNode] = useState<RepositoryNode | null>(null);
    const [sceneError, setSceneError] = useState<string | null>(null);

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
      const layout = buildRepositoryLayout(graph);
      const scene = new THREE.Scene();
      scene.background = new THREE.Color(0xd7cf9f);

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
        layout.extent * 1.25,
        layout.extent * 1.55,
        layout.extent * 1.25,
      );
      camera.position.copy(cameraPosition);
      controls.target.set(0, 0, 0);
      camera.lookAt(controls.target);

      const gridSize = Math.ceil((layout.extent * 2) / 10) * 10;
      const grid = new THREE.GridHelper(
        gridSize,
        Math.max(12, Math.round(gridSize / 4.8)),
        0x77734f,
        0xaaa474,
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

      const visuals = new Map<string, SceneVisual>();
      const hitTargets: THREE.Mesh[] = [];
      const modulesById = new Map(layout.modules.map((module) => [module.node.id, module]));

      for (const module of layout.modules) {
        const geometry = new THREE.BoxGeometry(module.width, module.height, module.depth);
        const fill = new THREE.MeshStandardMaterial({
          color: moduleColors[module.node.kind],
          roughness: 1,
          metalness: 0,
          transparent: true,
        });
        const mesh = new THREE.Mesh(geometry, fill);
        mesh.position.y = module.height / 2;
        mesh.userData.nodeId = module.node.id;

        const wire = new THREE.LineBasicMaterial({
          color: 0x292a20,
          transparent: true,
          opacity: 0.8,
        });
        const outline = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), wire);
        outline.position.copy(mesh.position);

        const group = new THREE.Group();
        group.position.set(module.x, 0, module.z);
        group.add(mesh, outline);

        let label = null;
        if (module.node.kind === "repository" || module.node.kind === "directory") {
          label = createLabel(module.node.name);
          if (label) {
            label.sprite.position.set(0, module.height + 0.62, 0);
            group.add(label.sprite);
          }
        }

        scene.add(group);
        hitTargets.push(mesh);
        visuals.set(module.node.id, {
          node: module.node,
          group,
          mesh,
          fill,
          wire,
          label: label?.material ?? null,
        });
      }

      const edgeVisuals: {
        source: string;
        target: string;
        line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
      }[] = [];
      for (const edge of layout.edges) {
        const source = modulesById.get(edge.source);
        const target = modulesById.get(edge.target);
        if (!source || !target) continue;

        const geometry = new THREE.BufferGeometry().setFromPoints([
          new THREE.Vector3(source.x, source.height + 0.08, source.z),
          new THREE.Vector3(target.x, target.height + 0.08, target.z),
        ]);
        const material = new THREE.LineBasicMaterial({
          color: 0x5e5d42,
          transparent: true,
          opacity: 0.28,
        });
        const line = new THREE.Line(geometry, material);
        line.renderOrder = -1;
        scene.add(line);
        edgeVisuals.push({ source: edge.source, target: edge.target, line });
      }

      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      let hoveredId: string | null = null;
      let pointerDown = { x: 0, y: 0 };

      function render() {
        renderer.render(scene, camera);
      }

      controls.addEventListener("change", render);

      function updateVisuals() {
        const query = searchQueryRef.current.trim().toLowerCase();

        for (const [id, visual] of visuals) {
          const visible = layersRef.current[layerForNode(visual.node)];
          const matches =
            !query ||
            visual.node.name.toLowerCase().includes(query) ||
            visual.node.path.toLowerCase().includes(query) ||
            visual.node.language?.toLowerCase().includes(query);
          const selected = id === selectedIdRef.current;
          const hovered = id === hoveredId;

          visual.group.visible = visible;
          visual.mesh.visible = visible;
          visual.fill.color.setHex(
            selected ? 0x292a20 : hovered ? 0x8f854d : matches && query ? 0xb46f3d : moduleColors[visual.node.kind],
          );
          visual.fill.opacity = query && !matches ? 0.18 : 1;
          visual.wire.color.setHex(selected ? 0xf1e8b6 : matches && query ? 0x713618 : 0x292a20);
          visual.wire.opacity = query && !matches ? 0.16 : selected ? 1 : 0.8;
          if (visual.label) visual.label.opacity = query && !matches ? 0.22 : 1;
        }

        for (const edge of edgeVisuals) {
          const source = visuals.get(edge.source);
          const target = visuals.get(edge.target);
          edge.line.visible = Boolean(source?.group.visible && target?.group.visible);
        }
        render();
      }

      function pointFromEvent(event: PointerEvent) {
        const rect = renderer.domElement.getBoundingClientRect();
        pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
        raycaster.setFromCamera(pointer, camera);
        return raycaster
          .intersectObjects(hitTargets, false)
          .find((hit) => hit.object.parent?.visible);
      }

      function handlePointerMove(event: PointerEvent) {
        const hit = pointFromEvent(event);
        const nextId = hit?.object.userData.nodeId ?? null;
        if (nextId === hoveredId) return;
        hoveredId = nextId;
        renderer.domElement.style.cursor = nextId ? "pointer" : "grab";
        setHoveredNode(nextId ? visuals.get(nextId)?.node ?? null : null);
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
        hoveredId = null;
        setHoveredNode(null);
        updateVisuals();
      }

      function resize() {
        const width = Math.max(1, host.clientWidth);
        const height = Math.max(1, host.clientHeight);
        const aspect = width / height;
        const fittedHeight = layout.extent * 2.18 * (aspect < 1 ? 1 / aspect : 1);
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
      syncVisualsRef.current = updateVisuals;

      renderer.domElement.addEventListener("pointermove", handlePointerMove);
      renderer.domElement.addEventListener("pointerdown", handlePointerDown);
      renderer.domElement.addEventListener("pointerup", handlePointerUp);
      renderer.domElement.addEventListener("pointerleave", handlePointerLeave);

      const resizeObserver = new ResizeObserver(resize);
      resizeObserver.observe(host);
      resize();
      updateVisuals();

      return () => {
        syncVisualsRef.current = null;
        sceneControlsRef.current = null;
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
    }, [graph]);

    useEffect(() => {
      selectedIdRef.current = selectedId;
      searchQueryRef.current = searchQuery;
      layersRef.current = layers;
      syncVisualsRef.current?.();
    }, [layers.config, layers.docs, layers.source, layers.structure, searchQuery, selectedId]);

    const renderedCount = Math.min(graph.nodes.length, MAX_RENDERED_NODES);

    return (
      <div className="scene-mount" ref={mountRef}>
        {sceneError ? <p className="scene-error">{sceneError}</p> : null}
        {hoveredNode ? (
          <div className="scene-readout" aria-hidden="true">
            <span>{hoveredNode.kind}</span>
            <strong>{hoveredNode.name}</strong>
          </div>
        ) : null}
        {graph.nodes.length > MAX_RENDERED_NODES ? (
          <p className="render-cap" title="The complete repository remains available in the module list.">
            MAP {renderedCount}/{graph.nodes.length}
          </p>
        ) : null}
      </div>
    );
  },
);

export default RepositoryScene;

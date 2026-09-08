import { useEffect, useRef, useState } from "react";
import { LoaderCircle } from "lucide-react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { CompatibleGLTFLoader as GLTFLoader } from "../viewer/CompatibleGLTFLoader";
import type { BakeLightState } from "../optimizer/modelOptimizer";
import type { AppLocale } from "../i18n";
import { captureModelThumbnail } from "../optimizer/captureModelThumbnail";
import { OptimizerPreviewActions } from "./OptimizerPreviewActions";
import { disposeOptimizerPreview } from "../optimizer/disposeOptimizerPreview";
import { frameOptimizerCamera } from "../optimizer/frameOptimizerCamera";

interface OptimizerPreviewRuntime {
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  transform: TransformControls;
  defaultLights: THREE.Light[];
  ambient: THREE.AmbientLight;
  lights: Map<string, { state: BakeLightState; light: THREE.Light; proxy: THREE.Group }>;
  center: THREE.Vector3;
  radius: number;
  model?: THREE.Object3D;
  environment?: THREE.WebGLRenderTarget;
  modelBounds?: THREE.Box3;
}

interface OptimizerPreviewProps {
  locale: AppLocale;
  url: string;
  bakeEnabled: boolean;
  comparisonMode: boolean;
  shadows: boolean;
  reflections: boolean;
  ambient: number;
  ambientColor: string;
  lights: BakeLightState[];
  selectedLightId: string | undefined;
  transformMode: "translate" | "rotate";
  onSelectLight: (id: string | undefined) => void;
  onUpdateLight: (id: string, patch: Partial<BakeLightState>) => void;
}

export function OptimizerPreview({
  locale,
  url,
  bakeEnabled,
  comparisonMode,
  shadows,
  reflections,
  ambient,
  ambientColor,
  lights,
  selectedLightId,
  transformMode,
  onSelectLight,
  onUpdateLight,
}: OptimizerPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef<OptimizerPreviewRuntime | undefined>(undefined);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const propsRef = useRef({ bakeEnabled, comparisonMode, shadows, reflections, ambient, ambientColor, lights, selectedLightId, transformMode, onSelectLight, onUpdateLight });
  propsRef.current = { bakeEnabled, comparisonMode, shadows, reflections, ambient, ambientColor, lights, selectedLightId, transformMode, onSelectLight, onUpdateLight };

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    setLoadState("loading");
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x111518);
    const hemisphere = new THREE.HemisphereLight(0xe8f2ff, 0x36404a, 2);
    const keyLight = new THREE.DirectionalLight(0xffffff, 2.2);
    keyLight.position.set(5, 10, 7);
    scene.add(hemisphere, keyLight, keyLight.target);
    const camera = new THREE.PerspectiveCamera(48, 1, 0.01, 100_000);
    camera.position.set(5, 4, 5);
    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "high-performance" });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.9;
    container.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    const transform = new TransformControls(camera, renderer.domElement);
    transform.setMode("translate");
    scene.add(transform.getHelper());
    const ambientLight = new THREE.AmbientLight(0xffffff, 0);
    scene.add(ambientLight);
    const runtime: OptimizerPreviewRuntime = {
      scene,
      renderer,
      camera,
      controls,
      transform,
      defaultLights: [hemisphere, keyLight],
      ambient: ambientLight,
      lights: new Map(),
      center: new THREE.Vector3(),
      radius: 5,
    };
    runtimeRef.current = runtime;
    transform.addEventListener("dragging-changed", (event) => {
      controls.enabled = !event.value;
    });
    transform.addEventListener("objectChange", () => updateDraggedBakeLight(runtime));
    transform.addEventListener("mouseUp", () => commitDraggedBakeLight(runtime, propsRef.current.onUpdateLight));
    const grid = new THREE.GridHelper(30, 30, 0x394249, 0x252c31);
    scene.add(grid);
    const dracoLoader = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    const loader = new GLTFLoader().setDRACOLoader(dracoLoader);
    let model: THREE.Object3D | undefined;
    let modelScenes: THREE.Object3D[] = [];
    let frame = 0;
    let disposed = false;
    void loader
      .loadAsync(url)
      .then((gltf) => {
        if (disposed) { disposeOptimizerPreview(gltf.scenes); return; }
        modelScenes = gltf.scenes;
        model = gltf.scene;
        runtime.model = model;
        scene.add(model);
        const box = new THREE.Box3().setFromObject(model);
        const center = box.getCenter(new THREE.Vector3());
        const size = Math.max(box.getSize(new THREE.Vector3()).length(), 1);
        runtime.modelBounds = box.clone();
        runtime.center.copy(center);
        runtime.radius = Math.max(size * 0.5, 1);
        frameOptimizerCamera(runtime);
        syncOptimizerPreviewLights(runtime, propsRef.current);
        setLoadState("ready");
      })
      .catch(() => {
        if (!disposed) setLoadState("error");
      });
    const raycaster = new THREE.Raycaster();
    const pointer = new THREE.Vector2();
    const selectLight = (event: PointerEvent) => {
      if (transform.dragging || transform.axis) return;
      const rect = renderer.domElement.getBoundingClientRect();
      pointer.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(pointer, camera);
      const roots = [...runtime.lights.values()].map((entry) => entry.proxy);
      let object: THREE.Object3D | null | undefined = raycaster.intersectObjects(roots, true)[0]?.object;
      while (object && !object.userData.bakeLightId) object = object.parent;
      if (object?.userData.bakeLightId) propsRef.current.onSelectLight(String(object.userData.bakeLightId));
    };
    renderer.domElement.addEventListener("pointerdown", selectLight);
    const resize = new ResizeObserver(() => {
      const width = Math.max(container.clientWidth, 1);
      const height = Math.max(container.clientHeight, 1);
      renderer.setSize(width, height);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    });
    resize.observe(container);
    const animate = () => {
      frame = requestAnimationFrame(animate);
      controls.update();
      renderer.render(scene, camera);
    };
    animate();
    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      controls.dispose();
      transform.dispose();
      dracoLoader.dispose();
      renderer.domElement.removeEventListener("pointerdown", selectLight);
      clearOptimizerPreviewLights(runtime);
      runtime.environment?.dispose();
      disposeOptimizerPreview([...modelScenes, grid]);
      keyLight.shadow.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      if (runtimeRef.current === runtime) runtimeRef.current = undefined;
    };
  }, [url]);

  useEffect(() => {
    const runtime = runtimeRef.current;
    if (runtime) syncOptimizerPreviewLights(runtime, { bakeEnabled, comparisonMode, shadows, reflections, ambient, ambientColor, lights, selectedLightId, transformMode });
  }, [ambient, ambientColor, bakeEnabled, comparisonMode, lights, reflections, selectedLightId, shadows, transformMode]);

  return (
    <div className="optimizer-canvas" ref={containerRef}>
      <OptimizerPreviewActions key={url} locale={locale} ready={loadState === "ready"}
        onFit={() => {
          const runtime = runtimeRef.current;
          if (runtime) frameOptimizerCamera(runtime);
        }}
        onCapture={() => {
          const runtime = runtimeRef.current;
          if (!runtime?.model) return Promise.reject(new Error("模型尚未载入"));
          const helpers = [...runtime.scene.children.filter(object => object instanceof THREE.GridHelper), runtime.transform.getHelper(), ...[...runtime.lights.values()].map(light => light.proxy)];
          return captureModelThumbnail(runtime.renderer, runtime.scene, runtime.camera, helpers);
        }} />
      {loadState !== "ready" && (
        <div className={`optimizer-preview-state ${loadState}`}>
          <LoaderCircle className={loadState === "loading" ? "spin" : ""} size={18} />
          {loadState === "loading" ? "正在载入预览" : "预览载入失败，请检查导出的 GLB"}
        </div>
      )}
    </div>
  );
}

function syncOptimizerPreviewLights(
  runtime: OptimizerPreviewRuntime,
  props: Pick<OptimizerPreviewProps, "bakeEnabled" | "comparisonMode" | "shadows" | "reflections" | "ambient" | "ambientColor" | "lights" | "selectedLightId" | "transformMode">,
): void {
  runtime.transform.detach();
  clearOptimizerPreviewLights(runtime);
  syncOptimizerPreviewEffects(runtime, props.shadows, props.reflections);
  const useNeutralComparisonRig = props.comparisonMode;
  const useDefaultRig = useNeutralComparisonRig || !props.bakeEnabled;
  for (let index = 0; index < runtime.defaultLights.length; index += 1) {
    const light = runtime.defaultLights[index]!;
    light.visible = useDefaultRig;
    light.intensity = useNeutralComparisonRig ? (index === 0 ? 1.7 : 1.55) : index === 0 ? 2 : 2.2;
    light.castShadow = props.shadows && light instanceof THREE.DirectionalLight;
    if (light instanceof THREE.DirectionalLight) configureDirectionalShadow(light, runtime);
  }
  runtime.ambient.visible = props.bakeEnabled && !useNeutralComparisonRig;
  runtime.ambient.intensity = props.ambient * 2.2;
  runtime.ambient.color.set(props.ambientColor);
  if (!props.bakeEnabled || useNeutralComparisonRig) return;
  for (const state of props.lights) {
    const color = new THREE.Color(state.color);
    let light: THREE.Light;
    const proxyPosition = new THREE.Vector3();
    if (state.type === "point") {
      light = new THREE.PointLight(color, state.intensity * 2.2, Math.max(0.1, state.range), 2);
      proxyPosition.fromArray(state.position);
    } else {
      const directional = new THREE.DirectionalLight(color, state.intensity * 2.2);
      const direction = new THREE.Vector3().fromArray(state.direction).normalize();
      proxyPosition.copy(runtime.center).addScaledVector(direction, runtime.radius * 1.25);
      directional.target.position.copy(runtime.center);
      runtime.scene.add(directional.target);
      light = directional;
    }
    light.position.copy(proxyPosition);
    light.visible = state.enabled;
    light.castShadow = props.shadows && state.enabled;
    if (light instanceof THREE.DirectionalLight) configureDirectionalShadow(light, runtime);
    if (light instanceof THREE.PointLight) configurePointShadow(light, runtime);
    runtime.scene.add(light);
    const proxy = createBakeLightProxy(state, proxyPosition, runtime.radius);
    if (state.type === "directional") orientDirectionalProxy(proxy, new THREE.Vector3().fromArray(state.direction));
    proxy.visible = state.enabled;
    runtime.scene.add(proxy);
    runtime.lights.set(state.id, { state, light, proxy });
  }
  const selected = props.selectedLightId ? runtime.lights.get(props.selectedLightId) : undefined;
  if (selected?.state.enabled) {
    runtime.transform.setMode(selected.state.type === "directional" ? props.transformMode : "translate");
    runtime.transform.attach(selected.proxy);
  }
}

function syncOptimizerPreviewEffects(runtime: OptimizerPreviewRuntime, shadows: boolean, reflections: boolean): void {
  runtime.renderer.shadowMap.enabled = shadows;
  runtime.renderer.shadowMap.type = THREE.PCFShadowMap;
  if (reflections && !runtime.environment) {
    const pmrem = new THREE.PMREMGenerator(runtime.renderer);
    const room = new RoomEnvironment();
    runtime.environment = pmrem.fromScene(room, 0.04);
    room.dispose();
    pmrem.dispose();
  }
  runtime.scene.environment = reflections ? (runtime.environment?.texture ?? null) : null;
  runtime.scene.environmentIntensity = reflections ? 0.65 : 1;
  runtime.model?.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    object.castShadow = shadows;
    object.receiveShadow = shadows;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) material.needsUpdate = true;
  });
}

function configureDirectionalShadow(light: THREE.DirectionalLight, runtime: OptimizerPreviewRuntime): void {
  const extent = Math.max(runtime.radius * 1.15, 1);
  light.target.position.copy(runtime.center);
  if (runtime.defaultLights.includes(light)) light.position.copy(runtime.center).add(new THREE.Vector3(0.45, 0.85, 0.55).normalize().multiplyScalar(runtime.radius * 2));
  light.shadow.mapSize.set(1024, 1024);
  light.shadow.camera.left = -extent;
  light.shadow.camera.right = extent;
  light.shadow.camera.top = extent;
  light.shadow.camera.bottom = -extent;
  light.shadow.camera.near = Math.max(runtime.radius * 0.02, 0.01);
  light.shadow.camera.far = Math.max(runtime.radius * 5, 10);
  light.shadow.bias = -0.0001;
  light.shadow.normalBias = Math.max(runtime.radius * 0.00015, 0.0001);
  light.shadow.camera.updateProjectionMatrix();
}

function configurePointShadow(light: THREE.PointLight, runtime: OptimizerPreviewRuntime): void {
  light.shadow.mapSize.set(512, 512);
  light.shadow.camera.near = Math.max(runtime.radius * 0.01, 0.01);
  light.shadow.camera.far = Math.max(light.distance, runtime.radius * 3, 10);
  light.shadow.bias = -0.0001;
  light.shadow.normalBias = Math.max(runtime.radius * 0.00015, 0.0001);
}

function createBakeLightProxy(state: BakeLightState, position: THREE.Vector3, radius: number): THREE.Group {
  const proxy = new THREE.Group();
  proxy.name = `bake-light-proxy:${state.id}`;
  proxy.position.copy(position);
  proxy.userData.bakeLightId = state.id;
  const scale = THREE.MathUtils.clamp(radius * 0.045, 0.18, 1.2);
  const body =
    state.type === "point"
      ? new THREE.Mesh(new THREE.SphereGeometry(scale, 18, 12), new THREE.MeshBasicMaterial({ color: state.color, depthTest: false }))
      : new THREE.Mesh(new THREE.ConeGeometry(scale * 0.72, scale * 1.6, 18), new THREE.MeshBasicMaterial({ color: state.color, depthTest: false }));
  const ring = new THREE.Mesh(new THREE.TorusGeometry(scale * 1.35, scale * 0.09, 6, 30), new THREE.MeshBasicMaterial({ color: 0xd4a84f, wireframe: true, depthTest: false }));
  body.renderOrder = ring.renderOrder = 1000;
  proxy.add(body, ring);
  proxy.traverse((object) => {
    object.userData.bakeLightId = state.id;
  });
  return proxy;
}

function updateDraggedBakeLight(runtime: OptimizerPreviewRuntime): void {
  const proxy = runtime.transform.object;
  const id = proxy?.userData.bakeLightId as string | undefined;
  const entry = id ? runtime.lights.get(id) : undefined;
  if (!entry || !proxy) return;
  if (entry.light instanceof THREE.DirectionalLight && runtime.transform.getMode() === "rotate") {
    const direction = directionFromProxy(proxy);
    entry.light.position.copy(runtime.center).addScaledVector(direction, runtime.radius * 1.25);
  } else {
    entry.light.position.copy(proxy.position);
  }
  if (entry.light instanceof THREE.DirectionalLight) entry.light.target.position.copy(runtime.center);
}

function commitDraggedBakeLight(runtime: OptimizerPreviewRuntime, onUpdateLight: (id: string, patch: Partial<BakeLightState>) => void): void {
  const proxy = runtime.transform.object;
  const id = proxy?.userData.bakeLightId as string | undefined;
  const entry = id ? runtime.lights.get(id) : undefined;
  if (!entry || !proxy) return;
  if (entry.state.type === "point") onUpdateLight(id!, { position: proxy.position.toArray() as [number, number, number] });
  else {
    const direction = runtime.transform.getMode() === "rotate" ? directionFromProxy(proxy) : proxy.position.clone().sub(runtime.center).normalize();
    onUpdateLight(id!, { direction: direction.toArray() as [number, number, number] });
  }
}

const PROXY_FORWARD = new THREE.Vector3(0, 1, 0);

function orientDirectionalProxy(proxy: THREE.Object3D, direction: THREE.Vector3): void {
  proxy.quaternion.setFromUnitVectors(PROXY_FORWARD, direction.normalize());
}

function directionFromProxy(proxy: THREE.Object3D): THREE.Vector3 {
  return PROXY_FORWARD.clone().applyQuaternion(proxy.quaternion).normalize();
}

function clearOptimizerPreviewLights(runtime: OptimizerPreviewRuntime): void {
  for (const entry of runtime.lights.values()) {
    if (entry.light instanceof THREE.DirectionalLight) entry.light.target.removeFromParent();
    entry.light.removeFromParent();
    if (entry.light instanceof THREE.DirectionalLight || entry.light instanceof THREE.PointLight) entry.light.shadow.dispose();
    entry.proxy.removeFromParent();
    disposeOptimizerPreview([entry.proxy]);
  }
  runtime.lights.clear();
}

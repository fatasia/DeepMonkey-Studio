import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { CompatibleGLTFLoader as GLTFLoader } from "../viewer/CompatibleGLTFLoader";
import { configureGltfKtx2, disposeGltfKtx2 } from "../viewer/gltfKtx2Support";
import { RGBELoader } from "three/examples/jsm/loaders/RGBELoader.js";
import { EXRLoader } from "three/examples/jsm/loaders/EXRLoader.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { MeshoptDecoder } from "meshoptimizer";
import type { ProjectAssetMapRecord } from "@bim-studio/contracts";
import { api } from "../api";
import { loadViewerAssetBlob } from "../viewer/viewerAssetTransport";
import { fitPerspectiveBox } from "../viewer/cameraFraming";
import { DEFAULT_CAMERA_CONSTRAINTS } from "../viewer/viewerEngineTypes";

export interface ResourcePreviewDefinition { kind: "model" | "environment" | "pbr-material"; url: string; maps?: ProjectAssetMapRecord[] }

/** 认证只随平台贴图请求发送；GLB 内引用的第三方图片不会继承平台令牌。 */
async function readPreviewFile(url: string, signal: AbortSignal) {
  return url.startsWith("/api/asset-library/") ? api.getLibraryPreviewBlob(url, signal) : loadViewerAssetBlob(url, "资源", { signal });
}

export function createResourcePreview(host: HTMLElement, definition: ResourcePreviewDefinition, onStatus: (error?: string) => void, onCapture?: (capture: (() => Promise<Blob>) | undefined) => void) {
  const abort = new AbortController();
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(42, 1, .01, 1000);
  camera.position.set(3, 2, 3);
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  host.append(renderer.domElement);
  const controls = new OrbitControls(camera, renderer.domElement);
  const resources: Array<{ dispose(): void }> = [];
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, .04);
  scene.environment = environment.texture;
  resources.push(room, environment, pmrem);
  scene.add(new THREE.HemisphereLight("white", "slategray", 1.5));
  const key = new THREE.DirectionalLight("white", 3); key.position.set(3, 5, 4); scene.add(key);
  const rim = new THREE.DirectionalLight("white", 1); rim.position.set(-3, 2, -2); scene.add(rim);
  let disposed = false;
  const render = () => { if (!disposed) renderer.render(scene, camera); };
  controls.addEventListener("change", render);
  const resize = new ResizeObserver(() => {
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
    camera.aspect = Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1);
    camera.updateProjectionMatrix(); render();
  });
  resize.observe(host);
  const onContextLost = (event: Event) => { event.preventDefault(); onStatus("预览渲染器已中断，请重试"); };
  renderer.domElement.addEventListener("webglcontextlost", onContextLost);

  async function texture(map: { url: string; name: string; mimeType?: string }, color = false) {
    const blob = await readPreviewFile(map.url, abort.signal);
    const objectUrl = URL.createObjectURL(blob);
    try {
      const format = map.name.toLowerCase();
      const loaded = format.endsWith(".hdr") ? await new RGBELoader().loadAsync(objectUrl)
        : format.endsWith(".exr") ? await new EXRLoader().loadAsync(objectUrl) : await new THREE.TextureLoader().loadAsync(objectUrl);
      if (disposed) { loaded.dispose(); throw new DOMException("预览已关闭", "AbortError"); }
      resources.push(loaded);
      if (color && !format.endsWith(".hdr") && !format.endsWith(".exr")) loaded.colorSpace = THREE.SRGBColorSpace;
      return loaded;
    } finally { URL.revokeObjectURL(objectUrl); }
  }
  async function load() {
    let object: THREE.Object3D;
    if (definition.kind === "model") {
      const binary = await (await readPreviewFile(definition.url, abort.signal)).arrayBuffer();
      const draco = new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
      resources.push(draco);
      const loader = new GLTFLoader().setDRACOLoader(draco).setMeshoptDecoder(MeshoptDecoder);
      configureGltfKtx2(loader, renderer); resources.push({ dispose: () => disposeGltfKtx2(loader) });
      const gltf = await loader.parseAsync(binary, "");
      object = gltf.scene;
      object.traverse(node => {
        if (!(node instanceof THREE.Mesh)) return;
        resources.push(node.geometry);
        for (const material of Array.isArray(node.material) ? node.material : [node.material]) {
          resources.push(material);
          for (const value of Object.values(material)) if (value instanceof THREE.Texture) resources.push(value);
        }
      });
    } else {
      const material = new THREE.MeshStandardMaterial({ color: "white", metalness: definition.kind === "environment" ? .85 : 0, roughness: .35 });
      const geometry = new THREE.SphereGeometry(1, 64, 40);
      resources.push(material, geometry); object = new THREE.Mesh(geometry, material);
      if (definition.kind === "environment") {
        const source = definition.maps?.find(map => map.kind === "environment") ?? { url: definition.url, name: definition.url.split("/").at(-1) ?? "" };
        const environmentMap = await texture(source, true);
        environmentMap.mapping = THREE.EquirectangularReflectionMapping;
        scene.environment = environmentMap; scene.background = environmentMap; scene.backgroundBlurriness = .04;
      } else {
        for (const map of definition.maps ?? []) {
          const loaded = await texture(map, map.kind === "base-color");
          if (map.kind === "base-color") material.map = loaded;
          else if (map.kind === "normal") material.normalMap = loaded;
          else if (map.kind === "roughness") { material.roughnessMap = loaded; material.roughness = 1; }
          else if (map.kind === "metalness") { material.metalnessMap = loaded; material.metalness = 1; }
          else if (map.kind === "ao") material.aoMap = loaded;
        }
        material.needsUpdate = true;
      }
    }
    if (disposed) { for (const resource of resources) resource.dispose(); return; }
    scene.add(object);
    const box = new THREE.Box3().setFromObject(object);
    if (box.isEmpty()) throw new Error("资源没有可浏览的几何体");
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, .01);
    // 按可视容器的横纵比例和八角点取景，细长小零件也应占据有效画幅。
    renderer.setSize(Math.max(host.clientWidth, 1), Math.max(host.clientHeight, 1), false);
    camera.aspect = Math.max(host.clientWidth, 1) / Math.max(host.clientHeight, 1);
    const direction = new THREE.Vector3(1, .65, 1).normalize();
    const framing = fitPerspectiveBox(box, camera, DEFAULT_CAMERA_CONSTRAINTS, direction);
    controls.target.copy(center);
    camera.position.copy(center).add(direction.multiplyScalar(framing?.distance ?? radius * 3.4));
    camera.near = radius / 1000; camera.far = radius * 100; camera.updateProjectionMatrix();
    controls.update(); render(); onStatus();
    onCapture?.(async () => {
      if (disposed) throw new Error("预览已关闭");
      const { captureThumbnailSource } = await import("./thumbnailCrop");
      render(); return captureThumbnailSource(renderer.domElement);
    });
  }
  void load().catch(error => { if (!disposed) onStatus(error instanceof Error ? error.message : String(error)); });
  return () => {
    disposed = true; onCapture?.(undefined); abort.abort(); resize.disconnect(); controls.dispose();
    renderer.domElement.removeEventListener("webglcontextlost", onContextLost);
    for (const resource of resources) resource.dispose();
    renderer.dispose(); renderer.forceContextLoss(); renderer.domElement.remove();
  };
}

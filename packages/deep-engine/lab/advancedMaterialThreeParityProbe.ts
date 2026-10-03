/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";
import { projectThreeWorldLights } from "../src/threeBridge/threeWorldLights.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { installThreeMaterialMath } from "../../../apps/web/src/viewer/threeMaterialMath.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { applyPhysicalLobes } from "../../../apps/web/src/viewer/materialPhysicalLobes.js";
type SceneMaterialState = Parameters<typeof applyPhysicalLobes>[1];
import { threeDirectMaterialProfile } from "../src/threeBridge/threeDirectMaterialProfile.js";
import { bounded, readSharedDeepFrame } from "./c8SharedSceneReadback.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";

/**
 * three r185 ↔ Deep 真 GPU 对拍(直射光,无环境):同一 MeshPhysicalMaterial 球经真实 three WebGLRenderer 与
 * 生产 DeepWebGpuBackend(ThreeProjectionBridge advancedMaterials 能力)渲染,比较线性 HDR。
 * 逐特性比较"特性增量"((feature − stock) 在两端的一致性),抵消两端 stock BRDF 的既有差异。
 */

const WIDTH = 320, HEIGHT = 192;
const BASE = { color: new THREE.Color(0.45, 0.2, 0.12), roughness: 0.5, metalness: 0 };
/** state 用例:经编辑器路径(SceneMaterialState → JSON 往返 → applyPhysicalLobes)写入 three 材质,验证编辑器存档与两端外观一致。 */
export const PARITY_CASES: ReadonlyArray<{ readonly id: string; readonly parameters: THREE.MeshPhysicalMaterialParameters; readonly state?: SceneMaterialState }> = [
  { id: "editor-sheen", parameters: {}, state: { sheen: 0.8, sheenColor: "#b3b3ff", sheenRoughness: 0.6 } },
  { id: "editor-iridescence", parameters: {}, state: { iridescence: 1, iridescenceIOR: 1.5, iridescenceThicknessMax: 320 } },
  { id: "editor-clearcoat", parameters: {}, state: { clearcoat: 0.9, clearcoatRoughness: 0.15 } },
  { id: "editor-combined", parameters: {}, state: { clearcoat: 0.6, clearcoatRoughness: 0.2, sheen: 0.7, sheenColor: "#ffd9a8", sheenRoughness: 0.5,
    iridescence: 0.6, iridescenceIOR: 1.4, iridescenceThicknessMax: 380 } },
  { id: "stock", parameters: {} },
  { id: "sheen", parameters: { sheen: 1, sheenColor: new THREE.Color(0.9, 0.6, 0.3), sheenRoughness: 0.4 } },
  { id: "iridescence", parameters: { iridescence: 1, iridescenceIOR: 1.3, iridescenceThicknessRange: [100, 400] } },
  { id: "iridescence-metal", parameters: { iridescence: 1, iridescenceIOR: 1.5, iridescenceThicknessRange: [100, 320], metalness: 1, roughness: 0.3 } },
  { id: "clearcoat", parameters: { clearcoat: 1, clearcoatRoughness: 0.3 } },
  { id: "combined", parameters: { sheen: 0.8, sheenColor: new THREE.Color(0.7, 0.7, 1), sheenRoughness: 0.6, iridescence: 0.7, iridescenceIOR: 1.4,
    iridescenceThicknessRange: [100, 380], clearcoat: 0.6, clearcoatRoughness: 0.2 } },
];

function projection(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  }, capabilities: { advancedMaterials: true } });
}

export async function runPhysicalParity() {
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const geometry = new THREE.SphereGeometry(1.7, 96, 64), material = new THREE.MeshPhysicalMaterial({ ...BASE });
  const mesh = new THREE.Mesh(geometry, material); root.add(mesh);
  const light = new THREE.DirectionalLight(new THREE.Color(1, 0.95, 0.9), 3);
  light.position.set(-3, 4, 5); light.castShadow = false;
  scene.add(light, light.target);
  const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 100);
  camera.position.set(0, 0, 6); camera.lookAt(0, 0, 0); camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  const lights = projectThreeWorldLights(scene, { cameraLayerMask: 1 });
  if (!lights.ok) throw Error(JSON.stringify(lights.issues));
  const view: RenderView = { eye: [0, 0, 6], target: [0, 0, 0], up: [0, 1, 0], extent: 4, background: [0, 0, 0], floor: [0, 0, 0],
    width: WIDTH, height: HEIGHT, pixelRatio: 1, exposure: 1, roughness: 0.5, environmentIntensity: 0, fog: null,
    verticalFovRadians: Math.PI / 4, near: 0.1, far: 100, lights: lights.lights,
    authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0 } } };
  const canvas = document.createElement("canvas"); canvas.width = WIDTH; canvas.height = HEIGHT;
  const errors: string[] = [], lifetime = new AbortController();
  let backend: DeepWebGpuBackend | undefined, renderer: THREE.WebGLRenderer | undefined, target: THREE.WebGLRenderTarget | undefined;
  const results: Array<{ id: string; three: number[]; deep: number[] }> = [];
  try {
    installThreeMaterialMath(); installThreeDisplayToneMapping();
    const chunks = threeDirectMaterialProfile(THREE.ShaderChunk, "three-r185");
    THREE.ShaderChunk.lights_physical_pars_fragment = chunks.lights_physical_pars_fragment;
    THREE.ShaderChunk.lights_physical_fragment = chunks.lights_physical_fragment;
    renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
    renderer.setSize(WIDTH, HEIGHT, false); renderer.setPixelRatio(1); renderer.setClearColor(0);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
    target = new THREE.WebGLRenderTarget(WIDTH, HEIGHT, { type: THREE.FloatType });
    backend = await bounded(DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu, projection: projection(), root, view, signal: lifetime.signal,
      renderer: { advancedMaterials: true, shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
        frameCapture: { session: new FrameCaptureSession(), readbacks: { requests: [{ resourceId: "present-color" }] } },
        features: { toneMapping: "three-aces-r185", environment: false, groundPlane: false, groundGrid: false, fog: false, ambientOcclusion: false,
          temporalAa: false, spatialAa: false, occlusionCulling: false, bloom: false, vignette: false, contactShadows: false } } }));
    if (!(backend.runtime instanceof PbrRenderer)) throw Error("Expected the production PbrRenderer.");
    const runtime = backend.runtime;
    for (const testCase of PARITY_CASES) {
      material.setValues({ color: BASE.color.clone(), roughness: BASE.roughness, metalness: BASE.metalness, sheen: 0, sheenColor: new THREE.Color(0, 0, 0),
        sheenRoughness: 1, iridescence: 0, iridescenceIOR: 1.3, iridescenceThicknessRange: [100, 400], clearcoat: 0, clearcoatRoughness: 0 });
      material.setValues(testCase.parameters);
      if (testCase.state) applyPhysicalLobes(material, JSON.parse(JSON.stringify(testCase.state)) as SceneMaterialState);
      material.needsUpdate = true; scene.updateMatrixWorld(true);
      const publication = await bounded(backend.sync(root, 1, lifetime.signal, view));
      if (publication.status !== "committed") throw Error(`Deep publication failed for ${testCase.id}: ${JSON.stringify(publication)}`);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const floats = new Float32Array(WIDTH * HEIGHT * 4);
      renderer.readRenderTargetPixels(target, 0, 0, WIDTH, HEIGHT, floats);
      const three: number[] = new Array(WIDTH * HEIGHT * 3);
      for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) for (let c = 0; c < 3; c++) {
        three[(y * WIDTH + x) * 3 + c] = floats[((HEIGHT - 1 - y) * WIDTH + x) * 4 + c]!;
      }
      if (!backend.render(view)) throw Error("Deep produced no frame.");
      results.push({ id: testCase.id, three, deep: (await readSharedDeepFrame(runtime, WIDTH, HEIGHT)).hdr });
    }
    if (errors.length) throw Error(errors.join("\n"));
    return { width: WIDTH, height: HEIGHT, results };
  } finally {
    lifetime.abort(); backend?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); target?.dispose(); geometry.dispose(); material.dispose();
  }
}
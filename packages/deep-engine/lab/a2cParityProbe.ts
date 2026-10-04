/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";
import { projectThreeWorldLights } from "../src/threeBridge/threeWorldLights.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { installThreeMaterialMath } from "../../../apps/web/src/viewer/threeMaterialMath.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { threeDirectMaterialProfile } from "../src/threeBridge/threeDirectMaterialProfile.js";
import { bounded, readSharedDeepFrame } from "./c8SharedSceneReadback.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";

/**
 * AA-M2 alpha-to-coverage 双端真机 parity 探针(three r185 ↔ Deep):
 * 同一 MeshStandardMaterial(alpha 贴图 + alphaTest=0 + alphaToCoverage=true)分别经
 * three WebGLRenderer(MSAA 默认帧缓冲 + GL_SAMPLE_ALPHA_TO_COVERAGE)与生产
 * DeepWebGpuBackend(ThreeProjectionBridge alphaToCoverage 能力 + MSAA4 主 pass
 * a2c 管线变体)渲染,采集两端 sRGB 显示帧 PNG 与 RMSE 证据。
 * 采集语义:两端硬件 a2c dither 矩阵未规范,本探针交付证据(截图+差异度量),
 * 不设硬门;阈值由主线程在 SMAA 路合并终表时随 parityGateThresholds 体系裁定。
 */

const WIDTH = 512, HEIGHT = 384;

/**
 * 程序化 alpha 贴图(投影桥只接受 DataTexture 的 RGBA8 存储):竖栅栏 + 45° 斜条 +
 * 同心圆弧,前景不透明、背景透明,边缘 2px 线性 alpha 渐变(CPU 光栅化,双端同一张)。
 */
function alphaPatternTexture(): THREE.Texture {
  const size = 256, data = new Uint8Array(size * size * 4);
  const ramp = (distance: number, solid: number, feather: number): number =>
    Math.round(255 * Math.min(1, Math.max(0, 1 - (distance - solid) / feather)));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const offset = (y * size + x) * 4;
    // 竖栅栏:周期 32px,杆宽 7px,两侧 2px 渐变。
    const rail = Math.abs(((x % 32) + 32) % 32 - 16);
    let alpha = rail <= 10.5 ? 255 : ramp(rail, 10.5, 2);
    // 45° 斜条:周期 36px,实宽 5px,两侧 2px 渐变。
    const diagonal = Math.abs((((x + y) * Math.SQRT1_2) % 36 + 36) % 36 - 18);
    alpha = Math.max(alpha, diagonal <= 8.5 ? 255 : ramp(diagonal, 8.5, 2));
    // 同心圆弧:环距 28px,线宽 4px,两侧 2px 渐变。
    const ring = Math.abs(Math.hypot(x - 128, y - 128) % 28);
    const ringDistance = Math.min(ring, 28 - ring);
    alpha = Math.max(alpha, ringDistance <= 5 ? 255 : ramp(ringDistance, 5, 2));
    data[offset] = 217; data[offset + 1] = 217; data[offset + 2] = 230; data[offset + 3] = alpha;
  }
  const texture = new THREE.DataTexture(data, size, size);
  texture.needsUpdate = true;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.ClampToEdgeWrapping; texture.wrapT = THREE.ClampToEdgeWrapping;
  return texture;
}

function projection(): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  }, capabilities: { alphaToCoverage: true } });
}

export async function runA2cParity() {
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const geometry = new THREE.PlaneGeometry(4, 3);
  const material = new THREE.MeshStandardMaterial({ map: alphaPatternTexture(), transparent: false,
    alphaTest: 0.4, alphaToCoverage: true, side: THREE.FrontSide, depthWrite: true,
    color: new THREE.Color(0.85, 0.85, 0.9), metalness: 0, roughness: 0.85 });
  const mesh = new THREE.Mesh(geometry, material); root.add(mesh);
  const light = new THREE.DirectionalLight(new THREE.Color(1, 0.97, 0.92), 2.6);
  light.position.set(2, 3, 6); light.castShadow = false;
  scene.add(light, light.target);
  const camera = new THREE.PerspectiveCamera(40, WIDTH / HEIGHT, 0.1, 50);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true); scene.updateMatrixWorld(true);
  const lights = projectThreeWorldLights(scene, { cameraLayerMask: 1 });
  if (!lights.ok) throw Error(JSON.stringify(lights.issues));
  const view: RenderView = { eye: [0, 0, 5], target: [0, 0, 0], up: [0, 1, 0], extent: 2.6,
    background: [0.04, 0.05, 0.06], floor: [0, 0, 0], width: WIDTH, height: HEIGHT, pixelRatio: 1,
    exposure: 1, roughness: 0.5, environmentIntensity: 0, fog: null, verticalFovRadians: 40 * Math.PI / 180,
    near: 0.1, far: 50, lights: lights.lights,
    authorColorEffects: { colorGrading: { hue: 0, saturation: 0, brightness: 0, contrast: 0 } } };
  const canvas = document.createElement("canvas"); canvas.width = WIDTH; canvas.height = HEIGHT;
  const errors: string[] = [], lifetime = new AbortController();
  let backend: DeepWebGpuBackend | undefined, renderer: THREE.WebGLRenderer | undefined;
  try {
    installThreeMaterialMath(); installThreeDisplayToneMapping();
    const chunks = threeDirectMaterialProfile(THREE.ShaderChunk, "three-r185");
    THREE.ShaderChunk.lights_physical_pars_fragment = chunks.lights_physical_pars_fragment;
    THREE.ShaderChunk.lights_physical_fragment = chunks.lights_physical_fragment;
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(WIDTH, HEIGHT, false); renderer.setPixelRatio(1); renderer.setClearColor(0x0a0d10);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
    backend = await bounded(DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu, projection: projection(), root, view,
      signal: lifetime.signal,
      renderer: { msaaSampleCount: 4,
        // deformation:true 仅用于把主 pass 切进 MRT+MSAA4 路径(静态网格无变形数据,
        // 视觉等价);直出 display 路径渲染进 1x swapchain,物理上不支持 a2c
        // (packetDraw 回退普通管线),不是本探针对象。
        deformation: true,
        shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
        frameCapture: { session: new FrameCaptureSession(), readbacks: { requests: [{ resourceId: "present-color" }] } },
        features: { toneMapping: "three-aces-r185", environment: false, groundPlane: false, groundGrid: false, fog: false,
          ambientOcclusion: false, temporalAa: false, spatialAa: false, occlusionCulling: false, bloom: false,
          vignette: false, contactShadows: false } } }));
    if (!(backend.runtime instanceof PbrRenderer)) throw Error("Expected the production PbrRenderer.");
    const runtime = backend.runtime;
    const publication = await bounded(backend.sync(root, 1, lifetime.signal, view));
    if (publication.status !== "committed") throw Error(`Deep publication failed: ${JSON.stringify(publication)}`);
    // three 侧:antialias 帧缓冲直出(resolve 后的 MSAA 结果,alphaToCoverage 生效)。
    renderer.render(scene, camera);
    const threeDataUrl = renderer.domElement.toDataURL("image/png");
    const threePixels = new Uint8Array(WIDTH * HEIGHT * 4);
    renderer.getContext().readPixels(0, 0, WIDTH, HEIGHT, renderer.getContext().RGBA, renderer.getContext().UNSIGNED_BYTE, threePixels);
    // Deep 侧:MSAA4 主 pass a2c 管线变体渲染,读实际 swapchain 表面。
    const metrics = backend.render(view);
    if (!metrics) throw Error("Deep produced no frame.");
    const deep = await readSharedDeepFrame(runtime, WIDTH, HEIGHT);
    const deepDataUrl = await rgbaToPngDataUrl(new Uint8Array(deep.display), WIDTH, HEIGHT);
    if (errors.length) throw Error(errors.join("\n"));
    // RMSE(sRGB 显示域,翻转 three 的行序后对齐)。
    let squared = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const from = ((HEIGHT - 1 - y) * WIDTH + x) * 4, to = (y * WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) { const delta = threePixels[from + c]! - deep.display[to + c]!; squared += delta * delta; }
    }
    const rmse = Math.sqrt(squared / (WIDTH * HEIGHT * 3));
    // alpha 通道统计:a2c 位(512)生效时 coverage() 直通贴图 α(0/中值/255 三段分布);
    // 未生效时 OPAQUE/MASK 语义输出恒 1.0(全 opaque)。这是 512 位到达 WGSL 的直接证据。
    let transparent = 0, partial = 0, opaque = 0;
    for (let index = 3; index < deep.display.length; index += 4) {
      const value = deep.display[index]!;
      if (value < 16) transparent++; else if (value > 239) opaque++; else partial++;
    }
    return { width: WIDTH, height: HEIGHT, three: threeDataUrl, deep: deepDataUrl,
      rmse, deepMsaa: metrics.msaa ?? null, deepAlpha: { transparent, partial, opaque } };
  } finally {
    lifetime.abort(); backend?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); geometry.dispose(); material.dispose();
  }
}

async function rgbaToPngDataUrl(pixels: Uint8Array, width: number, height: number): Promise<string> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

if (typeof window !== "undefined") {
  (window as unknown as { __A2C_PARITY__: Promise<unknown> }).__A2C_PARITY__ = runA2cParity();
}

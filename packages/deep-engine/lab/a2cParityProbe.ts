/// <reference types="@webgpu/types" />
import * as THREE from "three";
import { DeepWebGpuBackend } from "../src/threeBridge/DeepWebGpuBackend.js";
import { ThreeProjectionBridge } from "../src/threeBridge/ThreeProjectionBridge.js";
import { projectThreeWorldLights } from "../src/threeBridge/threeWorldLights.js";
import { PbrRenderer } from "../src/webgpu/pbrRenderer.js";
import { FrameCaptureSession } from "../src/r12/frameCapture.js";
import { isPbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import type { PbrFrameReadbackSnapshot } from "../src/webgpu/pbrFrameCaptureReadback.js";
import { installThreeMaterialMath } from "../../../apps/web/src/viewer/threeMaterialMath.js";
import { installThreeDisplayToneMapping } from "../../../apps/web/src/viewer/threeDisplayToneMapping.js";
import { threeDirectMaterialProfile } from "../src/threeBridge/threeDirectMaterialProfile.js";
import { bounded } from "./c8SharedSceneReadback.js";
import type { RenderView } from "../src/webgpu/pbrRendererTypes.js";

/**
 * AA-M2 alpha-to-coverage 双端真机 parity 探针(three r185 ↔ Deep),P1 取证版:
 * 同一 MeshStandardMaterial(alpha 贴图 + alphaToCoverage=true)分别经 three WebGLRenderer
 * (MSAA 默认帧缓冲 + GL_SAMPLE_ALPHA_TO_COVERAGE)与生产 DeepWebGpuBackend
 * (ThreeProjectionBridge alphaToCoverage 能力 + MSAA4 主 pass a2c 管线变体)渲染。
 *
 * P1(纯 a2c/OPAQUE 无 alphaTest 在 Deep MSAA4 显示全画实心板)取证设计——三个独立读数
 * 把疑点空间切成互斥象限,每个读数都来自生产链路真实帧:
 * 1. 管线 descriptor(由 a2c-parity.mjs 的 GPUDevice.prototype 钩子抓取,DeviceSession 的
 *    requestDevice 包装不可能剥掉原型补丁):alphaToCoverageEnabled 是否 true、multisample
 *    是否 4、target0 格式 —— 驱动层"收到并接受"的证据。
 * 2. opaque-hdr 读回(主 pass target0 的 MSAA resolve 结果,进入 present 链之前):
 *    alpha 桶分布是 coverage() 512 位到达 WGSL 的直接证据(512 位未置 ⇒ OPAQUE 恒 1.0);
 *    RGB 边缘密度是硬件采样掩码实际生效的证据(a2c 生效 ⇒ 图案处明暗抖动,实心 ⇒ 平坦)。
 *    两者正交:alpha 变化 + RGB 实心 = WGSL 直通生效而驱动未按 alpha 生成掩码。
 * 3. present(swapchain)读回的 alpha 桶分布与 opaque-hdr 对比 —— present 链是否把
 *    alpha 压成 1(判据污染假设的独立验证,不影响 RGB 实心板症状的归因)。
 * 采集语义不变:硬件 a2c dither 矩阵未规范,本探针交付证据与统计,不设硬门。
 */

const WIDTH = 512, HEIGHT = 384;

interface AlphaBuckets { readonly transparent: number; readonly partial: number; readonly opaque: number }

export interface A2cVariantEvidence {
  readonly alphaTest: number;
  /** true=主 pass 走 MRT(writeGeometryBuffers),false=单 HDR 目标。 */
  readonly mrt: boolean;
  readonly three: string;
  readonly deep: string;
  readonly rmse: number;
  readonly deepMsaa: { readonly requested: number; readonly active: number } | null;
  /** present(swapchain)alpha 桶分布 —— present 链之后。 */
  readonly presentAlpha: AlphaBuckets;
  /** opaque-hdr(主 pass target0 resolve)alpha 桶分布 —— present 链之前。 */
  readonly targetAlpha: AlphaBuckets;
  /** 主 pass target0 的实际格式(A2C-P1 A/B 实验的自报字段)。 */
  readonly targetFormat: GPUTextureFormat;
  /** opaque-hdr RGB 图案统计:实心板 ≈ 少色无边,抖动图案 ≈ 多色多边;saturated = HDR 截断量。 */
  readonly targetRgb: { readonly uniqueColors: number; readonly edgePixels: number; readonly saturatedPixels: number };
  /** A2C-P1 运行时有效性探针披露(FrameMetrics.a2cProbe;读回异步结算,第二帧起出现)。
   * maskFallback 臂材质不再请求 a2c ⇒ 探针从不进入测量 ⇒ null 本身即降级生效的证据。 */
  readonly a2cProbe: { readonly frame: number; readonly verdict: string; readonly alphaNonOpaquePixels: number;
    readonly edgePixels: number; readonly edgeDitherThreshold: number; readonly reason?: string } | null;
  readonly verdict: {
    /** coverage() 512 位到达 WGSL 并写进 target0 alpha。 */
    readonly wgslAlphaPassthrough: boolean;
    /** 硬件按 alpha 生成采样掩码(target0 RGB 呈现覆盖抖动)。 */
    readonly hardwareCoverageDither: boolean;
    /** present 链保真了 target 的 alpha 分布(否则 present 判据被污染)。 */
    readonly presentAlphaPreserved: boolean;
  };
}

export interface A2cParityReport {
  readonly width: number;
  readonly height: number;
  /** P1 主对象:纯 a2c(OPAQUE,无 alphaTest),生产同构 MRT 主 pass。 */
  readonly opaque: A2cVariantEvidence;
  /** 对照:MASK(alphaTest=0.4,discard 先于 a2c,上一刀已验证图案正确)。 */
  readonly masked: A2cVariantEvidence;
  /** 判别实验:纯 a2c 但单 HDR 目标(非 MRT)——区分"D3D12 不执行 a2c"与"a2c×MRT 组合触发"。 */
  readonly singleTarget: A2cVariantEvidence;
  /** A2C-P1 降级刀:同一 a2c 材质经 alphaToCoverageMaskFallback 能力投影(→ MASK@0.4)。
   * 预期:图案回到抖动档(masked 同构)、探针不触发(材质无 a2c 请求)、RMSE 显著低于
   * opaque 臂的全画实心板 —— 降级路径真机行为的端到端证据。 */
  readonly fallback: A2cVariantEvidence;
}

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

function projection(maskFallback = false): ThreeProjectionBridge {
  return new ThreeProjectionBridge({ hooks: {
    objectBeforeRender: THREE.Object3D.prototype.onBeforeRender, objectAfterRender: THREE.Object3D.prototype.onAfterRender,
    objectBeforeShadow: THREE.Object3D.prototype.onBeforeShadow, objectAfterShadow: THREE.Object3D.prototype.onAfterShadow,
    materialBeforeRender: THREE.Material.prototype.onBeforeRender, materialBeforeCompile: THREE.Material.prototype.onBeforeCompile,
    materialProgramCacheKey: THREE.Material.prototype.customProgramCacheKey,
  }, capabilities: { alphaToCoverage: !maskFallback,
    ...(maskFallback ? { alphaToCoverageMaskFallback: true } : {}) } });
}

function halfToFloat(bits: number): number {
  const sign = (bits & 0x8000) !== 0 ? -1 : 1, exponent = (bits & 0x7c00) >> 10, fraction = bits & 0x03ff;
  if (exponent === 0) return sign * fraction * 2 ** -24;
  if (exponent === 0x1f) return fraction ? NaN : sign * Infinity;
  return sign * (1 + fraction / 1024) * 2 ** (exponent - 15);
}

function alphaBuckets(channel: (index: number) => number, pixelCount: number): AlphaBuckets {
  let transparent = 0, partial = 0, opaque = 0;
  for (let pixel = 0; pixel < pixelCount; pixel++) {
    const value = channel(pixel) * 255;
    if (value < 16) transparent++; else if (value > 239) opaque++; else partial++;
  }
  return { transparent, partial, opaque };
}

/** 主 pass target0 读回的 RGB 图案统计(按实际读回格式自适应):唯一色数 + 水平边缘像素数
 * + 饱和像素数(任一通道 ≥0.999 —— 8-bit 档 HDR 截断的量化证据;float 档作为对照基线)。 */
function targetRgbStats(pixels: Uint8Array, bytesPerRow: number, width: number, height: number,
  format: GPUTextureFormat) {
  const float16 = format === "rgba16float";
  if (!float16 && format !== "rgba8unorm") throw Error(`Unsupported opaque-hdr readback format ${format}`);
  const stride = float16 ? 8 : 4;
  const colors = new Set<number>();
  let edgePixels = 0, saturatedPixels = 0;
  for (let y = 0; y < height; y++) {
    const row = y * bytesPerRow;
    let previousR = NaN, previousG = NaN, previousB = NaN;
    for (let x = 0; x < width; x++) {
      const offset = row + x * stride;
      // float16:半精度解码;rgba8unorm:字节直读。线性 HDR 显示域粗量化(0..1 截断到
      // 32 阶);目标是区分"平坦"与"抖动图案",不是色彩度量。
      const channel = (bits: number): number => float16
        ? Math.min(255, Math.max(0, Math.round(halfToFloat(bits) * 255)))
        : bits;
      const r = float16 ? channel(pixels[offset]! | (pixels[offset + 1]! << 8)) : pixels[offset]!;
      const g = float16 ? channel(pixels[offset + 2]! | (pixels[offset + 3]! << 8)) : pixels[offset + 1]!;
      const b = float16 ? channel(pixels[offset + 4]! | (pixels[offset + 5]! << 8)) : pixels[offset + 2]!;
      colors.add(((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3));
      if (x > 0 && (Math.abs(r - previousR) > 12 || Math.abs(g - previousG) > 12 || Math.abs(b - previousB) > 12)) edgePixels++;
      if (r >= 254 || g >= 254 || b >= 254) saturatedPixels++;
      previousR = r; previousG = g; previousB = b;
    }
  }
  return { uniqueColors: colors.size, edgePixels, saturatedPixels };
}

async function runVariant(alphaTest: number, mrt: boolean, maskFallback = false): Promise<A2cVariantEvidence> {
  const scene = new THREE.Scene(), root = new THREE.Group(); scene.add(root);
  const geometry = new THREE.PlaneGeometry(4, 3);
  const material = new THREE.MeshStandardMaterial({ map: alphaPatternTexture(), transparent: false,
    alphaTest, alphaToCoverage: true, side: THREE.FrontSide, depthWrite: true,
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
    const chunks = threeDirectMaterialProfile(THREE.ShaderChunk, "three-r185");
    THREE.ShaderChunk.lights_physical_pars_fragment = chunks.lights_physical_pars_fragment;
    THREE.ShaderChunk.lights_physical_fragment = chunks.lights_physical_fragment;
    renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(WIDTH, HEIGHT, false); renderer.setPixelRatio(1); renderer.setClearColor(0x0a0d10);
    renderer.toneMapping = THREE.ACESFilmicToneMapping; renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.debug.onShaderError = (gl, program, vertex, fragment) => errors.push([gl.getProgramInfoLog(program), gl.getShaderInfoLog(vertex), gl.getShaderInfoLog(fragment)].join("\n"));
    backend = await bounded(DeepWebGpuBackend.create({ canvas, gpu: navigator.gpu, projection: projection(maskFallback), root, view,
      signal: lifetime.signal,
      renderer: { msaaSampleCount: 4,
        // mrt:true(生产 Studio 的 SSR/体积雾同构路径)把主 pass 切进 MRT+MSAA4;
        // mrt:false(AO/SSR/体积雾/时域AA/接触阴影全关 + 无变形)得到单 HDR 目标主 pass,
        // 用于判别 a2c 失效是否与 MRT 附件组合绑定。直出 display 路径渲染进 1x swapchain,
        // 物理上不支持 a2c(packetDraw 回退普通管线),不是本探针对象。
        deformation: mrt,
        shadows: { exactProfile: { cascadeCount: 1, shadowMapSize: 128 } },
        frameCapture: { session: new FrameCaptureSession(),
          // present-color:swapchain 表面(present 链之后);opaque-hdr:主 pass target0 的
          // MSAA resolve(present 链之前)。两者的 alpha 差分就是判据污染假设的直接证据。
          readbacks: { requests: [{ resourceId: "present-color" }, { resourceId: "opaque-hdr" }] } },
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
    // Deep 侧:MSAA4 主 pass a2c 管线变体渲染,读 swapchain(present)与 opaque-hdr(主 pass)。
    const metrics = backend.render(view);
    if (!metrics) throw Error("Deep produced no frame.");
    const frames = await readVariantFrames(runtime);
    if (errors.length) throw Error(errors.join("\n"));
    // A2C-P1 降级刀:渲染器一次性探针在读回异步结算后经 FrameMetrics.a2cProbe 披露
    // (滞后 ≥1 帧)。逐帧轮询直到披露出现;maskFallback 臂材质无 a2c 请求 ⇒ 探针
    // 永不触发 ⇒ 轮询以 null 收口(这本身就是降级生效的证据)。
    let a2cProbe: A2cVariantEvidence["a2cProbe"] = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 50));
      const next = backend.render(view);
      if (next?.a2cProbe) { a2cProbe = next.a2cProbe; break; }
    }
    // RMSE(sRGB 显示域,翻转 three 的行序后对齐)。
    let squared = 0;
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const from = ((HEIGHT - 1 - y) * WIDTH + x) * 4, to = (y * WIDTH + x) * 4;
      for (let c = 0; c < 3; c++) { const delta = threePixels[from + c]! - frames.present[to + c]!; squared += delta * delta; }
    }
    const rmse = Math.sqrt(squared / (WIDTH * HEIGHT * 3));
    const presentAlpha = alphaBuckets(pixel => frames.present[pixel * 4 + 3]! / 255, WIDTH * HEIGHT);
    const targetAlpha = alphaBuckets(pixel => frames.hdrAlpha[pixel]!, WIDTH * HEIGHT);
    const targetRgb = targetRgbStats(frames.hdrBytes, frames.hdrBytesPerRow, WIDTH, HEIGHT, frames.hdrFormat);
    // 判据读法:主 pass 面片内部 alpha 出现非 1 ⇒ 512 位到达 WGSL;RGB 边缘密度超过
    // 轮廓量级 ⇒ 硬件按 alpha 生成了采样掩码(抖动覆盖);present 与主 pass 的 alpha
    // 分布同号 ⇒ present 判据未被污染。
    const dithered = targetRgb.edgePixels > 8 * WIDTH;
    const alphaNonOpaque = targetAlpha.partial + targetAlpha.transparent > 0;
    return { alphaTest, mrt, three: threeDataUrl, deep: frames.presentDataUrl, rmse,
      deepMsaa: metrics.msaa ?? null, presentAlpha, targetAlpha, targetFormat: frames.hdrFormat, targetRgb, a2cProbe,
      verdict: { wgslAlphaPassthrough: alphaNonOpaque, hardwareCoverageDither: dithered,
        presentAlphaPreserved: (presentAlpha.partial + presentAlpha.transparent > 0) === alphaNonOpaque } };
  } finally {
    lifetime.abort(); backend?.dispose(); renderer?.dispose(); renderer?.forceContextLoss(); geometry.dispose(); material.dispose();
  }
}

/** 同帧读回 swapchain(present)与 opaque-hdr(主 pass target0 resolve),并解码统计输入。 */
async function readVariantFrames(runtime: PbrRenderer) {
  const pending = runtime.frameReadbackResults;
  if (!pending) throw Error("Formal production HDR frame capture was not scheduled");
  const session = runtime.session, device = session.device;
  const bytesPerRow = Math.ceil(WIDTH * 4 / 256) * 256;
  const buffer = device.createBuffer({ size: bytesPerRow * HEIGHT, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  try {
    const encoder = device.createCommandEncoder(); encoder.copyTextureToBuffer({ texture: session.context.getCurrentTexture() },
      { buffer, bytesPerRow }, { width: WIDTH, height: HEIGHT }); device.queue.submit([encoder.finish()]);
    const [snapshots] = await Promise.all([bounded(pending), bounded(buffer.mapAsync(GPUMapMode.READ))]);
    const hdr = snapshots.find((value): value is PbrFrameReadbackSnapshot =>
      isPbrFrameReadbackSnapshot(value) && value.resourceId === "opaque-hdr"
      && value.width === WIDTH && value.height === HEIGHT
      && (value.format === "rgba16float" || value.format === "rgba8unorm"));
    if (!hdr) throw Error("opaque-hdr main-pass readback missing or wrong extent/format");
    if (session.format !== "bgra8unorm" && session.format !== "rgba8unorm") throw Error(`Unsupported actual surface format ${session.format}`);
    const bytes = new Uint8Array(buffer.getMappedRange()), present = new Uint8Array(WIDTH * HEIGHT * 4);
    for (let y = 0; y < HEIGHT; y++) for (let x = 0; x < WIDTH; x++) {
      const from = y * bytesPerRow + x * 4, to = (y * WIDTH + x) * 4;
      present[to] = bytes[from + (session.format === "bgra8unorm" ? 2 : 0)]!; present[to + 1] = bytes[from + 1]!;
      present[to + 2] = bytes[from + (session.format === "bgra8unorm" ? 0 : 2)]!; present[to + 3] = bytes[from + 3]!;
    }
    const view = new DataView(hdr.bytes.buffer, hdr.bytes.byteOffset, hdr.bytes.byteLength);
    const hdrAlpha = new Float32Array(WIDTH * HEIGHT);
    for (let pixel = 0; pixel < WIDTH * HEIGHT; pixel++) {
      // A2C-P1 A/B:主 pass target0 格式随实验钩子切换,读回按快照实际格式解析
      // (float16 = alpha 半精度第 4 个分量;rgba8unorm = 第 4 字节)。
      hdrAlpha[pixel] = hdr.format === "rgba16float"
        ? halfToFloat(view.getUint16(pixel * 8 + 6, true))
        : hdr.bytes[pixel * 4 + 3]! / 255;
    }
    const presentDataUrl = await rgbaToPngDataUrl(present, WIDTH, HEIGHT);
    return { present, presentDataUrl, hdrBytes: hdr.bytes, hdrBytesPerRow: hdr.bytesPerRow,
      hdrFormat: hdr.format, hdrAlpha };
  } finally { buffer.destroy(); }
}

async function rgbaToPngDataUrl(pixels: Uint8Array, width: number, height: number): Promise<string> {
  const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
  const context = canvas.getContext("2d")!;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return canvas.toDataURL("image/png");
}

async function runA2cParityOnce(): Promise<A2cParityReport> {
  installThreeMaterialMath(); installThreeDisplayToneMapping();
  // P1 主对象在前:纯 a2c(OPAQUE,无 alphaTest,discard 关闭,覆盖抖动是唯一图案来源);
  // MASK(alphaTest=0.4)为上一刀已验证的对照组;singleTarget 为 a2c×MRT 判别实验;
  // fallback(A2C-P1 降级刀)为同一 a2c 材质经 maskFallback 能力投影的降级路径端到端证据。
  const opaque = await runVariant(0, true);
  const masked = await runVariant(0.4, true);
  const singleTarget = await runVariant(0, false);
  const fallback = await runVariant(0, true, true);
  return { width: WIDTH, height: HEIGHT, opaque, masked, singleTarget, fallback };
}

let inFlight: Promise<A2cParityReport> | undefined;

/** 幂等入口:模块导入自启与运行器显式调用共享同一次执行,不并发争抢设备。 */
export function runA2cParity(): Promise<A2cParityReport> {
  return inFlight ??= runA2cParityOnce();
}

if (typeof window !== "undefined") {
  (window as unknown as { __A2C_PARITY__: Promise<unknown> }).__A2C_PARITY__ = runA2cParity();
}

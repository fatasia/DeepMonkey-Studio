import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import type { IndustrialPrefabDefinition } from "@bim-studio/contracts";
import { industrialPrefabPrimitiveVisual } from "../industrialPrefabInstance";
import { CompatibleGLTFLoader } from "../../viewer/CompatibleGLTFLoader";
import { buildIndustrialPrefabThumbnailModel, disposeThumbnailModel } from "./prefabThumbnailModels";
import { THUMB_COLORS, kelvinToColor, thumbnailStyleFor } from "./prefabThumbnailKit";
import type { SceneMode, ThumbnailStyle } from "./prefabThumbnailKit";
import { prefabModelMatchFor, prefabModelPreviewUrl } from "./prefabModelMatches";

/**
 * 工业预制体缩略图共享离屏渲染器(模块级单例)。
 *
 * 设计要点:
 * - 单一 WebGL 上下文 + 串行队列:每帧(rAF 间隙)只处理一个请求,避免资源面板
 *   一次性创建几十个上下文拖垮浏览器;
 * - 真实模型优先:命中 prefabModelMatches 的预制体先走 source-a GLB 加载
 *   (与资源页模型预览同一来源),加载失败/超时(10s)自动回退程序化构建器,
 *   未命中的预制体直接程序化 —— 永不白块;
 * - Box3 包围球自动取景,三档构图(平视 3/4 / 高俯视 / 侧低)按变体轮换,
 *   主体占画面 72~82%(FRAMING 取 1/0.82~1/0.72),禁止满幅顶格;
 * - 冷/暖两套场景氛围(渐变噪点背景 + 渐隐网格站台 + 接触阴影)与两套布光
 *   (主光角度/色温)按 kind 交替,轮廓光按域色微调 —— 对标 ThingJS 封面的
 *   环境/光照多样性,同时背景始终与 --bg-0 萤和;
 * - definitionId 级缓存,重复进入面板零渲染成本;GLB 源模型按 assetId 复用
 *   (克隆渲染、原件缓存,上限 FIFO 淘汰),失败资产会话内不再重试;
 * - WebGL 不可用/构建失败一律 resolve undefined,调用方降级回图标。
 */

export const PREFAB_THUMBNAIL_SIZE = 240;
const PREFAB_THUMBNAIL_DPR = 2;

/** GLB 真实模型加载上限:超过即视为不可用,回退程序化渲染(永不白块)。 */
const GLB_LOAD_TIMEOUT_MS = 10_000;
/** GLB 归一化目标:模型最长边统一缩放到该尺寸(米级观感,与程序化小样同量级)。 */
const GLB_TARGET_SIZE = 3;
/** GLB 源模型缓存上限:超出的最旧条目整体 dispose(FIFO,足够近似 LRU)。 */
const GLB_SOURCE_CACHE_LIMIT = 24;

interface RenderJob {
  definition: IndustrialPrefabDefinition;
  resolve: (dataUrl: string | undefined) => void;
}

/** 可注入的渲染画笔:真实实现走离屏 WebGL,测试注入假实现验证队列/缓存/降级。 */
export type PrefabThumbnailPainter = (model: THREE.Group) => string | undefined;

/** 可注入的 GLB 源加载器:真实实现走 asset-library preview;测试注入假实现验证回退。 */
export type PrefabGlbSourceLoader = (assetId: string) => Promise<THREE.Group>;

const cache = new Map<string, string>();
const pending = new Map<string, Promise<string | undefined>>();
const queue: RenderJob[] = [];
let pumpScheduled = false;
let jobExecuting = false;
let painter: PrefabThumbnailPainter | null = null;
let painterExhausted = false;
let releasePainterResources: (() => void) | null = null;

// ── GLB 真实模型路径的模块级状态 ────────────────────────────────────────────
/** GLB 源模型缓存(assetId → 已解析场景):同资产多变体克隆复用,渲染后仅移除不释放。 */
const glbSourceCache = new Map<string, Promise<THREE.Group>>();
/** 加载失败/超时的资产:会话内不再重试,直接走程序化,避免反复等待 10s。 */
const glbFailedAssets = new Set<string>();
let glbLoader: CompatibleGLTFLoader | null = null;
let dracoLoader: DRACOLoader | null = null;
/** 测试注入的 GLB 源加载器;为 null 时用真实实现。 */
let glbSourceLoaderForTests: PrefabGlbSourceLoader | null = null;
/** 画笔被测试注入时视为"测试程序化路径":未显式注入 GLB 加载器则旁路 GLB。 */
let painterOverridden = false;

/** 请求一个预制体缩略图;失败/不支持时 resolve undefined(调用方回落图标)。 */
export function getPrefabThumbnail(definition: IndustrialPrefabDefinition): Promise<string | undefined> {
  const hit = cache.get(definition.id);
  if (hit) return Promise.resolve(hit);
  const inFlight = pending.get(definition.id);
  if (inFlight) return inFlight;
  const task = new Promise<string | undefined>((resolve) => {
    queue.push({ definition, resolve });
  }).then((dataUrl) => {
    pending.delete(definition.id);
    if (dataUrl) cache.set(definition.id, dataUrl);
    return dataUrl;
  });
  pending.set(definition.id, task);
  schedulePump();
  return task;
}

function schedulePump(): void {
  // 串行执行:GLB 加载是 IO 密集,一个任务(加载+渲染)完成后再排下一个,
  // 避免几十个 GLB 并发下载;程序化路径为同步渲染,行为与"一帧一渲染"一致。
  if (pumpScheduled || jobExecuting) return;
  pumpScheduled = true;
  const tick = typeof requestAnimationFrame === "function"
    ? (callback: () => void) => requestAnimationFrame(() => callback())
    : (callback: () => void) => setTimeout(callback, 0);
  tick(() => {
    pumpScheduled = false;
    const job = queue.shift();
    if (!job) return;
    jobExecuting = true;
    void executeJob(job)
      .catch(() => job.resolve(undefined))
      .finally(() => {
        jobExecuting = false;
        if (queue.length > 0) schedulePump(); // 逐个继续,一个任务一帧起步
      });
  });
}

/** 真实模型加载器:测试注入优先;否则画笔未被注入(真实运行)时走 asset-library。 */
function activeGlbSourceLoader(): PrefabGlbSourceLoader | null {
  if (glbSourceLoaderForTests) return glbSourceLoaderForTests;
  return painterOverridden ? null : loadGlbSource;
}

async function executeJob(job: RenderJob): Promise<void> {
  // 1) 真实模型优先:命中匹配表且未标记失败的资产,加载 GLB → 归一化 → 既有管线出图。
  const loader = activeGlbSourceLoader();
  const match = loader ? prefabModelMatchFor(job.definition.id) : undefined;
  if (loader && match && !glbFailedAssets.has(match.assetId)) {
    try {
      const source = await loader(match.assetId);
      const model = prepareGlbClone(source, job.definition);
      if (model) {
        const activePainter = acquirePainter();
        if (activePainter) {
          const dataUrl = activePainter(model); // 渲染后仅出场景;共享几何/材质归缓存所有
          if (dataUrl) {
            job.resolve(dataUrl);
            return;
          }
        }
      }
    } catch (error) {
      // 失败标记 + 回退程序化:本会话内不再对该资产做 GLB 尝试。
      glbFailedAssets.add(match.assetId);
      console.warn(`[prefab-thumbnail] ${match.assetId} 真实模型加载失败,回退程序化渲染`, error);
    }
  }
  // 2) 程序化回退(匹配缺失 / GLB 失败 / 画笔不可用)。
  let model: THREE.Group | undefined;
  try {
    model = buildIndustrialPrefabThumbnailModel(job.definition);
    if (!model) {
      job.resolve(undefined);
      return;
    }
    const activePainter = acquirePainter();
    if (!activePainter) {
      job.resolve(undefined);
      return;
    }
    job.resolve(activePainter(model));
  } catch (error) {
    console.warn("[prefab-thumbnail] 渲染失败,降级回图标", error);
    job.resolve(undefined);
  } finally {
    if (model) disposeThumbnailModel(model);
  }
}

// ── GLB 真实模型:加载、归一化与缓存管理 ──────────────────────────────────

/** 带超时的 promise 包装:GLB 加载超过 GLB_LOAD_TIMEOUT_MS 即失败。 */
function withTimeout<T>(task: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`GLB 加载超过 ${GLB_LOAD_TIMEOUT_MS}ms`)), GLB_LOAD_TIMEOUT_MS);
    task.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

/** 加载 source-a 模型源(assetId):api/meshoptimizer 惰性加载,解析结果按 assetId 缓存复用。 */
async function loadGlbSource(assetId: string): Promise<THREE.Group> {
  const cached = glbSourceCache.get(assetId);
  // 缓存命中同样受超时保护:共享的底层任务可能因网络停滞而无限挂起。
  if (cached) return withTimeout(cached);
  const task = (async () => {
    // api.ts 体积较大且自带请求基础设施,缩略图链路按需加载,不拖累首屏。
    const [{ api }, { MeshoptDecoder }] = await Promise.all([
      import("../../api"),
      import("meshoptimizer"),
    ]);
    dracoLoader ??= new DRACOLoader().setDecoderPath(`${import.meta.env.BASE_URL}draco/`);
    // 与资源页预览同一加载器族(含 DRACO/Meshopt 解码);source-a 模型无 KTX2 贴图,
    // 不配 KTX2Loader(它需要 renderer 实例),个别含 KTX2 的资产会加载失败并回退程序化。
    glbLoader ??= new CompatibleGLTFLoader().setDRACOLoader(dracoLoader).setMeshoptDecoder(MeshoptDecoder);
    const url = prefabModelPreviewUrl(assetId);
    const blob = await api.getLibraryPreviewBlob(url);
    const binary = await blob.arrayBuffer();
    const gltf = await glbLoader.parseAsync(binary, "");
    return gltf.scene;
  })();
  glbSourceCache.set(assetId, task);
  task.then(
    () => evictGlbSourceCacheIfNeeded(assetId),
    () => glbSourceCache.delete(assetId), // 失败不占缓存;重试由 glbFailedAssets 拦截
  );
  return withTimeout(task);
}

/** 缓存 FIFO 上限:超出时淘汰最旧的源模型并整体释放(几何/材质/贴图)。 */
function evictGlbSourceCacheIfNeeded(justAdded: string): void {
  if (glbSourceCache.size <= GLB_SOURCE_CACHE_LIMIT) return;
  const oldest = glbSourceCache.keys().next().value;
  if (oldest === undefined || oldest === justAdded) return;
  const stale = glbSourceCache.get(oldest);
  glbSourceCache.delete(oldest);
  void stale?.then(releaseGlbGroup).catch(() => {});
}

/** 释放 GLB 源模型的全部 GPU 资源:几何、材质与其贴图。 */
function releaseGlbGroup(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry?.dispose();
    const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of list) {
      if (!material) continue;
      for (const value of Object.values(material)) {
        (value as THREE.Texture | null)?.dispose?.();
      }
      material.dispose();
    }
  });
}

/**
 * 把 GLB 源模型克隆成可渲染小样:整体缩放到 GLB_TARGET_SIZE、包围盒中心对齐原点、
 * 底面落地(y=0),并挂上与程序化小样同一套风格种子(prefabStyle),让真实模型
 * 复用既有取景/氛围/布光管线。克隆与源共享几何材质,渲染后只需从场景移除。
 */
function prepareGlbClone(source: THREE.Group, definition: IndustrialPrefabDefinition): THREE.Group | undefined {
  const clone = source.clone(true);
  clone.updateMatrixWorld(true);
  // precise=true:对 SkinnedMesh(人物等绑定骨骼的模型)按当前蒙皮姿态逐顶点取界,
  // 否则未蒙皮的几何 bounds 会让包围盒偏移/失真,取景黑屏或主体占比失衡。
  const box = new THREE.Box3().setFromObject(clone, true);
  if (box.isEmpty()) return undefined;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = GLB_TARGET_SIZE / Math.max(size.x, size.y, size.z, 1e-6);
  const root = new THREE.Group();
  clone.position.set(-center.x, -box.min.y, -center.z); // 居中 + 底面落地
  root.add(clone);
  root.scale.setScalar(scale);
  root.updateMatrixWorld(true);
  const style = thumbnailStyleFor(definition.kind, definition.id);
  root.userData.prefabStyle = {
    ...style,
    rimTint: Number.parseInt(industrialPrefabPrimitiveVisual(definition.kind).color.slice(1), 16),
  };
  return root;
}

function acquirePainter(): PrefabThumbnailPainter | null {
  if (painter) return painter;
  if (painterExhausted) return null;
  try {
    const created = createOffscreenPainter();
    painter = created.painter;
    releasePainterResources = created.release;
    return painter;
  } catch (error) {
    // WebGL 不可用:永久降级回图标,不再反复尝试创建上下文。
    painterExhausted = true;
    console.warn("[prefab-thumbnail] 离屏渲染器初始化失败,降级回图标", error);
    return null;
  }
}

/** 三档取景:方向向量决定机位(平视 3/4 / 高俯视 / 侧低视角),
 *  外扩系数决定主体占幅 —— 1/1.24≈81%、1/1.31≈76%、1/1.38≈72%,均落在 72~82% 区间。 */
const CAMERA_MODES: Array<{ direction: THREE.Vector3; padding: number }> = [
  { direction: new THREE.Vector3(1, 0.68, 1), padding: 1.24 },
  { direction: new THREE.Vector3(0.55, 1.32, 0.9), padding: 1.38 },
  { direction: new THREE.Vector3(1.55, 0.42, -0.85), padding: 1.31 },
];

/** 创建真实离屏画笔:常驻渲染器 + 场景,只换模型、布光与取景。 */
function createOffscreenPainter(): { painter: PrefabThumbnailPainter; release: () => void } {
  const canvas = document.createElement("canvas");
  canvas.width = PREFAB_THUMBNAIL_SIZE * PREFAB_THUMBNAIL_DPR;
  canvas.height = PREFAB_THUMBNAIL_SIZE * PREFAB_THUMBNAIL_DPR;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false, preserveDrawingBuffer: true });
  renderer.setPixelRatio(1);
  renderer.setSize(canvas.width, canvas.height, false);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;

  const backdrops: Record<SceneMode, THREE.CanvasTexture> = {
    cool: createBackdropTexture("cool"),
    warm: createBackdropTexture("warm"),
  };
  const grounds: Record<SceneMode, THREE.CanvasTexture> = {
    cool: createGroundTexture("cool"),
    warm: createGroundTexture("warm"),
  };
  const scene = new THREE.Scene();
  scene.background = backdrops.cool;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  const environment = pmrem.fromScene(room, 0.04).texture;
  scene.environment = environment;
  room.dispose?.();

  // 光照三件套 ×2 套布光(按 kind 交替,与背景模式错开一格,形成冷暖互补):
  // 冷棚拍:冷白主光 + 青色轮廓;暖车间:琥珀主光 + 沙金轮廓 + 地面暖反弹。
  const hemi = new THREE.HemisphereLight(0xcfe6ee, 0x1c2a30, 0.55);
  const key = new THREE.DirectionalLight(0xf4f9ff, 2.3);
  key.position.set(2.2, 3, 1.8);
  const rim = new THREE.DirectionalLight(0x6fd8e8, 1.1);
  rim.position.set(-2.2, 1.4, -2);
  const bounce = new THREE.DirectionalLight(0xffd9a8, 0);
  bounce.position.set(0.4, -1, 1.6);
  scene.add(hemi, key, rim, bounce);

  const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  const framing = new THREE.Vector3();
  // 场景小物常驻材质(中性工业色,不随 kind 主色,避免抢主体),随渲染器生命周期释放。
  const propMaterials = createPropMaterials();

  const release = (): void => {
    for (const texture of [...Object.values(backdrops), ...Object.values(grounds), environment]) texture.dispose();
    for (const material of Object.values(propMaterials)) material.dispose();
    pmrem.dispose();
    renderer.dispose();
  };

  return {
    painter: (model) => {
      const style = (model.userData.prefabStyle ?? undefined) as (ThumbnailStyle & { rimTint?: number }) | undefined;
      const sceneMode: SceneMode = style?.sceneMode ?? "cool";
      const rigWarm = sceneMode === "cool"; // 背景与布光错开:冷背景配暖灯,反之亦然
      scene.background = backdrops[sceneMode];
      scene.environmentIntensity = rigWarm ? 0.82 : 0.95;
      if (rigWarm) {
        hemi.color.set(0xe9e2d2);
        hemi.groundColor.set(0x2a241c);
        hemi.intensity = 0.5;
        key.color.set(0xffe2b8);
        key.intensity = 2.2;
        key.position.set(-2.4, 2.7, 1.6);
        bounce.intensity = 0.5;
      } else {
        hemi.color.set(0xcfe6ee);
        hemi.groundColor.set(0x1c2a30);
        hemi.intensity = 0.55;
        key.color.set(0xf4f9ff);
        key.intensity = 2.3;
        key.position.set(2.2, 3, 1.8);
        bounce.intensity = 0;
      }
      // 轮廓光按域色微调:kind 代理色向灯色靠拢 55%,分离主体与背景又不破坏语义;
      // 强度按种子 ±20% 摆动,主光色温按种子在 4300K~5600K 间微调(向基准布光色混合),
      // 让并排卡片有"同族不同照"的棚拍丰富感。
      if (style?.rimTint !== undefined) {
        rim.color.set(rigWarm ? 0xfff1d8 : 0xd8f2f5).lerp(new THREE.Color(style.rimTint), 0.45);
      } else {
        rim.color.set(rigWarm ? 0xffe2b8 : 0x6fd8e8);
      }
      rim.intensity = 1.15 * (style?.rimBoost ?? 1);
      if (style?.keyKelvin) key.color.copy(kelvinToColor(style.keyKelvin)).lerp(new THREE.Color(rigWarm ? 0xffe2b8 : 0xf4f9ff), 0.35);
      scene.add(model);
      // 同 prepareGlbClone:精确包围盒,蒙皮人物才不会被错误取景裁切。
      const box = new THREE.Box3().setFromObject(model, true);
      if (box.isEmpty()) {
        scene.remove(model);
        return undefined;
      }
      const size = box.getSize(new THREE.Vector3());
      const center = box.getCenter(new THREE.Vector3());
      // 包围球 + 正弦半角取景:球心到相机距离满足 d ≥ r/sin(fov/2) 时,
      // 球体(含全部几何角点)必然完整落入视锥,任何朝向都不会顶格裁切。
      const sphereRadius = Math.max(size.length() / 2, 1e-4);
      const footprint = Math.min(Math.max(size.x, size.z) * 1.7, size.length());
      const ground = createGroundPlane(grounds[sceneMode], footprint * 2.7);
      ground.position.set(center.x, box.min.y + 0.001, center.z);
      scene.add(ground);
      const shadow = createContactShadow(footprint);
      shadow.position.set(center.x, box.min.y + 0.003, center.z);
      scene.add(shadow);
      const mode = CAMERA_MODES[style?.cameraMode ?? 0] ?? CAMERA_MODES[0]!;
      const distance = (sphereRadius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * mode.padding;
      camera.position.copy(center).add(framing.copy(mode.direction).normalize().multiplyScalar(distance));
      camera.near = distance / 50;
      camera.far = distance * 20;
      camera.lookAt(center.x, center.y - sphereRadius * 0.03, center.z); // 轻微下压视线,留出顶部空间
      camera.updateProjectionMatrix();
      // 场景小语境:主体取景确定后,在主体侧前方摆 1~2 件迷你环境物(不参与包围盒,
      // 不挤占主体占幅),渲染完随地面阴影一起移除释放。
      const props = spawnSceneProps(style, box, mode.direction, propMaterials);
      scene.add(props.group);
      renderer.render(scene, camera);
      const dataUrl = canvas.toDataURL("image/webp", 0.92) || canvas.toDataURL("image/png");
      scene.remove(props.group);
      props.dispose();
      scene.remove(model);
      scene.remove(ground);
      scene.remove(shadow);
      disposeTexture(ground.material);
      disposeTexture(shadow.material.map);
      disposeTexture(shadow.material);
      return dataUrl;
    },
    release,
  };
}

/**
 * 径向渐变背景 + 微噪点:中心提亮到 surface 族色,边缘回落 --bg-0;
 * 冷模式走蓝青工程夜,暖模式走琥珀车间光(仍与 --bg-0 同明度域,不产生"两个世界")。
 * 噪点用于消除渐变色带(banding),让背景有"空气感"而非塑料渐变。
 */
function createBackdropTexture(mode: SceneMode): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(256, 216, 40, 256, 256, 360);
  if (mode === "cool") {
    // 镜像 base.css:中心 #1a2c33(surface-2 提亮族),边缘 #0b1114(--bg-0)
    gradient.addColorStop(0, "#1c2f36");
    gradient.addColorStop(0.65, "#101a1f");
    gradient.addColorStop(1, "#0b1114");
  } else {
    gradient.addColorStop(0, "#2e2820");
    gradient.addColorStop(0.65, "#1a1611");
    gradient.addColorStop(1, "#100f0d");
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, 512, 512);
  // 微噪点:低透明度随机颗粒,只求打断色带,不求可见纹理
  for (let i = 0; i < 1500; i += 1) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    context.fillStyle = i % 3 === 0 ? "rgba(255,255,255,0.024)" : "rgba(0,0,0,0.05)";
    context.fillRect(x, y, 1.4, 1.4);
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** 渐隐网格站台纹理:底盘色 + 细网格线,再经径向遮罩向边缘完全淡出(山海鲸水位,禁生硬平铺)。 */
function createGroundTexture(mode: SceneMode): THREE.CanvasTexture {
  const size = 256;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d")!;
  const fill = context.createRadialGradient(128, 128, 8, 128, 128, 127);
  if (mode === "cool") {
    fill.addColorStop(0, "rgba(32,44,50,0.6)");
    fill.addColorStop(0.68, "rgba(19,26,30,0.3)");
    fill.addColorStop(1, "rgba(0,0,0,0)");
  } else {
    fill.addColorStop(0, "rgba(46,39,30,0.55)");
    fill.addColorStop(0.68, "rgba(26,22,17,0.28)");
    fill.addColorStop(1, "rgba(0,0,0,0)");
  }
  context.fillStyle = fill;
  context.fillRect(0, 0, size, size);
  context.strokeStyle = mode === "cool" ? "rgba(146,186,198,0.22)" : "rgba(198,170,122,0.2)";
  context.lineWidth = 1;
  for (let i = 0; i <= 16; i += 1) {
    const p = i * 16 + 0.5;
    context.beginPath();
    context.moveTo(p, 0);
    context.lineTo(p, size);
    context.moveTo(0, p);
    context.lineTo(size, p);
    context.stroke();
  }
  // 径向渐隐遮罩:网格线越靠边越透明,中心 100% → 55% 处半透 → 边缘消失
  context.globalCompositeOperation = "destination-in";
  const mask = context.createRadialGradient(128, 128, 18, 128, 128, 127);
  mask.addColorStop(0, "rgba(0,0,0,1)");
  mask.addColorStop(0.55, "rgba(0,0,0,0.55)");
  mask.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = mask;
  context.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function createGroundPlane(texture: THREE.CanvasTexture, footprint: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(footprint, footprint), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -2;
  return mesh;
}

/** 柔和地面接触阴影:径向渐变贴图 + 无深度写入平面,免阴影贴图开销且无痤疮。 */
function createContactShadow(footprint: number): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial> {
  const canvas = document.createElement("canvas");
  canvas.width = 128;
  canvas.height = 128;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(64, 64, 6, 64, 64, 62);
  gradient.addColorStop(0, "rgba(0,0,0,0.5)");
  gradient.addColorStop(0.6, "rgba(0,0,0,0.19)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 128, 128);
  const texture = new THREE.CanvasTexture(canvas);
  const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(footprint * 1.7, footprint * 1.7), material);
  mesh.rotation.x = -Math.PI / 2;
  mesh.renderOrder = -1;
  return mesh;
}

function disposeTexture(value: unknown): void {
  const texture = value as THREE.Texture | null | undefined;
  texture?.dispose?.();
}

// ── 场景小语境:迷你环境物(波次 E)────────────────────────────────────────
// 每变体按稳定种子附带 1~2 件工业小物(托盘/料箱/锥桶/工具车/油桶),
// 尺寸 ≤ 主体 15%,摆在主体侧前方、不参与包围盒取景 —— 丰富画面但不抢主体。

interface PropMaterials extends Record<string, THREE.MeshStandardMaterial> {
  metal: THREE.MeshStandardMaterial;
  dark: THREE.MeshStandardMaterial;
  rubber: THREE.MeshStandardMaterial;
  safety: THREE.MeshStandardMaterial;
  bone: THREE.MeshStandardMaterial;
  orange: THREE.MeshStandardMaterial;
}

/** 小物常驻材质:中性工业色,与 kit 的语义令牌同源,不随变体主色变化。 */
function createPropMaterials(): PropMaterials {
  const matte = (color: number, roughness = 0.6, metalness = 0.12) =>
    new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    metal: matte(THUMB_COLORS.metal, 0.32, 0.75),
    dark: matte(THUMB_COLORS.ink, 0.62, 0.1),
    rubber: matte(0x161d21, 0.9, 0),
    safety: matte(THUMB_COLORS.safety, 0.5, 0.1),
    bone: matte(THUMB_COLORS.bone, 0.55, 0),
    orange: matte(0xd9772e, 0.5, 0.1), // 锥桶橙(仅环境物使用)
  };
}

/** 小物接触阴影的常驻几何与材质(惰性单例,避免在测试的 node 环境触碰 document):
 *  让迷你环境物落地,不漂浮。 */
const propShadowGeometry = new THREE.PlaneGeometry(1, 1);
let propShadowMaterialRef: THREE.MeshBasicMaterial | null = null;
function getPropShadowMaterial(): THREE.MeshBasicMaterial {
  if (propShadowMaterialRef) return propShadowMaterialRef;
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d")!;
  const gradient = context.createRadialGradient(32, 32, 4, 32, 32, 31);
  gradient.addColorStop(0, "rgba(0,0,0,0.42)");
  gradient.addColorStop(0.65, "rgba(0,0,0,0.16)");
  gradient.addColorStop(1, "rgba(0,0,0,0)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, 64, 64);
  const texture = new THREE.CanvasTexture(canvas);
  propShadowMaterialRef = new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false });
  return propShadowMaterialRef;
}

/** 单位尺寸小物原型(底面在 y=0,最长边约 1),spawn 时整体缩放。 */
function buildProp(kind: number, m: PropMaterials): THREE.Group {
  const g = new THREE.Group();
  const put = (mesh: THREE.Mesh, x: number, y: number, z = 0): THREE.Mesh => {
    mesh.position.set(x, y, z);
    g.add(mesh);
    return mesh;
  };
  switch (kind % 5) {
    case 0: { // 托盘:三块顶板 + 双纵梁 + 垫块(安全黄塑料托盘)
      for (const x of [-0.3, 0, 0.3]) put(new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.035, 0.9), m.safety), x, 0.1);
      for (const z of [-0.38, 0.38]) put(new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.06, 0.09), m.safety), 0, 0.05, z);
      for (const x of [-0.38, 0, 0.38]) put(new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.035, 0.85), m.safety), x, 0.018);
      break;
    }
    case 1: { // 料箱:黄身 + 深色盖沿 + 白标签
      put(new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.4, 0.46), m.safety), 0, 0.2);
      put(new THREE.Mesh(new THREE.BoxGeometry(0.66, 0.04, 0.5), m.dark), 0, 0.42);
      put(new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.16, 0.012), m.bone), -0.12, 0.22, 0.233);
      break;
    }
    case 2: { // 锥桶:锥台身 + 白反光环 + 方座
      put(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.17, 0.5, 14), m.orange), 0, 0.3);
      put(new THREE.Mesh(new THREE.CylinderGeometry(0.115, 0.135, 0.09, 14), m.bone), 0, 0.32);
      put(new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.4), m.dark), 0, 0.025);
      break;
    }
    case 3: { // 工具车:框架 + 双层板 + 推把 + 四轮 + 工具盒
      put(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.03, 0.36), m.metal), 0, 0.42);
      put(new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.03, 0.36), m.metal), 0, 0.18);
      for (const [x, z] of [[-0.25, -0.15], [0.25, -0.15], [-0.25, 0.15], [0.25, 0.15]] as const) {
        put(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.72, 0.04), m.dark), x, 0.36, z);
        put(new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.03, 10), m.rubber), x, 0.045, z);
      }
      put(new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 0.4), m.metal), -0.25, 0.86, 0.08);
      put(new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.09, 0.2), m.orange), 0.08, 0.48);
      break;
    }
    default: { // 油桶:桶身 + 双箍 + 顶盖
      put(new THREE.Mesh(new THREE.CylinderGeometry(0.21, 0.21, 0.62, 16), m.metal), 0, 0.31);
      for (const y of [0.18, 0.44]) put(new THREE.Mesh(new THREE.CylinderGeometry(0.218, 0.218, 0.03, 16), m.dark), 0, y);
      put(new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.03, 10), m.dark), 0, 0.64);
    }
  }
  return g;
}

/**
 * 按稳定种子在主体对角侧前方摆 1~2 件迷你环境物。方向取"视线水平方向 + 垂直侧向"
 * 的对角线,沿主体包围盒在该方向的支撑半径外推 —— 任何机位都不与主体相交、不超出
 * 画面;尺寸取主体最大维的 12%(≤15%),不参与包围盒取景(主体占幅 72~82% 不变)。
 */
function spawnSceneProps(style: (ThumbnailStyle & { rimTint?: number }) | undefined, box: THREE.Box3, camDirection: THREE.Vector3, m: PropMaterials): { group: THREE.Group; dispose: () => void } {
  const group = new THREE.Group();
  const seed = style?.propsSeed ?? 0;
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const scale = Math.min(Math.max(Math.max(size.x, size.y, size.z) * 0.12, 0.1), 0.32);
  const count = seed % 3 === 0 ? 2 : 1;
  const dirH = new THREE.Vector3(camDirection.x, 0, camDirection.z).normalize();
  const perp = new THREE.Vector3(-dirH.z, 0, dirH.x);
  const firstSide = (seed >>> 4) % 2 === 0 ? 1 : -1;
  for (let i = 0; i < count; i++) {
    const prop = buildProp(Math.floor((seed >>> (5 + i * 6)) % 5), m);
    prop.scale.setScalar(scale);
    const side = i === 0 ? firstSide : -firstSide;
    const diagonal = new THREE.Vector3().addScaledVector(dirH, 1).addScaledVector(perp, side).normalize(); // 对角方向
    const support = Math.abs(diagonal.x) * size.x * 0.5 + Math.abs(diagonal.z) * size.z * 0.5; // AABB 支撑半径
    const along = (((seed >>> (8 + i * 5)) % 7) - 3) * scale * 0.35; // 沿垂直方向小幅错位
    prop.position.set(
      center.x + diagonal.x * (support + scale * 0.9) + perp.x * along,
      box.min.y,
      center.z + diagonal.z * (support + scale * 0.9) + perp.z * along,
    );
    prop.rotation.y = ((seed >>> (3 + i * 7)) % 16) / 16 * Math.PI * 2;
    group.add(prop);
    // 迷你接触阴影:复用常驻的接触阴影材质,让小物"落地"不漂浮
    const shadow = new THREE.Mesh(propShadowGeometry, getPropShadowMaterial());
    shadow.rotation.x = -Math.PI / 2;
    shadow.position.set(prop.position.x, box.min.y + 0.002, prop.position.z);
    shadow.scale.setScalar(scale * 2.6);
    shadow.renderOrder = -1;
    group.add(shadow);
  }
  return {
    group,
    dispose: () => {
      group.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (mesh.isMesh && mesh.geometry !== propShadowGeometry) mesh.geometry?.dispose(); // 材质与阴影几何常驻,只释放小物几何
      });
    },
  };
}

/** 释放常驻渲染器与缓存;测试与热重载场景使用,正常生命周期无需调用。 */
export function disposePrefabThumbnailRenderer(): void {
  queue.length = 0;
  cache.clear();
  pending.clear();
  pumpScheduled = false;
  jobExecuting = false;
  painter = null;
  painterExhausted = false;
  releasePainterResources?.();
  releasePainterResources = null;
  propShadowMaterialRef?.dispose(); // 释放小物接触阴影贴图
  propShadowMaterialRef = null;
  for (const task of glbSourceCache.values()) void task.then(releaseGlbGroup).catch(() => {});
  glbSourceCache.clear();
  glbFailedAssets.clear();
  // GLTFLoader 本体无 GPU 资源;Draco 解码器的 wasm/worker 需要显式释放。
  dracoLoader?.dispose();
  dracoLoader = null;
  glbLoader = null;
}

/** 测试注入:替换渲染画笔(传 null 还原真实画笔并清空队列/缓存)。 */
export function __setPrefabThumbnailPainterForTests(override: PrefabThumbnailPainter | null): void {
  disposePrefabThumbnailRenderer();
  painterOverridden = override !== null; // 注入画笔即测试程序化路径;GLB 由 glbSourceLoaderForTests 显式开启
  if (override) painter = override;
}

/** 测试注入:替换 GLB 源加载器(传 null 还原真实加载)。两个注入互不清除对方状态。 */
export function __setPrefabThumbnailGlbLoaderForTests(loader: PrefabGlbSourceLoader | null): void {
  disposePrefabThumbnailRenderer();
  glbSourceLoaderForTests = loader;
}

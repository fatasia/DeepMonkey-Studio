import * as THREE from "three";
import type { SceneFireEffectState } from "@bim-studio/contracts";
import {
  createParticleSortScratch, sampleParticleCurveLut, sortParticlesBackToFront, type ParticleSortScratch,
} from "@bim-studio/deep-engine/particles";
import {
  fireBlendMode, fireRequestedParticles, resolveFireCurves, type ResolvedFireCurves,
} from "./modelFireParticles";

interface FireParticleSeed {
  phase: number;
  radialX: number;
  radialZ: number;
  drift: number;
  speed: number;
}

export interface ModelFireEffectOptions {
  /** WebGL 路径用 aSizeScale 逐粒子缩放；WebGPU 节点材质无该扩展，退化为曲线均值。默认 true。 */
  perParticleSize?: boolean;
  /** 初始场景预算分配量；省略 = 申请量。 */
  allocated?: number;
}

export interface ModelFireEffectRuntime {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  positionAttribute: THREE.BufferAttribute;
  colorAttribute: THREE.BufferAttribute;
  sizeAttribute?: THREE.BufferAttribute;
  seeds: FireParticleSeed[];
  /** 单发射器申请量（几何容量）与场景预算分配量（实际绘制/更新数量）。 */
  requestedCount: number;
  allocatedCount: number;
  blend: "additive" | "alpha";
  curves: ResolvedFireCurves;
  /** 余烬 / 基色 / 高光 的 rgb 线性分量，共 9 个。 */
  palette: Float32Array;
  sim: { progress: Float32Array; positions: Float32Array; order: Uint32Array; rank: Uint32Array; scratch: ParticleSortScratch };
  center: THREE.Vector3;
  radiusX: number;
  radiusZ: number;
  baseY: number;
  height: number;
  elapsed: number;
  intensity: number;
}

/** 单个 Points draw call 的火焰图层；只使用 WebGL/WebGPU 都支持的基础材质能力。 */
export function createModelFireEffect(
  model: THREE.Object3D,
  state: SceneFireEffectState,
  options: ModelFireEffectOptions = {},
): ModelFireEffectRuntime | undefined {
  const bounds = modelLocalBounds(model);
  if (!bounds || bounds.isEmpty()) return undefined;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const particleCount = fireRequestedParticles(state);
  const perParticleSize = options.perParticleSize !== false;
  const curves = resolveFireCurves(state.curves);
  const blend = fireBlendMode(state);
  const seeds = Array.from({ length: particleCount }, (_, index) => fireParticleSeed(index));
  const positions = new Float32Array(particleCount * 3);
  const palette = firePalette(state.color);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute("position", positionAttribute);
  const colorAttribute = new THREE.BufferAttribute(new Float32Array(particleCount * 4), 4);
  geometry.setAttribute("color", colorAttribute);
  let sizeAttribute: THREE.BufferAttribute | undefined;
  if (perParticleSize) {
    sizeAttribute = new THREE.BufferAttribute(new Float32Array(particleCount).fill(1), 1);
    geometry.setAttribute("aSizeScale", sizeAttribute);
  }

  const texture = createSoftParticleTexture();
  const material = new THREE.PointsMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    opacity: Math.min(1, state.intensity * 0.32),
    blending: blend === "alpha" ? THREE.NormalBlending : THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true,
    size: Math.max(0.08, state.height * (0.11 + state.intensity * 0.012)) * (perParticleSize ? 1 : curves.sizeMean),
  });
  if (perParticleSize) enablePerParticleSize(material);
  const points = new THREE.Points(geometry, material);
  points.name = "helper:model-fire";
  points.userData.effectHelper = true;
  points.frustumCulled = false;
  points.renderOrder = 29;
  // 视觉覆盖层不能抢占模型拾取，否则火焰会挡住属性选择与交互脚本点击。
  points.raycast = () => undefined;
  model.add(points);

  const radiusLimit = state.height * 0.65;
  const runtime: ModelFireEffectRuntime = {
    points,
    positionAttribute,
    seeds,
    colorAttribute,
    ...(sizeAttribute ? { sizeAttribute } : {}),
    requestedCount: particleCount,
    allocatedCount: particleCount,
    blend,
    curves,
    palette,
    sim: {
      progress: new Float32Array(particleCount),
      positions: new Float32Array(particleCount * 3),
      order: new Uint32Array(particleCount),
      rank: new Uint32Array(particleCount),
      scratch: createParticleSortScratch(particleCount),
    },
    center,
    radiusX: THREE.MathUtils.clamp(size.x * 0.22, state.height * 0.08, radiusLimit),
    radiusZ: THREE.MathUtils.clamp(size.z * 0.22, state.height * 0.08, radiusLimit),
    baseY: bounds.max.y - state.height * 0.06,
    height: state.height,
    elapsed: 0,
    intensity: state.intensity,
  };
  setModelFireAllocation(runtime, options.allocated ?? particleCount);
  updateModelFireEffect(runtime, 0);
  return runtime;
}

/** 场景预算分配：只缩绘制范围与更新循环，不重建几何、不崩溃。 */
export function setModelFireAllocation(runtime: ModelFireEffectRuntime, allocated: number): void {
  const next = Math.max(0, Math.min(runtime.requestedCount, Math.floor(allocated)));
  runtime.allocatedCount = next;
  runtime.points.geometry.setDrawRange(0, next);
  runtime.points.visible = next > 0;
}

const scratchEye = new THREE.Vector3();

/**
 * 逐帧更新：位置 → (alpha 混合时)引擎 back-to-front 排序 → 按 size/alpha/color 曲线 LUT 写属性。
 * cameraWorld 仅 alpha 混合需要；加色混合顺序无关，不排序。
 */
export function updateModelFireEffect(
  runtime: ModelFireEffectRuntime,
  deltaSeconds: number,
  cameraWorld?: THREE.Vector3,
): void {
  runtime.elapsed += Math.min(Math.max(deltaSeconds, 0), 0.1) * (0.55 + runtime.intensity * 0.22);
  const count = runtime.allocatedCount;
  const { sim, curves, palette } = runtime;
  for (let index = 0; index < count; index += 1) {
    const seed = runtime.seeds[index]!;
    const progress = (seed.phase + runtime.elapsed * seed.speed) % 1;
    const taper = Math.pow(1 - progress, 0.72);
    const flicker = Math.sin((runtime.elapsed + seed.phase) * Math.PI * 7 + seed.drift) * 0.08;
    const offset = index * 3;
    sim.progress[index] = progress;
    sim.positions[offset] = runtime.center.x + seed.radialX * runtime.radiusX * taper + flicker * runtime.radiusX;
    sim.positions[offset + 1] = runtime.baseY + progress * runtime.height;
    sim.positions[offset + 2] = runtime.center.z + seed.radialZ * runtime.radiusZ * taper - flicker * runtime.radiusZ;
  }
  let rank: Uint32Array | undefined;
  if (runtime.blend === "alpha" && cameraWorld && count > 1) {
    runtime.points.worldToLocal(scratchEye.copy(cameraWorld));
    sortParticlesBackToFront(sim.positions, count, [scratchEye.x, scratchEye.y, scratchEye.z], sim.order, sim.scratch);
    for (let slot = 0; slot < count; slot += 1) sim.rank[sim.order[slot]!] = slot;
    rank = sim.rank;
  }
  const positions = runtime.positionAttribute.array as Float32Array;
  const colors = runtime.colorAttribute.array as Float32Array;
  const sizes = runtime.sizeAttribute?.array as Float32Array | undefined;
  for (let index = 0; index < count; index += 1) {
    const slot = rank ? rank[index]! : index;
    const progress = sim.progress[index]!;
    positions[slot * 3] = sim.positions[index * 3]!;
    positions[slot * 3 + 1] = sim.positions[index * 3 + 1]!;
    positions[slot * 3 + 2] = sim.positions[index * 3 + 2]!;
    const heat = Math.min(1, Math.max(0, sampleParticleCurveLut(curves.color, progress) + (runtime.seeds[index]!.phase - 0.5) * 0.16));
    // 热度 0→0.5：余烬→基色；0.5→1：基色→高光。
    const low = heat < 0.5;
    const mix = low ? heat * 2 : (heat - 0.5) * 2;
    const from = low ? 0 : 3, to = low ? 3 : 6;
    const colorOffset = slot * 4;
    colors[colorOffset] = palette[from]! + (palette[to]! - palette[from]!) * mix;
    colors[colorOffset + 1] = palette[from + 1]! + (palette[to + 1]! - palette[from + 1]!) * mix;
    colors[colorOffset + 2] = palette[from + 2]! + (palette[to + 2]! - palette[from + 2]!) * mix;
    colors[colorOffset + 3] = sampleParticleCurveLut(curves.alpha, progress);
    if (sizes) sizes[slot] = sampleParticleCurveLut(curves.size, progress);
  }
  runtime.positionAttribute.needsUpdate = true;
  runtime.colorAttribute.needsUpdate = true;
  if (runtime.sizeAttribute) runtime.sizeAttribute.needsUpdate = true;
}
export function disposeModelFireEffect(
  runtime: ModelFireEffectRuntime,
  retireObject?: (object: THREE.Object3D) => void,
): void {
  if (retireObject) {
    retireObject(runtime.points);
    return;
  }
  runtime.points.removeFromParent();
  runtime.points.geometry.dispose();
  runtime.points.material.map?.dispose();
  runtime.points.material.dispose();
}

function modelLocalBounds(model: THREE.Object3D): THREE.Box3 | undefined {
  model.updateWorldMatrix(true, true);
  const inverseRoot = model.matrixWorld.clone().invert();
  const bounds = new THREE.Box3().makeEmpty();
  model.traverse((child) => {
    if (child !== model && child.userData.effectHelper) return;
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    const toRoot = inverseRoot.clone().multiply(mesh.matrixWorld);
    bounds.union(mesh.geometry.boundingBox.clone().applyMatrix4(toRoot));
  });
  return bounds.isEmpty() ? undefined : bounds;
}

function fireParticleSeed(index: number): FireParticleSeed {
  const radialAngle = random(index * 5 + 1) * Math.PI * 2;
  const radialDistance = Math.sqrt(random(index * 5 + 2));
  return {
    phase: random(index * 5 + 3),
    radialX: Math.cos(radialAngle) * radialDistance,
    radialZ: Math.sin(radialAngle) * radialDistance,
    drift: random(index * 5 + 4) * Math.PI * 2,
    speed: 0.72 + random(index * 5 + 5) * 0.58,
  };
}

/** 余烬(基色×0.35) / 基色 / 高光(基色向白 56%) 三档 rgb。 */
function firePalette(color: string): Float32Array {
  const base = new THREE.Color(color);
  const hot = base.clone().lerp(new THREE.Color(0xffffff), 0.56);
  const ember = base.clone().multiplyScalar(0.35);
  return new Float32Array([ember.r, ember.g, ember.b, base.r, base.g, base.b, hot.r, hot.g, hot.b]);
}

/** WebGL 专用：给 PointsMaterial 注入逐粒子尺寸属性（three 内置 points 着色器 `gl_PointSize = size;`）。 */
function enablePerParticleSize(material: THREE.PointsMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float aSizeScale;\n${shader.vertexShader.replace("gl_PointSize = size;", "gl_PointSize = size * aSizeScale;")}`;
  };
  material.customProgramCacheKey = () => "model-fire-size-scale";
}
function createSoftParticleTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size * 2 - 1;
      const dy = (y + 0.5) / size * 2 - 1;
      const alpha = Math.round(255 * Math.pow(Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy)), 1.7));
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = alpha;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return texture;
}

function random(seed: number): number {
  const value = Math.sin(seed * 12.9898) * 43_758.5453;
  return value - Math.floor(value);
}

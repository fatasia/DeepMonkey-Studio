import * as THREE from "three";
import type { SceneVfxEffectState } from "@bim-studio/contracts";
import {
  createParticleSortScratch, sampleParticleCurveLut, sortParticlesBackToFront, type ParticleSortScratch,
} from "@bim-studio/deep-engine/particles";
import { resolveVfxCurves, vfxBlendMode, vfxRequestedParticles, vfxTemplateOf, type ResolvedVfxCurves } from "./modelVfxParticles";

/**
 * 轻量 VFX 图层运行时：与火焰图层(modelFireEffect)同构的单批次 THREE.Points——
 * 确定性种子、progress 参数化轨迹、deep-engine 曲线 LUT、back-to-front 排序、
 * 场景预算 drawRange 降级。运动档来自模板(rise/fall/burst/ring/drift/flow)，
 * 不引入第二套模拟管线，WebGL/WebGPU 通用。
 */

interface VfxParticleSeed {
  /** 生命周期相位 0..1。 */
  phase: number;
  /** 水平方位角 0..2π。 */
  angle: number;
  /** 径向分布 0..1(面积均匀)。 */
  radial: number;
  /** 上升锥仰角偏置 0..1(burst 用)。 */
  elevation: number;
  /** 横向摆动相位 0..2π。 */
  wander: number;
  /** 速度抖动 0.72..1.3。 */
  speed: number;
}

export interface ModelVfxEffectOptions {
  /** WebGL 路径用 aSizeScale 逐粒子缩放；WebGPU 节点材质无该扩展，退化为曲线均值。默认 true。 */
  perParticleSize?: boolean;
  /** 初始场景预算分配量；省略 = 申请量。 */
  allocated?: number;
}

export interface ModelVfxEffectRuntime {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  positionAttribute: THREE.BufferAttribute;
  colorAttribute: THREE.BufferAttribute;
  sizeAttribute?: THREE.BufferAttribute;
  seeds: VfxParticleSeed[];
  /** 单发射器申请量(几何容量)与场景预算分配量(实际绘制/更新数量)。 */
  requestedCount: number;
  allocatedCount: number;
  blend: "additive" | "alpha";
  template: SceneVfxEffectState["template"];
  curves: ResolvedVfxCurves;
  /** 暗档 / 基色 / 亮档 的 rgb 线性分量，共 9 个。 */
  palette: Float32Array;
  sim: { progress: Float32Array; positions: Float32Array; order: Uint32Array; rank: Uint32Array; scratch: ParticleSortScratch };
  center: THREE.Vector3;
  radiusX: number;
  radiusZ: number;
  baseY: number;
  topY: number;
  /** 模板 range 语义量(高度/半径/长度,模型局部米)。 */
  range: number;
  /** 气流档的流向：true 沿局部 +X，false 沿局部 +Z（取包围盒较长轴）。 */
  flowAlongX: boolean;
  elapsed: number;
  intensity: number;
  motion: ReturnType<typeof vfxTemplateOf>["motion"];
}

/** 单个 Points draw call 的 VFX 图层；只使用 WebGL/WebGPU 都支持的基础材质能力。 */
export function createModelVfxEffect(
  model: THREE.Object3D,
  state: SceneVfxEffectState,
  options: ModelVfxEffectOptions = {},
): ModelVfxEffectRuntime | undefined {
  const bounds = modelLocalBounds(model);
  if (!bounds || bounds.isEmpty()) return undefined;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const template = vfxTemplateOf(state.template);
  const particleCount = vfxRequestedParticles(state);
  const perParticleSize = options.perParticleSize !== false;
  const curves = resolveVfxCurves(state);
  const blend = vfxBlendMode(state);
  const seeds = Array.from({ length: particleCount }, (_, index) => vfxParticleSeed(index));
  const positions = new Float32Array(particleCount * 3);
  const palette = vfxPalette(state.color);
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
  const additive = blend === "additive";
  const material = new THREE.PointsMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    // alpha 模板压住不透明度避免糊屏；additive 靠叠加自然衰减。
    opacity: additive ? Math.min(1, state.intensity * 0.3) : Math.min(0.85, 0.18 + state.intensity * 0.14),
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true,
    size: Math.max(0.05, state.range * template.pointScale * (0.8 + state.intensity * 0.1)) * (perParticleSize ? 1 : curves.sizeMean),
  });
  if (perParticleSize) enablePerParticleSize(material);
  const points = new THREE.Points(geometry, material);
  points.name = "helper:model-vfx";
  points.userData.effectHelper = true;
  points.frustumCulled = false;
  points.renderOrder = 30;
  // 视觉覆盖层不能抢占模型拾取，否则粒子会挡住属性选择与交互脚本点击。
  points.raycast = () => undefined;
  model.add(points);

  const radiusLimit = state.range * 0.65;
  const runtime: ModelVfxEffectRuntime = {
    points,
    positionAttribute,
    seeds,
    colorAttribute,
    ...(sizeAttribute ? { sizeAttribute } : {}),
    requestedCount: particleCount,
    allocatedCount: particleCount,
    blend,
    template: state.template,
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
    radiusX: THREE.MathUtils.clamp(size.x * 0.22, state.range * 0.08, radiusLimit),
    radiusZ: THREE.MathUtils.clamp(size.z * 0.22, state.range * 0.08, radiusLimit),
    baseY: bounds.min.y,
    topY: bounds.max.y,
    range: state.range,
    flowAlongX: size.x >= size.z,
    elapsed: 0,
    intensity: state.intensity,
    motion: template.motion,
  };
  setModelVfxAllocation(runtime, options.allocated ?? particleCount);
  updateModelVfxEffect(runtime, 0);
  return runtime;
}

/** 场景预算分配：只缩绘制范围与更新循环，不重建几何、不崩溃。 */
export function setModelVfxAllocation(runtime: ModelVfxEffectRuntime, allocated: number): void {
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
export function updateModelVfxEffect(
  runtime: ModelVfxEffectRuntime,
  deltaSeconds: number,
  cameraWorld?: THREE.Vector3,
): void {
  runtime.elapsed += Math.min(Math.max(deltaSeconds, 0), 0.1) * (0.55 + runtime.intensity * 0.22);
  const count = runtime.allocatedCount;
  const { sim, curves, palette } = runtime;
  const time = runtime.elapsed;
  for (let index = 0; index < count; index += 1) {
    const seed = runtime.seeds[index]!;
    const progress = (seed.phase + time * seed.speed) % 1;
    sim.progress[index] = progress;
    writeMotionPosition(runtime, seed, progress, index * 3);
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
    const tone = Math.min(1, Math.max(0, sampleParticleCurveLut(curves.color, progress)));
    // 色调 0→0.5：暗档→基色；0.5→1：基色→亮档。
    const low = tone < 0.5;
    const mix = low ? tone * 2 : (tone - 0.5) * 2;
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

export function disposeModelVfxEffect(
  runtime: ModelVfxEffectRuntime,
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

/** 各运动档的轨迹公式;全部是 progress 的确定性参数化,与火焰层同构,零分配。 */
function writeMotionPosition(
  runtime: ModelVfxEffectRuntime,
  seed: VfxParticleSeed,
  progress: number,
  offset: number,
): void {
  const { sim, center, radiusX, radiusZ, baseY, topY, range } = runtime;
  const sway = Math.sin((runtime.elapsed + seed.phase * 6.28) * Math.PI * 2 + seed.wander);
  switch (runtime.motion) {
    case "rise": {
      // 顶部圆盘发射,上升过程中横向扩张(蒸汽/烟雾)。
      const expand = 0.35 + 0.85 * progress;
      const flicker = sway * 0.05 * range;
      sim.positions[offset] = center.x + seed.radial * radiusX * expand + flicker;
      sim.positions[offset + 1] = topY + progress * range;
      sim.positions[offset + 2] = center.z + seed.radial * radiusZ * expand - flicker * 0.7;
      break;
    }
    case "fall": {
      // 底部区域滴落,progress^1.7 模拟重力加速(滴液)。
      const drop = Math.pow(progress, 1.7) * range;
      sim.positions[offset] = center.x + seed.radial * radiusX * 0.5 + sway * 0.01 * range;
      sim.positions[offset + 1] = baseY + range * 0.05 - drop;
      sim.positions[offset + 2] = center.z + seed.radial * radiusZ * 0.5;
      break;
    }
    case "burst": {
      // 中心锥形抛射 + 二次方重力下坠(火花/喷雾)。
      const flight = Math.pow(progress, 0.75) * range * seed.speed;
      const sag = 1.5 * progress * progress * range * 0.35;
      sim.positions[offset] = center.x + Math.cos(seed.angle) * flight;
      sim.positions[offset + 1] = center.y + (0.25 + seed.elevation * 0.75) * flight - sag;
      sim.positions[offset + 2] = center.z + Math.sin(seed.angle) * flight;
      break;
    }
    case "ring": {
      // 地面扩散环,整体缓慢旋转,微小呼吸起伏(告警脉冲)。
      const radius = range * (0.15 + 0.85 * progress);
      const angle = seed.angle + runtime.elapsed * 0.35;
      sim.positions[offset] = center.x + Math.cos(angle) * radius;
      sim.positions[offset + 1] = baseY + 0.05 + Math.sin(progress * Math.PI) * range * 0.02;
      sim.positions[offset + 2] = center.z + Math.sin(angle) * radius;
      break;
    }
    case "drift": {
      // 底部扬起,中段横向鼓包的缓慢漂移(灰尘)。
      const bulge = Math.sin(progress * Math.PI) * 0.25 * range;
      sim.positions[offset] = center.x + seed.radial * radiusX * 0.8 + Math.cos(seed.wander) * bulge;
      sim.positions[offset + 1] = baseY + progress * range;
      sim.positions[offset + 2] = center.z + seed.radial * radiusZ * 0.8 + Math.sin(seed.wander) * bulge;
      break;
    }
    case "flow": {
      // 沿对象最长水平轴的定向流线,轻微扰动(气流示踪)。
      const stream = progress * range;
      const wobble = Math.sin(progress * Math.PI * 8 + seed.wander) * 0.02 * range;
      const lateral = seed.radial * 0.3;
      if (runtime.flowAlongX) {
        sim.positions[offset] = center.x + stream;
        sim.positions[offset + 1] = center.y + wobble + lateral * radiusZ;
        sim.positions[offset + 2] = center.z + seed.radial * radiusZ * 0.6;
      } else {
        sim.positions[offset] = center.x + seed.radial * radiusX * 0.6;
        sim.positions[offset + 1] = center.y + wobble + lateral * radiusX;
        sim.positions[offset + 2] = center.z + stream;
      }
      break;
    }
  }
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

function vfxParticleSeed(index: number): VfxParticleSeed {
  return {
    phase: random(index * 6 + 1),
    angle: random(index * 6 + 2) * Math.PI * 2,
    radial: Math.sqrt(random(index * 6 + 3)),
    elevation: random(index * 6 + 4),
    wander: random(index * 6 + 5) * Math.PI * 2,
    speed: 0.72 + random(index * 6 + 6) * 0.58,
  };
}

/** 暗档(基色×0.35) / 基色 / 亮档(基色向白 56%) 三档 rgb。 */
function vfxPalette(color: string): Float32Array {
  const base = new THREE.Color(color);
  const bright = base.clone().lerp(new THREE.Color(0xffffff), 0.56);
  const dim = base.clone().multiplyScalar(0.35);
  return new Float32Array([dim.r, dim.g, dim.b, base.r, base.g, base.b, bright.r, bright.g, bright.b]);
}

/** WebGL 专用：给 PointsMaterial 注入逐粒子尺寸属性（three 内置 points 着色器 `gl_PointSize = size;`）。 */
function enablePerParticleSize(material: THREE.PointsMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = `attribute float aSizeScale;\n${shader.vertexShader.replace("gl_PointSize = size;", "gl_PointSize = size * aSizeScale;")}`;
  };
  material.customProgramCacheKey = () => "model-vfx-size-scale";
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

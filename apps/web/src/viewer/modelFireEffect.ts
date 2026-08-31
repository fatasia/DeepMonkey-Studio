import * as THREE from "three";
import type { SceneFireEffectState } from "@bim-studio/contracts";

interface FireParticleSeed {
  phase: number;
  radialX: number;
  radialZ: number;
  drift: number;
  speed: number;
}

export interface ModelFireEffectRuntime {
  points: THREE.Points<THREE.BufferGeometry, THREE.PointsMaterial>;
  positionAttribute: THREE.BufferAttribute;
  seeds: FireParticleSeed[];
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
): ModelFireEffectRuntime | undefined {
  const bounds = modelLocalBounds(model);
  if (!bounds || bounds.isEmpty()) return undefined;
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const particleCount = Math.round(80 * state.density);
  const seeds = Array.from({ length: particleCount }, (_, index) => fireParticleSeed(index));
  const positions = new Float32Array(particleCount * 3);
  const colors = fireParticleColors(state.color, seeds);
  const geometry = new THREE.BufferGeometry();
  const positionAttribute = new THREE.BufferAttribute(positions, 3);
  geometry.setAttribute("position", positionAttribute);
  geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));

  const texture = createSoftParticleTexture();
  const material = new THREE.PointsMaterial({
    map: texture,
    vertexColors: true,
    transparent: true,
    opacity: Math.min(1, state.intensity * 0.32),
    blending: THREE.AdditiveBlending,
    depthTest: true,
    depthWrite: false,
    sizeAttenuation: true,
    size: Math.max(0.08, state.height * (0.11 + state.intensity * 0.012)),
  });
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
    center,
    radiusX: THREE.MathUtils.clamp(size.x * 0.22, state.height * 0.08, radiusLimit),
    radiusZ: THREE.MathUtils.clamp(size.z * 0.22, state.height * 0.08, radiusLimit),
    baseY: bounds.max.y - state.height * 0.06,
    height: state.height,
    elapsed: 0,
    intensity: state.intensity,
  };
  updateModelFireEffect(runtime, 0);
  return runtime;
}

export function updateModelFireEffect(runtime: ModelFireEffectRuntime, deltaSeconds: number): void {
  runtime.elapsed += Math.min(Math.max(deltaSeconds, 0), 0.1) * (0.55 + runtime.intensity * 0.22);
  const positions = runtime.positionAttribute.array as Float32Array;
  for (let index = 0; index < runtime.seeds.length; index += 1) {
    const seed = runtime.seeds[index]!;
    const progress = (seed.phase + runtime.elapsed * seed.speed) % 1;
    const taper = Math.pow(1 - progress, 0.72);
    const flicker = Math.sin((runtime.elapsed + seed.phase) * Math.PI * 7 + seed.drift) * 0.08;
    const offset = index * 3;
    positions[offset] = runtime.center.x + seed.radialX * runtime.radiusX * taper + flicker * runtime.radiusX;
    positions[offset + 1] = runtime.baseY + progress * runtime.height;
    positions[offset + 2] = runtime.center.z + seed.radialZ * runtime.radiusZ * taper - flicker * runtime.radiusZ;
  }
  runtime.positionAttribute.needsUpdate = true;
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

function fireParticleColors(color: string, seeds: FireParticleSeed[]): Float32Array {
  const base = new THREE.Color(color);
  const bright = base.clone().lerp(new THREE.Color(0xffffff), 0.56);
  const values = new Float32Array(seeds.length * 3);
  seeds.forEach((seed, index) => {
    const current = base.clone().lerp(bright, 0.18 + seed.phase * 0.7);
    current.toArray(values, index * 3);
  });
  return values;
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

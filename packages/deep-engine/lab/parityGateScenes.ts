import * as THREE from "three";
import { DEFAULT_DISPLAY_CONTRACT } from "../../contracts/src/displayContract.js";

/** 像素一致性门的五个标准场景；three 与 Deep 共用同一作者根（Mesh 层级 + 灯光），只在宿主侧开关特性。 */
export type ParityScenarioId = "pbr-matrix" | "ibl" | "directional-shadow" | "aa-bloom" | "transparency" | "ibl-hq" | "bloom-only" | "transparency-direct";
export const PARITY_SCENARIO_IDS: readonly ParityScenarioId[] = ["pbr-matrix", "ibl", "directional-shadow", "aa-bloom", "transparency", "ibl-hq", "bloom-only", "transparency-direct"];
export const parityProfile = Object.freeze({ width: 320, height: 192, exposure: DEFAULT_DISPLAY_CONTRACT.toneMapping.exposure,
  verticalFovRadians: Math.PI / 4, near: .1, far: 100, up: [0, 1, 0] as const });

export interface ParityScene {
  readonly scene: THREE.Scene;
  readonly root: THREE.Group;
  readonly eye: readonly [number, number, number];
  readonly target: readonly [number, number, number];
  readonly shadows: boolean;
  /** 同一份线性 HDR 等距柱状全景：three 侧走 PMREM，Deep 侧走 radiance-hdr 预滤波。 */
  readonly environment?: { readonly width: number; readonly height: number; readonly data: Float32Array<ArrayBuffer> };
  /** Deep radiance-hdr 预滤波质量档（缺省 = 生产默认 128/32/128）。 */
  readonly environmentOptions?: { readonly specularSize: 64 | 128 | 256; readonly diffuseSize: 16 | 32 | 64; readonly sampleCount: 64 | 128 | 256 };
  readonly post?: { readonly antialias: boolean; readonly bloom?: { readonly strength: number; readonly radius: number; readonly threshold: number } };
  dispose(): void;
}

const sphere = (radius: number) => new THREE.SphereGeometry(radius, 48, 32);
const key = (scene: THREE.Scene, position: [number, number, number], intensity: number, color = new THREE.Color(1, .95, .9)) => {
  const light = new THREE.DirectionalLight(color, intensity); light.position.fromArray(position); light.castShadow = false;
  scene.add(light, light.target); return light;
};

function finish(scene: THREE.Scene, root: THREE.Group, geometries: THREE.BufferGeometry[], materials: THREE.Material[],
  extra: Omit<ParityScene, "scene" | "root" | "dispose">): ParityScene {
  scene.updateMatrixWorld(true);
  return { scene, root, ...extra, dispose() { geometries.forEach(geometry => geometry.dispose()); materials.forEach(material => material.dispose()); } };
}

function matrixRoot(root: THREE.Group, geometries: THREE.BufferGeometry[], materials: THREE.Material[]): void {
  const roughness = [.1, .3, .5, .7, .95], geometry = sphere(.58); geometries.push(geometry);
  for (let row = 0; row < 2; row++) for (let column = 0; column < roughness.length; column++) {
    const metal = row === 1;
    const material = new THREE.MeshStandardMaterial({ color: metal ? new THREE.Color(.95, .78, .42) : new THREE.Color(.8, .22, .12),
      roughness: roughness[column]!, metalness: metal ? 1 : 0 });
    materials.push(material);
    const mesh = new THREE.Mesh(geometry, material); mesh.name = `matrix-${row}-${column}`;
    mesh.position.set((column - 2) * 1.3, row === 0 ? .75 : -.75, 0); root.add(mesh);
  }
}

function pbrMatrix(): ParityScene {
  const scene = new THREE.Scene(), root = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  scene.add(root); matrixRoot(root, geometries, materials);
  key(scene, [-3, 4, 5], 3); key(scene, [4, 1, -3], 1.2, new THREE.Color(.6, .75, 1));
  return finish(scene, root, geometries, materials, { eye: [0, 0, 5.4], target: [0, 0, 0], shadows: false });
}

/** 低分辨率合成天空 + 太阳 + 方位标记，保证朝向/亮度错误都能被像素差暴露。 */
export function parityEnvironmentImage(width = 128, height = 64): { width: number; height: number; data: Float32Array<ArrayBuffer> } {
  const data = new Float32Array(width * height * 3), sun = new THREE.Vector3(-.5, .6, .62).normalize(), patch = new THREE.Vector3(.8, .15, -.5).normalize();
  for (let row = 0; row < height; row++) for (let column = 0; column < width; column++) {
    const polar = (row + .5) / height * Math.PI, azimuth = ((column + .5) / width - .5) * Math.PI * 2;
    const direction = new THREE.Vector3(Math.sin(polar) * Math.cos(azimuth), Math.cos(polar), Math.sin(polar) * Math.sin(azimuth));
    const below = direction.y < 0, ground = .6 + direction.y * .5 + .5, sky = Math.pow(Math.max(0, direction.y), .6);
    const rgb: [number, number, number] = below ? [.14 * ground, .11 * ground, .09 * ground]
      : [(.75 + (.18 - .75) * sky) * .9, (.72 + (.32 - .72) * sky) * .9, (.68 + (.7 - .68) * sky) * .9];
    const sunTerm = 14 * Math.pow(Math.max(0, direction.dot(sun)), 160), patchTerm = 2.5 * Math.pow(Math.max(0, direction.dot(patch)), 24);
    const color = { r: rgb[0] + sunTerm + .6 * patchTerm, g: rgb[1] + .9 * sunTerm + .15 * patchTerm, b: rgb[2] + .72 * sunTerm + .05 * patchTerm };
    data.set([color.r, color.g, color.b], (row * width + column) * 3);
  }
  return { width, height, data };
}

function ibl(): ParityScene {
  const scene = new THREE.Scene(), root = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  scene.add(root); matrixRoot(root, geometries, materials);
  return finish(scene, root, geometries, materials, { eye: [0, 0, 5.4], target: [0, 0, 0], shadows: false, environment: parityEnvironmentImage() });
}

function iblHq(): ParityScene {
  return { ...ibl(), environmentOptions: { specularSize: 256, diffuseSize: 64, sampleCount: 256 } };
}

function directionalShadow(): ParityScene {
  const scene = new THREE.Scene(), root = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  scene.add(root);
  const standard = (color: [number, number, number], roughness: number, metalness = 0) => { const material = new THREE.MeshStandardMaterial({ color: new THREE.Color(...color), roughness, metalness }); materials.push(material); return material; };
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, at: [number, number, number], rotation?: [number, number, number]) => {
    geometries.push(geometry); const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.fromArray(at);
    if (rotation) mesh.rotation.set(...rotation); mesh.castShadow = true; mesh.receiveShadow = true; root.add(mesh);
  };
  add("floor", new THREE.BoxGeometry(9, .2, 9), standard([.62, .62, .6], .85), [0, -1.1, 0]);
  add("ball", sphere(.8), standard([.8, .25, .15], .35), [-.9, -.2, .2]);
  add("block", new THREE.BoxGeometry(1.1, 1.6, 1.1), standard([.2, .45, .8], .6), [1.2, -.2, -.3], [0, .5, 0]);
  add("bar", new THREE.BoxGeometry(.25, 1.2, .25), standard([.9, .85, .2], .4, .5), [.1, -.4, 1.7]);
  const light = new THREE.DirectionalLight(new THREE.Color(1, .95, .9), 3); light.position.set(-3, 5, 3.5);
  light.castShadow = true; light.shadow.mapSize.set(DEFAULT_DISPLAY_CONTRACT.shadow.mapSize, DEFAULT_DISPLAY_CONTRACT.shadow.mapSize);
  const camera = light.shadow.camera; camera.left = -5; camera.right = 5; camera.top = 5; camera.bottom = -5; camera.near = .1; camera.far = 300; camera.updateProjectionMatrix();
  light.shadow.intensity = .38; light.shadow.radius = DEFAULT_DISPLAY_CONTRACT.shadow.radius; light.shadow.blurSamples = DEFAULT_DISPLAY_CONTRACT.shadow.blurSamples;
  light.shadow.bias = DEFAULT_DISPLAY_CONTRACT.shadow.bias; light.shadow.normalBias = DEFAULT_DISPLAY_CONTRACT.shadow.normalBias;
  scene.add(light, light.target);
  return finish(scene, root, geometries, materials, { eye: [3.4, 3.2, 6.2], target: [0, -.5, 0], shadows: true });
}

function aaBloom(): ParityScene {
  const scene = new THREE.Scene(), root = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  scene.add(root);
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, at: [number, number, number], rotation?: [number, number, number]) => {
    geometries.push(geometry); materials.push(material); const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.fromArray(at);
    if (rotation) mesh.rotation.set(...rotation); root.add(mesh);
  };
  const glow = (color: [number, number, number]) => new THREE.MeshStandardMaterial({ color: 0, emissive: new THREE.Color(...color), roughness: .6, metalness: 0 });
  add("glow-a", sphere(.55), glow([1, .95, .85]), [-1.6, .7, 0]); add("glow-b", sphere(.4), glow([.4, .9, 1]), [1.5, .9, .2]);
  add("glow-bar", new THREE.BoxGeometry(2.6, .12, .12), glow([1, .7, .3]), [0, -1.05, .2], [0, 0, .12]);
  add("lit-ball", sphere(.7), new THREE.MeshStandardMaterial({ color: new THREE.Color(.8, .8, .85), roughness: .25, metalness: .8 }), [0, -.1, -.3]);
  add("thin-rod", new THREE.BoxGeometry(.05, 2.4, .05), new THREE.MeshStandardMaterial({ color: new THREE.Color(.9, .2, .2), roughness: .5 }), [1.9, -.1, 0], [0, 0, .35]);
  add("lit-box", new THREE.BoxGeometry(.9, .9, .9), new THREE.MeshStandardMaterial({ color: new THREE.Color(.2, .6, .9), roughness: .5 }), [-1.5, -.9, .3], [.4, .5, 0]);
  key(scene, [-3, 4, 5], 3);
  const { strength, radius, threshold } = DEFAULT_DISPLAY_CONTRACT.bloom;
  return finish(scene, root, geometries, materials, { eye: [0, 0, 6], target: [0, 0, 0], shadows: false, post: { antialias: true, bloom: { strength, radius, threshold } } });
}

/** 诊断：同一场景去掉 SMAA/空间 AA，只剩 Bloom，用来把 aa-bloom 的差距归因到边缘 AA 还是泛光。 */
function bloomOnly(): ParityScene {
  const base = aaBloom();
  return { ...base, post: { ...base.post!, antialias: false } };
}

/**
 * 标准场景：three 走产品 composer 链（线性 HDR 混合 → OutputPass），与 Deep 加权 OIT 的线性合成同口径；AA 关闭以隔离混合语义。
 * `direct=true`：three renderer 直出（逐片元 ACES+sRGB 后再 alpha 混合）——非产品路径，仅诊断。
 */
function transparency(direct = false): ParityScene {
  const scene = new THREE.Scene(), root = new THREE.Group(), geometries: THREE.BufferGeometry[] = [], materials: THREE.Material[] = [];
  scene.add(root);
  const add = (name: string, geometry: THREE.BufferGeometry, material: THREE.Material, at: [number, number, number], order?: number) => {
    geometries.push(geometry); materials.push(material); const mesh = new THREE.Mesh(geometry, material); mesh.name = name; mesh.position.fromArray(at);
    if (order !== undefined) mesh.renderOrder = order; root.add(mesh);
  };
  [[.85, .15, .1], [.1, .7, .2], [.15, .25, .9], [.8, .8, .8]].forEach((color, index) => add(`backdrop-${index}`, new THREE.BoxGeometry(1.1, 3.4, .3),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(...color as [number, number, number]), roughness: .6 }), [(index - 1.5) * 1.15, 0, -1.2]));
  [[0, 1, 1], [1, 0, 1], [1, 1, 0]].forEach((color, index) => add(`glass-${index}`, sphere(.95),
    new THREE.MeshStandardMaterial({ color: new THREE.Color(...color as [number, number, number]).multiplyScalar(.8), roughness: .3, metalness: 0, transparent: true, opacity: .45, depthWrite: false }),
    [(index - 1) * 1.35, .1 * (index - 1), .4 * (1 - index)]));
  key(scene, [-3, 4, 5], 3); key(scene, [4, 1, 3], 1, new THREE.Color(.7, .8, 1));
  return finish(scene, root, geometries, materials, { eye: [0, 0, 6.2], target: [0, 0, 0], shadows: false, ...(direct ? {} : { post: { antialias: false } }) });
}

export function createParityScene(id: ParityScenarioId): ParityScene {
  switch (id) {
    case "pbr-matrix": return pbrMatrix();
    case "ibl": return ibl();
    case "directional-shadow": return directionalShadow();
    case "aa-bloom": return aaBloom();
    case "transparency": return transparency();
    case "ibl-hq": return iblHq();
    case "bloom-only": return bloomOnly();
    case "transparency-direct": return transparency(true);
  }
}

/** 扩展 PBR 瓣（Deep 桥当前 fail-closed 的特性）：每项生成一个独立根，用于机器化记录缺口。 */
export const PARITY_EXTENDED_LOBES = ["transmission", "sheen", "iridescence", "clearcoat", "anisotropy", "dispersion"] as const;
export function createExtendedLobeProbe(lobe: typeof PARITY_EXTENDED_LOBES[number]): { root: THREE.Group; dispose(): void } {
  const root = new THREE.Group(), geometry = sphere(.5), material = new THREE.MeshPhysicalMaterial({ color: new THREE.Color(.8, .8, .8), roughness: .4 });
  (material as unknown as Record<string, number>)[lobe] = lobe === "iridescence" || lobe === "anisotropy" ? .8 : lobe === "dispersion" ? .5 : lobe === "sheen" ? 1 : .6;
  if (lobe === "transmission") material.thickness = 1;
  root.add(new THREE.Mesh(geometry, material)); root.updateMatrixWorld(true);
  return { root, dispose() { geometry.dispose(); material.dispose(); } };
}

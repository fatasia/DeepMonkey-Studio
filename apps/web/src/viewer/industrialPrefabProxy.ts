import * as THREE from "three";
import type { IndustrialPrefabKind } from "@bim-studio/contracts";

const originalMaterials = new WeakMap<THREE.Mesh, THREE.Material | THREE.Material[]>();
const PROXY_MARKER = "industrialPrefabProxy";

/**
 * 只为没有 GLB 外观的基础元素补充可辨识程序化外观；上传模型仍保留作者资产。
 * 代理挂在持久化根对象下，因此选取、变换、碰撞和工业参数仍指向同一个稳定 ID。
 */
export function ensureIndustrialPrefabProxy(root: THREE.Object3D, kind: IndustrialPrefabKind): boolean {
  const mesh = root as THREE.Mesh;
  if (!mesh.isMesh || !root.userData.primitiveKind) return false;
  const current = root.children.find((child) => child.userData[PROXY_MARKER]) as THREE.Group | undefined;
  if (current?.userData.prefabKind === kind) return false;
  clearIndustrialPrefabProxy(root);

  const original = mesh.material;
  if (!originalMaterials.has(mesh)) originalMaterials.set(mesh, original);
  const color = materialColor(original) ?? new THREE.Color("#318f86");
  mesh.material = new THREE.MeshBasicMaterial({ color, visible: false });
  const proxy = buildProxy(kind, color);
  proxy.userData[PROXY_MARKER] = true;
  proxy.userData.prefabKind = kind;
  root.add(proxy);
  return true;
}

export function clearIndustrialPrefabProxy(root: THREE.Object3D): boolean {
  const proxy = root.children.find((child) => child.userData[PROXY_MARKER]);
  if (proxy) {
    root.remove(proxy);
    disposeProxy(proxy);
  }
  const mesh = root as THREE.Mesh;
  const original = mesh.isMesh ? originalMaterials.get(mesh) : undefined;
  if (mesh.isMesh && original) {
    disposeMaterial(mesh.material);
    mesh.material = original;
    originalMaterials.delete(mesh);
  }
  return Boolean(proxy || original);
}

function buildProxy(kind: IndustrialPrefabKind, color: THREE.Color): THREE.Group {
  const group = new THREE.Group();
  const main = material(color, 0.5, 0.22);
  const accent = material(color.clone().offsetHSL(0.02, 0.08, 0.18), 0.38, 0.34);
  const dark = material(new THREE.Color("#17343d"), 0.7, 0.18);

  if (kind === "robot-arm") {
    addCylinder(group, main, [0, -0.78, 0], [0.72, 0.18, 0.72], "底座");
    addCylinder(group, accent, [0, -0.45, 0], [0.38, 0.28, 0.38], "回转台");
    addSphere(group, accent, [0, -0.12, 0], [0.3, 0.3, 0.3], "肩关节");
    addBox(group, main, [0.25, 0.15, 0], [0.18, 0.55, 0.18], "大臂", [0, 0, -0.48]);
    addSphere(group, accent, [0.52, 0.42, 0], [0.22, 0.22, 0.22], "肘关节");
    addBox(group, main, [0.72, 0.62, 0], [0.15, 0.46, 0.15], "小臂", [0, 0, -0.9]);
    addSphere(group, dark, [1.02, 0.83, 0], [0.18, 0.18, 0.18], "末端工具");
  } else if (kind === "conveyor") {
    addBox(group, main, [0, 0.2, 0], [1, 0.15, 0.72], "机架");
    addBox(group, dark, [0, 0.43, 0], [0.95, 0.06, 0.62], "输送面");
    for (const x of [-0.72, -0.24, 0.24, 0.72]) addCylinder(group, accent, [x, 0.5, 0], [0.07, 0.66, 0.07], "辊筒", [Math.PI / 2, 0, 0]);
    for (const x of [-0.72, 0.72]) for (const z of [-0.48, 0.48]) addBox(group, dark, [x, -0.45, z], [0.08, 0.65, 0.08], "支腿");
  } else if (kind === "agv" || kind === "vehicle") {
    addBox(group, main, [0, -0.18, 0], [0.92, 0.38, 0.68], "车体");
    addBox(group, accent, [0.15, 0.28, 0], [0.58, 0.16, 0.48], "载台");
    addBox(group, dark, [0.72, 0.02, 0], [0.12, 0.16, 0.5], "前防撞条");
    for (const x of [-0.58, 0.58]) for (const z of [-0.7, 0.7]) addCylinder(group, dark, [x, -0.48, z], [0.2, 0.1, 0.2], "车轮", [Math.PI / 2, 0, 0]);
  } else if (kind === "person") {
    addCapsule(group, main, [0, -0.15, 0], [0.42, 0.75, 0.42], "躯干");
    addSphere(group, accent, [0, 0.78, 0], [0.32, 0.32, 0.32], "头部");
    addBox(group, dark, [-0.22, -0.88, 0], [0.13, 0.48, 0.16], "左腿");
    addBox(group, dark, [0.22, -0.88, 0], [0.13, 0.48, 0.16], "右腿");
  } else if (kind === "camera" || kind === "sensor") {
    addBox(group, dark, [0, -0.56, 0], [0.18, 0.45, 0.18], "支架");
    addBox(group, main, [0, 0.05, 0], [0.72, 0.42, 0.46], "机身");
    addCylinder(group, accent, [0.7, 0.05, 0], [0.26, 0.22, 0.26], "镜头", [0, 0, Math.PI / 2]);
    addCylinder(group, dark, [0.94, 0.05, 0], [0.18, 0.16, 0.18], "镜片", [0, 0, Math.PI / 2]);
  } else {
    addBox(group, main, [0, -0.05, 0], [0.82, 0.9, 0.68], "设备主体");
    addBox(group, dark, [0, 0.15, 0.7], [0.58, 0.38, 0.06], "控制面板");
    addBox(group, accent, [0, -0.66, 0], [0.68, 0.12, 0.58], "底座");
  }
  return group;
}

function material(color: THREE.Color, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function addBox(group: THREE.Group, mat: THREE.Material, position: number[], scale: number[], name: string, rotation = [0, 0, 0]): void {
  add(group, new THREE.BoxGeometry(1, 1, 1), mat, position, scale, name, rotation);
}
function addSphere(group: THREE.Group, mat: THREE.Material, position: number[], scale: number[], name: string): void {
  add(group, new THREE.SphereGeometry(0.5, 20, 14), mat, position, scale, name);
}
function addCylinder(group: THREE.Group, mat: THREE.Material, position: number[], scale: number[], name: string, rotation = [0, 0, 0]): void {
  add(group, new THREE.CylinderGeometry(0.5, 0.5, 1, 20), mat, position, scale, name, rotation);
}
function addCapsule(group: THREE.Group, mat: THREE.Material, position: number[], scale: number[], name: string): void {
  add(group, new THREE.CapsuleGeometry(0.45, 0.7, 8, 16), mat, position, scale, name);
}
function add(group: THREE.Group, geometry: THREE.BufferGeometry, mat: THREE.Material, position: number[], scale: number[], name: string, rotation = [0, 0, 0]): void {
  const mesh = new THREE.Mesh(geometry, mat);
  mesh.name = name;
  mesh.position.fromArray(position);
  mesh.scale.fromArray(scale);
  mesh.rotation.set(rotation[0] ?? 0, rotation[1] ?? 0, rotation[2] ?? 0);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
}

function materialColor(value: THREE.Material | THREE.Material[]): THREE.Color | undefined {
  const candidate = (Array.isArray(value) ? value[0] : value) as THREE.MeshStandardMaterial | undefined;
  return candidate?.color?.clone();
}

function disposeProxy(root: THREE.Object3D): void {
  const materials = new Set<THREE.Material>();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    mesh.geometry?.dispose();
    const values = Array.isArray(mesh.material) ? mesh.material : mesh.material ? [mesh.material] : [];
    for (const value of values) materials.add(value);
  });
  for (const value of materials) value.dispose();
}

function disposeMaterial(value: THREE.Material | THREE.Material[]): void {
  for (const material of Array.isArray(value) ? value : [value]) material.dispose();
}

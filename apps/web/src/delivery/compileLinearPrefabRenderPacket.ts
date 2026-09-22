import type { PrimitiveState } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import * as THREE from "three";
import { buildLinearPrefabGeometry } from "../prefabs/linearPrefabGeometry";
import { fenceShape, type FenceMaterials } from "../prefabs/parametricFenceGeometry";
import { straightRoadShape, type RoadMaterials } from "../prefabs/parametricRoadGeometry";
import { isNeutralMaterialField, staticSceneEffectEmissive } from "./sceneNeutralAppearance";

/** Compiles the same deterministic procedural geometry consumed by the author preview into Deep Web/Native packets. */
export function compileLinearPrefabRenderPacket(item: PrimitiveState, rootMatrix: THREE.Matrix4): RenderPacket {
  const state = item.prefab;
  if (!state?.placementPath || (state.kind !== "fence" && state.kind !== "road")) {
    throw new Error(`基础体 ${item.modelId} 的预制体尚未适配发布`);
  }
  const materials = state.kind === "fence" ? fenceMaterials(item) : roadMaterials(state.parameters);
  const root = buildLinearPrefabGeometry(state, materials);
  if (!root) throw new Error(`基础体 ${item.modelId} 的铺设路径无法生成`);
  root.updateMatrixWorld(true);
  const geometries: RenderPacket["geometries"][number][] = [];
  const packetMaterials: RenderPacket["materials"][number][] = [];
  const instances: RenderPacket["instances"][number][] = [];
  const geometryIds = new Map<THREE.BufferGeometry, string>();
  const materialIds = new Map<THREE.Material, string>();
  let instanceIndex = 0;
  try {
    root.traverse(object => {
      if (!(object instanceof THREE.Mesh) || Array.isArray(object.material)) return;
      let geometryId = geometryIds.get(object.geometry);
      if (!geometryId) {
        geometryId = `${item.modelId}/prefab/geometry/${geometryIds.size}`;
        geometryIds.set(object.geometry, geometryId);
        geometries.push(geometryResource(object.geometry, geometryId));
      }
      let materialId = materialIds.get(object.material);
      if (!materialId) {
        materialId = `${item.modelId}/prefab/material/${materialIds.size}`;
        materialIds.set(object.material, materialId);
        packetMaterials.push(materialResource(object.material, materialId, item));
      }
      if (object instanceof THREE.InstancedMesh) {
        const local = new THREE.Matrix4();
        for (let index = 0; index < object.count; index++) {
          object.getMatrixAt(index, local);
          addInstance(rootMatrix.clone().multiply(object.matrixWorld).multiply(local), object, geometryId, materialId);
        }
      } else addInstance(rootMatrix.clone().multiply(object.matrixWorld), object, geometryId, materialId);
    });
    return { geometries, materials: packetMaterials, instances };
  } finally {
    disposeGenerated(root);
  }

  function addInstance(transform: THREE.Matrix4, mesh: THREE.Mesh, geometry: string, material: string): void {
    instances.push({ id: `${item.modelId}/prefab/part/${instanceIndex++}`, geometry, material,
      transform: new Float32Array(transform.elements), castShadow: mesh.castShadow, receiveShadow: mesh.receiveShadow,
      ...(item.effects?.outline ? { outline: true } : {}) });
  }
}

function geometryResource(geometry: THREE.BufferGeometry, id: string): RenderPacket["geometries"][number] {
  const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal"), uv = geometry.getAttribute("uv");
  if (!position || !normal) throw new Error(`铺设几何 ${id} 缺少位置或法线`);
  const vertices = new Float32Array(position.count * 6);
  const uv0 = uv ? new Float32Array(position.count * 2) : undefined;
  for (let index = 0; index < position.count; index++) {
    vertices.set([position.getX(index), position.getY(index), position.getZ(index),
      normal.getX(index), normal.getY(index), normal.getZ(index)], index * 6);
    if (uv0) uv0.set([uv.getX(index), uv.getY(index)], index * 2);
  }
  const indices = geometry.index ? Uint32Array.from(geometry.index.array)
    : Uint32Array.from({ length: position.count }, (_, index) => index);
  return { id, revision: 1, vertices, ...(uv0 ? { uv0 } : {}), indices };
}

function materialResource(source: THREE.Material, id: string, item: PrimitiveState): RenderPacket["materials"][number] {
  if (!(source instanceof THREE.MeshStandardMaterial)) throw new Error(`铺设材质 ${source.type} 尚未适配`);
  const state = item.material;
  const supported = new Set(["color", "roughness", "metalness", "ior", "emissive", "emissiveIntensity", "doubleSided"]);
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value !== undefined && !supported.has(key) && !isNeutralMaterialField(key, value)) {
      throw new Error(`基础体 ${item.modelId} 的铺设材质需要适配：${key}`);
    }
  }
  const overrideColor = state?.color ?? item.colorOverride;
  if (overrideColor && !/^#[\da-f]{6}$/i.test(overrideColor)) throw new Error(`基础体 ${item.modelId} 的颜色无效`);
  const color = overrideColor ? new THREE.Color(overrideColor) : source.color;
  const opacity = finiteRange(source.opacity * finiteRange(item.opacity, 0, 1, "透明度"), 0, 1, "透明度");
  const effectEmissive = staticSceneEffectEmissive(item.effects);
  const emissive = new THREE.Color(effectEmissive?.color ?? state?.emissive ?? source.emissive);
  const ior = state?.ior;
  if (ior !== undefined && (!Number.isFinite(ior) || ior < 1)) throw new Error(`基础体 ${item.modelId} 的折射率无效`);
  return { id, baseColor: [color.r, color.g, color.b], metallic: finiteRange(state?.metalness ?? source.metalness, 0, 1, "金属度"),
    roughness: finiteRange(state?.roughness ?? source.roughness, 0, 1, "粗糙度"), ...(ior === undefined ? {} : { ior }),
    baseColorAlpha: opacity, alphaMode: source.transparent || opacity < 0.999 ? "BLEND" : "OPAQUE",
    doubleSided: state?.doubleSided ?? source.side === THREE.DoubleSide,
    emissiveFactor: [emissive.r, emissive.g, emissive.b],
    emissiveStrength: effectEmissive?.strength ?? finiteRange(state?.emissiveIntensity ?? source.emissiveIntensity, 0, 256, "自发光强度") };
}

function fenceMaterials(item: PrimitiveState): FenceMaterials {
  const color = new THREE.Color(item.material?.color ?? item.colorOverride ?? item.color);
  const metal = standard(color, 0.45, 0.55), dark = standard(color.clone().multiplyScalar(0.35), 0.7, 0.2);
  const panelKind = fenceShape(item.prefab?.parameters).panel;
  const panel = panelKind === "glass" ? new THREE.MeshStandardMaterial({ color, roughness: 0.12, transparent: true, opacity: 0.35 }) : metal;
  const warning = panelKind === "electronic"
    ? new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.6, roughness: 0.45 }) : metal;
  return { metal, dark, panel, warning };
}

function roadMaterials(parameters: Record<string, unknown>): RoadMaterials {
  const surfaceKind = straightRoadShape(parameters).surface;
  const surfaceColor = new THREE.Color(surfaceKind === "concrete" ? "#7d8180" : "#34393c");
  return { surface: standard(surfaceColor, surfaceKind === "concrete" ? 0.82 : 0.9, 0),
    shoulder: standard(surfaceColor.clone().multiplyScalar(0.72), 0.95, 0),
    marking: standard(new THREE.Color("#e7dfbf"), 0.68, 0) };
}

function standard(color: THREE.Color, roughness: number, metalness: number): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

function disposeGenerated(root: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>(), materials = new Set<THREE.Material>();
  root.traverse(object => {
    if (!(object instanceof THREE.Mesh)) return;
    geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) materials.add(material);
  });
  geometries.forEach(geometry => geometry.dispose());
  materials.forEach(material => material.dispose());
}

function finiteRange(value: number, min: number, max: number, label: string): number {
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`铺设材质${label}必须在 ${min}..${max}`);
  return value;
}

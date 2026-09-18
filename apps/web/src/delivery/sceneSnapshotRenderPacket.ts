import type { PrimitiveState, SceneSnapshot } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { Color } from "three";
import { primitiveGeometry } from "../viewer/primitiveGeometry";
import { sceneModelMatrix } from "./sceneModelMatrix";
import { createSceneGeometryPrecisionValidator } from "./sceneGeometryPrecision";

/** 基础体静态绘制投影；相机、环境、行为与二维语义由发布编译器分别处理。 */
export function sceneSnapshotToRenderPacket(scene: SceneSnapshot): RenderPacket {
  if (scene.models.length) throw new Error(`Native 场景需要模型资源适配：${scene.models[0]!.modelId}`);
  const geometries = new Map<string, RenderPacket["geometries"][number]>();
  const materials: Array<RenderPacket["materials"][number]> = [];
  const instances: Array<RenderPacket["instances"][number]> = [];
  const ids = new Set<string>();
  const verifyGeometryPrecision = createSceneGeometryPrecisionValidator();
  for (const primitive of [...scene.primitives].sort((a, b) => compare(a.modelId, b.modelId))) {
    if (!primitive.modelId || ids.has(primitive.modelId)) throw new Error(`重复或缺少基础体 ID：${primitive.modelId}`);
    ids.add(primitive.modelId);
    if (!primitive.visible) continue;
    const geometryId = `primitive:${primitive.kind}`;
    const material = primitiveMaterial(primitive);
    if (!geometries.has(geometryId)) geometries.set(geometryId, geometryResource(primitive.kind, geometryId));
    materials.push(material);
    const matrix = sceneModelMatrix(primitive.transform, primitive.modelId);
    verifyGeometryPrecision(geometries.get(geometryId)!, matrix.elements, `primitives[${primitive.modelId}]`);
    instances.push({ id: primitive.modelId, geometry: geometryId, material: material.id,
      transform: new Float32Array(matrix.elements), castShadow: true, receiveShadow: true });
  }
  return { geometries: [...geometries.values()].sort((a, b) => compare(a.id, b.id)), materials, instances };
}

function primitiveMaterial(item: PrimitiveState): RenderPacket["materials"][number] {
  const state = item.material;
  const supported = new Set(["color", "roughness", "metalness", "emissive", "emissiveIntensity", "doubleSided"]);
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value !== undefined && !supported.has(key)) throw new Error(`基础体 ${item.modelId} 的材质需要适配：${key}`);
  }
  // 会改变几何或外观的配置不能静默丢弃。
  if (item.prefab || item.layers?.length || item.effects || item.rig || item.explosionFactor) {
    throw new Error(`基础体 ${item.modelId} 的扩展外观需要适配`);
  }
  const baseColor = linearColor(state?.color ?? item.colorOverride ?? item.color, item.modelId);
  const opacity = finite(item.opacity, item.modelId);
  if (opacity < 0 || opacity > 1) throw new Error(`基础体 ${item.modelId} 的透明度超出 0..1`);
  return { id: `material:${item.modelId}`, baseColor,
    metallic: clamp(state?.metalness ?? 0.05, 1, item.modelId),
    roughness: clamp(state?.roughness ?? 0.72, 1, item.modelId),
    baseColorAlpha: opacity, alphaMode: opacity < 0.999 ? "BLEND" : "OPAQUE",
    doubleSided: state?.doubleSided ?? false,
    emissiveFactor: linearColor(state?.emissive ?? "#000000", item.modelId),
    emissiveStrength: clamp(state?.emissiveIntensity ?? 1, 10, item.modelId) };
}

function linearColor(value: string, id: string): [number, number, number] {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`基础体 ${id} 的颜色必须为 #RRGGBB：${value}`);
  const color = new Color(value);
  return [color.r, color.g, color.b];
}

function geometryResource(kind: PrimitiveState["kind"], id: string): RenderPacket["geometries"][number] {
  if (!["box", "sphere", "cylinder", "cone", "torus", "plane", "capsule"].includes(kind)) {
    throw new Error(`未知基础体类型：${kind}`);
  }
  const geometry = primitiveGeometry(kind);
  try {
    const position = geometry.getAttribute("position"), normal = geometry.getAttribute("normal");
    const uv = geometry.getAttribute("uv"), vertices = new Float32Array(position.count * 6);
    const uv0 = new Float32Array(position.count * 2);
    for (let index = 0; index < position.count; index++) {
      vertices.set([position.getX(index), position.getY(index), position.getZ(index),
        normal.getX(index), normal.getY(index), normal.getZ(index)], index * 6);
      uv0.set([uv.getX(index), uv.getY(index)], index * 2);
    }
    const indices = geometry.index ? Uint32Array.from(geometry.index.array)
      : Uint32Array.from({ length: position.count }, (_, index) => index);
    return { id, revision: 1, vertices, uv0, indices };
  } finally { geometry.dispose(); }
}

function finite(value: number, id: string): number {
  if (!Number.isFinite(value)) throw new Error(`基础体 ${id} 包含非有限数值`);
  return value;
}
function clamp(value: number, max: number, id: string): number { return Math.max(0, Math.min(max, finite(value, id))); }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }

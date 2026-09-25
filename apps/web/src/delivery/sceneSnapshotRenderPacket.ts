import type { PrimitiveState, SceneSnapshot } from "@bim-studio/contracts";
import type { RenderPacket } from "@bim-studio/deep-engine";
import { Matrix4 } from "three";
import { primitiveGeometry } from "../viewer/primitiveGeometry";
import { sceneModelMatrixValues } from "./sceneModelMatrixValues";
import { createSceneGeometryPrecisionValidator } from "./sceneGeometryPrecision";
import { isNeutralMaterialField, sceneHexToLinearRgb, staticSceneEffectEmissive, unsupportedStaticSceneEffectFields } from "./sceneNeutralAppearance";
import { compileLinearPrefabRenderPacket } from "./compileLinearPrefabRenderPacket";

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
    const matrix = sceneModelMatrixValues(primitive.transform, primitive.modelId);
    if (primitive.prefab) {
      assertPrimitiveExtensions(primitive, true);
      const compiled = compileLinearPrefabRenderPacket(primitive, new Matrix4().fromArray(matrix));
      for (const geometry of compiled.geometries) geometries.set(geometry.id, geometry);
      materials.push(...compiled.materials);
      instances.push(...compiled.instances);
      for (const instance of compiled.instances) verifyGeometryPrecision(geometries.get(instance.geometry)!, instance.transform,
        `primitives[${primitive.modelId}].${instance.id}`);
      continue;
    }
    const geometryId = `primitive:${primitive.kind}`;
    const material = primitiveMaterial(primitive);
    if (!geometries.has(geometryId)) geometries.set(geometryId, geometryResource(primitive.kind, geometryId));
    materials.push(material);
    verifyGeometryPrecision(geometries.get(geometryId)!, matrix, `primitives[${primitive.modelId}]`);
    instances.push({ id: primitive.modelId, geometry: geometryId, material: material.id,
      transform: new Float32Array(matrix), castShadow: true, receiveShadow: true,
      ...(primitive.effects?.outline ? { outline: true } : {}) });
  }
  return { geometries: [...geometries.values()].sort((a, b) => compare(a.id, b.id)), materials, instances };
}

function primitiveMaterial(item: PrimitiveState): RenderPacket["materials"][number] {
  const state = item.material;
  const supported = new Set(["color", "roughness", "metalness", "ior", "emissive", "emissiveIntensity", "doubleSided", "customShader"]);
  for (const [key, value] of Object.entries(state ?? {})) {
    if (value !== undefined && !supported.has(key) && !isNeutralMaterialField(key, value)) throw new Error(`基础体 ${item.modelId} 的材质需要适配：${key}`);
  }
  // 会改变几何或外观的配置不能静默丢弃。
  assertPrimitiveExtensions(item, false);
  const baseColor = linearColor(state?.color ?? item.colorOverride ?? item.color, item.modelId);
  const opacity = finite(item.opacity, item.modelId);
  if (opacity < 0 || opacity > 1) throw new Error(`基础体 ${item.modelId} 的透明度超出 0..1`);
  const ior = state?.ior;
  if (ior !== undefined && (!Number.isFinite(ior) || !Number.isFinite(Math.fround(ior)) || ior < 1)) {
    throw new Error(`基础体 ${item.modelId} 的折射率必须为不小于 1 的有限数值`);
  }
  const effectEmissive = staticSceneEffectEmissive(item.effects);
  return { id: `material:${item.modelId}`, baseColor,
    metallic: clamp(state?.metalness ?? 0.05, 1, item.modelId),
    roughness: clamp(state?.roughness ?? 0.72, 1, item.modelId),
    ...(ior === undefined ? {} : { ior }),
    baseColorAlpha: opacity, alphaMode: opacity < 0.999 ? "BLEND" : "OPAQUE",
    doubleSided: state?.doubleSided ?? false,
    emissiveFactor: linearColor(effectEmissive?.color ?? state?.emissive ?? "#000000", item.modelId),
    emissiveStrength: effectEmissive?.strength ?? clamp(state?.emissiveIntensity ?? 1, 10, item.modelId) };
}

function assertPrimitiveExtensions(item: PrimitiveState, allowPrefab: boolean): void {
  const activeEffects = unsupportedStaticSceneEffectFields(item.effects);
  if ((!allowPrefab && item.prefab) || item.layers?.length || activeEffects.length || item.rig || item.explosionFactor) {
    const fields = [!allowPrefab && item.prefab ? "prefab" : undefined, item.layers?.length ? "layers" : undefined,
      ...activeEffects, item.rig ? "rig" : undefined, item.explosionFactor ? "explosionFactor" : undefined]
      .filter((value): value is string => value !== undefined);
    throw new Error(`基础体 ${item.modelId} 的扩展外观需要适配：${fields.join(", ")}`);
  }
}

function linearColor(value: string, id: string): [number, number, number] {
  if (!/^#[\da-f]{6}$/i.test(value)) throw new Error(`基础体 ${id} 的颜色必须为 #RRGGBB：${value}`);
  return sceneHexToLinearRgb(value);
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

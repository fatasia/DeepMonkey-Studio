import type { ScenePostProcessingState } from "@bim-studio/contracts";
import * as THREE from "three";
import type { RendererBackend } from "./viewerTypes";

const TEXTURE_SLOTS = [
  "map", "alphaMap", "aoMap", "bumpMap", "displacementMap", "emissiveMap",
  "envMap", "lightMap", "metalnessMap", "normalMap", "roughnessMap",
] as const;

/**
 * 生成影响着色器结构的稳定签名。颜色、强度和对象数量属于 uniform/实例数据，
 * 不应让相同管线在每次场景恢复时重复预编译。
 */
export function rendererPipelineSignature(
  scene: THREE.Scene,
  backend: RendererBackend,
  postProcessing?: ScenePostProcessingState,
): string {
  const renderVariants = new Set<string>();
  const lightCounts = new Map<string, number>();

  scene.traverseVisible((object) => {
    if (object instanceof THREE.Light) {
      const key = `${object.type}:shadow=${"castShadow" in object && object.castShadow ? 1 : 0}`;
      lightCounts.set(key, (lightCounts.get(key) ?? 0) + 1);
      return;
    }
    const renderable = object as THREE.Mesh & { geometry?: THREE.BufferGeometry; material?: THREE.Material | THREE.Material[] };
    if (!renderable.geometry || !renderable.material) return;
    const geometry = geometryVariant(renderable.geometry);
    const objectFeatures = [
      object.type,
      `skin=${object instanceof THREE.SkinnedMesh ? 1 : 0}`,
      `instanced=${object instanceof THREE.InstancedMesh ? 1 : 0}`,
      `morph=${renderable.morphTargetInfluences ? 1 : 0}`,
      `cast=${object.castShadow ? 1 : 0}`,
      `receive=${object.receiveShadow ? 1 : 0}`,
    ].join(":");
    const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material];
    for (const material of materials) renderVariants.add(`${objectFeatures}|${geometry}|${materialVariant(material)}`);
  });

  const sceneFeatures = [
    backend,
    `fog=${scene.fog instanceof THREE.FogExp2 ? "FogExp2" : scene.fog ? "Fog" : "none"}`,
    `background=${scene.background instanceof THREE.Texture ? "texture" : "color"}`,
    `environment=${scene.environment ? "texture" : "none"}`,
    `lights=${[...lightCounts].sort(([left], [right]) => left.localeCompare(right)).map(([key, count]) => `${key}x${count}`).join(",")}`,
    `post=${postProcessingVariant(postProcessing)}`,
  ];
  return [...sceneFeatures, ...[...renderVariants].sort()].join("\n");
}

function geometryVariant(geometry: THREE.BufferGeometry): string {
  const attributes = Object.keys(geometry.attributes).sort().join(",");
  const morphAttributes = Object.entries(geometry.morphAttributes)
    .filter(([, values]) => (values?.length ?? 0) > 0)
    .map(([name]) => name)
    .sort()
    .join(",");
  return `geometry:${attributes}:index=${geometry.index ? 1 : 0}:morph=${morphAttributes}`;
}

function materialVariant(material: THREE.Material): string {
  const record = material as THREE.Material & Record<string, unknown>;
  const textures = TEXTURE_SLOTS.filter((slot) => record[slot] instanceof THREE.Texture).join(",");
  const defines = record.defines && typeof record.defines === "object"
    ? Object.entries(record.defines as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right))
    : [];
  return [
    material.type,
    `side=${material.side}`,
    `transparent=${material.transparent ? 1 : 0}`,
    `alphaTest=${material.alphaTest > 0 ? 1 : 0}`,
    `blend=${material.blending}`,
    `depth=${material.depthTest ? 1 : 0}/${material.depthWrite ? 1 : 0}`,
    `vertexColors=${material.vertexColors ? 1 : 0}`,
    `flat=${record.flatShading ? 1 : 0}`,
    `textures=${textures}`,
    `defines=${JSON.stringify(defines)}`,
    `custom=${safeProgramKey(material)}`,
  ].join(":");
}

function safeProgramKey(material: THREE.Material): string {
  try {
    return material.customProgramCacheKey();
  } catch {
    return "unavailable";
  }
}

function postProcessingVariant(state?: ScenePostProcessingState): string {
  if (!state?.enabled) return "off";
  return [
    `quality=${state.qualityProfile ?? "adaptive"}`,
    "smaa", "fxaa", "ssao", "gtao", "screenSpaceReflection", "bloom", "outline", "depthOfField",
    "vignette", "filmGrain", "afterimage",
  ].filter((key) => Boolean(state[key as keyof ScenePostProcessingState])).join(",") || "enabled";
}

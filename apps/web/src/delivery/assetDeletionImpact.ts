/**
 * T12 缺口闭环:资产/模型删除前的引用影响检查(纯客户端)。
 *
 * 语义:删除 targetId 前扫描场景快照集合,产出"哪些场景、哪些字段路径"引用了它,
 * 供删除确认 UI 呈现影响清单。匹配双通道:
 * 1. 精确值(实例 modelId 等字段 === targetId);
 * 2. 资产 URL 引用(字符串含 `assets/{targetId}`,覆盖环境贴图/材质 map 上传后的 URL 形态)。
 * 深遍历不依赖具体字段名——新增引用字段自动纳入,不需要本模块跟进。
 */
import type { SceneSnapshot } from "@bim-studio/contracts";

export interface AssetDeletionImpactScene {
  readonly sceneId: string;
  readonly sceneName: string;
  /** 引用字段路径(如 `models[2].modelId`、`environment.settings.url`),按路径排序。 */
  readonly references: readonly string[];
}

export interface AssetDeletionImpact {
  readonly targetId: string;
  readonly scenes: readonly AssetDeletionImpactScene[];
  readonly totalReferences: number;
}

function* walkStrings(node: unknown, path: string): Generator<[string, string]> {
  if (node === null || node === undefined) return;
  if (typeof node === "string") {
    yield [path, node];
    return;
  }
  if (typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (let index = 0; index < node.length; index += 1) yield* walkStrings(node[index], `${path}[${index}]`);
    return;
  }
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    yield* walkStrings(value, path ? `${path}.${key}` : key);
  }
}

/** 计算删除 targetId 的场景级影响清单;scenes 来自既有 listScenes API。 */
export function computeAssetDeletionImpact(targetId: string, scenes: readonly SceneSnapshot[]): AssetDeletionImpact {
  if (!targetId) throw new Error("computeAssetDeletionImpact: targetId is required.");
  const urlFragment = `assets/${targetId}`;
  const impacted: AssetDeletionImpactScene[] = [];
  let totalReferences = 0;
  for (const scene of scenes) {
    const references: string[] = [];
    for (const [path, value] of walkStrings(scene, "")) {
      if (value === targetId || value.includes(urlFragment)) references.push(path);
    }
    if (references.length) {
      impacted.push({ sceneId: scene.id, sceneName: scene.name, references: [...references].sort() });
      totalReferences += references.length;
    }
  }
  return { targetId, scenes: impacted, totalReferences };
}

/** 人话摘要(确认弹窗文案);无引用返回 undefined。 */
export function describeAssetDeletionImpact(impact: AssetDeletionImpact): string | undefined {
  if (!impact.totalReferences) return undefined;
  const head = impact.scenes
    .slice(0, 3)
    .map(scene => `「${scene.sceneName}」(${scene.references.length} 处)`)
    .join("、");
  const more = impact.scenes.length > 3 ? ` 等 ${impact.scenes.length} 个场景` : "";
  return `仍被 ${head}${more} 共 ${impact.totalReferences} 处引用,删除后这些位置的引用将失效。`;
}

import type { SceneSnapshot } from "@bim-studio/contracts";

/** 编译源仅忽略顶层保存/发布时间；历史版本和 CAS 仍使用完整快照身份。 */
export function sceneCompilationSource(scene: SceneSnapshot): Record<string, unknown> {
  // 保留 JSON 的 undefined 省略规则，拒绝被 stringify 静默转换的非有限数字。
  const source = JSON.parse(JSON.stringify(scene, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("场景 JSON 语义包含非有限数值");
    if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") throw new Error("场景语义包含非 JSON 值");
    return value;
  })) as Record<string, unknown>;
  delete source.updatedAt;
  delete source.publishedAt;
  return source;
}

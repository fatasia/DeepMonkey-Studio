import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { industrialPrefabDefinition } from "../industrialPrefabCatalog";
import { PREFAB_MODEL_MATCHES, prefabModelMatchCount, prefabModelMatchFor, prefabModelPreviewUrl } from "./prefabModelMatches";

/**
 * 匹配表一致性校验:
 * - source-a 条目(`industrial-{id}`):引用模型必须真实存在、名称对得上,
 *   且已通过质量审核(preview 端点才会返回 GLB);
 * - source-b 条目(`community-{uid}`):引用模型必须在 source-b catalog 中、
 *   许可为 CC0-1.0/CC-BY-4.0 且署名完整,audit 中有 approved 视觉复核记录,
 *   公开名(displayName)与匹配表 name 一致。
 * 只读引用 data/external-assets,不改动任何数据文件。
 */

interface SourceACatalogModel { id: number; name: string; type?: { name?: string } }
interface SourceAAuditItem { sourceModelId: string; valid?: boolean; duplicateOf?: string; qualityStatus?: string }

interface SourceBModel { uid: string; name: string; license: string; author: string; attribution: string; sha256: string; publicationStatus: string; modelAudit?: { valid?: boolean } }
interface SourceBReview { uid: string; status: string; displayName: string; contentHash: string }

function findDataDir(): string | undefined {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  while (dir !== path.dirname(dir)) {
    const candidate = path.join(dir, "data", "external-assets");
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return undefined;
}

const dataDir = findDataDir();
const sourceA = {
  catalog: dataDir ? JSON.parse(readFileSync(path.join(dataDir, "source-a", "catalog.json"), "utf8")) as { models: SourceACatalogModel[] } : { models: [] },
  audit: dataDir ? JSON.parse(readFileSync(path.join(dataDir, "source-a", "audit.json"), "utf8")) as { items: SourceAAuditItem[] } : { items: [] },
};
const sourceAById = new Map(sourceA.catalog.models.map((model) => [String(model.id), model]));
const sourceAAuditById = new Map(sourceA.audit.items.map((item) => [item.sourceModelId, item]));

const sourceB = {
  catalog: dataDir ? JSON.parse(readFileSync(path.join(dataDir, "source-b", "catalog.json"), "utf8")) as { models: SourceBModel[] } : { models: [] },
  audit: dataDir ? JSON.parse(readFileSync(path.join(dataDir, "source-b", "audit.json"), "utf8")) as { items: SourceBReview[] } : { items: [] },
};
const sourceBByUid = new Map(sourceB.catalog.models.map((model) => [model.uid, model]));
const sourceBReviewByUid = new Map(sourceB.audit.items.map((item) => [item.uid, item]));

describe.skipIf(!dataDir)("prefabModelMatches [skipped: external asset catalogs unavailable]", () => {
  it("每个匹配键都是真实存在的预制体定义 id", () => {
    for (const definitionId of Object.keys(PREFAB_MODEL_MATCHES)) {
      expect(industrialPrefabDefinition(definitionId), `未知预制体:${definitionId}`).toBeDefined();
    }
  });

  it("每个 assetId 都是可识别的来源格式(industrial-{id} 或 community-{uid})", () => {
    for (const [definitionId, match] of Object.entries(PREFAB_MODEL_MATCHES)) {
      expect(match.assetId, `${definitionId} 的 assetId 格式无效`).toMatch(/^(industrial-\d+|community-[a-f0-9]{32})$/);
    }
  });

  it("source-a 匹配:assetId 在 catalog 中存在且名称一致", () => {
    for (const [definitionId, match] of Object.entries(PREFAB_MODEL_MATCHES)) {
      if (!match.assetId.startsWith("industrial-")) continue;
      const modelId = match.assetId.replace(/^industrial-/, "");
      const model = sourceAById.get(modelId);
      expect(model, `${definitionId} → ${match.assetId} 不在 source-a catalog 中`).toBeDefined();
      expect(match.name, `${definitionId} 的模型名与 source-a catalog 不一致`).toBe(model!.name);
    }
  });

  it("source-a 匹配:模型已通过质量审核(valid、非重复、ready),preview 才可用", () => {
    for (const [definitionId, match] of Object.entries(PREFAB_MODEL_MATCHES)) {
      if (!match.assetId.startsWith("industrial-")) continue;
      const modelId = match.assetId.replace(/^industrial-/, "");
      const auditItem = sourceAAuditById.get(modelId);
      expect(auditItem, `${definitionId} → ${match.assetId} 缺少审核记录`).toBeDefined();
      expect(auditItem!.valid, `${match.assetId} 校验失败`).toBe(true);
      expect(auditItem!.duplicateOf, `${match.assetId} 是重复资产`).toBeUndefined();
      expect(auditItem!.qualityStatus, `${match.assetId} 未达 ready`).toBe("ready");
    }
  });

  it("source-b 匹配:catalog 记录存在,许可为 CC0/CC-BY 且署名完整、结构有效、已发布", () => {
    for (const [definitionId, match] of Object.entries(PREFAB_MODEL_MATCHES)) {
      if (!match.assetId.startsWith("community-")) continue;
      const uid = match.assetId.replace(/^community-/, "");
      const model = sourceBByUid.get(uid);
      expect(model, `${definitionId} → ${match.assetId} 不在 source-b catalog 中`).toBeDefined();
      expect(["CC0-1.0", "CC-BY-4.0"], `${match.assetId} 许可不合规`).toContain(model!.license);
      expect(model!.author.trim(), `${match.assetId} 缺少作者署名`).not.toBe("");
      expect(model!.attribution, `${match.assetId} 缺少完整 attribution`).toContain(model!.license);
      expect(model!.publicationStatus, `${match.assetId} 未发布`).toBe("published");
      expect(model!.modelAudit?.valid, `${match.assetId} 结构审计未通过`).toBe(true);
      expect(sourceBReviewByUid.get(uid)?.contentHash, `${match.assetId} 复核哈希与模型不一致`).toBe(model!.sha256);
    }
  });

  it("source-b 匹配:存在 approved 视觉复核记录,公开名与匹配表一致", () => {
    for (const [definitionId, match] of Object.entries(PREFAB_MODEL_MATCHES)) {
      if (!match.assetId.startsWith("community-")) continue;
      const uid = match.assetId.replace(/^community-/, "");
      const review = sourceBReviewByUid.get(uid);
      expect(review, `${definitionId} → ${match.assetId} 缺少视觉复核记录`).toBeDefined();
      expect(review!.status, `${match.assetId} 未通过视觉复核`).toBe("approved");
      expect(match.name, `${definitionId} 的名称与复核 displayName 不一致`).toBe(review!.displayName);
    }
  });

  it("preview URL 与 assetLibraryApi 的地址约束一致", () => {
    expect(prefabModelPreviewUrl("industrial-576")).toBe("/api/asset-library/items/industrial-576/preview");
    expect(prefabModelPreviewUrl("industrial-576")).toMatch(/^\/api\/asset-library\/items\/[^/?#]+\/preview$/);
    expect(prefabModelPreviewUrl("community-" + "a".repeat(32))).toMatch(/^\/api\/asset-library\/items\/[^/?#]+\/preview$/);
  });

  it("取表与计数一致", () => {
    expect(prefabModelMatchFor("robot.articulated-6")).toEqual({ assetId: "industrial-576", name: "机械臂" });
    expect(prefabModelMatchCount()).toBe(Object.keys(PREFAB_MODEL_MATCHES).length);
  });

  it("匹配规模保持在批处理水位:≥70 个预制体有真实模型", () => {
    // 120 个预制体中无达标真实模型的(部分机器人/传感器/特种车辆等)
    // 保持缺失走程序化兜底;这里防止匹配表被误清空。
    expect(prefabModelMatchCount()).toBeGreaterThanOrEqual(70);
  });
});

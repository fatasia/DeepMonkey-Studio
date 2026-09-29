import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  RENDERER_CAPABILITY_CONTRACT_VERSION,
  RENDERER_CAPABILITY_IDS,
  RENDERER_CAPABILITY_MANIFEST,
  RENDERER_CAPABILITY_REASON_CODES,
  RENDERER_CAPABILITY_SUPPORT_VOCABULARY,
  REASON_PAIRS_FOR_SUPPORT,
  findRendererCapabilityEntry,
  rendererCapabilityCoverageReport,
  rendererCapabilityDeclarationIssues,
  rendererCapabilityEvidencePath,
  rendererCapabilityManifestJson,
  type RendererCapabilityManifestEntry,
} from "./rendererCapabilityManifest.js";

/** deep-engine TS 自检导出(跨包动态导入;该模块导入闭包无 bare 依赖)。 */
interface SelfCheckRow {
  readonly capabilityId: string;
  readonly support: "supported" | "degraded" | "unavailable";
  readonly reason: string;
  readonly passIds?: readonly string[];
  readonly observed: Readonly<Record<string, string | number | boolean | ReadonlyArray<string | number>>>;
}
interface SelfCheckModule {
  readonly PBR_RENDERER_CAPABILITY_SELF_CHECK: readonly SelfCheckRow[];
  readonly PBR_RENDERER_TS_SURFACE: {
    readonly featureKeys: readonly string[];
    readonly timedPassIds: readonly string[];
    readonly giDirectionStandard: number;
    readonly giDirectionHigh: number;
    readonly materialCoreBlockBytes: number;
    readonly contactShadowQualityTiers: readonly string[];
  };
}

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const FIXTURE_PATH = new URL("../fixtures/renderer-capability-manifest.json", import.meta.url);
const RUST_MODULE_PATH = "packages/deep-engine-native/src/renderer_capability_manifest.rs";
const FEATURES_SOURCE_PATH = "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts";

async function loadSelfCheck(): Promise<SelfCheckModule> {
  // 跨包动态导入:Vite 在变换期解析相对路径;该模块导入闭包无 bare 依赖,
  // 可在 contracts 测试环境安全加载(deep-engine 自身 vitest 同一解析行为)。
  return await import("../../deep-engine/src/webgpu/rendererCapabilitySelfCheck.ts") as SelfCheckModule;
}

/** 支持档/原因码 → Rust 枚举变体名(kebab↔Pascal 镜像,用于 Rust 模块文本对拍)。 */
function rustSupportVariant(support: string): string {
  return support.charAt(0).toUpperCase() + support.slice(1);
}
function rustReasonVariant(reason: string): string {
  return reason.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

describe("J4 渲染能力清单 —— 结构自洽", () => {
  it("能力 id 单源数组与登记行一一对应且唯一", () => {
    expect(RENDERER_CAPABILITY_IDS.length).toBeGreaterThanOrEqual(27);
    expect(new Set(RENDERER_CAPABILITY_IDS).size).toBe(RENDERER_CAPABILITY_IDS.length);
    expect(RENDERER_CAPABILITY_IDS).toEqual(RENDERER_CAPABILITY_MANIFEST.map((entry) => entry.id));
    for (const id of RENDERER_CAPABILITY_IDS) {
      expect(findRendererCapabilityEntry(id)?.id).toBe(id);
    }
    expect(findRendererCapabilityEntry("no-such-capability")).toBeUndefined();
  });

  it("词汇封闭:支持档与原因码均在封闭集内,且配对合法", () => {
    expect([...RENDERER_CAPABILITY_SUPPORT_VOCABULARY]).toEqual(["supported", "degraded", "unavailable"]);
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      expect(rendererCapabilityDeclarationIssues(entry.web, "web", entry.id)).toEqual([]);
      expect(rendererCapabilityDeclarationIssues(entry.native, "native", entry.id)).toEqual([]);
    }
  });

  it("证据必须指向真实存在的仓库文件(证据纪律,防抄旧路径)", () => {
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      for (const [name, decl] of [["web", entry.web], ["native", entry.native]] as const) {
        const path = REPO_ROOT + rendererCapabilityEvidencePath(decl.evidence);
        expect(() => readFileSync(path, "utf8"), `${entry.id}[${name}] ${path}`).not.toThrow();
      }
    }
  });

  it("覆盖率报告:双端声明齐全 + 无结构缺口(缺任一侧红)", () => {
    const report = rendererCapabilityCoverageReport();
    expect(report.missingWeb).toEqual([]);
    expect(report.missingNative).toEqual([]);
    expect(report.invalidDeclarations).toEqual([]);
    expect(report.duplicateIds).toEqual([]);
  });

  it("覆盖率检测器自证:构造缺 native/非法配对的清单副本,报告必须红(检测器有效)", () => {
    const broken: RendererCapabilityManifestEntry[] = [
      {
        id: "fixture-no-native", title: "检测器自证行", webFeatureKeys: [],
        web: { support: "supported", reason: "full", evidence: "packages/contracts/src/rendererCapabilityManifest.ts" },
        native: { support: "unavailable", reason: "full", evidence: "packages/contracts/src/rendererCapabilityManifest.ts" },
      },
    ];
    const report = rendererCapabilityCoverageReport(broken);
    expect(report.missingNative).toEqual([]); // native 字段存在,但配对非法:
    expect(report.invalidDeclarations.length).toBeGreaterThan(0);
    expect(report.invalidDeclarations[0]).toContain("fixture-no-native");
    expect(report.invalidDeclarations[0]).toContain("unavailable 不允许原因码 full");
  });
});

describe("J4 渲染能力清单 —— 覆盖率(PbrRendererFeatures 特性面)", () => {
  it("登记表 webFeatureKeys 并集 == 实际特性面全集(既不漏记也不幻记)", async () => {
    const selfCheck = await loadSelfCheck();
    const surfaceKeys = [...selfCheck.PBR_RENDERER_TS_SURFACE.featureKeys].sort();
    const claimedKeys = [...new Set(RENDERER_CAPABILITY_MANIFEST.flatMap((entry) => entry.webFeatureKeys))].sort();
    expect(claimedKeys).toEqual(surfaceKeys);
  });

  it("每个特性键恰好登记在一条能力下(无重复认领)", () => {
    const counts = new Map<string, number>();
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      for (const key of entry.webFeatureKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    expect(duplicated).toEqual([]);
  });
});

describe("J4 渲染能力清单 —— TS 自检对拍与漂移检测", () => {
  it("自检行与登记表 web 列逐词一致(支持档+原因码)", async () => {
    const selfCheck = await loadSelfCheck();
    const rows = new Map(selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.map((row) => [row.capabilityId, row]));
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      const row = rows.get(entry.id);
      expect(row, `self-check missing capability ${entry.id}`).toBeDefined();
      expect(row!.support).toBe(entry.web.support);
      expect(row!.reason).toBe(entry.web.reason);
    }
  });

  it("自检不得声明登记表之外的能力(防双清单各自生长)", async () => {
    const selfCheck = await loadSelfCheck();
    const extra = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK
      .map((row) => row.capabilityId)
      .filter((id) => !RENDERER_CAPABILITY_IDS.includes(id));
    expect(extra).toEqual([]);
  });

  it("漂移检测:自检实际面快照与 pbrRendererFeatures.ts 源文件接口键一致", async () => {
    const selfCheck = await loadSelfCheck();
    const source = readFileSync(REPO_ROOT + FEATURES_SOURCE_PATH, "utf8");
    const interfaceBody = source.slice(
      source.indexOf("export interface PbrRendererFeatures"),
      source.indexOf("export const DEFAULT_PBR_RENDERER_FEATURES"),
    );
    const sourceKeys = [...interfaceBody.matchAll(/readonly (\w+):/g)].map((match) => match[1]!);
    expect(sourceKeys.length).toBeGreaterThanOrEqual(18);
    expect([...selfCheck.PBR_RENDERER_TS_SURFACE.featureKeys].sort()).toEqual([...sourceKeys].sort());
  });

  it("自检观测值钉住关键实际面常量(GI 方向档/材质 ABI/接触阴影档/恢复预算与分型)", async () => {
    const selfCheck = await loadSelfCheck();
    const gi = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "gi-probe-directions");
    expect(gi?.observed).toMatchObject({ standardDirections: 16, highDirections: 32 });
    expect(selfCheck.PBR_RENDERER_TS_SURFACE.giDirectionHigh).toBe(32);
    const material = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "material-abi-192b");
    expect(material?.observed).toMatchObject({ packedFloats: 48, packedBytes: 192, coreBlockBytes: 160 });
    // F7b：spot uniform ABI 扩容 16 条目/1536B 后钉住（自检值从常量派生，漂移即红）。
    const shadowLocal = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "shadow-local");
    expect(shadowLocal?.observed).toMatchObject({ spotShadowMaxLights: 16, spotShadowUniformBytes: 1536 });
    expect(selfCheck.PBR_RENDERER_TS_SURFACE.contactShadowQualityTiers).toEqual(["performance", "balanced", "quality"]);
    const recovery = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "device-recovery");
    expect(recovery?.observed).toMatchObject({
      defaultMaxAttempts: 3,
      deviceLostUnknownRecoverable: true,
      deviceLostDestroyedRecoverable: false,
    });
  });

  it("能力宣称的计时 pass 真实存在于 PBR_TIMED_PASS_IDS 且非空(漂移检测)", async () => {
    const selfCheck = await loadSelfCheck();
    const timedPassIds = new Set(selfCheck.PBR_RENDERER_TS_SURFACE.timedPassIds);
    for (const row of selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK) {
      for (const passId of row.passIds ?? []) {
        expect(timedPassIds.has(passId), `${row.capabilityId} -> ${passId}`).toBe(true);
      }
    }
    const nonEmptyRequired: ReadonlyArray<[string, string]> = [
      ["contact-shadows", "contact-shadow"],
      ["ssr", "screen-space-reflection-trace"],
      ["fog-volumetric", "volumetric-fog-march"],
      ["taa", "temporal-aa"],
      ["ambient-occlusion", "ambient-occlusion"],
      ["bloom", "bloom"],
      ["temporal-upscale", "temporal-upscale"],
      ["weighted-oit", "transparent-oit"],
    ];
    for (const [capabilityId, passId] of nonEmptyRequired) {
      const row = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((entry) => entry.capabilityId === capabilityId);
      expect(row?.passIds ?? []).toContain(passId);
    }
  });
});

describe("J4 渲染能力清单 —— Rust 同形声明对拍(文本级独立网)", () => {
  const rustSource = readFileSync(REPO_ROOT + RUST_MODULE_PATH, "utf8");

  it("每个登记能力在 Rust 模块有一行自检声明,支持档/原因码逐词一致", () => {
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      const rowPattern = new RegExp(
        `capability_id: "${entry.id.replace(/[-]/g, "\\-")}",\\s*`
        + `support: RendererCapabilitySupport::${rustSupportVariant(entry.native.support)},\\s*`
        + `reason: RendererCapabilityReasonCode::${rustReasonVariant(entry.native.reason)},`,
      );
      expect(rowPattern.test(rustSource), `rust row mismatch for ${entry.id}`).toBe(true);
    }
  });

  it("Rust 模块消费同一金样(contracts fixtures include_str!)", () => {
    expect(rustSource).toContain('include_str!("../../contracts/fixtures/renderer-capability-manifest.json")');
    expect(rustSource).toContain("every_manifest_capability_has_native_declaration");
    expect(rustSource).toContain("native_self_check_matches_manifest_native_column");
  });
});

describe("J4 渲染能力清单 —— 金样(native include_str! 消费源)", () => {
  it("提交的金样与清单对象深度一致", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;
    expect(fixture).toEqual({
      contractVersion: RENDERER_CAPABILITY_CONTRACT_VERSION,
      entries: JSON.parse(JSON.stringify(RENDERER_CAPABILITY_MANIFEST)),
    });
  });

  it("rendererCapabilityManifestJson() 序列化稳定(重序列化不动点)", () => {
    const json = rendererCapabilityManifestJson();
    expect(JSON.parse(json)).toEqual(JSON.parse(rendererCapabilityManifestJson()));
    expect(json.endsWith("\n")).toBe(true);
    expect(json).toContain("\"contractVersion\": 1");
  });

  it("金样词汇合法且双端齐全(独立于结构测试的最后一道闸)", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as {
      entries: RendererCapabilityManifestEntry[];
    };
    expect(fixture.entries.length).toBe(RENDERER_CAPABILITY_MANIFEST.length);
    for (const entry of fixture.entries) {
      expect(RENDERER_CAPABILITY_SUPPORT_VOCABULARY).toContain(entry.web.support);
      expect(RENDERER_CAPABILITY_SUPPORT_VOCABULARY).toContain(entry.native.support);
      expect(RENDERER_CAPABILITY_REASON_CODES).toContain(entry.web.reason);
      expect(RENDERER_CAPABILITY_REASON_CODES).toContain(entry.native.reason);
      expect(REASON_PAIRS_FOR_SUPPORT[entry.web.support]).toContain(entry.web.reason);
      expect(REASON_PAIRS_FOR_SUPPORT[entry.native.support]).toContain(entry.native.reason);
    }
  });
});

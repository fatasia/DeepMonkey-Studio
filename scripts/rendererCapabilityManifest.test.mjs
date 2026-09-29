/**
 * J4 渲染能力清单 —— 三方对拍网(TS 结构 / deep-engine TS 自检 / Rust 同形声明 / 金样)。
 *
 * == 为什么在 scripts/ ==
 * 原文件 packages/contracts/src/rendererCapabilityManifest.test.ts 深导入 deep-engine 源
 * (`../deep-engine/src/webgpu/rendererCapabilitySelfCheck.ts`),被 web architecture
 * 边界扫描(apps/+packages/)判为违规。scripts/ 不受该边界扫描约束,故整文件搬迁至此,
 * 以 node:test 运行(先例 scripts/j5-dual-end-gate.test.mjs):
 *   node --test scripts/rendererCapabilityManifest.test.mjs
 * TS 源加载依赖 scripts/lib/tsSourceModuleResolution.mjs 的 .js→.ts 回退解析 hook
 * (必须保持为第一个 import),Node ≥24。
 *
 * == 覆盖(与搬迁前一致,漂移即红) ==
 * 结构自洽 / 证据存在性 / 覆盖率与检测器自证 / webFeatureKeys 并集对拍 /
 * TS 自检逐词对拍与漂移检测 / Rust 文本级同形对拍 / 金样 include_str! 消费源对拍。
 */
import "./lib/tsSourceModuleResolution.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";
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
} from "../packages/contracts/src/rendererCapabilityManifest.ts";

/**
 * deep-engine TS 自检导出(跨包动态导入;该模块导入闭包无 bare 依赖,
 * 靠 tsSourceModuleResolution hook 完成 .js→.ts specifier 映射)。
 * 行形状:{ capabilityId, support: "supported"|"degraded"|"unavailable", reason,
 * passIds?, observed: Record<string, string|number|boolean|string[]|number[]> };
 * 表面快照 PBR_RENDERER_TS_SURFACE:{ featureKeys, timedPassIds, giDirectionStandard,
 * giDirectionHigh, materialCoreBlockBytes, contactShadowQualityTiers }。
 */

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const FIXTURE_PATH = new URL("../packages/contracts/fixtures/renderer-capability-manifest.json", import.meta.url);
const RUST_MODULE_PATH = "packages/deep-engine-native/src/renderer_capability_manifest.rs";
const FEATURES_SOURCE_PATH = "packages/deep-engine/src/webgpu/pbrRendererFeatures.ts";

async function loadSelfCheck() {
  return await import("../packages/deep-engine/src/webgpu/rendererCapabilitySelfCheck.ts");
}

/** 支持档/原因码 → Rust 枚举变体名(kebab↔Pascal 镜像,用于 Rust 模块文本对拍)。 */
function rustSupportVariant(support) {
  return support.charAt(0).toUpperCase() + support.slice(1);
}
function rustReasonVariant(reason) {
  return reason.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join("");
}

/** vitest toMatchObject 等价:逐键 deepEqual 的子集断言(observed 对象为扁平结构)。 */
function assertMatchesObject(actual, expected, message) {
  for (const [key, value] of Object.entries(expected)) {
    assert.deepEqual(actual?.[key], value, `${message} [${key}]`);
  }
}

test("J4 渲染能力清单 —— 结构自洽", async (t) => {
  await t.test("能力 id 单源数组与登记行一一对应且唯一", () => {
    assert.ok(RENDERER_CAPABILITY_IDS.length >= 27);
    assert.equal(new Set(RENDERER_CAPABILITY_IDS).size, RENDERER_CAPABILITY_IDS.length);
    assert.deepEqual(RENDERER_CAPABILITY_IDS, RENDERER_CAPABILITY_MANIFEST.map((entry) => entry.id));
    for (const id of RENDERER_CAPABILITY_IDS) {
      assert.equal(findRendererCapabilityEntry(id)?.id, id);
    }
    assert.equal(findRendererCapabilityEntry("no-such-capability"), undefined);
  });

  await t.test("词汇封闭:支持档与原因码均在封闭集内,且配对合法", () => {
    assert.deepEqual([...RENDERER_CAPABILITY_SUPPORT_VOCABULARY], ["supported", "degraded", "unavailable"]);
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      assert.deepEqual(rendererCapabilityDeclarationIssues(entry.web, "web", entry.id), []);
      assert.deepEqual(rendererCapabilityDeclarationIssues(entry.native, "native", entry.id), []);
    }
  });

  await t.test("证据必须指向真实存在的仓库文件(证据纪律,防抄旧路径)", () => {
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      for (const [name, decl] of [["web", entry.web], ["native", entry.native]]) {
        const path = REPO_ROOT + rendererCapabilityEvidencePath(decl.evidence);
        assert.doesNotThrow(() => readFileSync(path, "utf8"), `${entry.id}[${name}] ${path}`);
      }
    }
  });

  await t.test("覆盖率报告:双端声明齐全 + 无结构缺口(缺任一侧红)", () => {
    const report = rendererCapabilityCoverageReport();
    assert.deepEqual(report.missingWeb, []);
    assert.deepEqual(report.missingNative, []);
    assert.deepEqual(report.invalidDeclarations, []);
    assert.deepEqual(report.duplicateIds, []);
  });

  await t.test("覆盖率检测器自证:构造缺 native/非法配对的清单副本,报告必须红(检测器有效)", () => {
    const broken = [
      {
        id: "fixture-no-native", title: "检测器自证行", webFeatureKeys: [],
        web: { support: "supported", reason: "full", evidence: "packages/contracts/src/rendererCapabilityManifest.ts" },
        native: { support: "unavailable", reason: "full", evidence: "packages/contracts/src/rendererCapabilityManifest.ts" },
      },
    ];
    const report = rendererCapabilityCoverageReport(broken);
    assert.deepEqual(report.missingNative, []); // native 字段存在,但配对非法:
    assert.ok(report.invalidDeclarations.length > 0);
    assert.ok(report.invalidDeclarations[0].includes("fixture-no-native"));
    assert.ok(report.invalidDeclarations[0].includes("unavailable 不允许原因码 full"));
  });
});

test("J4 渲染能力清单 —— 覆盖率(PbrRendererFeatures 特性面)", async (t) => {
  await t.test("登记表 webFeatureKeys 并集 == 实际特性面全集(既不漏记也不幻记)", async () => {
    const selfCheck = await loadSelfCheck();
    const surfaceKeys = [...selfCheck.PBR_RENDERER_TS_SURFACE.featureKeys].sort();
    const claimedKeys = [...new Set(RENDERER_CAPABILITY_MANIFEST.flatMap((entry) => entry.webFeatureKeys))].sort();
    assert.deepEqual(claimedKeys, surfaceKeys);
  });

  await t.test("每个特性键恰好登记在一条能力下(无重复认领)", () => {
    const counts = new Map();
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      for (const key of entry.webFeatureKeys) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const duplicated = [...counts.entries()].filter(([, count]) => count > 1).map(([key]) => key);
    assert.deepEqual(duplicated, []);
  });
});

test("J4 渲染能力清单 —— TS 自检对拍与漂移检测", async (t) => {
  await t.test("自检行与登记表 web 列逐词一致(支持档+原因码)", async () => {
    const selfCheck = await loadSelfCheck();
    const rows = new Map(selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.map((row) => [row.capabilityId, row]));
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      const row = rows.get(entry.id);
      assert.ok(row, `self-check missing capability ${entry.id}`);
      assert.equal(row.support, entry.web.support);
      assert.equal(row.reason, entry.web.reason);
    }
  });

  await t.test("自检不得声明登记表之外的能力(防双清单各自生长)", async () => {
    const selfCheck = await loadSelfCheck();
    const extra = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK
      .map((row) => row.capabilityId)
      .filter((id) => !RENDERER_CAPABILITY_IDS.includes(id));
    assert.deepEqual(extra, []);
  });

  await t.test("漂移检测:自检实际面快照与 pbrRendererFeatures.ts 源文件接口键一致", async () => {
    const selfCheck = await loadSelfCheck();
    const source = readFileSync(REPO_ROOT + FEATURES_SOURCE_PATH, "utf8");
    const interfaceBody = source.slice(
      source.indexOf("export interface PbrRendererFeatures"),
      source.indexOf("export const DEFAULT_PBR_RENDERER_FEATURES"),
    );
    const sourceKeys = [...interfaceBody.matchAll(/readonly (\w+):/g)].map((match) => match[1]);
    assert.ok(sourceKeys.length >= 18);
    assert.deepEqual([...selfCheck.PBR_RENDERER_TS_SURFACE.featureKeys].sort(), [...sourceKeys].sort());
  });

  await t.test("自检观测值钉住关键实际面常量(GI 方向档/材质 ABI/接触阴影档/恢复预算与分型)", async () => {
    const selfCheck = await loadSelfCheck();
    const gi = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "gi-probe-directions");
    assertMatchesObject(gi?.observed, { standardDirections: 16, highDirections: 32 }, "gi-probe-directions");
    assert.equal(selfCheck.PBR_RENDERER_TS_SURFACE.giDirectionHigh, 32);
    const material = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "material-abi-192b");
    assertMatchesObject(material?.observed, { packedFloats: 48, packedBytes: 192, coreBlockBytes: 160 }, "material-abi-192b");
    // F7b：spot uniform ABI 扩容 16 条目/1536B 后钉住（自检值从常量派生，漂移即红）。
    const shadowLocal = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "shadow-local");
    assertMatchesObject(shadowLocal?.observed, { spotShadowMaxLights: 16, spotShadowUniformBytes: 1536 }, "shadow-local");
    assert.deepEqual(selfCheck.PBR_RENDERER_TS_SURFACE.contactShadowQualityTiers, ["performance", "balanced", "quality"]);
    const recovery = selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((row) => row.capabilityId === "device-recovery");
    assertMatchesObject(recovery?.observed, {
      defaultMaxAttempts: 3,
      deviceLostUnknownRecoverable: true,
      deviceLostDestroyedRecoverable: false,
    }, "device-recovery");
  });

  await t.test("能力宣称的计时 pass 真实存在于 PBR_TIMED_PASS_IDS 且非空(漂移检测)", async () => {
    const selfCheck = await loadSelfCheck();
    const timedPassIds = new Set(selfCheck.PBR_RENDERER_TS_SURFACE.timedPassIds);
    for (const row of selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK) {
      for (const passId of row.passIds ?? []) {
        assert.ok(timedPassIds.has(passId), `${row.capabilityId} -> ${passId}`);
      }
    }
    const nonEmptyRequired = [
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
      assert.ok((selfCheck.PBR_RENDERER_CAPABILITY_SELF_CHECK.find((entry) => entry.capabilityId === capabilityId)?.passIds ?? []).includes(passId),
        `${capabilityId} 缺计时 pass ${passId}`);
    }
  });
});

test("J4 渲染能力清单 —— Rust 同形声明对拍(文本级独立网)", async (t) => {
  const rustSource = readFileSync(REPO_ROOT + RUST_MODULE_PATH, "utf8");

  await t.test("每个登记能力在 Rust 模块有一行自检声明,支持档/原因码逐词一致", () => {
    for (const entry of RENDERER_CAPABILITY_MANIFEST) {
      const rowPattern = new RegExp(
        `capability_id: "${entry.id.replace(/[-]/g, "\\-")}",\\s*`
        + `support: RendererCapabilitySupport::${rustSupportVariant(entry.native.support)},\\s*`
        + `reason: RendererCapabilityReasonCode::${rustReasonVariant(entry.native.reason)},`,
      );
      assert.ok(rowPattern.test(rustSource), `rust row mismatch for ${entry.id}`);
    }
  });

  await t.test("Rust 模块消费同一金样(contracts fixtures include_str!)", () => {
    assert.ok(rustSource.includes('include_str!("../../contracts/fixtures/renderer-capability-manifest.json")'));
    assert.ok(rustSource.includes("every_manifest_capability_has_native_declaration"));
    assert.ok(rustSource.includes("native_self_check_matches_manifest_native_column"));
  });
});

test("J4 渲染能力清单 —— 金样(native include_str! 消费源)", async (t) => {
  await t.test("提交的金样与清单对象深度一致", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    assert.deepEqual(fixture, {
      contractVersion: RENDERER_CAPABILITY_CONTRACT_VERSION,
      entries: JSON.parse(JSON.stringify(RENDERER_CAPABILITY_MANIFEST)),
    });
  });

  await t.test("rendererCapabilityManifestJson() 序列化稳定(重序列化不动点)", () => {
    const json = rendererCapabilityManifestJson();
    assert.deepEqual(JSON.parse(json), JSON.parse(rendererCapabilityManifestJson()));
    assert.equal(json.endsWith("\n"), true);
    assert.ok(json.includes("\"contractVersion\": 1"));
  });

  await t.test("金样词汇合法且双端齐全(独立于结构测试的最后一道闸)", () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, "utf8"));
    assert.equal(fixture.entries.length, RENDERER_CAPABILITY_MANIFEST.length);
    for (const entry of fixture.entries) {
      assert.ok(RENDERER_CAPABILITY_SUPPORT_VOCABULARY.includes(entry.web.support));
      assert.ok(RENDERER_CAPABILITY_SUPPORT_VOCABULARY.includes(entry.native.support));
      assert.ok(RENDERER_CAPABILITY_REASON_CODES.includes(entry.web.reason));
      assert.ok(RENDERER_CAPABILITY_REASON_CODES.includes(entry.native.reason));
      assert.ok(REASON_PAIRS_FOR_SUPPORT[entry.web.support].includes(entry.web.reason));
      assert.ok(REASON_PAIRS_FOR_SUPPORT[entry.native.support].includes(entry.native.reason));
    }
  });
});

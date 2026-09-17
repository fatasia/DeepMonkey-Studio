/**
 * N1 版本化输入适配器(P1-23,TS 侧消费面)。
 *
 * fail-closed 三态与 Native `adapter_n1.rs` 同一矩阵:缺失 fixture、非法
 * JSON、载荷不符、未认证组合、摘要不符、预算/语义触界一律 `blocked`;未知
 * kind 或未知 schema 版本是 `unknown`(语义未知,绝不猜测);仅当 kind 与
 * 版本可识别、组合已认证、摘要匹配、预算与语义全部通过才产出,任何失败
 * 路径都不产出部分结果。渲染仍在 Native,本模块只做合同与数据面消费。
 */

import { sha256Utf8 } from "../shaderPackage/hash.js";
import { canonicalJsonText, parseJsonBytes, type JsonNode } from "./canonicalJson.js";
import {
  readAnimationAbiInput, readChartExtensionInput, readRichTextInlineInput, readSvgInput,
} from "./inputParse.js";
import { adaptAnimationAbiInput, adaptChartExtensionInput, adaptSvgInput } from "./adapt.js";
import { adaptRichTextInput } from "./adaptRichText.js";
import {
  DEFAULT_N1_BUDGET, N1_INPUT_KINDS, SUPPORTED_INPUT_SCHEMA_VERSIONS,
  type AnimationAbiInput, type ChartExtensionInput, type N1Adapted, type N1Budget,
  type N1Certifications, type N1HostAssets, type N1InputKind, type N1Outcome,
  type RichTextInlineInput, type SvgInputV1,
} from "./types.js";
import { MAX_IMAGE_DIMENSION, N1Rejection, requireId } from "./validation.js";

export interface N1Adapter {
  /** 适配一个 fixture 字节载荷;`elapsedMs` 是注入时钟,仅动画 ABI 消费。 */
  adapt: (fixture: Uint8Array | null | undefined, platform: string, elapsedMs: number) => N1Outcome;
}

export type N1AdapterResult = { readonly ok: true; readonly adapter: N1Adapter } | { readonly ok: false; readonly reason: string };

/** 构造时校验宿主资产形状;之后 `adapt` 为纯函数:同一输入恒得同一结果。 */
export function createN1Adapter(certifications: N1Certifications, budget: N1Budget = DEFAULT_N1_BUDGET, assets: N1HostAssets): N1AdapterResult {
  const { font } = assets;
  for (const [value, label] of [[font.id, "font id"], [font.assetId, "font asset id"], [font.family, "font family"]] as const) {
    if (value.trim().length === 0) return { ok: false, reason: `host font ${label} must be non-blank` };
  }
  if (!Number.isInteger(font.weight) || font.weight < 100 || font.weight > 900 || font.weight % 100 !== 0) {
    return { ok: false, reason: "host font weight must be 100..900 in steps of 100" };
  }
  try {
    requireId(font.id, "host font id");
  } catch (error) {
    return error instanceof N1Rejection ? { ok: false, reason: error.reason } : { ok: false, reason: String(error) };
  }
  if (!font.color.every((channel) => Number.isFinite(channel) && channel >= 0 && channel <= 1)) {
    return { ok: false, reason: "host font color must be four finite channels in [0, 1]" };
  }
  if (!Number.isFinite(font.fontSize) || font.fontSize <= 0 || font.fontSize > 65_536) {
    return { ok: false, reason: "host font size must be finite in (0, 65536]" };
  }
  for (const objectId of [...assets.inlineAssets.keys()].sort()) {
    const asset = assets.inlineAssets.get(objectId)!;
    if (asset.assetId.trim().length === 0) return { ok: false, reason: `inline asset '${objectId}' has a blank asset id` };
    const dimensions = [asset.width, asset.height];
    if (dimensions.some((dimension) => !Number.isInteger(dimension) || dimension <= 0 || dimension > MAX_IMAGE_DIMENSION)) {
      return { ok: false, reason: `inline asset '${objectId}' dimensions must be in 1..=${MAX_IMAGE_DIMENSION}` };
    }
  }
  return {
    ok: true,
    adapter: {
      adapt: (fixture, platform, elapsedMs) => adaptFixture(certifications, budget, assets, fixture, platform, elapsedMs),
    },
  };
}

function adaptFixture(
  certifications: N1Certifications,
  budget: N1Budget,
  assets: N1HostAssets,
  fixture: Uint8Array | null | undefined,
  platform: string,
  elapsedMs: number,
): N1Outcome {
  const blocked = (reason: string): N1Outcome => ({ state: "blocked", reason });
  if (fixture === null || fixture === undefined || fixture.length === 0) {
    return blocked("missing fixture bytes: certified combinations require the reviewed fixture");
  }
  if (fixture.length > budget.maxFixtureBytes) {
    return blocked(`fixture exceeds the byte budget: ${fixture.length} > max ${budget.maxFixtureBytes}`);
  }
  let value: JsonNode;
  try {
    value = parseJsonBytes(fixture);
  } catch (error) {
    if (!(error instanceof N1Rejection)) throw error;
    return blocked(`fixture is not valid JSON: ${error.reason}`);
  }
  const classified = classify(value);
  if (classified.state !== "classified") return classified;
  const { kind, schemaVersion } = classified;
  const certification = certifications.lookup(kind, schemaVersion, platform);
  if (certification === undefined) {
    return blocked(`platform combination ('${kind}', schema v${schemaVersion}, platform '${platform}') is not certified`);
  }
  const digest = sha256Utf8(canonicalJsonText(value));
  if (digest !== certification.fixtureDigest) {
    return blocked(`fixture digest mismatch: certified ${certification.fixtureDigest}, got ${digest}`);
  }
  // 摘要匹配的 fixture 理论上必然符合其声明 schema;仍按防御性复核解析,失败即 blocked。
  const input = value.kind === "object" ? value.entries.get("input") : undefined;
  if (input === undefined) return blocked("fixture has no 'input' payload");
  let payload: SvgInputV1 | RichTextInlineInput | ChartExtensionInput | AnimationAbiInput;
  try {
    payload = readInput(kind, input);
  } catch (error) {
    if (!(error instanceof N1Rejection)) throw error;
    return blocked(`input does not conform to its declared schema: ${error.reason}`);
  }
  try {
    return { state: "adapted", adapted: adaptInput(kind, payload, budget, assets, elapsedMs) };
  } catch (error) {
    if (!(error instanceof N1Rejection)) throw error;
    return blocked(error.reason);
  }
}

/** 从原始 JSON 里先读判别字段:未知 kind / 未知版本 → unknown(处置纪律与 blocked 不同)。 */
function classify(value: JsonNode): { state: "classified"; kind: N1InputKind; schemaVersion: number } | Extract<N1Outcome, { state: "unknown" }> {
  const unknown = (reason: string) => ({ state: "unknown" as const, reason });
  if (value.kind !== "object") return unknown("fixture has no 'kind' discriminator");
  const { entries } = value;
  const kindNode = entries.get("kind");
  if (kindNode === undefined || kindNode.kind !== "string") return unknown("fixture has no 'kind' discriminator");
  if (!N1_INPUT_KINDS.includes(kindNode.value as N1InputKind)) {
    return unknown(`unknown input kind '${kindNode.value}' (known kinds: ${N1_INPUT_KINDS.join(", ")})`);
  }
  const kind = kindNode.value as N1InputKind;
  const versionNode = entries.get("schemaVersion");
  if (versionNode === undefined || versionNode.kind !== "int" || versionNode.value < 0n) {
    return unknown("fixture has no numeric 'schemaVersion'");
  }
  const schemaVersion = Number(versionNode.value);  if (schemaVersion > 4_294_967_295) return unknown(`schema version ${versionNode.value} is out of range`);
  if (!SUPPORTED_INPUT_SCHEMA_VERSIONS.includes(schemaVersion)) return unknown(`unsupported schema version ${schemaVersion} for kind '${kind}'`);
  return { state: "classified", kind, schemaVersion };
}

function readInput(kind: N1InputKind, input: JsonNode): SvgInputV1 | RichTextInlineInput | ChartExtensionInput | AnimationAbiInput {
  switch (kind) {
    case "svg": return readSvgInput(input);
    case "rich-text-inline": return readRichTextInlineInput(input);
    case "chart-extension": return readChartExtensionInput(input);
    case "animation-abi": return readAnimationAbiInput(input);
  }
}

function adaptInput(
  kind: N1InputKind,
  payload: SvgInputV1 | RichTextInlineInput | ChartExtensionInput | AnimationAbiInput,
  budget: N1Budget,
  assets: N1HostAssets,
  elapsedMs: number,
): N1Adapted {
  switch (kind) {
    case "svg": return adaptSvgInput(payload as SvgInputV1, budget);
    case "rich-text-inline": return adaptRichTextInput(payload as RichTextInlineInput, budget, assets);
    case "chart-extension": return adaptChartExtensionInput(payload as ChartExtensionInput, budget);
    case "animation-abi": return adaptAnimationAbiInput(payload as AnimationAbiInput, elapsedMs, budget);
  }
}

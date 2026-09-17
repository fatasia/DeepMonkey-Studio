/**
 * 富文本 inline 适配:复用 TextDocument 同构的簇/区间校验(越界、乱序、重叠
 * 在此拒绝),段落按字素簇切片产出 text 命令;inline object 的资源身份由宿主
 * 注入,查不到即 fail-closed。与 Native `adapter_n1/adapt.rs::adapt_rich_text`
 * 逐字段同构。
 */

import type { Deep2dCommand, Deep2dResource } from "../deep2dDisplayList.js";
import { derivedCommandId, emptyDelta, finish, IDENTITY_MATRIX } from "./adapt.js";
import {
  type N1Adapted, type N1Budget, type N1HostAssets, type RichTextInlineInput,
  type RichTextParagraph, type RichTextStyleSpan,
} from "./types.js";
import { N1Rejection, requireId } from "./validation.js";

/** 字素簇切分:与 Native `grapheme_clusters` 同为扩展字素簇语义;运行时缺失即 fail-closed。 */
export function graphemeClusters(text: string): string[] {
  if (typeof Intl === "undefined" || typeof Intl.Segmenter !== "function") {
    throw new N1Rejection("grapheme segmentation is unavailable in this runtime (Intl.Segmenter is required; fail-closed, no fallback approximation)");
  }
  return [...new Intl.Segmenter("und", { granularity: "grapheme" }).segment(text)].map((segment) => segment.segment);
}

export function adaptRichTextInput(input: RichTextInlineInput, budget: N1Budget, assets: N1HostAssets): N1Adapted {
  requireId(input.id, "rich text input id");
  const clusters = graphemeClusters(input.text);
  const clusterCount = clusters.length;
  validateStyleSpans(input.styles, clusterCount);
  const paragraphs = normalizeParagraphs(input.paragraphs, clusterCount);
  validateInlineObjects(input.inlineObjects, clusterCount);
  const { font } = assets;
  const resources: Deep2dResource[] = [
    { kind: "font", id: font.id, revision: 0, assetId: font.assetId, family: font.family, weight: font.weight, style: font.style },
  ];
  const commands: Deep2dCommand[] = [];
  let codeUnits = 0;
  for (const [index, paragraph] of paragraphs.entries()) {
    if (paragraph.endCluster === 0) throw new N1Rejection("rich text document rejected: paragraph must cover at least one cluster");
    const text = clusters.slice(paragraph.startCluster, paragraph.endCluster).join("");
    // wire 预算按 UTF-16 code unit 计,保证与 Native 对同一载荷同样拒绝(astral 字符不吃亏)。
    codeUnits += text.length;
    if (codeUnits > budget.maxTextCodeUnits) {
      throw new N1Rejection(`rich text code-unit budget exceeded: ${codeUnits} > max ${budget.maxTextCodeUnits}`);
    }
    commands.push({
      kind: "text",
      id: derivedCommandId(`${input.id}.text.${index}`),
      zOrder: 0,
      transform: IDENTITY_MATRIX,
      text,
      x: 0,
      y: 0,
      fontId: font.id,
      fontSize: font.fontSize,
      color: font.color,
    });
  }
  for (const object of input.inlineObjects) {
    const asset = assets.inlineAssets.get(object.objectId);
    if (asset === undefined) {
      throw new N1Rejection(`inline object '${object.objectId}' has no host-injected asset identity (fail-closed: the adapter never invents resources)`);
    }
    resources.push({ kind: "image", id: object.objectId, revision: 0, assetId: asset.assetId, width: asset.width, height: asset.height, colorSpace: "srgb" });
    commands.push({
      kind: "image",
      id: derivedCommandId(`${input.id}.inline.${object.atCluster}`),
      zOrder: 0,
      transform: IDENTITY_MATRIX,
      hitId: object.objectId,
      imageId: object.objectId,
      x: 0,
      y: 0,
      width: asset.width,
      height: asset.height,
    });
  }
  return finish({ ...emptyDelta(), resources, commands }, "rich-text-inline", commands.length, budget);
}

function validateStyleSpans(styles: readonly RichTextStyleSpan[], clusterCount: number): void {
  let previousEnd = 0;
  for (const [index, span] of styles.entries()) {
    if (span.startCluster >= span.endCluster) throw new N1Rejection(`rich text document rejected: style span ${index} invalid: start must be strictly before end`);
    if (span.endCluster > clusterCount) throw new N1Rejection(`rich text document rejected: style span ${index} invalid: end ${span.endCluster} exceeds cluster count ${clusterCount}`);
    if (span.startCluster < previousEnd) throw new N1Rejection(`rich text document rejected: style span ${index} invalid: spans must be sorted and non-overlapping`);
    previousEnd = span.endCluster;
  }
}

/** 段落重叠/乱序/越界是调用方错误 → 拒绝;空洞允许 → 沿前段对齐补全。 */
function normalizeParagraphs(paragraphs: readonly RichTextParagraph[], clusterCount: number): RichTextParagraph[] {
  let previousEnd = 0;
  for (const [index, paragraph] of paragraphs.entries()) {
    if (paragraph.startCluster >= paragraph.endCluster) throw new N1Rejection(`rich text document rejected: paragraph ${index} invalid: start must be strictly before end`);
    if (paragraph.endCluster > clusterCount) throw new N1Rejection(`rich text document rejected: paragraph ${index} invalid: end ${paragraph.endCluster} exceeds cluster count ${clusterCount}`);
    if (paragraph.startCluster < previousEnd) throw new N1Rejection(`rich text document rejected: paragraph ${index} invalid: paragraphs must be sorted and non-overlapping`);
    previousEnd = paragraph.endCluster;
  }
  const sorted = [...paragraphs].sort((left, right) => left.startCluster - right.startCluster);
  const filled: RichTextParagraph[] = [];
  for (let index = 0; index < sorted.length; index += 1) {
    const paragraph = sorted[index]!;
    const previous = index === 0 ? undefined : sorted[index - 1]!;
    const gapStart = previous === undefined ? 0 : previous.endCluster;
    if (gapStart < paragraph.startCluster) {
      // 首部空洞沿用后一段对齐,中段空洞沿用前一段——补全不引入新语义。
      filled.push({ startCluster: gapStart, endCluster: paragraph.startCluster, align: (previous ?? paragraph).align });
    }
    filled.push(paragraph);
  }
  if (filled.length === 0) {
    filled.push({ startCluster: 0, endCluster: clusterCount, align: "start" });
    return filled;
  }
  const last = filled[filled.length - 1]!;
  if (last.endCluster < clusterCount) {
    filled.push({ startCluster: last.endCluster, endCluster: clusterCount, align: last.align });
  }
  return filled;
}

function validateInlineObjects(objects: readonly { atCluster: number; objectId: string }[], clusterCount: number): void {
  let previous: number | undefined;
  for (const [index, object] of objects.entries()) {
    if (object.atCluster > clusterCount) throw new N1Rejection(`rich text document rejected: inline object ${index} invalid: position ${object.atCluster} exceeds cluster count ${clusterCount}`);
    if (previous !== undefined && object.atCluster <= previous) throw new N1Rejection(`rich text document rejected: inline object ${index} invalid: objects must be sorted and unique per position`);
    if (object.objectId.length === 0) throw new N1Rejection(`rich text document rejected: inline object ${index} invalid: object id must not be empty`);
    previous = object.atCluster;
  }
}

/**
 * K2（AI 助手可靠性审计 20260929 §一）：chat 回答的轻量出域复核器。
 *
 * 服务端此前对客户端快照零复核（contextTrust 恒为硬编码 client-snapshot），
 * 模型可以在答案里写出上下文中不存在的数值/编号而服务端照发。本模块只做
 * **确定性比对**（不做语义级事实验证，防过度工程）：从答案抽取数值与编号
 * token，逐项检查是否出现在真正发送给模型的上下文前缀中。
 * - 命中至少一项 → contextTrust 提为 server-evidence（服务端确实复核过依据）；
 * - 存在未命中项 → 逐条警示进 warnings，并把 verification 压为 limited。
 * 误报的代价只是一条警示与降级标注，不是拒绝服务——诚实优先于打断。
 *
 * T5（同审计 §二 T5，依赖本 K1/K2 校验器）：`anchorChatAnswerEvidence` 把命中 token
 * 进一步对齐到**真正证据锚**（来源 id + 源内偏移 + 来源指纹），产出逐条引用对齐表。
 */

import { auditFingerprint } from "./aiReliabilityAudit.js";

export interface ChatEvidenceAudit {
  /** 送入比对的 token 总数（抽取为空时为 0，audit 不改变任何可靠性字段）。 */
  checked: number;
  /** 在发送上下文中找到依据的 token（按出现顺序去重）。 */
  matched: string[];
  /** 未找到依据的 token——回答中不被上下文支撑的数值/编号。 */
  unmatched: string[];
}

/** 单次答案复核的 token 上限：防御超长答案的比对成本与警示噪音。 */
const MAX_AUDITED_TOKENS = 24;

/**
 * 数值 token：两位以上整数、带千分位整数，或带小数部分的单个整数位（"7.8" 取、"3 个" 不取）。
 * 小数分支优先于纯整数分支，保证 "87.3" 整体抽取而不是截成 "87"。
 * 连字符前缀一并排除：编号 "EQ-2205" 内部的 2205 由编号 token 代表，不重复计。
 */
const NUMBER_TOKEN = /(?<![\w.$-])(?:\d{1,3}(?:,\d{3})+|\d{2,}(?:\.\d+)?|\d\.\d+)(?![\w])/g;
/** 编号 token：大写开头、内部含数字的工业编号样式（如 EQ-2205、P101、K2-07）。 */
const IDENTIFIER_TOKEN = /\b[A-Z][A-Z0-9_-]*\d[A-Z0-9_-]*\b/g;

export function auditChatAnswerEvidence(answer: string, sentContext: string): ChatEvidenceAudit {
  const tokens = collectTokens(answer).slice(0, MAX_AUDITED_TOKENS);
  const matched: string[] = [];
  const unmatched: string[] = [];
  for (const token of tokens) {
    const variants = token.includes(",") ? [token, token.replace(/,/g, "")] : [token];
    if (variants.some((candidate) => sentContext.includes(candidate))) matched.push(token);
    else unmatched.push(token);
  }
  return { checked: tokens.length, matched, unmatched };
}

function collectTokens(answer: string): string[] {
  const tokens = new Set<string>();
  for (const pattern of [NUMBER_TOKEN, IDENTIFIER_TOKEN]) {
    pattern.lastIndex = 0;
    for (const match of answer.matchAll(pattern)) {
      const token = match[0];
      if (token) tokens.add(token);
    }
  }
  return [...tokens];
}

/** 逐条引用锚：一个证据定位（来源+偏移+指纹），坐标系与 contextDelivery 一致。 */
export interface ChatEvidenceAnchor {
  sourceId: string;
  sourcePath: string;
  /** 来源准备文本内的 UTF-16 偏移。 */
  offset: number;
  /** 来源准备文本的 sha256（auditFingerprint 同一载体，与 contextFingerprint 同族）。 */
  fingerprint: string;
}

/** 逐条引用：回答中的一个数值/编号 token 与它落得的全部真实证据锚。 */
export interface ChatEvidenceCitation {
  token: string;
  anchors: ChatEvidenceAnchor[];
}

/** T5 锚定的证据定位输入：与 assistantContextDelivery 同坐标系的来源段。 */
export interface ChatEvidenceAnchorSource {
  id: string;
  path: string;
  /** 来源段在 prepared 串内的起始偏移（contextDelivery 同款 locate 产物）。 */
  start: number;
  text: string;
  /** 该来源真正发送进模型前缀的长度（clamp(sentChars - start, 0, text.length)）。 */
  sentChars: number;
}

/**
 * T5 逐条引用锚定：对 K2 同源抽取的 token，逐来源在**已发送窗口内**定位首次出现。
 * 铁律：锚点必须完整落在该来源的已发送长度内——部分发送来源的尾部内容模型从未见过，
 * 据此出引用就是伪引用（引用漂移的根源），一律不产出。token 与任何来源都对不上时
 * 不进 citations（它仍由 K2 的 warnings 通道如实披露，两条通道互补不互替）。
 */
export function anchorChatAnswerEvidence(
  answer: string,
  sources: readonly ChatEvidenceAnchorSource[],
): ChatEvidenceCitation[] {
  if (!sources.length) return [];
  const fingerprints = new Map<string, string>();
  const citations: ChatEvidenceCitation[] = [];
  for (const token of collectTokens(answer).slice(0, MAX_AUDITED_TOKENS)) {
    const anchors: ChatEvidenceAnchor[] = [];
    for (const source of sources) {
      const sentLength = Math.max(0, Math.min(source.text.length, source.sentChars));
      if (sentLength <= 0) continue;
      const variants = token.includes(",") ? [token, token.replace(/,/g, "")] : [token];
      for (const candidate of variants) {
        const index = source.text.indexOf(candidate);
        // 窗口约束：锚点尾沿必须 ≤ 已发送长度，否则模型根本看不到该依据。
        if (index < 0 || index + candidate.length > sentLength) continue;
        let fingerprint = fingerprints.get(source.text);
        if (!fingerprint) {
          fingerprint = auditFingerprint(source.text);
          fingerprints.set(source.text, fingerprint);
        }
        anchors.push({ sourceId: source.id, sourcePath: source.path, offset: index, fingerprint });
        break;
      }
    }
    if (anchors.length) citations.push({ token, anchors });
    if (citations.length >= MAX_AUDITED_TOKENS) break;
  }
  return citations;
}

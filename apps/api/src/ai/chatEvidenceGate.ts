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
 */

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

import type { AiAssistantRoute } from "@bim-studio/contracts";

/**
 * 助手模型路由：用户选择「自动」时，简单只读问答走小模型，规划/编码/写操作/高风险一律走强模型。
 * 设计原则：
 * - fail-open 到强模型：只有"肯定是简单问答"才走小模型，任何不确定、异常、未配置都落回用户/服务默认模型；
 * - 含写操作意图的请求永远走强模型（宁可多花钱，不可误路由）；
 * - 路由决定是纯函数，可单测；配置来自环境变量，规则表见本文件常量。
 */

export interface AiRoutingConfig {
  /** 小模型 ID；缺省 = 未配置，「自动」退化为默认模型。 */
  fastModel?: string;
  /** 小模型可接手的最大问题长度（字符）。 */
  fastMaxQuestionChars: number;
  /** 额外强模型关键词（逗号分隔环境变量解析而来），命中即走强模型。 */
  strongKeywords: string[];
}

export type AiRouteReason =
  | "not-auto" | "no-fast-model" | "input-risk" | "mode-needs-strong" | "long-question" | "write-intent"
  | "planning-or-code" | "multi-step" | "code-input" | "custom-keyword" | "simple-question" | "no-fast-match" | "router-error";

export interface AiRouteDecision {
  tier: "fast" | "strong";
  model: string;
  /** 小模型不沿用强模型的思考档位（避免向不支持该参数的模型发送）。 */
  reasoningEffort?: "minimal" | "standard" | "deep";
  reason: AiRouteReason;
}

export interface AiRouteInput {
  mode: string;
  question: string;
  settings: { model: string; reasoningEffort?: "minimal" | "standard" | "deep"; routing?: AiRoutingConfig };
  /** 用户是否选择了「自动」；false 时原样返回默认模型。 */
  auto: boolean;
  /** 可靠性扫描结论；非 allow（含可疑注入）一律强模型。 */
  assessment?: "allow" | "constrain" | "block";
}

export const DEFAULT_FAST_MAX_QUESTION_CHARS = 160;

/** 小模型只接这些模式的只读问答；bim（证据严格）、dashboard（结构化 JSON 输出）、sql（受控查询服务）不路由。 */
const FAST_MODES: ReadonlySet<string> = new Set(["platform", "operations", "vision", "scene", "component"]);

const WRITE_INTENT_ZH = /创建|新建|新增|添加|增加|插入|生成|制作|绘制|搭建|建立|构建|删除|移除|清除|清空|去掉|修改|更改|改成|改为|调整|设置|设定|配置|替换|修复|更新|升级|移动|旋转|缩放|摆放|对齐|复制|粘贴|导入|导出|发布|保存|应用|执行|运行|启动|停止|部署|重命名|批量|写入|控制|开启|关闭|打开|切换|下发|触发/;
const WRITE_INTENT_EN = /\b(create|add|insert|delete|remove|clear|update|modify|edit|change|set|move|rotate|scale|apply|run|execute|deploy|generate|build|write|rename|import|export|publish|save|fix|start|stop|enable|disable|toggle|open|close|trigger|drop|truncate|insert)\b/i;
const PLANNING_ZH = /代码|脚本|函数|编写|实现|重构|调试|报错|算法|公式|推导|计算|方案|规划|设计|架构|对比|比较|原因|根因|为什么|诊断|优化|预测|评估|建议|如何|怎样|总结|分析|排查|复盘|策略|步骤|推理|论证/;
const PLANNING_EN = /\b(code|script|function|implement|refactor|debug|algorithm|plan|design|architecture|compare|why|diagnos\w*|optimi[sz]e|predict|how (?:do|to|can|should)|analy[sz]e|summari[sz]e|strategy|steps?|reason\w*)\b/i;
const MULTI_STEP = /然后|接着|之后再|并且|同时|首先|其次|最后|逐步|分步|step by step|\bthen\b|\band then\b/i;
const CODE_INPUT = /```|=>|\bfunction\b|\bSELECT\b|\bFROM\b|[{};]{2,}/i;
const SIMPLE_QA = /是什么|是多少|多少|几个|几台|几条|有哪些|有没有|列出|列表|状态|当前|现在|最新|查看|显示|告诉我|是否|谁|哪个|哪些|哪里|什么时候|名称|数量|版本|什么意思|介绍一下|解释一下|怎么样|\b(what|which|who|when|where|how many|list|show|status|current|latest|is there|are there)\b/i;

export function resolveAiRoutingConfig(env: NodeJS.ProcessEnv = process.env): AiRoutingConfig {
  const fastModel = env.AI_ROUTER_FAST_MODEL?.trim();
  const disabled = ["false", "0", "off"].includes((env.AI_ROUTER_ENABLED ?? "").trim().toLowerCase());
  const max = Number(env.AI_ROUTER_FAST_MAX_CHARS);
  return {
    ...(fastModel && !disabled ? { fastModel } : {}),
    fastMaxQuestionChars: Number.isFinite(max) && max >= 20 && max <= 2_000 ? Math.floor(max) : DEFAULT_FAST_MAX_QUESTION_CHARS,
    strongKeywords: (env.AI_ROUTER_STRONG_KEYWORDS ?? "").split(",").map((item) => item.trim().toLowerCase()).filter(Boolean),
  };
}

/** 「自动」是否可用：已配置小模型且不同于默认模型（目录可得时还须在目录内）。 */
export function autoRoutingAvailable(settings: { model: string; routing?: AiRoutingConfig }, catalogModels?: readonly string[]): boolean {
  const fast = settings.routing?.fastModel;
  if (!fast || fast === settings.model) return false;
  return !catalogModels || catalogModels.includes(fast);
}

export function routeAssistantModel(input: AiRouteInput): AiRouteDecision {
  const strong = (reason: AiRouteReason): AiRouteDecision => ({
    tier: "strong", model: input.settings.model, ...(input.settings.reasoningEffort ? { reasoningEffort: input.settings.reasoningEffort } : {}), reason,
  });
  try {
    if (!input.auto) return strong("not-auto");
    const config = input.settings.routing;
    const fast = config?.fastModel;
    if (!config || !fast || fast === input.settings.model) return strong("no-fast-model");
    if (input.assessment && input.assessment !== "allow") return strong("input-risk");
    if (!FAST_MODES.has(input.mode)) return strong("mode-needs-strong");
    const question = input.question.trim();
    if (question.length > config.fastMaxQuestionChars) return strong("long-question");
    // "怎么样"是状态询问而非"如何做"，先剔除再判规划意图。
    const planning = question.replace(/怎么样/g, "");
    if (WRITE_INTENT_ZH.test(question) || WRITE_INTENT_EN.test(question)) return strong("write-intent");
    if (CODE_INPUT.test(question)) return strong("code-input");
    if (PLANNING_ZH.test(planning) || PLANNING_EN.test(planning)) return strong("planning-or-code");
    if (MULTI_STEP.test(question)) return strong("multi-step");
    const lowered = question.toLowerCase();
    if (config.strongKeywords.some((keyword) => lowered.includes(keyword))) return strong("custom-keyword");
    if (!SIMPLE_QA.test(question)) return strong("no-fast-match");
    return { tier: "fast", model: fast, reason: "simple-question" };
  } catch {
    return strong("router-error");
  }
}

export function routeReceipt(decision: AiRouteDecision, fellBack = false): AiAssistantRoute {
  return { mode: "auto", tier: decision.tier, model: decision.model, reason: decision.reason, ...(fellBack ? { fellBack: true } : {}) };
}

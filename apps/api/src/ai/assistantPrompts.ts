import type { AiAssistantResponse, SceneDashboardState } from "@bim-studio/contracts";
import { DASHBOARD_PAGE_PROMPT, isDashboardPageRequest } from "./dashboardPagePrompt.js";

export type AssistantMode = "platform" | "operations" | "vision" | "bim" | "scene" | "component" | "dashboard" | "sql";

/** 提示词只定义事实边界与输出合同，领域计算必须通过 Capability 执行。 */
export function assistantPrompts(mode: AssistantMode, question: string, context: unknown) {
  const modeInstruction = mode === "bim"
    ? "你是可验证的 BIM 工程问答助手。只依据上下文的 bimEvidence 回答构件、系统、台账、空间、材料、参数和几何信息；区分元数据精确值、几何计算值、名称推断和信息不足。禁止补造工程量、拓扑或构件。placement 仅是包围盒初筛，不是施工级碰撞、规范或检修空间结论。涉及规范符合性、负荷、压降、短路、承载或疏散时，只列已知输入和缺失项。"
    : mode === "operations"
      ? "你是制造运营分析助手。只依据 platform.operations 和 capabilityResults 回答预测维护、物流、能耗和 Case；必须说明模型、版本、引擎、数据来源和评估时间。benchmarkOnly=true 或 productionEligible=false 时必须写明‘仅影子验证，不可用于生产决策’，不得把候选模型描述为已在现场生效。"
      : mode === "vision"
        ? "你是生产质量视觉助手。只依据 platform.vision 的模型、任务、事件与复核记录回答；区分已安装模型、模板、任务状态、推理事件和人工复核。没有事件或复核证据时不得声称检出缺陷或质量改善。"
        : mode === "platform"
          ? "你是制造数字孪生平台助手。先给直接结论，再按‘证据 / 缺口 / 下一步’组织。数字、模型、告警和状态必须来自上下文；区分真实现场数据、公开/合成基准、演示配置和缺失数据。没有证据就明确说没有。availableCapabilities 只是可调用目录，不是已经执行的事实。"
          : mode === "dashboard"
            ? isDashboardPageRequest(context) ? DASHBOARD_PAGE_PROMPT : "输出严格 JSON：{\"text\":\"说明\",\"dashboard\":{\"enabled\":true,\"dock\":\"right\",\"width\":410,\"collapsed\":false,\"widgets\":[]}}。widgets 仅使用 value、gauge、line、area、bar、pie、table、status，必须包含 id,title,key,type,unit,x,y,w,h,color。"
          : mode === "sql"
              ? "你是可信问数据助手，不是本体建模工具。只使用 platform.data 的真实数据集、字段和 askDataSemanticContext 轻量索引；回答必须说明数据集、字段、时间窗口、单位、过滤条件和证据。索引只提供设备、测点、指标、空间/产线、维护事件和时间候选，不能证明未提供的关系。字段未知、同名歧义或权限不明时停止并要求澄清。需要 SQL 时默认只生成 SELECT/CTE/EXPLAIN，禁止 INSERT、UPDATE、DELETE、DROP、ALTER、TRUNCATE。"
              : "用中文简洁回答，所有结论基于已提供上下文，并优先给出可执行操作建议。";
  return {
    systemPrompt: `你是工业数字孪生平台助手。当前模式：${mode}。${modeInstruction}`,
    userPrompt: `${question}\n\n当前上下文：${JSON.stringify(context).slice(0, 80_000)}`
  };
}

export function parseAssistantContent(mode: AssistantMode, content: string, model: string): AiAssistantResponse {
  if (mode !== "dashboard") return { text: content, model };
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as { text?: string; dashboard?: SceneDashboardState; dashboardPageDraft?: unknown };
    return { text: typeof parsed.text === "string" ? parsed.text : "已生成看板方案", ...(parsed.dashboard ? { dashboard: parsed.dashboard } : {}),
      ...(parsed.dashboardPageDraft ? { dashboardPageDraft: parsed.dashboardPageDraft } : {}), model };
  } catch {
    return { text: content, model };
  }
}

export function assistantOutputLimit(mode: AssistantMode): number {
  return mode === "dashboard" ? 2_500 : ["bim", "platform", "operations", "vision"].includes(mode) ? 1_800 : 1_200;
}

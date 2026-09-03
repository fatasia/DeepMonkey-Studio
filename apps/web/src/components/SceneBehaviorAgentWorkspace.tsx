import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { AiAssistantResponse, ScriptModule } from "@bim-studio/contracts";
import { ArrowLeft, Bot, CheckCircle2, CircleAlert, FileSearch, LoaderCircle, Sparkles, Undo2, WandSparkles, Workflow } from "lucide-react";
import { createAiSceneScriptDraft, type AiSceneScriptDraftResult } from "../ai/sceneScriptDraft";
import { api } from "../api";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneScriptAnalysis } from "../studio/sceneScriptAnalysis";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { AiSceneScriptDraftReview } from "./AiSceneScriptDraftReview";
import { IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";
import { acceptAiSceneScriptDraft } from "./sceneBehaviorAiDraft";
import "./SceneBehaviorAgentWorkspace.css";

export type SceneBehaviorAiMode = "generate" | "explain" | "diagnose" | "agent";

interface Props {
  locale: AppLocale;
  projectId?: string;
  sceneId?: string;
  target?: SceneScriptTarget;
  draft?: ScriptModule;
  analysis?: SceneScriptAnalysis;
  intelligence: SceneScriptIntelligenceContext;
  initialMode?: SceneBehaviorAiMode;
  canUndoInsert?: boolean;
  onInsertIntoEditor: (script: ScriptModule) => void;
  onUndoInsert: () => void;
  onBack: () => void;
}

interface NormalizedIntentEnvelope {
  normalizedIntent: string;
  summary?: string;
}

type ModelEvidence = { model: string; reliability?: NonNullable<AiAssistantResponse["reliability"]> };

/**
 * 脚本内只保留一个 AI 入口：确定性生成器负责可写草稿，模型插件负责解释、诊断和
 * 无法直接识别的自然语言。任何模型输出都必须再次经过白名单编译与静态门禁。
 */
export function SceneBehaviorAgentWorkspace(props: Props) {
  const [mode, setMode] = useState<SceneBehaviorAiMode>(props.initialMode ?? "generate");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [answer, setAnswer] = useState("");
  const [draftResult, setDraftResult] = useState<AiSceneScriptDraftResult>();
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [modelEvidence, setModelEvidence] = useState<ModelEvidence>();
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const scriptContext = useMemo(() => buildScriptAssistantContext(props), [props.analysis, props.draft, props.sceneId, props.target]);

  useEffect(() => {
    if (props.initialMode) setMode(props.initialMode);
  }, [props.initialMode]);

  useEffect(() => {
    setDraftResult(undefined);
    setAnswer("");
    setNotice("");
    setError("");
    setModelEvidence(undefined);
  }, [props.draft?.id, props.draft?.target?.kind, props.draft?.target && props.draft.target.kind !== "scene" ? props.draft.target.id : "scene"]);

  async function runAssistant() {
    if (!props.draft || busy) return;
    setBusy(true);
    setAnswer("");
    setDraftResult(undefined);
    setNotice("");
    setError("");
    setModelEvidence(undefined);
    try {
      if (mode === "generate") await generateDraft();
      else if (mode === "explain" || mode === "diagnose") await answerReadOnly(mode);
    } finally {
      setBusy(false);
    }
  }

  async function generateDraft() {
    const intent = prompt.trim();
    if (!intent || !props.sceneId || !props.target || !props.draft) return;
    const direct = createAiSceneScriptDraft({
      intent,
      sceneId: props.sceneId,
      target: props.target,
      intelligence: props.intelligence,
      existingScript: props.draft,
    });
    if (direct.status === "ready") {
      setDraftResult(direct);
      setNotice(t("已由受控生成器完成，无需把可执行代码发送给模型。", "Completed by the controlled generator without sending executable code to the model."));
      return;
    }
    if (!props.projectId) {
      setDraftResult(direct);
      setNotice(t("当前未连接项目 AI；已保留本地静态诊断。", "Project AI is not connected; local static diagnostics remain available."));
      return;
    }
    try {
      const response = await api.askAssistant("scene", normalizationPrompt(intent), scriptContext, props.projectId);
      const normalized = parseNormalizedScriptIntent(response.text);
      if (!normalized) {
        setDraftResult(direct);
        setNotice(t("模型回复未通过结构化意图合同，已安全降级为本地检查。", "The model response failed the structured intent contract; local checks were used safely."));
        setModelEvidence(toModelEvidence(response));
        return;
      }
      const reviewed = createAiSceneScriptDraft({
        intent: normalized.normalizedIntent,
        sceneId: props.sceneId,
        target: props.target,
        intelligence: props.intelligence,
        existingScript: props.draft,
      });
      setDraftResult(reviewed);
      setAnswer(normalized.summary ?? "");
      setModelEvidence(toModelEvidence(response));
      if (reviewed.status !== "ready") setNotice(t("模型已解释意图，但结果仍未通过确定性静态门禁。", "The model interpreted the intent, but deterministic static gates still rejected it."));
    } catch (reason) {
      setDraftResult(direct);
      setNotice(`${t("模型插件暂不可用，已降级为本地静态检查：", "The model plugin is unavailable; local static checks were used: ")}${errorMessage(reason)}`);
    }
  }

  async function answerReadOnly(task: "explain" | "diagnose") {
    if (!props.draft) return;
    const question = prompt.trim() || defaultQuestion(task, props.locale);
    if (!props.projectId) {
      setAnswer(localReadOnlyFallback(task, props.draft, props.analysis, props.locale));
      setNotice(t("未连接项目 AI，当前显示确定性本地结果。", "Project AI is not connected; deterministic local results are shown."));
      return;
    }
    try {
      const response = await api.askAssistant("scene", readOnlyPrompt(task, question), scriptContext, props.projectId);
      setAnswer(response.text);
      setModelEvidence(toModelEvidence(response));
    } catch (reason) {
      setAnswer(localReadOnlyFallback(task, props.draft, props.analysis, props.locale));
      setNotice(`${t("模型插件暂不可用，已显示本地结果：", "The model plugin is unavailable; local results are shown: ")}${errorMessage(reason)}`);
    }
  }

  function insertIntoEditor(reviewed: AiSceneScriptDraftResult) {
    if (!props.draft) return;
    try {
      props.onInsertIntoEditor(acceptAiSceneScriptDraft(props.draft, reviewed));
      setError("");
      setNotice(t("草稿已插入本地编辑器，尚未保存或运行；可立即撤销。", "The draft is in the local editor, not saved or run, and can be undone immediately."));
    } catch (reason) {
      setError(errorMessage(reason));
    }
  }

  if (mode === "agent") {
    return <div className="behavior-agent-workspace">
      <WorkspaceHeader locale={props.locale} mode={mode} onMode={setMode} onBack={props.onBack} />
      <IndustrialAgentWorkspace
        locale={props.locale}
        {...(props.projectId ? { projectId: props.projectId } : {})}
        surface="script"
        context={scriptContext}
      />
    </div>;
  }

  const runnable = Boolean(props.draft && (mode !== "generate" || prompt.trim() && props.sceneId && props.target));
  return <div className="behavior-agent-workspace">
    <WorkspaceHeader locale={props.locale} mode={mode} onMode={setMode} onBack={props.onBack} />
    <div className="behavior-script-ai-body">
      <div className="behavior-script-ai-context">
        <span><strong>{props.draft?.name ?? t("未选择脚本", "No script selected")}</strong><small>{targetLabel(props.target, props.locale)}</small></span>
        <em>{props.analysis?.issues.length ?? 0} {t("项静态问题", "static issues")}</em>
      </div>
      {!draftResult && <label className="behavior-script-ai-prompt">
        <span>{mode === "generate" ? t("描述要生成的行为", "Describe the behavior") : t("可补充关注点（可选）", "Optional focus")}</span>
        <textarea value={prompt} rows={4} placeholder={placeholder(mode, props.locale)} onChange={(event) => setPrompt(event.target.value)} />
      </label>}
      {!draftResult && <button className="primary behavior-script-ai-run" type="button" disabled={!runnable || busy} onClick={() => void runAssistant()}>
        {busy ? <LoaderCircle className="spin" size={14} /> : mode === "generate" ? <WandSparkles size={14} /> : <FileSearch size={14} />}
        {busy ? t("正在处理", "Working") : mode === "generate" ? t("生成并检查", "Generate and check") : mode === "explain" ? t("解释脚本", "Explain script") : t("诊断脚本", "Diagnose script")}
      </button>}
      {draftResult && <AiSceneScriptDraftReview locale={props.locale} draft={draftResult} {...(error ? { error } : {})} onCancel={() => setDraftResult(undefined)} onInsertIntoEditor={insertIntoEditor} />}
      {answer && <section className="behavior-script-ai-answer" aria-live="polite"><Bot size={15} /><div><strong>{mode === "generate" ? t("意图解释", "Intent summary") : mode === "explain" ? t("脚本解释", "Script explanation") : t("诊断结论", "Diagnostic result")}</strong><p>{answer}</p></div></section>}
      {modelEvidence && <div className="behavior-script-ai-evidence"><CheckCircle2 size={13} /><span>{modelEvidence.model}<small>{modelEvidence.reliability?.traceId ? `Trace ${modelEvidence.reliability.traceId}` : t("模型文本仅作辅助，静态门禁仍为最终依据", "Model text is advisory; static gates remain authoritative")}</small></span></div>}
      {notice && <p className="behavior-script-ai-notice" role="status"><CircleAlert size={13} />{notice}</p>}
      {props.canUndoInsert && <button className="behavior-script-ai-undo" type="button" onClick={props.onUndoInsert}><Undo2 size={13} />{t("撤销本次 AI 插入", "Undo this AI insertion")}</button>}
    </div>
  </div>;
}

function WorkspaceHeader(props: { locale: AppLocale; mode: SceneBehaviorAiMode; onMode: (mode: SceneBehaviorAiMode) => void; onBack: () => void }) {
  const t = (zh: string, en: string) => tr(props.locale, zh, en);
  const items: Array<{ id: SceneBehaviorAiMode; label: string; icon: ReactNode }> = [
    { id: "generate", label: t("生成", "Create"), icon: <Sparkles size={12} /> },
    { id: "explain", label: t("解释", "Explain"), icon: <Bot size={12} /> },
    { id: "diagnose", label: t("诊断", "Diagnose"), icon: <FileSearch size={12} /> },
    { id: "agent", label: t("任务", "Agent"), icon: <Workflow size={12} /> },
  ];
  return <header className="behavior-script-ai-header">
    <button type="button" onClick={props.onBack}><ArrowLeft size={13} />{t("返回脚本", "Back to script")}</button>
    <nav aria-label={t("脚本 AI 能力", "Script AI capabilities")}>{items.map((item) => <button key={item.id} type="button" className={props.mode === item.id ? "active" : ""} aria-pressed={props.mode === item.id} onClick={() => props.onMode(item.id)}>{item.icon}{item.label}</button>)}</nav>
  </header>;
}

function buildScriptAssistantContext(props: Pick<Props, "analysis" | "draft" | "sceneId" | "target">) {
  return {
    workspace: "behavior-script",
    sceneId: props.sceneId,
    target: props.target,
    script: props.draft ? {
      id: props.draft.id,
      name: props.draft.name,
      code: props.draft.code,
      target: props.draft.target,
      lifecycle: props.draft.lifecycle,
      enabled: props.draft.enabled,
      permissions: props.draft.permissions,
      capabilities: props.draft.capabilities,
    } : undefined,
    diagnostics: props.analysis?.issues,
  };
}

export function parseNormalizedScriptIntent(text: string): NormalizedIntentEnvelope | undefined {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1)) as Record<string, unknown>;
    const normalizedIntent = typeof parsed.normalizedIntent === "string" ? parsed.normalizedIntent.trim() : "";
    if (!normalizedIntent || normalizedIntent.length > 2_000 || /(?:```|\bfunction\b|=>|\beval\b|\bimport\s*\(|\bfetch\s*\()/i.test(normalizedIntent)) return undefined;
    return { normalizedIntent, ...(typeof parsed.summary === "string" && parsed.summary.trim() ? { summary: parsed.summary.trim().slice(0, 1_000) } : {}) };
  } catch {
    return undefined;
  }
}

function normalizationPrompt(intent: string): string {
  return `把下面自然语言转换为受限场景行为意图。只返回 JSON：{"normalizedIntent":"...","summary":"..."}。不得输出代码、API、Markdown 或新增对象 ID；只可表达显示/隐藏/定位/选中/播放暂停停止动画/三轴移动/颜色/透明度、二维组件显隐、Unity 灯光强度，以及已有数据键或事件触发。无法确定参数时 normalizedIntent 保留缺失，不得猜测。\n用户意图：${intent}`;
}

function readOnlyPrompt(task: "explain" | "diagnose", question: string): string {
  return task === "explain"
    ? `基于当前脚本快照解释生命周期、目标、数据流和可能产生的场景动作。不要声称已经运行。关注点：${question}`
    : `基于当前脚本快照和静态诊断定位问题，按“阻断项 / 风险 / 最小修复”回答。不得编造运行证据。关注点：${question}`;
}

function localReadOnlyFallback(task: "explain" | "diagnose", script: ScriptModule, analysis: SceneScriptAnalysis | undefined, locale: AppLocale): string {
  if (task === "explain") return tr(locale, `脚本“${script.name}”挂载到 ${script.target?.kind ?? "scene"}，在 ${script.lifecycle.join("、") || "未声明生命周期"} 执行；声明 ${script.capabilities.length} 项能力和 ${script.permissions.length} 项权限。`, `“${script.name}” is attached to ${script.target?.kind ?? "scene"} and runs in ${script.lifecycle.join(", ") || "no declared lifecycle"}; it declares ${script.capabilities.length} capabilities and ${script.permissions.length} permissions.`);
  const issues = analysis?.issues ?? [];
  if (!issues.length) return tr(locale, "本地静态检查未发现阻断项；运行时结果仍需通过运行日志验证。", "Local static checks found no blocker; runtime behavior still needs log verification.");
  return issues.map((issue, index) => `${index + 1}. [${issue.severity}] ${issue.message} (${issue.line}:${issue.column})`).join("\n");
}

function defaultQuestion(task: "explain" | "diagnose", locale: AppLocale): string {
  return task === "explain" ? tr(locale, "解释当前脚本的作用与执行条件", "Explain what this script does and when it runs") : tr(locale, "检查当前脚本为什么不能安全运行", "Check why this script cannot run safely");
}

function placeholder(mode: Exclude<SceneBehaviorAiMode, "agent">, locale: AppLocale): string {
  if (mode === "generate") return tr(locale, "例如：当 temperature > 80 时把当前设备改为 #ef4444", "Example: when temperature > 80, set this device to #ef4444");
  if (mode === "explain") return tr(locale, "例如：重点说明数据触发和对象动作", "Example: focus on data triggers and object actions");
  return tr(locale, "例如：为什么当前脚本无法运行？", "Example: why can’t this script run?");
}

function targetLabel(target: SceneScriptTarget | undefined, locale: AppLocale): string {
  if (!target) return tr(locale, "尚未挂载有效对象", "No valid target attached");
  return `${target.name} · ${target.kind === "object" ? tr(locale, "三维对象", "3D object") : target.runtime === "unity" ? "Unity" : tr(locale, "二维组件", "2D component")}`;
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason);
}

function toModelEvidence(response: AiAssistantResponse): ModelEvidence {
  return { model: response.model, ...(response.reliability ? { reliability: response.reliability } : {}) };
}

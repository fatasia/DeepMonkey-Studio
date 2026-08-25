import { useEffect, useState } from "react";
import { Bot, Box, Database, Eye, Focus, LayoutDashboard, LoaderCircle, Send, Sparkles, X } from "lucide-react";
import type { DataConnectionRecord, DataDatasetRecord, SceneDashboardState } from "@bim-studio/contracts";
import { api } from "../api";
import type { BimAssistantPreparedContext } from "../bimAssistant";
import { translate as tr, type AppLocale } from "../i18n";

type AssistantMode = "bim" | "scene" | "component" | "dashboard" | "sql";
type BimAction = "focus" | "isolate" | "show-placement" | "clear-isolation" | "clear-placement";

interface AiAssistantPanelProps {
  locale: AppLocale;
  projectId: string | undefined;
  context: unknown;
  componentSelected: boolean;
  onPrepareBimContext: (question: string) => Promise<BimAssistantPreparedContext>;
  onBimAction: (action: BimAction, context: BimAssistantPreparedContext, componentId?: string) => void;
  onApplyDashboard: (dashboard: SceneDashboardState) => void;
  onClose: () => void;
}

interface AssistantPresetGroup {
  label: string;
  questions: string[];
}

export function AiAssistantPanel({ locale, projectId, context, componentSelected, onPrepareBimContext, onBimAction, onApplyDashboard, onClose }: AiAssistantPanelProps) {
  const [mode, setMode] = useState<AssistantMode>("bim");
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [dashboard, setDashboard] = useState<SceneDashboardState>();
  const [bimEvidence, setBimEvidence] = useState<BimAssistantPreparedContext>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [sqlContext, setSqlContext] = useState<{ connections: DataConnectionRecord[]; datasets: DataDatasetRecord[] }>({ connections: [], datasets: [] });
  const t = (zh: string, en: string) => tr(locale, zh, en);
  useEffect(() => {
    if (mode !== "sql" || !projectId) return;
    void Promise.all([api.listDataConnections(projectId), api.listDatasets(projectId)])
      .then(([connections, datasets]) => setSqlContext({ connections, datasets }))
      .catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [mode, projectId]);

  async function ask() {
    const prompt = question.trim();
    if (!prompt) return;
    setBusy(true); setError(undefined); setDashboard(undefined); setBimEvidence(undefined); setAnswer("");
    try {
      const prepared = mode === "bim" ? await onPrepareBimContext(prompt) : undefined;
      if (prepared) setBimEvidence(prepared);
      const requestContext = mode === "sql" ? { workspace: context, data: sqlContext } : mode === "bim" ? { workspace: context, bimEvidence: prepared } : context;
      const result = await api.streamAssistant(mode, prompt, requestContext, (delta) => setAnswer((current) => current + delta));
      setAnswer(result.text); setDashboard(result.dashboard);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const emptyTitle = mode === "bim" ? t("询问 BIM 模型", "Ask the BIM model") : mode === "dashboard" ? t("描述你想要的数据看板", "Describe the dashboard you need") : mode === "component" ? t("询问当前选中构件", "Ask about the selected component") : mode === "sql" ? t("用自然语言生成或分析 SQL", "Generate or analyze SQL in natural language") : t("询问或分析当前场景", "Ask about the current scene");
  const emptyHint = mode === "bim" ? t("构件/系统统计、设备位置、楼层空间、材料参数、尺寸净空，以及设备试放", "Components, systems, equipment location, spaces, materials, dimensions and placement checks") : mode === "dashboard" ? t("例如：生成温度、压力和设备状态看板", "For example: create a temperature, pressure and status dashboard") : mode === "sql" ? t(`已读取 ${sqlContext.connections.length} 个连接、${sqlContext.datasets.length} 个数据集，仅生成只读 SQL`, `${sqlContext.connections.length} connections and ${sqlContext.datasets.length} datasets loaded; read-only SQL only`) : t("助手会读取当前场景与构件上下文", "The assistant reads the current scene and component context");
  const presetGroups: AssistantPresetGroup[] = mode === "bim" ? [
    { label: t("模型审查", "Model review"), questions: [t("当前模型有哪些楼层、系统和构件类别？", "What levels, systems and component categories are in this model?"), t("每个楼层分别有多少构件？", "How many components are on each level?")] },
    { label: t("设备与厂务", "Assets & facilities"), questions: [t("有多少摄像头？分别在哪个楼层和房间？", "How many cameras are there, and which level and room is each in?"), t("当前模型有哪些生产设备、泵、阀门和传感器？", "What production equipment, pumps, valves and sensors are in this model?")] },
    { label: t("土建与空间", "Civil & spaces"), questions: [t("模型中的墙体使用了哪些材质和厚度？", "What materials and thicknesses are used by the walls?"), t("当前选中构件的尺寸、标高和所在空间是什么？", "What are the selected component's dimensions, elevation and space?")] },
    { label: t("电气与机电", "Electrical & MEP"), questions: [t("F2 有哪些配电柜和电缆桥架？", "Which switchboards and cable trays are on F2?"), t("当前模型有哪些电气系统和回路？", "What electrical systems and circuits are in this model?")] },
    { label: t("净空试放", "Clearance"), questions: [t("“A设备”和“B设备”之间能否放下 1.2m × 0.8m × 2m 的设备？", "Can a 1.2m × 0.8m × 2m unit fit between ‘Equipment A’ and ‘Equipment B’?")] }
  ] : [];

  return <aside className="ai-assistant-panel">
    <header><div><Bot size={17} /><span><strong>{t("AI 助手", "AI Assistant")}</strong><small>{t("BIM · 场景 · SQL · 看板", "BIM · Scene · SQL · Dashboard")}</small></span></div><button onClick={onClose}><X size={15} /></button></header>
    <nav className="ai-assistant-tabs">
      <button className={mode === "bim" ? "active" : ""} onClick={() => setMode("bim")}><Box size={12} />BIM</button>
      <button className={mode === "scene" ? "active" : ""} onClick={() => setMode("scene")}><Sparkles size={12} />{t("场景", "Scene")}</button>
      <button disabled={!componentSelected} className={mode === "component" ? "active" : ""} onClick={() => setMode("component")}><Bot size={12} />{t("构件", "Component")}</button>
      <button className={mode === "sql" ? "active" : ""} onClick={() => setMode("sql")}><Database size={12} />SQL</button>
      <button className={mode === "dashboard" ? "active" : ""} onClick={() => setMode("dashboard")}><LayoutDashboard size={12} />{t("看板", "Dashboard")}</button>
    </nav>
    <div className="ai-assistant-body">
      {answer ? <article><small>{t("模型回答", "Model response")}</small>{mode === "sql" ? <pre className="ai-sql-response">{answer}</pre> : <p>{answer}</p>}{dashboard && <button className="primary" onClick={() => onApplyDashboard(dashboard)}><LayoutDashboard size={13} />{t("应用到当前场景", "Apply to scene")}</button>}</article> : <div className="ai-assistant-empty"><Sparkles size={23} /><strong>{emptyTitle}</strong><span>{emptyHint}</span>{presetGroups.length > 0 && <section className="ai-question-presets"><header><span>{t("常用问题", "Suggested questions")}</span><small>{t("点击填入，可继续修改", "Click to fill, then edit if needed")}</small></header>{presetGroups.map((group) => <div className="ai-question-preset-group" key={group.label}><label>{group.label}</label><div>{group.questions.map((preset) => <button key={preset} type="button" onClick={() => setQuestion(preset)}>{preset}</button>)}</div></div>)}</section>}</div>}
      {bimEvidence && <section className="bim-ai-evidence">
        <header><strong>{t("模型证据", "Model evidence")}</strong><span>{bimEvidence.matchCount} {t("个匹配", "matches")}</span></header>
        <div className="bim-ai-summary"><span>{bimEvidence.scene.componentCount} {t("构件", "components")}</span><span>{bimEvidence.scene.spaceCount} {t("空间", "spaces")}</span><span>{bimEvidence.confidence === "exact" ? t("精确匹配", "Exact") : bimEvidence.confidence === "inferred" ? t("推断匹配", "Inferred") : t("信息不足", "Insufficient")}</span></div>
        {bimEvidence.matches.slice(0, 8).map((item) => <div className="bim-ai-match" key={`${item.modelId}:${item.id}`}><span><strong>{item.name}</strong><small>{[item.level, item.space?.name, item.category || item.type].filter(Boolean).join(" · ")}</small></span><button title={t("定位", "Focus")} onClick={() => onBimAction("focus", bimEvidence, item.id)}><Focus size={12} /></button><button title={t("隔离", "Isolate")} onClick={() => onBimAction("isolate", bimEvidence, item.id)}><Eye size={12} /></button></div>)}
        {bimEvidence.placement && <div className={`bim-ai-placement ${bimEvidence.placement.status}`}><strong>{bimEvidence.placement.status === "fits" ? t("净空初筛：可放置", "Clearance check: fits") : bimEvidence.placement.status === "blocked" ? t("净空初筛：不可放置", "Clearance check: blocked") : t("净空信息不足", "Insufficient clearance data")}</strong><small>{bimEvidence.placement.note}</small>{bimEvidence.placement.candidateCenter && <button onClick={() => onBimAction("show-placement", bimEvidence)}>{t("显示试放体", "Show placement")}</button>}</div>}
      </section>}
      {error && <em>{error}</em>}
    </div>
    <footer><textarea value={question} onChange={(event) => setQuestion(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void ask(); } }} placeholder={mode === "bim" ? t("例如：有多少个摄像头，分别在哪个楼层和房间？", "For example: How many cameras are there and where are they?") : mode === "dashboard" ? t("生成一个设备运行监控看板……", "Create an equipment monitoring dashboard…") : mode === "sql" ? t("例如：查询最近 24 小时各设备的平均温度", "For example: average temperature per device in the last 24 hours") : t("请输入问题……", "Ask a question…")} /><button aria-label={t("发送", "Send")} disabled={busy || !question.trim()} onClick={() => void ask()}>{busy ? <LoaderCircle className="spin" size={15} /> : <Send size={15} />}</button></footer>
  </aside>;
}

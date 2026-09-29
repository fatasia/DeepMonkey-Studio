import { useEffect, useState } from "react";
import { BookLock, BrainCircuit, Check, ChevronDown, ClipboardCopy, Pencil, Trash2, Workflow } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";
import type { AgentMemoryRecord, AgentMemoryView } from "../apiClients/industrialAgentApi";
import { copyDocumentationCode } from "./DocsCenterClipboard";
import { AiFirstUseGuide } from "./AiFirstUseGuide";
import "./AiHarnessCards.css";

type AgentMemoryApi = {
  listAgentMemory: (projectId: string, signal?: AbortSignal) => Promise<AgentMemoryView>;
  confirmAgentMemory: (projectId: string, memoryId: string) => Promise<AgentMemoryRecord>;
  updateAgentMemory: (projectId: string, memoryId: string, patch: { content?: string; enabled?: boolean }) => Promise<AgentMemoryRecord>;
  deleteAgentMemory: (projectId: string, memoryId: string) => Promise<{ deleted: string }>;
};

async function getMemoryApi(): Promise<AgentMemoryApi> {
  return (await import("../api")).api;
}

/**
 * H-C2 记忆面板（交互统一设计 §3.3，M0 族扩展）：入口是 body 顶部的折叠行
 * （与 AiContextDisclosure 同构）；折叠内为条目行（来源徽标 + 摘要 + 启停/编辑/删除）。
 * "规则 > 记忆"优先级以徽标文字表达，不做第二套开关语义；
 * 确认/删除等低风险不可逆操作用就地确认（footer 双键模式）。
 */
export function AiMemoryPanel({ locale, projectId, onOpenAgent }: { locale: AppLocale; projectId: string; onOpenAgent?: () => void }) {
  const [view, setView] = useState<AgentMemoryView>();
  const [error, setError] = useState<string>();
  const [busyId, setBusyId] = useState<string>();
  const [editingId, setEditingId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [confirmingId, setConfirmingId] = useState<string>();

  useEffect(() => {
    if (!projectId) return;
    const controller = new AbortController();
    void getMemoryApi().then((api) => api.listAgentMemory(projectId, controller.signal))
      .then((next) => { if (!controller.signal.aborted) setView(next); })
      .catch((reason) => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => controller.abort();
  }, [projectId]);

  return (
    <AiMemoryPanelView
      locale={locale}
      {...(view ? { view } : {})}
      {...(error !== undefined ? { error } : {})}
      {...(busyId !== undefined ? { busyId } : {})}
      {...(editingId !== undefined ? { editingId } : {})}
      draft={draft}
      {...(confirmingId !== undefined ? { confirmingId } : {})}
      {...(onOpenAgent ? { onOpenAgent } : {})}
      onDraft={setDraft}
      onEdit={(memoryId, content) => { setEditingId(memoryId); setDraft(content); }}
      onCancelEdit={() => { setEditingId(undefined); setDraft(""); }}
      onConfirmDelete={(memoryId) => setConfirmingId(memoryId)}
      onCancelDelete={() => setConfirmingId(undefined)}
      onAction={async (memoryId, action) => {
        if (busyId) return;
        setBusyId(memoryId);
        setError(undefined);
        try {
          const api = await getMemoryApi();
          if (action === "confirm") await api.confirmAgentMemory(projectId, memoryId);
          else if (action === "enable") await api.updateAgentMemory(projectId, memoryId, { enabled: true });
          else if (action === "disable") await api.updateAgentMemory(projectId, memoryId, { enabled: false });
          else if (action === "delete") await api.deleteAgentMemory(projectId, memoryId);
          else await api.updateAgentMemory(projectId, memoryId, { content: draft });
          setEditingId(undefined);
          setConfirmingId(undefined);
          setView(await api.listAgentMemory(projectId));
        } catch (reason) {
          setError(reason instanceof Error ? reason.message : String(reason));
        } finally {
          setBusyId(undefined);
        }
      }}
    />
  );
}

export type AiMemoryAction = "confirm" | "enable" | "disable" | "delete" | "save";

/** 纯视图：数据与回调全部由外部注入（可静态渲染测试）。 */
export function AiMemoryPanelView({ locale, view, error, busyId, editingId, draft, confirmingId, onDraft, onEdit, onCancelEdit, onConfirmDelete, onCancelDelete, onAction, onOpenAgent }: {
  locale: AppLocale;
  view?: AgentMemoryView;
  error?: string;
  busyId?: string;
  editingId?: string;
  draft: string;
  confirmingId?: string;
  onDraft: (value: string) => void;
  onEdit: (memoryId: string, content: string) => void;
  onCancelEdit: () => void;
  onConfirmDelete: (memoryId: string) => void;
  onCancelDelete: () => void;
  onAction: (memoryId: string, action: AiMemoryAction) => Promise<void>;
  /** T10：三证首次引导的一键切换；缺省时引导块仍渲染（无跳转按钮）。 */
  onOpenAgent?: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const rules = view?.rules;
  const memories = view?.memories ?? [];
  const pending = memories.filter((item) => item.status === "pending").length;
  const injected = memories.filter((item) => item.status === "active").length;
  const summary = t(
    `守则 ${rules?.configured ? `已配置(${rules.chars}字符${rules.truncated ? "，截断" : ""})` : "未配置"} · 待确认 ${pending} · 生效 ${injected}`,
    `Rules ${rules?.configured ? `on (${rules.chars} chars${rules.truncated ? ", truncated" : ""})` : "off"} · pending ${pending} · active ${injected}`,
  );

  return (
    <details className="ai-context-disclosure ai-memory" aria-label={t("项目记忆", "Project memory")}>
      <summary>
        <span>
          <BrainCircuit size={13} aria-hidden="true" />
          <strong>{t("记忆", "Memory")}</strong>
        </span>
        <span className={error ? "partial" : "ready"}>
          {error ? t("读取失败", "Unavailable") : summary}
          <ChevronDown size={12} />
        </span>
      </summary>
      <div className="ai-context-disclosure-body ai-memory-body">
        <div className="ai-memory-rules">
          <span className="ai-memory-source-badge source-rules"><BookLock size={12} />{t("守则", "Rules")}</span>
          {rules?.configured
            ? <small title={rules.excerpt}>{t(`RULES.md 已配置（${rules.chars} 字符${rules.truncated ? "，仅注入前 200 行/25KB" : ""}）；编辑请直接修改该文件。`, `RULES.md configured (${rules.chars} chars${rules.truncated ? ", first 200 lines/25KB injected" : ""}); edit the file directly.`)}</small>
            : <small>{t("未配置：在数据目录 agent-memory/<项目>/RULES.md 写入守则后，下一轮自动注入。", "Not configured: write agent-memory/<project>/RULES.md in the data dir; injected next round.")}</small>}
        </div>
        <div className="ai-memory-source-badge-line">
          <span className="ai-memory-source-badge source-memory"><BrainCircuit size={12} />{t("自动记忆", "Agent memories")}</span>
          <small>{t("候选由 agent 提炼，确认后才进入注入；守则始终优先于记忆。", "Candidates are proposed by the agent and only injected after confirmation; rules always outrank memories.")}</small>
        </div>
        {memories.length === 0 && <>
          <small className="ai-memory-empty">{t("还没有自动记忆；运行一次假设验证后，被反驳的方案会作为候选出现在这里。", "No memories yet; refuted proposals from hypothesis verification will appear here as candidates.")}</small>
          <AiFirstUseGuide
            locale={locale}
            guide={t("记忆的来源：在「执行任务」页签运行一次假设验证，被反驳的方案会自动成为候选记忆，下一轮不再重复同方案。", "Memories come from hypothesis verification in the \"Run task\" tab; refuted proposals become candidate memories so the same plan is not repeated next round.")}
            sampleGoal={t("示例目标：把水泵转速提高 10%，验证流量是否按相似定律上升", "Sample goal: raise pump speed by 10% and verify whether flow follows the affinity law")}
            {...(onOpenAgent ? { onOpenAgent } : {})}
          />
        </>}
        <ul className="ai-memory-list">
          {memories.map((item) => (
            <li key={item.id} className={`ai-memory-item status-${item.status}`}>
              <span className={`ai-memory-status status-${item.status}`}>
                {item.status === "pending" ? t("待确认", "Pending") : item.status === "active" ? t("生效中", "Active") : t("已停用", "Disabled")}
              </span>
              {editingId === item.id ? (
                <span className="ai-memory-edit">
                  <textarea value={draft} onChange={(event) => onDraft(event.target.value)} rows={2} />
                  <span>
                    <button type="button" disabled={busyId === item.id || !draft.trim()} onClick={() => void onAction(item.id, "save")}>{t("保存", "Save")}</button>
                    <button type="button" onClick={onCancelEdit}>{t("取消", "Cancel")}</button>
                  </span>
                </span>
              ) : (
                <span className="ai-memory-content" title={item.content}>{item.content}</span>
              )}
              <span className="ai-memory-origin" title={item.origin.proposalFingerprint ?? item.origin.runId ?? ""}>
                {item.origin.runId ? `${t("来源", "Source")} run ${shortId(item.origin.runId)}${item.origin.step !== undefined ? `#${item.origin.step}` : ""}` : t("来源：手动", "Source: manual")}
              </span>
              <span className="ai-memory-actions">
                {item.status === "pending" && <button type="button" disabled={busyId === item.id} onClick={() => void onAction(item.id, "confirm")}><Check size={12} />{t("确认生效", "Confirm")}</button>}
                {item.status === "active" && <button type="button" disabled={busyId === item.id} onClick={() => void onAction(item.id, "disable")}>{t("停用", "Disable")}</button>}
                {item.status === "disabled" && <button type="button" disabled={busyId === item.id} onClick={() => void onAction(item.id, "enable")}>{t("启用", "Enable")}</button>}
                <button type="button" disabled={busyId === item.id} onClick={() => onEdit(item.id, item.content)} title={t("编辑", "Edit")}><Pencil size={12} /></button>
                {confirmingId === item.id
                  ? <span className="ai-memory-confirm-delete"><button type="button" disabled={busyId === item.id} onClick={() => void onAction(item.id, "delete")}>{t("确认删除", "Confirm delete")}</button><button type="button" onClick={onCancelDelete}>{t("取消", "Cancel")}</button></span>
                  : <button type="button" disabled={busyId === item.id} onClick={() => onConfirmDelete(item.id)} title={t("删除", "Delete")}><Trash2 size={12} /></button>}
              </span>
            </li>
          ))}
        </ul>
        <p className="ai-memory-audit-note">{t("注入走逐源审计：每轮提示词中每个来源（守则/记忆/结论）在投递审计中可见。", "Injections are audited per source; each source (rules/memories/verdicts) is visible in the delivery audit each round.")}</p>
        {error && <small role="alert" className="ai-memory-error">{error}</small>}
      </div>
    </details>
  );
}

function shortId(value: string): string {
  return value.length > 8 ? `${value.slice(0, 8)}…` : value;
}

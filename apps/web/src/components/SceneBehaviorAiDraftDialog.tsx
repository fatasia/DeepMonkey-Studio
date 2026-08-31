import { useEffect, useMemo, useRef, useState } from "react";
import type { ScriptModule } from "@bim-studio/contracts";
import { ArrowLeft, Sparkles, WandSparkles, X } from "lucide-react";
import { createAiSceneScriptDraft, type AiSceneScriptDraftResult } from "../ai/sceneScriptDraft";
import { translate as tr, type AppLocale } from "../i18n";
import type { SceneScriptIntelligenceContext, SceneScriptTarget } from "../studio/sceneScriptContext";
import { AiSceneScriptDraftReview } from "./AiSceneScriptDraftReview";
import { acceptAiSceneScriptDraft } from "./sceneBehaviorAiDraft";
import "./SceneBehaviorAiDraftDialog.css";

interface SceneBehaviorAiDraftDialogProps {
  locale: AppLocale;
  sceneId: string;
  target: SceneScriptTarget;
  intelligence: SceneScriptIntelligenceContext;
  existingScript: ScriptModule;
  onClose: () => void;
  onInsertIntoEditor: (script: ScriptModule) => void;
}

/** AI 只在浏览器内编排受限模板；审查通过后仍只写入本地代码编辑器。 */
export function SceneBehaviorAiDraftDialog(props: SceneBehaviorAiDraftDialogProps) {
  const [intent, setIntent] = useState("");
  const [result, setResult] = useState<AiSceneScriptDraftResult>();
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const suggestions = useMemo(() => intentSuggestions(props.target, props.intelligence), [props.target, props.intelligence]);
  const t = (zh: string, en: string) => tr(props.locale, zh, en);

  useEffect(() => {
    inputRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [props.onClose]);

  function generateDraft() {
    setError("");
    setResult(createAiSceneScriptDraft({
      intent,
      sceneId: props.sceneId,
      target: props.target,
      intelligence: props.intelligence,
      existingScript: props.existingScript,
    }));
  }

  function insertIntoEditor(reviewed: AiSceneScriptDraftResult) {
    try {
      props.onInsertIntoEditor(acceptAiSceneScriptDraft(props.existingScript, reviewed));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : t("无法插入当前编辑器", "Could not insert into the current editor"));
    }
  }

  return (
    <div className="behavior-ai-draft-overlay" role="presentation">
      <section className="behavior-ai-draft-dialog" role="dialog" aria-modal="true" aria-labelledby="behavior-ai-draft-title">
        <header>
          <span><WandSparkles size={16} /></span>
          <div>
            <strong id="behavior-ai-draft-title">{t("AI 生成脚本草稿", "Generate an AI script draft")}</strong>
            <small>{t("受限动作模板 · 静态检查 · 人工确认", "Restricted templates · static checks · user confirmation")}</small>
          </div>
          <button type="button" aria-label={t("关闭 AI 草稿", "Close AI draft")} onClick={props.onClose}><X size={15} /></button>
        </header>

        <div className="behavior-ai-draft-context">
          <span>{t("项目场景", "Project scene")}<b>{props.sceneId}</b></span>
          <span>{t("当前目标", "Current target")}<b>{props.target.name}</b></span>
          <span>{t("本地脚本", "Local script")}<b>{props.existingScript.name}</b></span>
        </div>

        {result ? (
          <>
            <button className="behavior-ai-draft-back" type="button" onClick={() => { setResult(undefined); setError(""); }}>
              <ArrowLeft size={13} />{t("修改意图", "Edit intent")}
            </button>
            <AiSceneScriptDraftReview
              locale={props.locale}
              draft={result}
              {...(error ? { error } : {})}
              onCancel={() => { setResult(undefined); setError(""); }}
              onInsertIntoEditor={insertIntoEditor}
            />
          </>
        ) : (
          <div className="behavior-ai-draft-form">
            <label htmlFor="behavior-ai-draft-intent">{t("描述目标状态或触发条件", "Describe the desired state or trigger")}</label>
            <textarea
              ref={inputRef}
              id="behavior-ai-draft-intent"
              value={intent}
              rows={4}
              placeholder={t("例如：当温度超过 80 时，将设备颜色改为 #ef4444", "Example: when temperature exceeds 80, set the device color to #ef4444")}
              onChange={(event) => setIntent(event.target.value)}
            />
            <div className="behavior-ai-draft-suggestions" aria-label={t("意图示例", "Intent examples")}>
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" onClick={() => setIntent(suggestion)}>{suggestion}</button>
              ))}
            </div>
            <p><Sparkles size={12} />{t("生成过程不会调用运行时；只有白名单动作可进入审查。", "Generation does not call the runtime; only allowlisted actions can enter review.")}</p>
            <footer>
              <button type="button" onClick={props.onClose}>{t("取消", "Cancel")}</button>
              <button className="primary" type="button" disabled={!intent.trim()} onClick={generateDraft}>
                <WandSparkles size={13} />{t("生成并静态检查", "Generate and check")}
              </button>
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}

export function intentSuggestions(target: SceneScriptTarget, intelligence: SceneScriptIntelligenceContext): string[] {
  if (target.runtime === "unity") return ["灯光强度设为 2.5"];
  if (target.kind === "component") return ["隐藏组件", "显示组件"];
  const suggestions = ["定位对象并播放动画", "隐藏对象", "移动到 12, 0, -6"];
  const dataKey = intelligence.dataKeys[0];
  if (dataKey) suggestions.push(`当 ${dataKey} > 80 时颜色改为 #ef4444`);
  return suggestions;
}

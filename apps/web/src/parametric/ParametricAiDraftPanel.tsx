import { Bot, LoaderCircle, WandSparkles } from "lucide-react";
import type { AppLocale } from "../i18n";
import { translate as tr } from "../i18n";

interface ParametricAiDraftPanelProps {
  locale: AppLocale;
  prompt: string;
  busy: boolean;
  disabled: boolean;
  onPromptChange: (value: string) => void;
  onGenerate: () => void;
}

/** AI 入口属于可关闭的插件层，只生成受限 DSL，不直接触发构建或保存。 */
export function ParametricAiDraftPanel(props: ParametricAiDraftPanelProps) {
  const { locale, prompt, busy, disabled, onPromptChange, onGenerate } = props;
  return (
    <section className="parametric-ai-draft">
      <header>
        <Bot size={14} />
        <strong>{tr(locale, "AI 参数草案", "AI parameter draft")}</strong>
        <i>PLUGIN</i>
      </header>
      <textarea
        aria-label={tr(locale, "参数化部件需求", "Parametric part request")}
        maxLength={4000}
        value={prompt}
        onChange={(event) => onPromptChange(event.target.value)}
        placeholder={tr(
          locale,
          "例：生成 160×90mm、四孔、带 12mm 折边的传感器安装板",
          "Example: 160×90 mm sensor plate with four holes and a 12 mm flange"
        )}
      />
      <button disabled={disabled || prompt.trim().length < 3} onClick={onGenerate}>
        {busy ? <LoaderCircle className="spin" size={13} /> : <WandSparkles size={13} />}
        {busy ? tr(locale, "生成中…", "Generating…") : tr(locale, "生成受限草案", "Generate safe draft")}
      </button>
      <small>{tr(locale, "仅生成受限 DSL，仍需预览确认后才能保存。", "Produces restricted DSL; preview is still required before saving.")}</small>
    </section>
  );
}

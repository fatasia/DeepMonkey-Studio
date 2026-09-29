import { useState } from "react";
import { Check, ClipboardCopy, Workflow } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { copyDocumentationCode } from "./DocsCenterClipboard";

/**
 * T10（审计 §二 2.4）：三证体系（假设→验证→档案）的首次引导块。
 * 空态文案此前是循环指引（"运行一次后会出现"却不说在哪运行）——本块补齐：
 * 在哪运行 + 一句可复制的样例目标 + 一键切换到执行任务页签。
 * 样例目标是示意措辞（需按项目实际可验证指标改写），如实标注，不伪装成已注册假设。
 */
export function AiFirstUseGuide({ locale, guide, sampleGoal, onOpenAgent }: {
  locale: AppLocale;
  guide: string;
  sampleGoal: string;
  onOpenAgent?: () => void;
}) {
  const t = (zh: string, en: string) => tr(locale, zh, en);
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void copyDocumentationCode(sampleGoal)
      .then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1_600);
      })
      .catch(() => { /* 复制失败不打断引导；文本仍可手动选择。 */ });
  };
  return (
    <div className="ai-firstuse-guide" role="note">
      <small>{guide}</small>
      <span className="ai-firstuse-sample">
        <code>{sampleGoal}</code>
        <button type="button" aria-label={t("复制示例目标", "Copy sample goal")} title={t("复制示例目标", "Copy sample goal")} onClick={copy}>
          {copied ? <Check size={11} aria-hidden="true" /> : <ClipboardCopy size={11} aria-hidden="true" />}
        </button>
      </span>
      {onOpenAgent && (
        <button type="button" className="ai-firstuse-open-agent" onClick={onOpenAgent}>
          <Workflow size={12} aria-hidden="true" />
          {t("去「执行任务」运行一次假设验证", "Open \"Run task\" to verify a hypothesis")}
        </button>
      )}
    </div>
  );
}

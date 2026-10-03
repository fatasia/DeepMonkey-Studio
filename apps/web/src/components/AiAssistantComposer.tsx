import { useRef, type ReactNode } from "react";
import { Send, Square } from "lucide-react";
import { shouldSendAssistantInput } from "../ai/assistantInput";
import { translate as tr, type AppLocale } from "../i18n";

export function AiAssistantComposer({ locale, question, busy, sendDisabled = false, disabledReason, placeholder, toolbar, onChange, onSend, onStop }: {
  locale: AppLocale;
  question: string;
  busy: boolean;
  sendDisabled?: boolean;
  disabledReason?: string;
  placeholder?: string;
  /** 输入框内左下角的工具位（范围/模型选择），与发送按钮同一行。 */
  toolbar?: ReactNode;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const composing = useRef(false);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <footer className="ai-composer">
    <div className="ai-composer-box">
    <textarea
      aria-label={t("向 AI 助手提问", "Ask the AI assistant")}
      value={question}
      onChange={(event) => onChange(event.target.value)}
      onCompositionStart={() => { composing.current = true; }}
      onCompositionEnd={() => { composing.current = false; }}
      onKeyDown={(event) => {
        if (shouldSendAssistantInput({ key: event.key, shiftKey: event.shiftKey,
          isComposing: event.nativeEvent.isComposing, keyCode: event.nativeEvent.keyCode }, composing.current)) {
          event.preventDefault();
          if (!busy && !sendDisabled) onSend();
        }
      }}
      placeholder={placeholder ?? t("问模型、事件、风险、数据或下一步动作……", "Ask about models, events, risks, data or next actions…")}
    />
    <div className="ai-composer-toolbar">
      <div className="ai-composer-tools">{toolbar}</div>
      {busy ? <button className="ai-composer-send is-stop" aria-label={t("停止生成", "Stop generating")} title={t("停止生成", "Stop generating")} onClick={onStop}>
        <Square size={13} />
      </button> : <button className="ai-composer-send" aria-label={t("发送", "Send")} title={sendDisabled ? disabledReason : t("发送（Enter）", "Send (Enter)")} disabled={sendDisabled || !question.trim()} onClick={onSend}>
        <Send size={14} />
      </button>}
    </div>
    </div>
  </footer>;
}

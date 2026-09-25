import { useRef } from "react";
import { Send, Square } from "lucide-react";
import { shouldSendAssistantInput } from "../ai/assistantInput";
import { translate as tr, type AppLocale } from "../i18n";

export function AiAssistantComposer({ locale, question, busy, sendDisabled = false, disabledReason, onChange, onSend, onStop }: {
  locale: AppLocale;
  question: string;
  busy: boolean;
  sendDisabled?: boolean;
  disabledReason?: string;
  onChange: (value: string) => void;
  onSend: () => void;
  onStop: () => void;
}) {
  const composing = useRef(false);
  const t = (zh: string, en: string) => tr(locale, zh, en);
  return <footer>
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
      placeholder={t("问模型、事件、风险、数据或下一步动作……", "Ask about models, events, risks, data or next actions…")}
    />
    {busy ? <button aria-label={t("停止生成", "Stop generating")} title={t("停止生成", "Stop generating")} onClick={onStop}>
      <Square size={15} />
    </button> : <button aria-label={t("发送", "Send")} title={sendDisabled ? disabledReason : t("发送", "Send")} disabled={sendDisabled || !question.trim()} onClick={onSend}>
      <Send size={15} />
    </button>}
  </footer>;
}

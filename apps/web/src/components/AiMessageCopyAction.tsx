import { useState } from "react";
import { Check, Copy } from "lucide-react";
import { translate as tr, type AppLocale } from "../i18n";
import { copyDocumentationCode } from "./DocsCenterClipboard";
import "./AiMessageCopyAction.css";

export function AiMessageCopyAction({ locale, text }: { locale: AppLocale; text: string }) {
  const [status, setStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  if (!text) return null;
  const label = tr(locale, status === "copied" ? "已复制" : status === "copying" ? "复制中…" : "复制回答",
    status === "copied" ? "Copied" : status === "copying" ? "Copying…" : "Copy answer");
  async function copy() {
    if (status === "copying") return;
    setStatus("copying");
    try { await copyDocumentationCode(text); setStatus("copied"); }
    catch { setStatus("failed"); }
  }
  return <div className="ai-message-actions">
    <button type="button" aria-label={tr(locale, "复制回答", "Copy answer")} disabled={status === "copying"} onClick={() => void copy()}>
      {status === "copied" ? <Check size={13} /> : <Copy size={13} />}{label}
    </button>
    <span role="status" className={status === "failed" ? undefined : "sr-only"}>{status === "failed" ? tr(locale, "复制失败，请选择回答文字后复制。", "Copy failed. Select the answer text and copy it.") : status === "copied" ? tr(locale, "回答已复制", "Answer copied") : ""}</span>
  </div>;
}

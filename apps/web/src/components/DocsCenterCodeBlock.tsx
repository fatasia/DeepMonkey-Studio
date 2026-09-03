import { useEffect, useRef, useState } from "react";
import { Check, Copy, TriangleAlert } from "lucide-react";
import { copyDocumentationCode } from "./DocsCenterClipboard";

interface DocsCenterCodeBlockProps {
  language?: string;
  value: string;
}

type CopyState = "idle" | "copied" | "failed";

/** 文档代码块提供明确的成功与失败反馈，不让复制动作静默完成。 */
export function DocsCenterCodeBlock({ language, value }: DocsCenterCodeBlockProps) {
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copyCode() {
    window.clearTimeout(resetTimer.current);
    try {
      await copyDocumentationCode(value);
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
    resetTimer.current = window.setTimeout(() => setCopyState("idle"), 1_800);
  }

  const label = copyState === "copied" ? "已复制" : copyState === "failed" ? "复制失败" : "复制代码";
  const Icon = copyState === "copied" ? Check : copyState === "failed" ? TriangleAlert : Copy;

  return (
    <div className={`docs-code-block ${copyState}`}>
      <div className="docs-code-toolbar">
        <span>{language || "text"}</span>
        <button type="button" onClick={() => void copyCode()} aria-label={`${label}：${language || "文本"}`}>
          <Icon size={12} />{label}
        </button>
      </div>
      <pre><code>{value}</code></pre>
      <span className="docs-copy-status" role="status" aria-live="polite">
        {copyState === "idle" ? "" : label}
      </span>
    </div>
  );
}

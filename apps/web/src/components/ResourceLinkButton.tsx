import { useState } from "react";
import { Check, Link as LinkIcon } from "lucide-react";
import type { ModelRecord, ProjectAssetRecord } from "@bim-studio/contracts";
import { runtimeHost } from "../adapters/runtimeHost";
import { translate as tr, type AppLocale } from "../i18n";
import { copyDocumentationCode } from "./DocsCenterClipboard";
import { resourceBrowseLink, resourceFileLink, type ResourceBrowseKind } from "./resourceLinks";
import "./ResourceLinkButton.css";

export function ResourceLinkButton({ locale, name, resource, browse, compact = false }: {
  locale: AppLocale; name: string; resource?: ModelRecord | ProjectAssetRecord | undefined;
  browse?: { kind: ResourceBrowseKind; id: string }; compact?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [fallback, setFallback] = useState<string>();
  const [error, setError] = useState<string>();
  const label = resource ? tr(locale, "复制外链", "Copy file link") : tr(locale, "复制浏览链接", "Copy browse link");
  async function copy() {
    setCopied(false); setFallback(undefined); setError(undefined);
    let url: string;
    try {
      const origin = runtimeHost.getServerProfile().baseUrl;
      url = resource ? resourceFileLink(resource, origin) : resourceBrowseLink(browse!.kind, browse!.id, origin);
    } catch {
      setError(tr(locale, "资源尚无可复制的文件地址", "This resource has no shareable file URL"));
      return;
    }
    try { await copyDocumentationCode(url); setCopied(true); }
    catch { setFallback(url); setError(tr(locale, "复制失败，请手动复制链接", "Copy failed. Select and copy the link below")); }
  }
  return <span className={`resource-link-action ${compact ? "is-compact" : ""}`}>
    <button type="button" className={compact ? "manager-icon-button" : "button"} data-copied={copied || undefined} aria-label={`${label} ${name}`} title={copied ? tr(locale, "链接已复制", "Link copied") : label} onClick={() => void copy()}>
      {copied ? <Check size={14} /> : <LinkIcon size={14} />}{!compact && (copied ? tr(locale, "已复制", "Copied") : label)}
    </button>
    {copied && <span className="resource-link-feedback" role="status">{tr(locale, "链接已复制", "Link copied")}</span>}
    {error && <span className="resource-link-fallback" role="alert"><span>{error}</span>{fallback && <input readOnly aria-label={tr(locale, "资源链接", "Resource link")} value={fallback} onFocus={event => event.currentTarget.select()} />}</span>}
  </span>;
}

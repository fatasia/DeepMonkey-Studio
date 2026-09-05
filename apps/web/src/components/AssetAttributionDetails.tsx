import type { AssetAttribution } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";

export function AssetAttributionDetails({ attribution, locale }: { attribution: AssetAttribution; locale: AppLocale }) {
  // 链接单独呈现，避免把两个长 URL 重复排成说明墙；原始署名仍完整保存在合同中。
  const credit = attribution.text.replaceAll(attribution.sourceUrl, "").replaceAll(attribution.licenseUrl, "").replace(/(?:\s*·\s*)+$/, "").trim();
  return (
    <details className="asset-attribution">
      <summary>{tr(locale, "许可与来源", "License & attribution")}</summary>
      <p>{credit}</p>
      <p>{attribution.modifications}</p>
      <nav aria-label={tr(locale, "素材署名链接", "Asset attribution links")}>
        {safeLink(attribution.sourceUrl) && <a href={attribution.sourceUrl} target="_blank" rel="noopener noreferrer">{tr(locale, "原始模型", "Original model")}</a>}
        {safeLink(attribution.licenseUrl) && <a href={attribution.licenseUrl} target="_blank" rel="noopener noreferrer">{tr(locale, "许可条款", "License terms")}</a>}
      </nav>
    </details>
  );
}

function safeLink(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password; }
  catch { return false; }
}

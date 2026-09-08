import { useMemo, useState } from "react";
import type { DashboardDataWidgetNode, DashboardPageDocument } from "@bim-studio/contracts";
import { translate as tr, type AppLocale } from "../i18n";
import { buildIndustryPackImport } from "./industryPackImport";
import { packPageTemplate } from "./industryTemplatePackCatalog";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";
import type { IndustryTemplatePack } from "./industryTemplatePackTypes";

export function IndustryPackCard({ pack, locale, page, onInsert }: { pack: IndustryTemplatePack; locale: AppLocale; page: DashboardPageDocument; onInsert(): void }) {
  const built = useMemo(() => buildIndustryPackImport(pack, locale, page), [pack, locale, page.width, page.height, page.viewportFit]);
  const [selected, setSelected] = useState(0);
  const preview = built.pages[selected] ?? built.pages[0]!;
  const template = packPageTemplate(pack, pack.pages[selected] ?? pack.pages[0]!);
  return <article className="dashboard-template-pack">
    <DashboardTemplatePreview locale={locale} template={template} page={preview}
      previewTitle={preview.name} previewNodes={preview.nodes.filter((node): node is DashboardDataWidgetNode => node.kind === "data-widget")} />
    <div className="industry-pack-details">
      <strong title={tr(locale, pack.guideZh, pack.guideEn)}>{tr(locale, pack.titleZh, pack.titleEn)}</strong>
      <div className="industry-pack-pages" role="group" aria-label={tr(locale, "预览业务页面", "Preview business pages")}>
        {built.pages.map((item, index) => <button key={item.id} aria-pressed={index === selected} onClick={() => setSelected(index)}>{item.name}</button>)}
      </div>
      <button className="industry-pack-insert" onClick={onInsert}>{tr(locale, `导入整包（${pack.pages.length} 页）`, `Import pack (${pack.pages.length} pages)`)}</button>
    </div>
  </article>;
}

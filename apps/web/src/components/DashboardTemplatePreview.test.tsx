import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";

describe("DashboardTemplatePreview", () => {
  it("renders all nine actual layout regions without invented metric values", () => {
    const template = DASHBOARD_TEMPLATES[0]!;
    const html = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={template} />);
    expect(html).toContain(`${template.zh}模板预览`);
    expect(html).toContain(`>${template.zh}<`);
    expect(html).not.toContain("86.4");
    expect(html).not.toContain("97.2");
    expect(html.match(/data-template-node=/g)).toHaveLength(9);
    expect(html).toContain('data-widget-type="filter"');
    expect(html).toContain(`data-widget-type="${template.layout.detailType}"`);
    expect(html).toContain('viewBox="0 0 1920 1080"');
  });
  it("matches the destination page aspect ratio", () => {
    const html = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={DASHBOARD_TEMPLATES[0]!} page={{ width: 1080, height: 1920 }} />);
    expect(html).toContain('viewBox="0 0 1080 1920"');
  });
});

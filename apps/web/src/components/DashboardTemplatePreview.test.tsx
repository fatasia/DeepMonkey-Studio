import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";

describe("DashboardTemplatePreview", () => {
  it("renders all nine actual layout regions with purified cover graphics", () => {
    const template = DASHBOARD_TEMPLATES[0]!;
    const html = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={template} />);
    expect(html).toContain(`${template.zh}模板预览`);
    expect(html).toContain(`>${template.zh}<`);
    expect(html.match(/data-template-node=/g)).toHaveLength(9);
    expect(html).toContain('data-widget-type="filter"');
    expect(html).toContain(`data-widget-type="${template.layout.detailType}"`);
    expect(html).toContain('viewBox="0 0 1920 1080"');
    // 净化清单:封面不再渲染线框轴线与图例路径
    expect(html).not.toContain('d="M 16 42');
    // 封面装饰数字仅为确定性示意(见 coverArt),不应出现线框时代的固定占位数
    expect(html).not.toContain("— 86.4");
  });
  it("renders the tier badge and feature chrome for commercial layers", () => {
    const template = DASHBOARD_TEMPLATES[0]!;
    const html = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={template} tier="industry" tierLabel="行业包" />);
    expect(html).toContain("dashboard-template-tier-badge");
    expect(html).toContain("行业包");
  });
  it("matches the destination page aspect ratio", () => {
    const html = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={DASHBOARD_TEMPLATES[0]!} page={{ width: 1080, height: 1920 }} />);
    expect(html).toContain('viewBox="0 0 1080 1920"');
  });
  it("keeps decorative numbers deterministic per template", () => {
    const template = DASHBOARD_TEMPLATES[5]!;
    const first = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={template} />);
    const second = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={template} />);
    expect(first).toBe(second);
  });
});

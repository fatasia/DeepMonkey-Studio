import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";
import { DashboardTemplatePreview } from "./DashboardTemplatePreview";

describe("DashboardTemplatePreview", () => {
  it("renders the actual template identity, metrics and chart previews", () => {
    const template = DASHBOARD_TEMPLATES[0]!;
    const html = renderToStaticMarkup(<DashboardTemplatePreview locale="zh-CN" template={template} />);
    expect(html).toContain(`${template.zh}模板预览`);
    expect(html).toContain(`>${template.zh}<`);
    expect(html).toContain("86.4");
    expect(html).toContain("97.2");
    expect(html).toContain("dashboard-library-preview");
  });
});

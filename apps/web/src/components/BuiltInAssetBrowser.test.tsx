import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { BuiltInAssetBrowser } from "./BuiltInAssetBrowser";
import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DASHBOARD_TEMPLATES } from "./DashboardTemplateCatalog";

describe("BuiltInAssetBrowser", () => {
  it.each([
    ["2d", DASHBOARD_COMPONENT_PRESETS.length, "个二维资源"],
    ["template", DASHBOARD_TEMPLATES.length, "个商业看板模板"],
    ["prefab", INDUSTRIAL_PREFAB_CATALOG.length, "个工业三维预制体"],
  ] as const)("exposes the real %s catalog without placeholder counts", (kind, count, label) => {
    const html = renderToStaticMarkup(
      <BuiltInAssetBrowser kind={kind} locale="zh-CN" editorAvailable onOpenEditor={() => undefined} />,
    );
    expect(html).toContain(`${count}</strong> ${label}`);
    expect(html).toContain(`built-in-${kind}`);
    expect(html).toContain("进入编辑器插入");
    expect(html.match(/进入编辑器插入/g)).toHaveLength(1);
    expect(html).not.toContain("没有匹配资源");
    expect(html).not.toContain("素材");
  });

  it("keeps one editor entry visible but unavailable until a scene exists", () => {
    const html = renderToStaticMarkup(
      <BuiltInAssetBrowser kind="2d" locale="zh-CN" editorAvailable={false} onOpenEditor={() => undefined} />,
    );
    expect(html).toContain("请先创建场景");
    expect(html).toContain("disabled");
    expect(html.match(/请先创建场景/g)).toHaveLength(2);
  });
});

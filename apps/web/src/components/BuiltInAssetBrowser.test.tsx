import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { INDUSTRIAL_PREFAB_CATALOG } from "../prefabs/industrialPrefabCatalog";
import { BuiltInAssetBrowser } from "./BuiltInAssetBrowser";
import { DASHBOARD_COMPONENT_PRESETS } from "./DashboardComponentCatalog";
import { DASHBOARD_TEMPLATES } from "./dashboardTemplateCatalog";

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
    expect(html).toContain("unified-asset-actions built-in-asset-actions");
    expect(html).toContain("asset-action-label");
    expect(html).toContain("复制浏览链接");
    expect(html).not.toContain("没有匹配资源");
  });

  it("keeps one editor entry visible but unavailable until a scene exists", () => {
    const html = renderToStaticMarkup(
      <BuiltInAssetBrowser kind="2d" locale="zh-CN" editorAvailable={false} onOpenEditor={() => undefined} />,
    );
    expect(html).toContain("请先创建场景");
    expect(html).toContain("disabled");
    expect(html.match(/请先创建场景/g)).toHaveLength(2);
  });

  it("renders a distinct preview variant per 2D preset instead of one shared metric card", () => {
    // 回归：此前误读 preset.widget.type（恒为 undefined），全部缩略图静默兜底成指标卡。
    const html = renderToStaticMarkup(
      <BuiltInAssetBrowser kind="2d" locale="zh-CN" editorAvailable onOpenEditor={() => undefined} />,
    );
    const allVariants = new Set(DASHBOARD_COMPONENT_PRESETS.map((preset) => preset.preview.variant));
    const renderedVariants = [...html.matchAll(/data-preview-variant="([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(renderedVariants.length).toBeGreaterThan(0);
    for (const variant of renderedVariants) expect(allVariants.has(variant)).toBe(true);
    // 首页必须已经呈现多种图形语义（此前全部是 metric value 一种）。
    const graphicShapes = new Set([...html.matchAll(/dashboard-library-preview ([a-z-]+ [a-z-]+|[a-z-]+)["\s]/g)].map((match) => match[1] ?? ""));
    expect(graphicShapes.size).toBeGreaterThan(3);
    expect(html).not.toContain("built-in-asset-kind");
    expect(html).not.toContain("dashboard-library-preview-mark");
  });

  it("organizes catalogs into Fanruan-style category chips with counts", () => {
    // 分类行参考帆软"大类清晰+计数徽章":2D=用途大类,模板=行业 9 大类+分层筛选,预制体=kind。
    const twoD = renderToStaticMarkup(
      <BuiltInAssetBrowser kind="2d" locale="zh-CN" editorAvailable onOpenEditor={() => undefined} />,
    );
    for (const label of ["数据组件", "交互组件", "空间组件", "媒体组件", "视觉素材"]) expect(twoD).toContain(label);
    const twoDChipCounts = [...twoD.matchAll(/<small>(\d+)<\/small>/g)].map((match) => Number(match[1] ?? 0));
    expect(twoDChipCounts.reduce((total, value) => total + value, 0)).toBe(DASHBOARD_COMPONENT_PRESETS.length * 2);

    const template = renderToStaticMarkup(
      <BuiltInAssetBrowser kind="template" locale="zh-CN" editorAvailable onOpenEditor={() => undefined} />,
    );
    for (const label of ["生产制造", "能源环保", "物流仓储", "经营管理", "公共服务"]) expect(template).toContain(label);
    for (const tier of ["行业包", "标准"]) expect(template).toContain(tier);

    const prefab = renderToStaticMarkup(
      <BuiltInAssetBrowser kind="prefab" locale="zh-CN" editorAvailable onOpenEditor={() => undefined} />,
    );
    expect(prefab).toContain("工业机器人");
    expect(prefab).toContain("输送设备");
    expect(prefab).toContain("公用工程");
  });
});

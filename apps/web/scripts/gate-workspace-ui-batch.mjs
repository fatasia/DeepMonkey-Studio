import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const viewportWidth = Number(process.env.BIM_STUDIO_QA_WIDTH ?? 1440);
const viewportHeight = Number(process.env.BIM_STUDIO_QA_HEIGHT ?? 900);
const outputRoot = resolve("test-output", "visual-compare", "workspace-ui-batch");
mkdirSync(outputRoot, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });

try {
  for (const theme of ["dark", "light"]) {
    const page = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 });
    await page.goto(`${origin}/?__visualQa=dashboard&theme=${theme}`, { waitUntil: "networkidle" });
    const layerItems = page.locator(".dashboard-layer-select");
    if (await layerItems.count() < 2) throw new Error("二维图层夹具不足，无法验证多选编组");
    await layerItems.nth(0).click();
    await layerItems.nth(1).click({ modifiers: ["Control"] });
    await page.keyboard.press("Control+g");
    if (await page.locator(".dashboard-layer-group").count() !== 1) throw new Error("二维编辑器 Ctrl+G 未创建编组");
    await page.getByRole("button", { name: "资源" }).click();
    const library = page.locator(".dashboard-library-browser");
    await library.waitFor();

    const density = await library.evaluate((element) => {
      const card = element.querySelector(".dashboard-library-card");
      const sources = [...element.querySelectorAll(".dashboard-library-sources button")];
      const style = getComputedStyle(element);
      return {
        paddingInline: parseFloat(style.paddingInlineStart),
        cardHeight: card?.getBoundingClientRect().height ?? 0,
        sourceCount: sources.length,
        previewMarks: element.querySelectorAll(".dashboard-library-preview-mark").length,
      };
    });
    if (density.paddingInline > 8 || density.cardHeight > 76 || density.sourceCount !== 2 || density.previewMarks !== 0) {
      throw new Error(`二维资源密度或分类不符合预期：${JSON.stringify(density)}`);
    }

    for (const name of ["标题", "输入框", "下拉框", "明细表", "滚动表格", "图片", "视频", "实时监控", "Unity 场景", "拓扑", "三维场景视口"]) await page.locator(`.dashboard-library-card:has-text("${name}")`).first().waitFor();
    await library.screenshot({ path: resolve(outputRoot, `01-basic-controls-${theme}-${viewportWidth}.png`) });

    const before = await page.locator(".dashboard-node").count();
    await page.locator('.dashboard-library-card:has-text("拓扑")').first().click();
    const after = await page.locator(".dashboard-node").count();
    if (after !== before + 1) throw new Error(`插入拓扑未新增画布节点：${before} -> ${after}`);

    await page.locator('.dashboard-library-sources button:has-text("资源库")').click();
    if (await page.locator(".dashboard-library-tabs button").count() !== 5) throw new Error("资源库必须使用五类资源体系");
    await page.locator('.dashboard-library-tabs button:has-text("空间组件")').click();
    await page.locator('.dashboard-library-card:has-text("总装线设备拓扑")').first().waitFor();
    await library.screenshot({ path: resolve(outputRoot, `02-resource-library-${theme}-${viewportWidth}.png`) });

    await page.getByRole("button", { name: "模板" }).click();
    const templateDialog = page.getByRole("dialog", { name: "看板模板库" });
    await templateDialog.waitFor();
    const templateLayout = await templateDialog.evaluate((element) => {
      const card = element.querySelector(".dashboard-template-row > article");
      const heading = element.querySelector(".dashboard-template-section-head");
      const action = card?.querySelector("button:not(.dashboard-template-favorite)");
      if (!(card instanceof HTMLElement) || !(heading instanceof HTMLElement) || !(action instanceof HTMLElement)) return null;
      const cardRect = card.getBoundingClientRect();
      const headingRect = heading.getBoundingClientRect();
      const panelRect = element.getBoundingClientRect();
      const actionRect = action.getBoundingClientRect();
      return {
        cardHeight: cardRect.height,
        actionBottom: actionRect.bottom,
        cardBottom: cardRect.bottom,
        actionWidth: actionRect.width,
        leftOffset: Math.abs(headingRect.left - cardRect.left),
        leftInset: cardRect.left - panelRect.left,
      };
    });
    if (!templateLayout || templateLayout.actionWidth < 120 || templateLayout.actionBottom > templateLayout.cardBottom + 1 || templateLayout.leftOffset > 1 || templateLayout.leftInset < 15) {
      throw new Error(`模板卡片操作区或推荐区左对齐不符合预期：${JSON.stringify(templateLayout)}`);
    }
    await templateDialog.screenshot({ path: resolve(outputRoot, `03-template-library-${theme}-${viewportWidth}.png`) });
    console.log(`[workspace-ui-batch] ${theme} 通过 ${JSON.stringify({ density, templateLayout, topologyNodes: after })}`);
    await page.close();

    const chromePage = await browser.newPage({ viewport: { width: viewportWidth, height: viewportHeight }, deviceScaleFactor: 1 });
    await chromePage.goto(`${origin}/?__visualQa=workspace-chrome&theme=${theme}`, { waitUntil: "networkidle" });
    await chromePage.getByRole("button", { name: "验收 RVT 设置" }).click();
    const rvtDialog = chromePage.getByRole("dialog", { name: "RVT 导入设置" });
    await rvtDialog.waitFor();
    if (await chromePage.locator(".left-panel").count() !== 1 || await chromePage.locator(".unified-object-manager").count() !== 1) throw new Error("RVT 设置打开后不应替换场景对象目录");
    await rvtDialog.screenshot({ path: resolve(outputRoot, `04-rvt-import-settings-${theme}-${viewportWidth}.png`) });
    await rvtDialog.getByRole("button", { name: "完成" }).click();
    await chromePage.locator(".scene-selection-more > summary").click();
    await chromePage.getByRole("button", { name: "开启所选对象碰撞" }).waitFor();
    const chromeMetrics = await chromePage.evaluate(() => {
      const cube = document.querySelector(".cube-viewport");
      const actions = document.querySelector(".cube-actions");
      const timeline = document.querySelector(".timeline-panel-resizable");
      if (!(cube instanceof HTMLElement) || !(actions instanceof HTMLElement) || !(timeline instanceof HTMLElement)) return null;
      const cubeRect = cube.getBoundingClientRect();
      const actionRect = actions.getBoundingClientRect();
      return {
        outliners: document.querySelectorAll(".left-panel").length,
        selectionBars: document.querySelectorAll(".unified-object-manager > .scene-tree-selection-bar").length,
        organizationDrawers: document.querySelectorAll(".scene-organization-drawer").length,
        workflowEntries: document.querySelectorAll(".scene-asset-workflow-entry, .workspace-chrome-qa__workflow").length,
        objectTrees: document.querySelectorAll(".unified-object-manager > .windowed-scene-rows").length,
        inlineGroups: document.querySelectorAll(".unified-object-manager .scene-layer-group").length,
        cubeActionsAboveCube: actionRect.bottom <= cubeRect.top,
        cubeActionGap: cubeRect.top - actionRect.bottom,
        timelineResize: getComputedStyle(timeline).resize,
        hasNewTrack: timeline.textContent?.includes("新增轨道") ?? false,
        hasDirectorWorkspaces: ["时间线", "镜头", "漫游"].every((label) => timeline.textContent?.includes(label)),
        hasCollisionAction: Boolean(document.querySelector('[aria-label="开启所选对象碰撞"], [aria-label="关闭所选对象碰撞"]')),
        hasIsolationAction: Boolean(document.querySelector('[aria-label="隔离所选对象"]')),
        selectedRowChecks: document.querySelectorAll(".scene-object-row.batch-selected .scene-row-selection-mark svg").length,
      };
    });
    if (!chromeMetrics || chromeMetrics.outliners !== 1 || chromeMetrics.selectionBars !== 1 || chromeMetrics.organizationDrawers !== 0 || chromeMetrics.workflowEntries !== 0 || chromeMetrics.objectTrees !== 1 || chromeMetrics.inlineGroups !== 1 || !chromeMetrics.cubeActionsAboveCube || chromeMetrics.cubeActionGap < 10 || chromeMetrics.timelineResize !== "both" || !chromeMetrics.hasNewTrack || !chromeMetrics.hasDirectorWorkspaces || !chromeMetrics.hasCollisionAction || !chromeMetrics.hasIsolationAction || chromeMetrics.selectedRowChecks !== 2) {
      throw new Error(`场景工作区组件未合一：${JSON.stringify(chromeMetrics)}`);
    }
    await chromePage.locator(".topbar").click();
    if (await chromePage.locator(".scene-selection-more").evaluate((element) => element.open)) throw new Error("选择集更多菜单点击外部后未关闭");
    await chromePage.getByRole("button", { name: "新增轨道" }).click();
    await chromePage.getByRole("menuitem", { name: /相机轨道/ }).click();
    await chromePage.getByRole("button", { name: "新增轨道" }).click();
    await chromePage.getByRole("menuitem", { name: /对象轨道/ }).click();
    if (await chromePage.locator(".timeline-marker").count() !== 2) throw new Error("新增相机与对象轨道后未生成首个关键帧");
    if (await chromePage.locator(".timeline-range").count() !== 0 || !(await chromePage.locator(".timeline-auto-key").textContent())?.includes("自动关键帧")) throw new Error("导演台仍存在重复时间滑块或缺少 Auto Key 状态");
    await chromePage.locator(".timeline-marker").first().click();
    await chromePage.locator(".timeline-frame-inspector").waitFor();
    const frameTime = chromePage.locator(".timeline-frame-time input");
    await frameTime.fill("2.2");
    await frameTime.press("Enter");
    if (await frameTime.inputValue() !== "2.2") throw new Error("关键帧时间无法编辑");
    const timelineGrowth = await chromePage.locator(".timeline-panel-resizable").evaluate((timeline) => {
      const header = timeline.querySelector(".timeline-heading");
      const tracks = timeline.querySelector(".timeline-track-list");
      const button = timeline.querySelector(".timeline-play");
      if (!(header instanceof HTMLElement) || !(tracks instanceof HTMLElement) || !(button instanceof HTMLElement)) return null;
      const before = { panel: timeline.getBoundingClientRect().height, header: header.getBoundingClientRect().height, tracks: tracks.getBoundingClientRect().height, button: button.getBoundingClientRect().height, font: getComputedStyle(header).fontSize };
      timeline.style.height = "520px";
      const after = { panel: timeline.getBoundingClientRect().height, header: header.getBoundingClientRect().height, tracks: tracks.getBoundingClientRect().height, button: button.getBoundingClientRect().height, font: getComputedStyle(header).fontSize };
      return { before, after };
    });
    if (!timelineGrowth || timelineGrowth.after.tracks - timelineGrowth.before.tracks < timelineGrowth.after.panel - timelineGrowth.before.panel - 2 || timelineGrowth.after.header !== timelineGrowth.before.header || timelineGrowth.after.button !== timelineGrowth.before.button || timelineGrowth.after.font !== timelineGrowth.before.font) {
      throw new Error(`导演台缩放必须扩大轨道工作区且保持控件尺寸：${JSON.stringify(timelineGrowth)}`);
    }
    await chromePage.locator(".scene-object-row .scene-row-menu > summary").first().click();
    const rowMenu = chromePage.locator(".scene-object-row .scene-row-menu-popover").first();
    await rowMenu.getByText("隔离", { exact: true }).waitFor();
    await rowMenu.getByText("开启碰撞", { exact: true }).waitFor();
    await chromePage.locator(".topbar").click();
    if (await chromePage.locator(".scene-object-row .scene-row-menu").first().evaluate((element) => element.open)) throw new Error("对象行更多菜单点击外部后未关闭");
    await chromePage.screenshot({ path: resolve(outputRoot, `05-workspace-chrome-${theme}-${viewportWidth}.png`) });
    await chromePage.locator(".timeline-marker").first().focus();
    await chromePage.keyboard.press("Delete");
    if (await chromePage.locator(".timeline-marker").count() !== 1) throw new Error("导演台关键帧获得焦点后 Delete 未删除");
    const remainingTrack = chromePage.locator(".timeline-track-row").first();
    await remainingTrack.focus();
    await chromePage.keyboard.press("Delete");
    if (await chromePage.locator(".timeline-track-row").count() !== 0) throw new Error("导演台轨道获得焦点后 Delete 未删除整条轨道");

    await chromePage.getByRole("button", { name: "资源" }).click();
    const resourcePreview = await chromePage.locator(".scene-resource-row").first().evaluate((row) => {
      const thumbnail = row.querySelector(".scene-prefab-thumbnail, img, .scene-resource-icon");
      if (!(thumbnail instanceof HTMLElement)) return null;
      const rowRect = row.getBoundingClientRect();
      const thumbnailRect = thumbnail.getBoundingClientRect();
      return { rowHeight: rowRect.height, thumbnailWidth: thumbnailRect.width, thumbnailHeight: thumbnailRect.height };
    });
    if (!resourcePreview || resourcePreview.rowHeight < 68 || resourcePreview.thumbnailWidth < 56 || resourcePreview.thumbnailHeight < 56) {
      throw new Error(`三维项目资源或工业预制体缩略图过小：${JSON.stringify(resourcePreview)}`);
    }
    await chromePage.locator(".scene-resource-floating").screenshot({ path: resolve(outputRoot, `06-scene-resources-${theme}-${viewportWidth}.png`) });
    console.log(`[workspace-chrome] ${theme} 通过 ${JSON.stringify(chromeMetrics)}`);
    await chromePage.close();
  }
} finally {
  await browser.close();
}

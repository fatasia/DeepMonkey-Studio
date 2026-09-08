import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { createScene, observeDiagnostics, themeContext } from "./gateModelInstancesSupport.mjs";

/**
 * 综合门禁（第 2/3/1 项并行批次）：
 * A 行业深度包：导入 5 页 → 筛选跨页联动 → 整组改数 → 保存/刷新/发布/匿名联动
 * B 导出：PNG 图片导出 + 打印页眉页脚 DOM；Excel 由 dashboard-samples 门禁覆盖，此处补按钮可达
 * C V3：返回二维复验（publication 字段剥离修补）+ /view 刷新复现取证
 */
const gate = await createIsolatedStudioGate("industry-packs");
const report = { cases: [] }; console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const entry = { round, theme, width, errors: [], driverWarnings: [], expectedNetworkErrors: [], passed: false }; report.cases.push(entry);
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    page.setDefaultTimeout(30000); observeDiagnostics(page, entry);
    const shot = name => page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${name}.png`) });
    try {
      // --- A: 行业深度包导入与联动 ---
      const project = await gate.json("POST", "/api/projects", { name: `行业包-${round}-${theme}` });
      const { application, appPath, scenePath } = await createScene(gate, page, project.id);
      const authored = structuredClone(application); authored.pages[0].nodes = [];
      await gate.json("PUT", appPath, authored);
      const beforePages = application.pages.length;
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/pages/${application.pages[0].id}`);
      await page.locator(".dashboard-left-tabs").getByRole("button", { name: "资源", exact: true }).click();
      await page.getByRole("button", { name: "模板", exact: true }).click();
      const modal = page.getByRole("dialog", { name: "看板模板库", exact: true });
      await modal.waitFor();
      await modal.getByLabel("模板分类").selectOption({ label: "行业深度包" });
      const packCard = modal.locator("article.dashboard-template-pack").filter({ hasText: "制造设备运行包" });
      await packCard.waitFor();
      assert.match((await packCard.locator(".industry-pack-pages").innerText()).replace(/\s+/g, " "), /生产总览.*设备健康.*告警处置.*质量分析.*维护计划/);
      for (const name of ["生产总览", "设备健康", "告警处置", "质量分析", "维护计划"]) {
        await packCard.getByRole("button", { name, exact: true }).click();
        assert.equal(await packCard.locator(".template-layout-preview [data-template-node]").count(), 10, "预览必须来自整页十个实际节点");
        assert.equal(await packCard.getByRole("button", { name, exact: true }).getAttribute("aria-pressed"), "true");
      }
      entry.packLayout = await packCard.evaluate(card => {
        const preview = card.querySelector(".template-layout-preview");
        const details = card.querySelector(".industry-pack-details");
        const button = card.querySelector(".industry-pack-insert");
        return { height: card.getBoundingClientRect().height,
          contentHeight: Math.max(preview.getBoundingClientRect().height, details.getBoundingClientRect().height),
          detailsDisplay: getComputedStyle(details).display,
          previewStroke: getComputedStyle(preview.querySelector("rect")).stroke,
          actionColor: getComputedStyle(button).backgroundColor };
      });
      assert.equal(entry.packLayout.detailsDisplay, "flex", "详情不应继承普通模板三行布局");
      assert.ok(entry.packLayout.height <= entry.packLayout.contentHeight + 2, "卡片不应继承固定行高留下空白");
      assert.equal(entry.packLayout.previewStroke, entry.packLayout.actionColor, "行业包预览应使用当前品牌色");
      await shot("pack-card");
      await packCard.getByRole("button", { name: /导入整包（5 页）/ }).click();
      await modal.waitFor({ state: "detached" });
      await page.locator(".dashboard-page-tab").nth(0).waitFor();
      const tabs = page.locator(".dashboard-page-tab");
      assert.equal(await tabs.count(), beforePages + 5);
      assert.match(await page.locator(".dashboard-page-tab.active").innerText(), /生产总览/);
      await page.getByRole("button", { name: "撤销", exact: true }).click();
      await tabs.first().waitFor();
      assert.equal(await tabs.count(), beforePages, "一次撤销必须移除整包");
      await page.getByRole("button", { name: "重做", exact: true }).click();
      assert.equal(await tabs.count(), beforePages + 5);
      await tabs.filter({ hasText: "生产总览" }).click();
      await page.locator(".dashboard-artboard .dashboard-node").nth(2).waitFor();
      await shot("pack-imported");
      // 保存 → 校验 5 个新页都有 9 节点与共享联动 key
      const saving = page.waitForResponse(response => response.url().endsWith(appPath) && response.request().method() === "PUT");
      await page.getByRole("button", { name: "保存", exact: true }).click(); assert.equal((await saving).status(), 200);
      const saved = await gate.json("GET", appPath);
      const packPages = saved.pages.filter(savedPage => !application.pages.some(original => original.id === savedPage.id));
      assert.equal(packPages.length, 5);
      const linkageKeys = new Set();
      for (const savedPage of packPages) {
        assert.equal(savedPage.nodes.length, 10);
        assert.equal(savedPage.templateSource.kind, "industry-pack");
        assert.equal(savedPage.templateSource.packId, "manufacturing-asset-ops");
        assert.equal(savedPage.templateSource.revision, 1);
        const filterNode = savedPage.nodes.find(node => node.widget?.type === "filter");
        linkageKeys.add(filterNode?.widget?.key);
        assert.equal(filterNode?.widget?.options?.[0], "全部");
      }
      assert.equal(linkageKeys.size, 1, "同包筛选器必须共享一个联动 key");
      assert.equal(new Set(packPages.map(item => item.templateSource.instanceId)).size, 1);
      assert.equal(new Set(packPages.map(item => item.templateSource.pageTemplateId)).size, 5);
      assert.equal(saved.interactions.length - application.interactions.length, 5, "工作流必须实际写入应用");
      await page.reload();
      await page.locator(".dashboard-artboard .dashboard-node").nth(9).waitFor();
      // 浏览态联动：总览选 B → 设备健康页只剩 B 线设备
      await page.getByRole("button", { name: "浏览", exact: true }).click();
      const runtime = page.locator(".dashboard-runtime-preview"); await runtime.waitFor();
      await runtime.locator(".dashboard-value strong").filter({ hasText: /^2,600\s*件$/ }).waitFor();
      const filter = runtime.locator(".dashboard-runtime-artboard select").first();
      await filter.selectOption("B");
      await runtime.locator(".dashboard-value strong").filter({ hasText: /^920/ }).waitFor();
      await shot("runtime-filter-B");
      for (const [label, nextName] of [["查看产线设备", "设备健康"], ["追踪告警来源", "告警处置"], ["关联质量损失", "质量分析"], ["安排维护工单", "维护计划"], ["回到全局视角", "生产总览"]]) {
        await runtime.getByRole("button", { name: label, exact: true }).click();
        await runtime.locator(".dashboard-decoration-widget").filter({ hasText: nextName }).waitFor();
        assert.equal(await runtime.locator(".dashboard-runtime-artboard select").first().inputValue(), "B", "跨页跳转保留同包筛选");
        assert.equal(await runtime.getByRole("button", { name: "CSV", exact: true }).count(), 1, "每页台账都应提供导出");
        const [csv] = await Promise.all([page.waitForEvent("download"), runtime.getByRole("button", { name: "CSV", exact: true }).click()]);
        const csvPath = resolve(gate.output, `r${round}-${theme}-${nextName}.csv`); await csv.saveAs(csvPath);
        assert.match(await readFile(csvPath, "utf8"), /产线/, "必须导出实际台账字段而非排名编号");
        assert.doesNotMatch((await runtime.locator(".dashboard-value strong").allTextContents()).join(" "), /\.\d{4,}/, "KPI 不得显示无限小数");
        await page.waitForTimeout(1200);
        await shot(`workflow-${nextName}`);
      }
      await runtime.locator(".dashboard-value strong").filter({ hasText: /^920/ }).waitFor();
      // --- B: 图片导出 + 打印元素（先展开运行控制面板）---
      await runtime.getByRole("button", { name: "项目控制", exact: true }).click();
      await runtime.getByRole("button", { name: "导出图片", exact: true }).waitFor();
      const [image] = await Promise.all([page.waitForEvent("download"), runtime.getByRole("button", { name: "导出图片", exact: true }).click()]);
      const imagePath = resolve(gate.output, `r${round}-${theme}.png`); await image.saveAs(imagePath);
      const imageBytes = await readFile(imagePath);
      assert.equal(imageBytes[0], 0x89); assert.equal(imageBytes[1], 0x50); // PNG magic
      assert.ok(imageBytes.length > 20000, "整页截图不应只有几十字节");
      assert.equal(imageBytes.readUInt32BE(16), packPages[0].width);
      assert.equal(imageBytes.readUInt32BE(20), packPages[0].height);
      await page.locator("button.dashboard-runtime-back").click();
      // 发布 → 匿名页联动保持 + 打印页眉页脚
      const publishing = page.waitForResponse(response => response.url().endsWith(`${appPath}/publish`) && response.request().method() === "POST");
      await page.getByRole("button", { name: "发布", exact: true }).click(); assert.equal((await publishing).status(), 201);
      const anonymous = await themeContext(gate, theme, width);
      const publicPage = await anonymous.newPage(); observeDiagnostics(publicPage, entry);
      const publicBundle = await anonymous.request.get(`${gate.origin}/api/public/applications/${application.metadata.id}/browse`);
      assert.equal(publicBundle.status(), 200);
      const publicDocument = (await publicBundle.json()).publication.document;
      assert.deepEqual(publicDocument.pages.filter(item => item.templateSource).map(item => item.templateSource), packPages.map(item => item.templateSource), "来源版本必须经过真实发布并由匿名读取保留");
      await publicPage.goto(`${gate.origin}/apps/${application.metadata.id}`);
      await publicPage.locator(".dashboard-value strong").filter({ hasText: /^2,600\s*件$/ }).waitFor();
      const publicFilter = publicPage.locator(".dashboard-runtime-artboard select").first();
      await publicFilter.selectOption("C");
      await publicPage.locator(".dashboard-value strong").filter({ hasText: /^600/ }).waitFor();
      await publicPage.getByRole("button", { name: "查看产线设备", exact: true }).click();
      await publicPage.locator(".dashboard-decoration-widget").filter({ hasText: "设备健康" }).waitFor();
      assert.equal(await publicPage.locator(".dashboard-runtime-artboard select").first().inputValue(), "C");
      await publicPage.waitForTimeout(1200);
      await publicPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-public.png`) });
      await publicPage.emulateMedia({ media: "print" });
      assert.equal(await publicPage.locator(".dashboard-print-header").isVisible(), true);
      assert.match(await publicPage.locator(".dashboard-print-header strong").innerText(), /.+/);
      assert.equal(await publicPage.locator(".dashboard-print-footer").isVisible(), true);
      await publicPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-print-headerfooter.png`) });
      await anonymous.close();
      await shot("pack-runtime-done");
      // --- C1: V3-P2 返回二维复验（场景编辑 → 三维 → 返回二维不再被 schema 阻断）---
      const sceneId = application.scenes[0].id;
      await page.goto(scenePath);
      await page.getByRole("button", { name: "二维", exact: true }).waitFor({ timeout: 15000 });
      await shot("3d-before-back");
      await page.getByRole("button", { name: "二维", exact: true }).click();
      await page.locator(".dashboard-workspace").waitFor({ timeout: 15000 });
      assert.match(page.url(), /\/pages\//, "必须真正回到二维页面");
      const toast = page.locator(".app-toast, [role='alert']").filter({ hasText: /不属于 SceneDocument/ });
      assert.equal(await toast.count(), 0, "返回二维不应再出现 schema 校验错误");
      await shot("back-to-2d");
      // --- C2: V3-P1 /view 刷新复现取证（新标签打开场景浏览 → F5）---
      await page.goto(`${gate.origin}/manager?project=${project.id}`);
      await page.locator(".scene-card-title").first().waitFor({ timeout: 15000 });
      await shot("manager-cards");
      const viewPage = await context.newPage();
      observeDiagnostics(viewPage, entry);
      await viewPage.goto(`${gate.origin}/view/${sceneId}`);
      await viewPage.waitForLoadState("networkidle");
      const titleBefore = await viewPage.title();
      await viewPage.reload(); await viewPage.waitForLoadState("networkidle");
      await viewPage.waitForTimeout(2500);
      const h1After = await viewPage.locator("h1").first().innerText().catch(() => "");
      const canvasesAfter = await viewPage.locator("canvas").count();
      entry.viewRefresh = { titleBefore, h1After: h1After.slice(0, 60), canvasesAfter };
      await viewPage.screenshot({ path: resolve(gate.output, `r${round}-${theme}-view-refresh.png`) });
      // 复现标准：canvas 为 0 或标题退化为“未命名场景”即 V3-P1 仍存在
      entry.viewRefreshReproduced = canvasesAfter === 0 || h1After.includes("未命名场景");
      assert.equal(entry.viewRefreshReproduced, false, "浏览刷新退化必须阻断门禁");
      await viewPage.close();
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log("industry-packs gate passed");

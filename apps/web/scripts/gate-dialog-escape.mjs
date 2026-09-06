import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const gate = await createIsolatedStudioGate("dialog-escape");
const report = { createdAt: new Date().toISOString(), cases: [] };

async function fixture(label) {
  const project = await gate.json("POST", "/api/projects", { name: `Esc 隔离验证 ${label}` });
  const now = new Date().toISOString();
  const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
    schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "交互验证", revision: 1, createdAt: now, updatedAt: now },
    pages: [{ id: "page", name: "看板", width: 1920, height: 1080, viewportFit: "contain", nodes: [] }],
    scenes: [{ id: randomUUID(), name: "Esc 验证场景", camera: { position: { x: 5, y: 4, z: 5 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [],
      primitives: [{ modelId: "pump", name: "验证泵", kind: "box", color: "#ffffff", visible: true, opacity: 1, transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 2, y: 2, z: 2 } } }], measurements: [] }],
    topologies: [], geo: { providerIds: [], layers: [] }, data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [], scripts: [], assets: [], timelines: [], publicationProfiles: [],
  });
  const scene = application.scenes[0];
  const scenePath = `/api/projects/${project.id}/scenes/${scene.id}`;
  await gate.json("PUT", scenePath, { ...scene, projectId: project.id, schemaVersion: 1, createdAt: now, updatedAt: now });
  await gate.json("POST", `${scenePath}/publish`);
  return { project, application, scene, scenePath };
}

async function hold(page, url, method) {
  let release, entered, continued;
  const resumed = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const completed = new Promise(resolve => { continued = resolve; });
  let requests = 0;
  const handler = async route => {
    if (route.request().method() !== method) return route.fallback();
    requests++; entered(); await resumed;
    try { await route.continue(); } finally { continued(); }
  };
  await page.route(`**${url}`, handler);
  return { started, count: () => requests, release: async () => { release(); if (requests) await completed; await page.unroute(`**${url}`, handler); } };
}

async function assertOpen(page, selector) {
  await page.keyboard.press("Escape");
  assert.equal(await page.locator(selector).isVisible(), true, "Busy operation must keep the top dialog open");
  await page.mouse.click(2, 2);
  assert.equal(await page.locator(selector).isVisible(), true, "Busy operation must reject backdrop dismissal too");
}

async function inspectManagerLanguages(page, theme, round) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const results = [];
  for (const locale of ["zh-CN", "en-US"]) {
    const bounds = await page.locator(".manager-header").evaluate(header => ({
      locale: document.documentElement.lang, viewport: window.innerWidth, documentWidth: document.documentElement.scrollWidth,
      outside: [...header.querySelectorAll("button, summary, select")].filter(element => { const b = element.getBoundingClientRect(); return b.width > 0 && (b.left < -1 || b.right > window.innerWidth + 1); }).map(element => element.getAttribute("aria-label") ?? element.textContent),
    }));
    assert.equal(bounds.locale, locale); assert.ok(bounds.documentWidth <= 1441); assert.deepEqual(bounds.outside, []);
    await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-1440-manager-${locale}.png`) });
    results.push(bounds);
    await page.getByRole("button", { name: locale === "zh-CN" ? "切换语言" : "Switch language", exact: true }).click();
  }
  return results;
}

async function inspectFormControl(control, theme) {
  await control.focus(); await control.press("ArrowLeft");
  const style = await control.evaluate(input => {
    const rgb = value => value.startsWith("#") ? value.slice(1).match(/../g).map(part => Number.parseInt(part, 16)) : value.match(/[\d.]+/g).slice(0, 3).map(Number);
    const luminance = channels => channels.map(n => { const c = n / 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [.2126, .7152, .0722][i], 0);
    const normal = getComputedStyle(input), placeholder = getComputedStyle(input, "::placeholder");
    const bg = rgb(normal.backgroundColor), fg = rgb(placeholder.color), l1 = luminance(bg), l2 = luminance(fg);
    const accent = rgb(getComputedStyle(document.documentElement).getPropertyValue("--accent").trim());
    return { background: bg, color: normal.color, placeholder: placeholder.color, placeholderOpacity: placeholder.opacity,
      placeholderContrast: (Math.max(l1, l2) + .05) / (Math.min(l1, l2) + .05), focusVisible: input.matches(":focus-visible"),
      outline: normal.outlineColor, accent: `rgb(${accent.join(", ")})`, fontSize: normal.fontSize };
  });
  assert.equal(style.background.reduce((sum, channel) => sum + channel, 0) / 3 > 170, theme === "light", "The field surface must follow the active theme");
  assert.ok(style.placeholderContrast >= 4.5); assert.equal(style.placeholderOpacity, "1");
  assert.equal(style.focusVisible, true); assert.equal(style.outline, style.accent, "Keyboard focus must use the current brand accent");
  return style;
}

try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1280], ["light", 980]]) {
    const entry = { round, theme, width, passed: false, errors: [], driverWarnings: [], steps: [] };
    report.cases.push(entry);
    const data = await fixture(`${round}-${theme}`);
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(25000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      const text = message.text();
      if (/^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    const shot = async name => {
      await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-${name}.png`) });
      const bounds = await page.locator(".dialog-backdrop > :is(.dialog,.vision-modal)").evaluateAll(nodes => nodes.map(node => { const b = node.getBoundingClientRect(); return { width: b.width, left: b.left, right: b.right, top: b.top, bottom: b.bottom }; }));
      assert.ok(bounds.every(b => b.left >= -1 && b.right <= width + 1 && b.top >= -1 && b.bottom <= 901), "Dialog must stay within the viewport");
    };
    let pending;
    try {
      await gate.loginPage(page); await page.goto(`${gate.origin}/manager?project=${data.project.id}`);
      entry.navigation = await inspectManagerLanguages(page, theme, round);
      await page.setViewportSize({ width, height: 900 });
      await page.getByRole("button", { name: "重命名场景", exact: true }).first().click();
      const name = page.getByLabel("场景名称", { exact: true });
      entry.nameControl = await inspectFormControl(name, theme);
      await name.fill("仅取消的名称"); await shot("rename-keyboard");
      const hintGap = await name.evaluate(input => document.getElementById("scene-name-hint").getBoundingClientRect().top - input.getBoundingClientRect().bottom);
      assert.ok(hintGap >= 6, "The character hint must clear the outer keyboard focus ring");
      entry.contrast = await page.locator(".dialog").evaluate(collectTextContrast, "h2, p, .eyebrow, small, label > span, input, button");
      assert.deepEqual(entry.contrast.filter(item => item.contrast < 4.5), []);
      await page.keyboard.press("Escape"); await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
      assert.equal((await gate.json("GET", `/api/projects/${data.project.id}/scenes`))[0].name, data.scene.name);
      await page.getByRole("button", { name: "重命名场景", exact: true }).first().click(); await name.fill("已保存的名称");
      pending = await hold(page, data.scenePath, "PATCH");
      await page.getByRole("button", { name: "保存名称", exact: true }).click(); await pending.started;
      await assertOpen(page, ".dialog"); assert.equal(await page.getByRole("button", { name: "取消", exact: true }).isDisabled(), true);
      assert.equal(await name.isDisabled(), true);
      await shot("rename-busy-guard"); await pending.release(); pending = undefined;
      await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
      assert.equal((await gate.json("GET", `/api/projects/${data.project.id}/scenes`))[0].name, "已保存的名称");
      entry.steps.push("rename-Escape-cancels-no-write / busy-Escape-and-backdrop-blocked / successful-save");

      pending = await hold(page, `${data.scenePath}/publications`, "GET");
      await page.getByRole("button", { name: "版本历史", exact: true }).click(); await pending.started;
      await assertOpen(page, ".publication-history-dialog"); await shot("versions-loading");
      await pending.release(); pending = undefined;
      await page.locator(".publication-history-list article").first().waitFor();
      assert.ok(await page.locator(".publication-history-list article").count() > 0);
      await page.locator(".publication-history-list summary").first().click();
      entry.versionContrast = await page.locator(".publication-history-dialog").evaluate(collectTextContrast, "h2, p, .eyebrow, strong, small, summary, .publication-diff-sections span");
      assert.deepEqual(entry.versionContrast.filter(item => item.contrast < 4.5), []);
      await shot("versions-real-record"); await page.keyboard.press("Escape");
      await page.locator(".publication-history-dialog").waitFor({ state: "detached" });
      entry.steps.push("real-publication-history-nonempty / loading-busy / Escape-close");

      await page.getByRole("button", { name: "重新发布场景", exact: true }).first().click();
      entry.publishContrast = await page.locator(".publication-dialog").evaluate(collectTextContrast, "h2, p, strong, small");
      assert.deepEqual(entry.publishContrast.filter(item => item.contrast < 4.5), []);
      await page.locator(".publication-dialog").getByRole("button", { name: "WebGPU", exact: true }).click();
      assert.equal(await page.locator(".publication-dialog").getByRole("button", { name: "WebGPU", exact: true }).getAttribute("aria-pressed"), "true");
      await page.locator(".publication-dialog").getByRole("button", { name: "WebGL", exact: true }).click();
      await shot("publish-ready-theme");
      pending = await hold(page, `${data.scenePath}/publish`, "POST");
      await page.locator(".publication-dialog").getByRole("button", { name: "发布", exact: true }).click(); await pending.started;
      await assertOpen(page, ".publication-dialog");
      assert.equal(await page.locator(".publication-dialog .dialog-actions button").first().isDisabled(), true);
      assert.equal(await page.locator(".publication-dialog button:not(:disabled)").count(), 0, "Submitted publication choices must remain immutable while busy");
      await page.keyboard.press("Enter"); assert.equal(pending.count(), 1, "Busy publish must not create duplicate requests");
      await shot("publish-busy-guard"); await pending.release(); pending = undefined;
      await page.locator(".publication-dialog").waitFor({ state: "detached" });
      entry.steps.push("publish-busy-Escape-backdrop-no-duplicate");

      await page.locator('summary[aria-label="项目管理"]').click();
      await page.getByRole("button", { name: "新建项目", exact: true }).click();
      await page.getByLabel("项目名称", { exact: true }).fill("取消不会创建项目");
      entry.projectNameControl = await inspectFormControl(page.getByLabel("项目名称", { exact: true }), theme);
      entry.projectDescriptionControl = await inspectFormControl(page.getByLabel("项目说明", { exact: true }), theme);
      entry.projectContrast = await page.locator(".dialog").evaluate(collectTextContrast, "h2, .eyebrow, small, label > span, p, input, textarea");
      assert.deepEqual(entry.projectContrast.filter(item => item.contrast < 4.5), []);
      await shot("project-form-theme");
      await page.keyboard.press("Escape"); await page.locator(".dialog-backdrop").waitFor({ state: "detached" });
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "视觉中心", exact: true }).click();
      await page.getByRole("button", { name: "视觉源", exact: true }).click();
      await page.getByRole("button", { name: "添加视频源", exact: true }).click();
      const sourceType = page.locator(".vision-modal select").first();
      assert.match(await sourceType.locator("..").innerText(), /接入方式/);
      await sourceType.focus(); await page.keyboard.press("Alt+ArrowDown");
      await page.keyboard.press("Escape"); assert.equal(await page.locator(".vision-modal").isVisible(), true, "The first Escape belongs to the native select popup");
      await shot("nested-select-Escape-keeps-dialog");
      await page.keyboard.press("Escape"); await page.locator(".vision-modal").waitFor({ state: "detached" });
      entry.steps.push("project-cancel / native-inner-select-Escape-first / second-Escape-dismisses-dialog");

      const applicationPath = `/api/projects/${data.project.id}/applications/${data.application.metadata.id}`;
      const studio = `${gate.origin}/studio/${data.project.id}/applications/${data.application.metadata.id}/scenes/${data.scene.id}`;
      await page.goto(studio); await page.locator(".viewport canvas").waitFor();
      const auto = page.getByLabel("自动保存"); if (await auto.isChecked()) await auto.uncheck();
      const primitive = page.locator(".scene-tree-row.object").filter({ hasText: "验证泵" });
      if (!await primitive.count()) await page.getByRole("button", { name: "场景图层与编组", exact: true }).click();
      await primitive.click();
      await page.getByRole("button", { name: "隐藏所选元素", exact: true }).click();
      await page.waitForTimeout(850);
      if (round === 2) {
        const serverDraft = await gate.json("GET", applicationPath);
        const saved = await gate.json("PUT", applicationPath, serverDraft);
        assert.ok(saved.metadata.revision > serverDraft.metadata.revision, "Isolated server update must advance the recovery comparison revision");
      }
      await page.reload();
      const recovery = page.getByRole("dialog", { name: "恢复未保存工作", exact: true }); await recovery.waitFor();
      assert.equal(await recovery.locator(".workspace-recovery-warning").count(), round === 2 ? 1 : 0);
      entry.recoveryContrast = await recovery.evaluate(collectTextContrast, "h2, p, strong, small, button");
      assert.deepEqual(entry.recoveryContrast.filter(item => item.contrast < 4.5 || item.fontSize < 12), []);
      await page.mouse.click(2, 2); assert.equal(await recovery.isVisible(), true, "Recovery backdrop must not acquire mouse dismissal");
      await shot("recovery-before-Escape"); await page.keyboard.press("Escape");
      await recovery.waitFor({ state: "detached" }); await page.getByText("已使用服务器版本打开；本地恢复副本仍保留，可稍后处理", { exact: false }).waitFor();
      assert.equal((await gate.json("GET", applicationPath)).scenes[0].primitives[0].visible, true, "Escape must not overwrite server data");
      await shot("recovery-deferred"); await page.reload(); await recovery.waitFor();
      await shot("recovery-copy-preserved-on-reload"); await page.keyboard.press("Escape"); await recovery.waitFor({ state: "detached" });
      entry.steps.push("real-local-edit-and-reload / recovery-backdrop-keeps / Escape-defers-not-discards / reload-offers-preserved-copy / server-unchanged");
      assert.deepEqual(entry.errors, []); entry.passed = true;
    } catch (error) { entry.failure = error.stack ?? String(error); entry.url = page.url(); await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${width}-failed.png`) }); }
    finally { await pending?.release(); await context.close(); console.log(JSON.stringify(entry)); }
    if (!entry.passed) throw new Error(entry.failure);
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, report }, null, 2));
assert.equal(report.cases.filter(entry => entry.passed).length, 4);

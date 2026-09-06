import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const baseline = process.env.INSPECTOR_BASELINE === "1";
const accent = process.env.INSPECTOR_ACCENT;
assert.ok(!accent || /^#[\da-f]{6}$/i.test(accent), "INSPECTOR_ACCENT must be an opaque six-digit fixture color");
const gate = await createIsolatedStudioGate(baseline ? "inspector-baseline" : "inspector-theme");
const report = { createdAt: new Date().toISOString(), baseline, accent: accent ?? "default", cases: [] };
try {
  for (const theme of ["light", "dark"]) for (const width of [1280, 980]) {
    const entry = { theme, width, errors: [], driverWarnings: [], steps: [] }; report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `检查器-${theme}-${width}` });
    const now = new Date().toISOString();
    const scene = { id: randomUUID(), name: "设备属性验收", camera: { position: { x: 6, y: 5, z: 8 }, target: { x: 0, y: 0, z: 0 }, mode: "orbit" }, models: [], measurements: [],
      primitives: [{ modelId: "inspector-device", name: "装配工位设备 · 长名称完整展示检查", kind: "box", color: "#3ec6c1", visible: true, opacity: 1,
        transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1.5, y: 1.5, z: 1.5 } } }] };
    await gate.json("PUT", `/api/projects/${project.id}/scenes/${scene.id}`, { ...scene, schemaVersion: 1, projectId: project.id, createdAt: now, updatedAt: now });
    const application = await gate.json("POST", `/api/projects/${project.id}/applications`, {
      schemaVersion: 2, metadata: { id: randomUUID(), projectId: project.id, name: "检查器验收", revision: 1, createdAt: now, updatedAt: now },
      pages: [{ id: "one", name: "概览", width: 720, height: 650, viewportFit: "contain", nodes: [] }], scenes: [scene], topologies: [], geo: { providerIds: [], layers: [] },
      data: { connectionIds: [], datasetIds: [], transforms: [], variables: [] }, interactions: [], scripts: [], assets: [], timelines: [], publicationProfiles: [{ id: "browser", name: "浏览器", target: "browser-preview", entryPageId: "one", renderer: "auto" }],
    });
    const appPath = `/api/projects/${project.id}/applications/${application.metadata.id}`;
    const context = await gate.browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: "reduce" });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme, ...(accent ? { primaryColor: accent } : {}) } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["warning", "error"].includes(message.type())) return;
      const text = message.text();
      if (message.type() === "warning" && /^THREE\.WebGLProgram: Program Info Log:/.test(text) && /warning X4122: sum of/.test(text) && !/error/i.test(text)) entry.driverWarnings.push(text);
      else entry.errors.push(text);
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    const inspector = page.locator(".right-panel");
    try {
      await gate.loginPage(page);
      await page.goto(`${gate.origin}/studio/${project.id}/applications/${application.metadata.id}/scenes/${scene.id}`);
      await page.locator(".viewport canvas").waitFor();
      await inspector.locator(".empty-inspector").waitFor();
      await shot("empty");
      entry.emptyContrast = await inspector.evaluate(collectTextContrast, ".empty-inspector strong, .empty-inspector span");
      await page.locator(".scene-tree-row.object").filter({ hasText: scene.primitives[0].name }).click();
      await inspector.locator(".transform-fields").first().waitFor();
      await shot("overview");
      entry.contrast = await inspector.evaluate(collectTextContrast, ".inspector-selection-context strong, .inspector-selection-context small, .inspector-context-tabs button, .field > span, .field input:not([type=color]), .field output, .toggle, .transform-fields legend, .transform-fields label span, .transform-fields input, .transform-fields label i");
      entry.layout = await inspector.evaluate(root => ({ width: root.clientWidth, scrollWidth: root.scrollWidth, fields: [...root.querySelectorAll(".transform-fields input")].map(n => ({ font: getComputedStyle(n).fontSize, numeric: getComputedStyle(n).fontVariantNumeric, width: n.clientWidth })) }));
      const appearance = inspector.locator(".inspector-appearance-settings");
      await appearance.locator("summary").first().click();
      await appearance.scrollIntoViewIfNeeded(); await shot("appearance");
      entry.appearanceContrast = await appearance.evaluate(collectTextContrast, "summary, label, output, button:not(:disabled), small");
      await appearance.locator("summary").first().click();
      await inspector.getByRole("button", { name: "数据", exact: false }).click();
      await shot("data");
      await inspector.getByRole("button", { name: "行为", exact: false }).click();
      await shot("behavior");
      await inspector.getByRole("button", { name: "概览", exact: true }).click();
      entry.steps.push("empty-guidance", "select-real-scene-object", "appearance-collapse-expand", "data-behavior-overview-roundtrip");
      if (!baseline) {
        const x = inspector.locator(".transform-fields").first().locator("input").first();
        await x.fill("12.375"); await x.press("ArrowLeft");
        entry.focus = await x.evaluate(input => ({ color: getComputedStyle(input.closest("label")).outlineColor, accent: getComputedStyle(document.documentElement).getPropertyValue("--accent").trim(), visible: input.matches(":focus-visible"), inputOutline: getComputedStyle(input).outlineStyle }));
        const expectedFocus = entry.focus.accent.slice(1).match(/.{2}/g).map(hex => Number.parseInt(hex, 16));
        assert.equal(entry.focus.visible, true);
        assert.equal(entry.focus.color, `rgb(${expectedFocus.join(", ")})`);
        assert.equal(entry.focus.inputOutline, "none");
        await shot("keyboard-focus");
        await x.press("Escape"); assert.equal(await x.inputValue(), "0");
        for (const invalid of ["", "-", "Infinity", "1e999", "文字"]) {
          await x.fill(invalid); await x.press("Enter"); assert.equal(await x.inputValue(), "0");
        }
        await x.fill("1.125"); await x.press("Enter"); assert.equal(await x.inputValue(), "1.125");
        entry.lockControls = await inspector.locator(".two-column").ariaSnapshot();
        await inspector.locator("button.toggle").filter({ hasText: "未锁定" }).click();
        assert.ok(await x.isDisabled());
        entry.lockedInput = await x.evaluate(input => ({ opacity: getComputedStyle(input).opacity, cursor: getComputedStyle(input).cursor }));
        assert.equal(entry.lockedInput.cursor, "not-allowed");
        assert.equal(Number(entry.lockedInput.opacity), .5);
        await shot("locked");
        await inspector.locator("button.toggle").filter({ hasText: "已锁定" }).click();
        assert.equal(await x.isDisabled(), false);
        const save = page.waitForResponse(response => response.url().includes(appPath) && response.request().method() === "PUT");
        await page.getByRole("button", { name: "保存项目", exact: true }).click(); await save;
        const saved = await gate.json("GET", appPath);
        assert.equal(saved.scenes[0].primitives[0].transform.position.x, 1.125);
        await page.reload(); await page.locator(".viewport canvas").waitFor();
        await page.locator(".scene-tree-row.object").filter({ hasText: scene.primitives[0].name }).click();
        assert.equal(await x.inputValue(), "1.125"); await shot("saved-reloaded");
        entry.steps.push("escape-cancels-draft", "invalid-value-restored", "enter-commits", "save-reload-position");
        assert.deepEqual(entry.contrast.filter(item => item.contrast < 4.5), []);
        assert.deepEqual(entry.emptyContrast.filter(item => item.contrast < 4.5), []);
        assert.deepEqual(entry.appearanceContrast.filter(item => item.contrast < 4.5), []);
        assert.ok(entry.layout.scrollWidth <= entry.layout.width);
        assert.ok(entry.layout.fields.every(field => field.numeric === "tabular-nums" && field.width >= 30));
        assert.deepEqual(entry.errors, []);
      }
      entry.passed = true;
    } catch (error) { entry.failure = String(error); await shot("failure"); }
    finally {
      await context.close();
      console.log(JSON.stringify({ theme, width, passed: entry.passed, failure: entry.failure, errors: entry.errors.length,
        minimumContrast: Math.min(...[entry.contrast, entry.emptyContrast, entry.appearanceContrast].flatMap(items => items?.map(item => item.contrast) ?? [])) }));
    }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); console.log(gate.output); }
assert.ok(report.cases.every(entry => entry.passed), `Inspect ${gate.output}`);

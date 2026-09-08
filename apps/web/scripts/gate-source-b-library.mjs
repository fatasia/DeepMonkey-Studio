import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { collectTextContrast } from "./browserTextContrast.mjs";

const root = resolve(import.meta.dirname, "../../..");
const cache = resolve(root, "data/external-assets/source-b");
const catalog = JSON.parse(await readFile(resolve(cache, "catalog.json"), "utf8"));
const audit = JSON.parse(await readFile(resolve(cache, "audit.json"), "utf8"));
const approvedReviews = audit.items.filter(item => item.status === "approved");
function collectThumbnailGeometry(images) {
  return images.map(image => {
    const preview = image.closest(".unified-asset-preview"), box = preview.getBoundingClientRect(), rect = image.getBoundingClientRect();
    const style = getComputedStyle(image), containerStyle = getComputedStyle(preview);
    return { name: image.closest(".unified-asset-card").querySelector("strong")?.textContent,
      complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
      image: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      preview: { x: box.x, y: box.y, width: box.width, height: box.height },
      objectFit: style.objectFit, minHeight: style.minHeight, imageHeight: style.height,
      display: containerStyle.display, gridRows: containerStyle.gridTemplateRows, aspectRatio: containerStyle.aspectRatio,
      clipped: rect.left < box.left - 1 || rect.top < box.top - 1 || rect.right > box.right + 1 || rect.bottom > box.bottom + 1 };
  });
}

function assertThumbnailGeometry(images) {
  if (!process.argv.includes("--inspect-geometry")) {
    assert.deepEqual(images.filter(image => image.clipped || !image.complete || image.naturalWidth === 0), [], "Real thumbnail image must fit its preview container");
  }
}
const gate = await createIsolatedStudioGate("source-b-library");
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  const target = resolve(gate.output, "data/external-assets/source-b");
  const sourceA = resolve(gate.output, "data/external-assets/source-a");
  await Promise.all([mkdir(sourceA, { recursive: true }), mkdir(resolve(target, "models"), { recursive: true }), mkdir(resolve(target, "reviewed-thumbnails"), { recursive: true })]);
  await writeFile(resolve(sourceA, "catalog.json"), '{"models":[],"files":[]}');
  await writeFile(resolve(sourceA, "audit.json"), '{"items":[]}');
  await copyFile(resolve(cache, "catalog.json"), resolve(target, "catalog.json"));
  await copyFile(resolve(cache, "audit.json"), resolve(target, "audit.json"));
  for (const review of approvedReviews) {
    assert.match(review.uid, /^[a-f0-9]{32}$/);
    assert.equal(review.thumbnail.relativePath, `reviewed-thumbnails/${review.uid}.png`);
    await copyFile(resolve(cache, "models", `${review.uid}.glb`), resolve(target, "models", `${review.uid}.glb`));
    await copyFile(resolve(cache, review.thumbnail.relativePath), resolve(target, review.thumbnail.relativePath));
  }
  const available = await gate.json("GET", "/api/asset-library");
  assert.equal(available.total, approvedReviews.length, "Only individually approved assets may be visible");
  assert.deepEqual(available.items.map(item => item.id).sort(), approvedReviews.map(item => `community-${item.uid}`).sort());
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, passed: false, errors: [], steps: [], imports: [] };
    report.cases.push(entry);
    const project = await gate.json("POST", "/api/projects", { name: `素材闭环-${theme}-${width}` });
    const context = await gate.browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => { const response = await route.fetch(); await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } }); });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    let fault = false;
    page.on("pageerror", error => entry.errors.push(error.message));
    page.on("console", message => {
      if (!["error", "warning"].includes(message.type())) return;
      if (fault && /^Failed to load resource: the server responded with a status of 503/.test(message.text())) return;
      entry.errors.push(message.text());
    });
    const shot = name => page.screenshot({ path: resolve(gate.output, `${theme}-${width}-${name}.png`) });
    try {
      await gate.loginPage(page);
      await page.getByLabel("当前项目").selectOption(project.id);
      const flow = page.locator(".project-delivery-flow");
      await flow.getByRole("button", { name: "展开开发流程" }).click();
      await flow.locator('button[data-step-id="assets"]').click();
      const library = page.locator(".unified-assets-browser"); await library.waitFor();
      await page.getByRole("tab", { name: "三维模型", exact: true }).click();
      await library.getByRole("button", { name: "精选资源", exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".unified-assets-summary")?.textContent.includes("个可用资源"));
      assert.equal(await library.locator(".unified-asset-card").count(), approvedReviews.length, "Disabling curated must include, not exclude, curated assets");
      for (const review of approvedReviews) {
        const source = catalog.models.find(model => model.uid === review.uid);
        const card = library.locator(".unified-asset-card").filter({ hasText: review.displayName });
        await card.waitFor();
        await page.waitForFunction(name => [...document.querySelectorAll(".unified-asset-card")].find(card => card.textContent.includes(name))?.querySelector("img")?.naturalWidth > 0, review.displayName);
        const image = await card.locator("img").getAttribute("src");
        const thumbnail = await gate.client.get(image);
        assert.equal(createHash("sha256").update(await thumbnail.body()).digest("hex"), review.thumbnail.sha256);
        await card.locator("summary").press("Enter");
        assert.match(await card.locator(".asset-attribution").innerText(), new RegExp(source.author));
        assert.equal(await card.getByRole("link", { name: "许可条款" }).getAttribute("href"), source.licenseUrl);
        await shot(`${review.uid}-credit`);
        entry.contrast = await library.evaluate(collectTextContrast, ".unified-asset-copy strong, .unified-asset-copy small, .asset-attribution summary, .asset-attribution p, .asset-attribution a, .asset-import");
        entry.contrast.push(...await page.locator(".unified-assets-page").evaluate(collectTextContrast, ".unified-assets-head h2, .unified-assets-head p, .unified-assets-scope button, .unified-assets-kinds button, .unified-assets-controls button, .unified-assets-dimensions button, .unified-assets-summary span, .quality-tier, .asset-animation, .asset-publication"));
        assert.deepEqual(entry.contrast.filter(item => item.text && item.contrast < 4.5), [], "Asset card text below 4.5:1");
        await card.locator("summary").press("Enter");
        await card.getByRole("button", { name: "导入", exact: true }).click();
        await card.getByRole("button", { name: "已在项目", exact: true }).waitFor();
        let imported;
        for (let attempt = 0; attempt < 100; attempt++) {
          imported = (await gate.json("GET", `/api/projects/${project.id}`)).models.find(model => model.libraryOrigin?.itemId === `community-${review.uid}`);
          if (imported?.status === "ready" || imported?.status === "failed") break;
          await page.waitForTimeout(200);
        }
        assert.equal(imported?.status, "ready", imported?.message);
        assert.equal(imported.libraryOrigin.attribution.text, source.attribution);
        const sourceFile = await gate.client.get(imported.sourceUrl);
        assert.equal(createHash("sha256").update(await sourceFile.body()).digest("hex"), source.sha256);
        const repeat = await gate.json("POST", `/api/projects/${project.id}/asset-library/community-${review.uid}/import`);
        assert.equal(repeat.reused, true); assert.equal(repeat.model.id, imported.id);
        entry.imports.push({ id: imported.id, name: imported.name, ready: true, sourceHash: source.sha256 });
      }
      assert.equal(new URL(page.url()).searchParams.get("project"), project.id);
      assert.equal(new URL(page.url()).searchParams.get("tab"), "assets");
      await page.reload(); await library.waitFor();
      assert.equal(await page.getByLabel("当前项目").inputValue(), project.id);
      await library.getByRole("button", { name: "已在项目", exact: true }).nth(approvedReviews.length - 1).waitFor();
      assert.equal(await library.getByRole("button", { name: "已在项目", exact: true }).count(), approvedReviews.length);
      await page.waitForFunction(count => {
        const images = [...document.querySelectorAll(".unified-asset-card img")];
        return images.length === count && images.every(image => image.complete && image.naturalWidth > 0);
      }, approvedReviews.length);
      await library.locator("img").evaluateAll(images => Promise.all(images.map(image => image.decode())));
      await page.mouse.move(0, 0);
      await page.waitForTimeout(300);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      entry.thumbnailGeometry = await library.locator(".unified-asset-preview img").evaluateAll(collectThumbnailGeometry);
      await shot("imported-after-reload");
      assert.equal(entry.thumbnailGeometry.length, approvedReviews.length);
      assertThumbnailGeometry(entry.thumbnailGeometry);
      entry.thumbnailHover = [];
      for (const card of await library.locator(".unified-asset-card").all()) {
        await card.hover(); await page.waitForTimeout(300);
        const [geometry] = await card.locator("img").evaluateAll(collectThumbnailGeometry);
        entry.thumbnailHover.push(geometry);
        assertThumbnailGeometry([geometry]);
      }
      await page.mouse.move(0, 0);
      await library.locator(".unified-asset-card").first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(300);
      await shot("imported-after-hover");
      const search = page.getByRole("textbox", { name: "搜索资源", exact: true });
      await search.fill("不会匹配的名称"); await page.getByText("没有匹配资源", { exact: true }).waitFor();
      await shot("empty-search");
      fault = true;
      await page.route("**/api/asset-library?**", route => route.fulfill({ status: 503, contentType: "application/json", body: '{"message":"目录暂不可用"}' }));
      await search.fill("夹爪"); await page.getByText("资源目录暂不可用", { exact: true }).waitFor(); await shot("catalog-error");
      await page.unroute("**/api/asset-library?**");
      await library.getByRole("button", { name: "重试", exact: true }).click();
      await library.locator(".unified-asset-card").filter({ hasText: "平行机械夹爪" }).waitFor();
      if (theme === "dark" && width === 1440) {
        const other = await gate.json("POST", "/api/projects", { name: "延迟导入项目" });
        await page.reload(); await library.waitFor();
        await page.getByLabel("当前项目").selectOption(other.id);
        let release, received;
        const held = new Promise(resolve => { release = resolve; });
        const started = new Promise(resolve => { received = resolve; });
        await page.route(`**/api/projects/${other.id}/asset-library/**/import`, async route => {
          const response = await route.fetch(); received(); await held; await route.fulfill({ response });
        });
        await library.locator(".unified-asset-card").filter({ hasText: "平行机械夹爪" }).getByRole("button", { name: "导入", exact: true }).click();
        await started;
        await page.getByLabel("当前项目").selectOption(project.id);
        release(); await page.waitForTimeout(500);
        assert.equal(await page.getByLabel("当前项目").inputValue(), project.id, "Late import must not switch the active project");
        assert.equal(new URL(page.url()).searchParams.get("project"), project.id);
        assert.equal(await library.getByRole("button", { name: "已在项目", exact: true }).count(), approvedReviews.length);
        await shot("late-import-project-protected");
        entry.steps.push("late-import-project-protected");
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.deepEqual(entry.errors, []);
      entry.steps.push("licensed-real-render-thumbnail", "keyboard-attribution", "import-convert-source-preserved", "duplicate-reuse", "reload-project-and-workspace", "curated-off-keeps-all", "empty-search", "503-retry");
      entry.passed = true;
    } catch (error) { entry.failure = error.stack; await shot("failed"); throw error; }
    finally { await context.close(); console.log(JSON.stringify(entry)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(report, null, 2)); await gate.close(); }
console.log(JSON.stringify({ output: gate.output, ...report }));

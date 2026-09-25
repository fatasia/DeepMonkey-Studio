import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import playwright from "../../cloud-render-worker/node_modules/playwright-core/index.js";

// 原项目只读回归；全部视图操作必须零业务写入。测试主题仅替换浏览器收到的品牌响应。
const origin = process.env.BIM_STUDIO_QA_ORIGIN ?? "http://127.0.0.1:5173";
const output = fileURLToPath(new URL("../../../test-output/runs/2026-09-05/topology/", import.meta.url));
await mkdir(output, { recursive: true });
const browser = await playwright.chromium.launch({ executablePath: process.env.BIM_STUDIO_CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true });
const report = { createdAt: new Date().toISOString(), cases: [] };
try {
  for (const theme of ["dark", "light"]) for (const width of [1440, 980]) {
    const entry = { theme, width, errors: [], writes: [], checks: [] };
    report.cases.push(entry);
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await context.route("**/api/public/branding", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, json: { ...await response.json(), themeMode: theme } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on("pageerror", e => entry.errors.push(e.message));
    page.on("console", m => { if (["warning", "error"].includes(m.type())) entry.errors.push(m.text()); });
    page.on("request", r => {
      if (!["GET", "HEAD", "OPTIONS"].includes(r.method()) && !r.url().endsWith("/api/auth/login")) entry.writes.push(`${r.method()} ${r.url()}`);
    });
    const shot = name => page.screenshot({ path: `${output}${theme}-${width}-${name}.png` });
    const fitCheck = async label => {
      await page.waitForFunction(() => {
        const viewport = document.querySelector(".topology-editor__scroll");
        if (!viewport) return false;
        const r = viewport.getBoundingClientRect();
        const nodes = [...document.querySelectorAll(".topology-editor__node")];
        return nodes.length > 0 && nodes.every(node => {
          const n = node.getBoundingClientRect();
          return n.left >= r.left + 8 && n.right <= r.left + viewport.clientWidth - 8 && n.top >= r.top + 8 && n.bottom <= r.top + viewport.clientHeight - 8;
        });
      });
      entry.checks.push(label);
    };
    const positions = () => page.locator(".topology-editor__node").evaluateAll(nodes => nodes.map(n => [n.style.left, n.style.top]));
    try {
      await page.goto(`${origin}/manager`);
      await page.getByRole("textbox", { name: "用户名", exact: true }).fill("admin");
      await page.getByLabel("密码", { exact: true }).fill("admin");
      await page.getByRole("button", { name: "登录", exact: true }).click();
      await page.getByLabel("当前项目").selectOption({ label: "智造综合案例验证" });
      await page.getByRole("button", { name: "拓扑", exact: true }).click();
      await page.getByRole("button", { name: "打开编辑", exact: true }).first().click();
      await fitCheck("initial-all-nodes");
      const before = await positions();
      assert.match(await page.getByRole("status", { name: "SCADA 运行诊断" }).innerText(), /待数据/);
      assert.doesNotMatch(await page.getByRole("status", { name: "SCADA 运行诊断" }).innerText(), /失联|离线/);
      const bg = await page.locator(".topology-editor__palette").evaluate(n => getComputedStyle(n).backgroundColor);
      assert.equal(bg, theme === "light" ? "rgb(255, 255, 255)" : "rgb(21, 27, 30)");
      await shot("initial-fit");
      await page.getByRole("button", { name: "收起属性面板", exact: true }).click();
      await fitCheck("inspector-collapse");
      await page.getByRole("button", { name: "展开属性面板", exact: true }).click();
      await fitCheck("inspector-expand");
      await page.getByRole("button", { name: "收起设备库", exact: true }).click();
      await fitCheck("palette-collapse");
      await page.getByRole("button", { name: "展开设备库", exact: true }).click();
      await fitCheck("palette-expand");
      await page.getByRole("button", { name: "层级", exact: true }).click();
      await page.locator(".topology-editor__viewport.is-2-5d").waitFor();
      await fitCheck("2.5d-projection");
      await shot("2.5d-fit");
      await page.getByRole("button", { name: "2D", exact: true }).click();
      await fitCheck("back-to-2d");
      const zoom = page.locator(".topology-editor__zoom-value");
      await zoom.click();
      assert.equal(await zoom.innerText(), "100%");
      await page.getByRole("button", { name: "缩小", exact: true }).click();
      assert.equal(await zoom.innerText(), "90%");
      await page.getByRole("button", { name: "收起属性面板", exact: true }).click();
      assert.equal(await zoom.innerText(), "90%", "manual zoom must survive sidebar changes");
      await page.getByRole("button", { name: "展开属性面板", exact: true }).click();
      await page.getByRole("button", { name: "显示全部节点", exact: true }).focus();
      await page.keyboard.press("Enter");
      await fitCheck("keyboard-fit-after-manual-zoom");
      await page.setViewportSize({ width: width === 980 ? 1440 : 980, height: 740 });
      await fitCheck("window-resize");
      assert.deepEqual(await positions(), before, "view operations must not rearrange nodes");
      assert.equal(await page.getByRole("button", { name: "撤销 Ctrl+Z", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "保存", exact: true }).isDisabled(), true);
      // 独立内存夹具验证编辑坐标、负投影、空态、切文档；不会触碰原拓扑。
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${origin}/?__visualQa=topology&theme=${theme}`);
      await fitCheck("fixture-extreme-bounds");
      const snapshot = async () => JSON.parse(await page.getByLabel("拓扑快照").textContent());
      const original = await snapshot();
      const node = page.locator(".topology-editor__node").filter({ hasText: "未知仪表" });
      const box = await node.boundingBox();
      assert.ok(box);
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 32, box.y + box.height / 2 + 16, { steps: 8 });
      await page.mouse.up();
      assert.equal(await page.getByLabel("文档修改次数").innerText(), "1");
      const changed = await snapshot();
      assert.notDeepEqual(changed.nodes[1], original.nodes[1]);
      await page.getByRole("button", { name: "撤销 Ctrl+Z", exact: true }).click();
      assert.deepEqual((await snapshot()).nodes, original.nodes);
      assert.equal(await page.getByRole("button", { name: "撤销 Ctrl+Z", exact: true }).isDisabled(), true);
      await page.getByRole("button", { name: "层级", exact: true }).click();
      await fitCheck("fixture-negative-elevation");
      await shot("fixture-elevation-status");
      await page.getByRole("button", { name: "空拓扑夹具", exact: true }).click();
      await page.getByText("从左侧添加第一个节点", { exact: true }).waitFor();
      assert.equal(await page.locator(".topology-editor__node").count(), 0);
      const empty = await page.getByText("从左侧添加第一个节点", { exact: true }).boundingBox();
      assert.ok(empty && empty.x > 0 && empty.x + empty.width < width && empty.y < 900);
      await shot("fixture-empty");
      await page.getByRole("button", { name: "2D", exact: true }).click();
      await page.getByRole("button", { name: "通用设备 device", exact: true }).click();
      await fitCheck("fixture-first-node-visible");
      await page.getByRole("button", { name: "单节点夹具", exact: true }).click();
      await fitCheck("fixture-switch-document");
      await page.getByRole("button", { name: "恢复完整夹具", exact: true }).click();
      await fitCheck("fixture-restore-document");
      assert.equal(await page.getByLabel("文档修改次数").innerText(), "3", "only drag, undo and adding a node may add edits");
      assert.deepEqual(entry.writes, []);
      assert.deepEqual(entry.errors, []);
      entry.passed = true;
    } catch (error) {
      entry.failure = String(error);
      await shot("failed");
      throw error;
    } finally { await context.close(); }
  }
} finally {
  await browser.close();
  await writeFile(`${output}report.json`, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

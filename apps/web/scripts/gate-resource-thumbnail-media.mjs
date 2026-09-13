import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import sharp from "sharp";
import { createIsolatedStudioGate } from "./isolatedStudioGate.mjs";
import { themeContext } from "./gateModelInstancesSupport.mjs";

const gate = await createIsolatedStudioGate("thumbnail-media");
const cases = [];
console.log(JSON.stringify({ output: gate.output }));
try {
  for (const round of [1, 2]) for (const [theme, width] of [["dark", 1440], ["light", 980]]) {
    const context = await themeContext(gate, theme, width), page = await context.newPage();
    const result = { round, theme, width, passed: false, errors: [] }; cases.push(result);
    page.on("pageerror", error => result.errors.push(error.message));
    try {
      await gate.loginPage(page);
      const project = await gate.json("POST", "/api/projects", { name: `媒体缩略图-${round}-${theme}` });
      const image = await sharp({ create: { width: 640, height: 480, channels: 3, background: "steelblue" } }).png().toBuffer();
      const video = Buffer.from(await page.evaluate(async () => {
        const canvas = document.createElement("canvas"); canvas.width = 320; canvas.height = 240;
        document.body.append(canvas);
        const ctx = canvas.getContext("2d"), stream = canvas.captureStream(0);
        const recorder = new MediaRecorder(stream, { mimeType: "video/webm;codecs=vp8" }), chunks = [];
        const stopped = new Promise(resolve => { recorder.ondataavailable = event => chunks.push(event.data); recorder.onstop = async () => resolve(Array.from(new Uint8Array(await new Blob(chunks).arrayBuffer()))); });
        recorder.start(100);
        for (let frame = 0; frame < 5; frame++) {
          ctx.fillStyle = "steelblue"; ctx.fillRect(0, 0, 320, 240);
          ctx.fillStyle = "goldenrod"; ctx.fillRect(30 + frame * 10, 30, 160, 120);
          stream.getVideoTracks()[0].requestFrame(); await new Promise(resolve => setTimeout(resolve, 200));
        }
        recorder.stop();
        const bytes = await stopped; stream.getTracks().forEach(track => track.stop()); canvas.remove(); return bytes;
      }));
      assert.ok(video.length > 500, `Video fixture is empty: ${video.length}`);
      for (const [collection, name, mimeType, buffer] of [["images", "验证图片.png", "image/png", image], ["videos", "验证视频.webm", "video/webm", video]]) {
        const uploaded = await gate.client.post(`/api/projects/${project.id}/assets/${collection}`, { multipart: { file: { name, mimeType, buffer } } });
        assert.equal(uploaded.status(), 201); const asset = await uploaded.json();
        await page.goto(`${gate.origin}/manager?project=${project.id}&tab=assets&scope=project`);
        const card = page.locator(".project-resource-card").filter({ has: page.getByText(name, { exact: true }) });
        await card.locator(".project-resource-thumbnail").click();
        const dialog = page.locator(".resource-preview-dialog"), capture = dialog.getByRole("button", { name: "截取预览", exact: true });
        await capture.waitFor(); await page.waitForFunction(() => [...document.querySelectorAll(".resource-thumbnail-editor button")].some(button => button.textContent.includes("截取") && !button.disabled));
        await capture.click(); await dialog.locator(".resource-thumbnail-crop canvas").waitFor();
        await dialog.getByRole("button", { name: "保存缩略图", exact: true }).click();
        await dialog.getByText("缩略图已保存", { exact: true }).waitFor();
        await page.screenshot({ path: resolve(gate.output, `r${round}-${theme}-${collection}.png`) });
        const saved = (await gate.json("GET", `/api/projects/${project.id}/assets`)).find(item => item.id === asset.id);
        assert.equal(saved.url, asset.url); assert.ok(saved.thumbnailUrl?.endsWith(".webp"));
        await dialog.getByRole("button", { name: "关闭资源浏览", exact: true }).click(); await page.reload();
        await card.locator("img.is-ready").waitFor(); assert.equal(await card.locator("img").getAttribute("src"), saved.thumbnailUrl);
      }
      assert.deepEqual(result.errors, []); result.passed = true;
    } catch (error) { result.failure = error.stack; await page.screenshot({ path: resolve(gate.output, "failed.png") }); throw error; }
    finally { await context.close(); console.log(JSON.stringify(result)); }
  }
} finally { await writeFile(resolve(gate.output, "report.json"), JSON.stringify(cases, null, 2)); await gate.close(); }

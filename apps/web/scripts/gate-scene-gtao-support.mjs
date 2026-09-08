import assert from "node:assert/strict";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function prepareDeterministicSimulationCapture({ page, timeline, shot, appPath, gate, entry, sceneId }) {
  const range = timeline.getByLabel("仿真时间轴");
  const seek = async minute => {
    await range.focus(); await range.press("Home");
    for (let index = 0; index < minute * 50; index++) await range.press("ArrowRight");
    assert.equal(Number(await range.inputValue()), minute);
  };
  await seek(3);
  const canvas = await page.locator(".viewport canvas").first().boundingBox();
  const track = await timeline.boundingBox();
  const clip = { x: canvas.x, y: canvas.y + 190, width: canvas.width, height: track.y - canvas.y - 198 };
  assert.ok(clip.height > 100);
  const capture = async () => {
    const samples = [];
    for (let index = 0; index < 6; index++) {
      samples.push(await sharp(await page.screenshot({ clip })).ensureAlpha().raw().toBuffer());
      await page.waitForTimeout(100);
    }
    return pixelEnvelope(samples);
  };
  const base = await capture();
  await timeline.getByRole("button", { name: "运输轨迹", exact: true }).click();
  assert.equal(await timeline.getByRole("button", { name: "运输轨迹", exact: true }).getAttribute("aria-pressed"), "true");
  const trail = await capture();
  await timeline.getByRole("button", { name: "等待热力", exact: true }).click();
  assert.equal(await timeline.getByRole("button", { name: "等待热力", exact: true }).getAttribute("aria-pressed"), "true");
  const heat = await capture();
  entry.defaultTimelineLayout = await timeline.evaluate(node => [node, ...node.children, node.querySelector(".plant-playback > footer")].map(element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return { className: element.className, y: box.y, height: box.height, bottom: box.bottom, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight, display: style.display, overflowY: style.overflowY, minHeight: style.minHeight, maxHeight: style.maxHeight };
  }));
  entry.defaultLayerPixels = { clip, trail: separatedPixelEnvelopes(base, trail), heat: separatedPixelEnvelopes(trail, heat), channelSeparationAbove: 8, samplesPerState: 6 };
  assert.ok(entry.defaultLayerPixels.trail >= 15, "Default-quality trail must visibly exceed measured background variation");
  assert.ok(entry.defaultLayerPixels.heat >= 15, "Default-quality waiting heat must visibly exceed measured background variation");
  assert.equal(await timeline.getByLabel("空间等待样本").innerText(), "等待 3 件（样本）");
  await shot("default-quality-spatial");
  await seek(1); await seek(3);
  // Keyboard input commits before the parent frame effect publishes its sampled count.
  await timeline.getByText("等待 3 件（样本）", { exact: true }).waitFor();
  assert.equal(await timeline.getByLabel("空间等待样本").innerText(), "等待 3 件（样本）");
  await shot("default-quality-restored");
  await timeline.getByRole("button", { name: "等待热力", exact: true }).click();
  await timeline.getByRole("button", { name: "运输轨迹", exact: true }).click();
  await page.getByRole("button", { name: "查看与分析", exact: true }).click();
  await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
  const panel = page.getByLabel("环境与全局灯光", { exact: true });
  const before = await gate.json("GET", appPath);
  entry.defaultPostProcessing = before.scenes.find(scene => scene.id === sceneId).postProcessing;
  await panel.locator(".post-processing-control .light-system-head").getByRole("button", { name: "已启用", exact: true }).click();
  await shot("deterministic-post-processing-off");
  await page.getByRole("button", { name: "查看与分析", exact: true }).click();
  await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
  const saving = page.waitForResponse(response => response.url().endsWith(`${appPath}/workspace`) && response.request().method() === "PUT");
  await page.getByRole("button", { name: "保存项目", exact: true }).click();
  assert.equal((await saving).status(), 200);
  const saved = await gate.json("GET", appPath);
  const configured = saved.scenes.find(scene => scene.id === sceneId);
  assert.equal(configured.postProcessing.enabled, false);
  entry.captureBoundary = "Default quality has visible layers and reversible sample counts; strict scene-pixel equality uses saved isolated-fixture postProcessing.enabled=false, not normal project settings.";
  entry.capturePostProcessing = configured.postProcessing;
}

function pixelEnvelope(samples) {
  const min = Uint8Array.from(samples[0]), max = Uint8Array.from(samples[0]);
  for (const pixels of samples.slice(1)) for (let index = 0; index < pixels.length; index++) {
    min[index] = Math.min(min[index], pixels[index]); max[index] = Math.max(max[index], pixels[index]);
  }
  return { min, max };
}

function separatedPixelEnvelopes(before, after) {
  assert.equal(before.min.length, after.min.length);
  let changed = 0;
  // Count only pixels whose six-frame RGB ranges are disjoint by >8/255.
  // This rejects same-theme temporal background variation without requiring a light overlay
  // to exceed an unrelated dark-theme edge maximum. Strict reversible checks are unchanged.
  for (let offset = 0; offset < before.min.length; offset += 4) {
    if ([0, 1, 2].some(channel => Math.max(after.min[offset + channel] - before.max[offset + channel], before.min[offset + channel] - after.max[offset + channel]) > 8)) changed++;
  }
  return changed;
}

/** Independent fixture only: characterize default image variation without weakening geometry assertions. */
export async function inspectSimulationGtaoStability({ page, timeline, pixelDifference, output, shot }) {
  const range = timeline.getByLabel("仿真时间轴");
  await range.focus(); await range.press("Home");
  for (let index = 0; index < 150; index++) await range.press("ArrowRight");
  await timeline.getByRole("button", { name: "等待热力", exact: true }).click();
  await timeline.getByRole("button", { name: "运输轨迹", exact: true }).click();
  const result = [];
  for (const enabled of [true, false, true, false]) {
    await page.getByRole("button", { name: "查看与分析", exact: true }).click();
    await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
    const panel = page.getByLabel("环境与全局灯光", { exact: true });
    const gtao = panel.getByRole("button", { name: "GTAO", exact: true });
    const initial = (await gtao.getAttribute("class") ?? "").split(" ").includes("active");
    if (initial !== enabled) await gtao.click();
    assert.equal((await gtao.getAttribute("class") ?? "").split(" ").includes("active"), enabled);
    const postDisabled = result.length === 3;
    if (postDisabled) await panel.locator(".post-processing-control .light-system-head").getByRole("button", { name: "已启用", exact: true }).click();
    await shot(`gtao-${result.length}-${enabled}-controls`);
    await page.getByRole("button", { name: "查看与分析", exact: true }).click();
    await page.getByRole("menuitem", { name: "环境与灯光", exact: true }).click();
    await panel.waitFor({ state: "hidden" });
    const canvas = await page.locator(".viewport canvas").first().boundingBox();
    const track = await timeline.boundingBox();
    const clip = { x: canvas.x, y: canvas.y + 190, width: canvas.width, height: track.y - canvas.y - 198 };
    assert.ok(clip.height > 100);
    const frames = [], boxes = [];
    let previous;
    for (let index = 0; index < 20; index++) {
      await page.waitForTimeout(100);
      const png = await page.screenshot({ clip });
      const pixels = await sharp(png).ensureAlpha().raw().toBuffer();
      if (previous) {
        const difference = pixelDifference(previous, pixels);
        if (difference.changed && !frames.some(frame => frame.changed)) {
          await writeFile(resolve(output, `gtao-${result.length}-${enabled}-changed.png`), png);
        }
        frames.push(difference);
      }
      if (index < 2) await writeFile(resolve(output, `gtao-${result.length}-${enabled}-frame-${index}.png`), png);
      previous = pixels; boxes.push(await page.locator(".viewport canvas").first().boundingBox());
    }
    await shot(`gtao-${result.length}-${enabled}-spatial`);
    result.push({ enabled, initial, postDisabled, clip, frames, boxes });
  }
  return result;
}

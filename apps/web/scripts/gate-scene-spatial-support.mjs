import assert from "node:assert/strict";
import sharp from "sharp";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export async function verifySpatialLayers({ page, timeline, study, stableCanvas, pixelDifference, shot, entry, outputDirectory, filePrefix }) {
  const range = timeline.getByLabel("仿真时间轴");
  const seek = async minute => {
    await range.focus(); await range.press("Home");
    for (let index = 0; index < Math.round(minute / .02); index++) await range.press("ArrowRight");
    assert.ok(Math.abs(Number(await range.inputValue()) - minute) < .021);
  };
  const pixels = async label => {
    const buffer = await stableCanvas(page);
    if (label) await writeFile(resolve(outputDirectory, `${filePrefix}-spatial-${label}.png`), buffer);
    return sharp(buffer).ensureAlpha().raw().toBuffer();
  };
  await seek(3);
  const base = await pixels("base");
  await timeline.getByRole("button", { name: "运输轨迹", exact: true }).click();
  const trail = await pixels("trail");
  const trailDifference = pixelDifference(base, trail);
  assert.ok(trailDifference.changed >= 15 && trailDifference.maxChannelDelta >= 8, "Recorded transport trail must change scene pixels");
  await timeline.getByRole("button", { name: "等待热力", exact: true }).click();
  const latest = new Map();
  for (const event of study.trace.events.filter(event => event.atMinute <= 3).sort((a, b) => a.atMinute - b.atMinute || a.sequence - b.sequence)) if (event.itemId) latest.set(event.itemId, event);
  const expected = [...latest.values()].filter(event => {
    const kind = study.model.nodes.find(node => node.id === event.nodeId)?.kind;
    return kind && kind !== "source" && kind !== "sink" && ["item-enter", "item-complete"].includes(event.type);
  }).length;
  assert.ok(expected > 0, "Fixture must exercise real waiting samples");
  const output = timeline.getByLabel("空间等待样本");
  assert.equal(await output.innerText(), `等待 ${expected} 件（样本）`);
  const heat = await pixels("heat"), heatDifference = pixelDifference(trail, heat);
  entry.spatial = { expectedWaitingSamples: expected, trailDifference, heatDifference };
  assert.ok(heatDifference.changed >= 40 && heatDifference.maxChannelDelta >= 8, "Waiting heat must visibly change real anchored scene pixels");
  await shot("waiting-heat-and-trail");
  await seek(1); await pixels(); await seek(3);
  const restored = pixelDifference(heat, await pixels("restored"));
  entry.spatial.reverse = restored;
  assert.ok(restored.maxChannelDelta <= 1 && restored.changed <= Math.ceil(restored.pixels * .00001), "Heat must seek reversibly, not accumulate frames");
  await timeline.getByRole("button", { name: "等待热力", exact: true }).click();
  await timeline.getByRole("button", { name: "运输轨迹", exact: true }).click();
  const hidden = pixelDifference(base, await pixels("hidden"));
  entry.spatial.hidden = hidden;
  assert.ok(hidden.maxChannelDelta <= 1 && hidden.changed <= Math.ceil(hidden.pixels * .00001), "Disabling layers must restore original playback pixels");
  entry.steps.push("sample-count-not-event-frequency", "visible-spatial-waiting-heat", "recorded-transport-trail", "layer-toggle-restores-canvas", "heat-reverse-seek");
  return expected;
}

export async function verifyReproducedSpatialLayers(timeline, expected, shot) {
  const range = timeline.getByLabel("仿真时间轴");
  await range.focus(); await range.press("Home");
  for (let index = 0; index < 150; index++) await range.press("ArrowRight");
  await timeline.getByRole("button", { name: "等待热力", exact: true }).click();
  await timeline.getByRole("button", { name: "运输轨迹", exact: true }).click();
  await timeline.getByText(`等待 ${expected} 件（样本）`, { exact: true }).waitFor();
  assert.equal(await timeline.getByLabel("空间等待样本").innerText(), `等待 ${expected} 件（样本）`);
  await shot("reproduced-spatial-layers");
}

export async function verifySimulationTimelineFooter({ page, timeline, shot, entry }) {
  const initialViewport = page.viewportSize();
  const geometry = async () => {
    const parent = await timeline.boundingBox(), footer = await timeline.locator(".plant-playback > footer").boundingBox();
    const stage = await timeline.locator(".plant-playback-stage").boundingBox();
    return { parent, footer, stage };
  };
  const assertVisible = ({ parent, footer }) => {
    assert.ok(footer.y >= parent.y && footer.y + footer.height <= parent.y + parent.height + 1,
      `Simulation footer must be wholly readable: ${JSON.stringify({ parent, footer })}`);
  };
  entry.timelineFooter = { initial: await geometry(), shortViewports: [] };
  assertVisible(entry.timelineFooter.initial);
  assert.ok(entry.timelineFooter.initial.stage.height >= 100, "Schematic nodes must retain their readable minimum height");
  for (const width of [980, 800]) {
    await page.setViewportSize({ width, height: 700 });
    await timeline.locator(".plant-playback > footer").scrollIntoViewIfNeeded();
    const next = await geometry(); assertVisible(next);
    assert.ok(next.stage.height >= 100);
    entry.timelineFooter.shortViewports.push({ width, ...next });
    await shot(`short-${width}-footer-reachable`);
  }
  await page.setViewportSize(initialViewport);
  await timeline.evaluate(node => { node.scrollTop = 0; });
  assertVisible(await geometry());
  await shot("timeline-footer-restored");
}

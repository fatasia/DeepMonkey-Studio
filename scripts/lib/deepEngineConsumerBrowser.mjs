import assert from "node:assert/strict";
import { runConsumerBrowser } from "./sdkConsumerBrowser.mjs";

export async function checkDeepEngineBrowser({ root, consumer, reportDir, bundle }) {
  const browser = await runConsumerBrowser({ root, consumer, reportDir, bundle,
    screenshot: "deep-engine-consumer-browser.png", waitFor: 'output:not([data-status="running"])',
    launchArgs: ["--enable-unsafe-webgpu"], consoleLevels: ["error"],
    readResult: async page => {
      if (await page.locator("output").getAttribute("data-status") !== "rendered") {
        throw new Error(`Browser fixture failed: ${await page.locator("output").innerText()}`);
      }
      await page.evaluate(() => globalThis.finishDeepEngineConsumer());
      await page.locator('output[data-status="passed"]').waitFor({ timeout: 30_000 });
      return JSON.parse(await page.locator("output").innerText());
    },
    validate: result => {
      assert.equal(result.rendererId, "deep-webgpu");
      assert.equal(result.frames.length, 2); assert.ok(result.frames.every(frame => frame.drawCalls > 0 && frame.triangles >= 2));
      assert.ok(result.frames[1].frame > result.frames[0].frame, "Camera/update frame must advance production renderer state");
      assert.ok(result.pixelEvidence.distinctFromCorner > 200, "GPU readback must contain rendered non-background pixels");
      assert.equal(result.cancelled, true); assert.equal(result.sameDisposePromise, true); assert.equal(result.disposed, true);
    } });
  return { ...browser, pixelEvidence: browser.observed.pixelEvidence };
}

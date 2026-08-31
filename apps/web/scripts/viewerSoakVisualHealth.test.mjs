import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { analyzeRenderFrame, isBlankRenderFrame } from "./viewerSoakVisualHealth.mjs";

describe("viewer soak visual health", () => {
  it("rejects a fully black render frame", async () => {
    const frame = await analyzeRenderFrame(await solidImage(0, 0, 0));

    expect(isBlankRenderFrame(frame)).toBe(true);
    expect(frame.visiblePixelRatio).toBe(0);
  });

  it("accepts a dark industrial frame with visible geometry", async () => {
    const background = await sharp({ create: { width: 100, height: 100, channels: 3, background: { r: 14, g: 20, b: 23 } } })
      .composite([{ input: await solidImage(210, 175, 80, 40, 40), left: 30, top: 30 }])
      .png()
      .toBuffer();
    const frame = await analyzeRenderFrame(background);

    expect(isBlankRenderFrame(frame)).toBe(false);
    expect(frame.visiblePixelRatio).toBeGreaterThan(0.1);
  });
});

function solidImage(r, g, b, width = 8, height = 8) {
  return sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer();
}

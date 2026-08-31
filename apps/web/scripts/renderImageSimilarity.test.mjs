import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it } from "vitest";
import { compareImageFiles } from "./renderImageSimilarity.mjs";

let testRoot;

afterEach(async () => {
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

describe("render image similarity", () => {
  it("reports identical images without pixel error", async () => {
    const [reference, candidate] = await imagePair([32, 64, 96], [32, 64, 96]);
    const result = await compareImageFiles(reference, candidate, "webgl", "webgpu");

    expect(result.ssim).toBeCloseTo(1, 8);
    expect(result.meanAbsoluteError).toBe(0);
    expect(result.changedPixelRatio).toBe(0);
    expect(result.severePixelRatio).toBe(0);
    expect(result.maximumChannelError).toBe(0);
    expect(result.psnrDb).toBe(Number.POSITIVE_INFINITY);
  });

  it("detects a severe full-frame color regression", async () => {
    const [reference, candidate] = await imagePair([0, 0, 0], [255, 255, 255]);
    const differencePath = join(testRoot, "difference.png");
    const result = await compareImageFiles(reference, candidate, "reference", "candidate", { differencePath });

    expect(result.ssim).toBeLessThan(0.01);
    expect(result.meanAbsoluteError).toBe(1);
    expect(result.changedPixelRatio).toBe(1);
    expect(result.severePixelRatio).toBe(1);
    expect(result.maximumChannelError).toBe(255);
    expect(result.psnrDb).toBe(0);
    expect(result.differencePath).toBe(differencePath);
    expect((await stat(differencePath)).size).toBeGreaterThan(0);
  });

  it("reports semantic regions independently from the global image", async () => {
    testRoot = await mkdtemp(join(tmpdir(), "bim-render-similarity-"));
    const reference = join(testRoot, "reference.png");
    const candidate = join(testRoot, "candidate.png");
    await Promise.all([
      writeSolidImage(reference, [0, 0, 0]),
      writeSplitImage(candidate),
    ]);
    const result = await compareImageFiles(reference, candidate, "reference", "candidate", {
      regions: [
        { id: "left", label: "Left", rectangles: [{ x: 0, y: 0, width: 0.5, height: 1 }] },
        { id: "right", label: "Right", rectangles: [{ x: 0.5, y: 0, width: 0.5, height: 1 }] },
      ],
    });

    expect(result.regions).toEqual([
      expect.objectContaining({ id: "left", pixelCount: 32, severePixelRatio: 1 }),
      expect.objectContaining({ id: "right", pixelCount: 32, severePixelRatio: 0 }),
    ]);
  });

  it("rejects a semantic region outside the normalized canvas", async () => {
    const [reference, candidate] = await imagePair([0, 0, 0], [0, 0, 0]);
    await expect(compareImageFiles(reference, candidate, "reference", "candidate", {
      regions: [{ id: "invalid", label: "Invalid", rectangles: [{ x: 0.8, y: 0, width: 0.3, height: 1 }] }],
    })).rejects.toThrow("0–1 归一化画布");
  });
});

async function imagePair(referenceColor, candidateColor) {
  testRoot = await mkdtemp(join(tmpdir(), "bim-render-similarity-"));
  const reference = join(testRoot, "reference.png");
  const candidate = join(testRoot, "candidate.png");
  await Promise.all([
    writeSolidImage(reference, referenceColor),
    writeSolidImage(candidate, candidateColor)
  ]);
  return [reference, candidate];
}

function writeSolidImage(path, [r, g, b]) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r, g, b } } }).png().toFile(path);
}

function writeSplitImage(path) {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .composite([{ input: { create: { width: 4, height: 8, channels: 3, background: { r: 255, g: 255, b: 255 } } }, left: 0, top: 0 }])
    .png()
    .toFile(path);
}

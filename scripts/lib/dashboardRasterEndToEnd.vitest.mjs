import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import sharp from "sharp";
import { createDashboardRasterHost } from "./dashboardRasterHost.mjs";
import { compileDashboardRasterContent } from "../../apps/web/src/delivery/compileDashboardRasterContent.ts";
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test.skipIf(!process.env.C2_NATIVE_EXECUTABLE || !process.env.C2_FONT_PATH)("real frozen font and image producers compile a C1 package", async () => {
  const document = JSON.parse(readFileSync(new URL("../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url), "utf8"));
  document.application.scripts = []; document.application.interactions = [];
  const text = { id: "text-real", kind: "data-widget", zIndex: 0, frame: { x: 10, y: 20, width: 354, height: 144 },
    widget: { type: "text", title: "真实文字", content: "中文文字与组合符 é\n冻结像素", key: "text-real", unit: "",
      fontSize: 24, fontWeight: 400, textColor: "#eef2f4" } };
  const image = { id: "image-real", kind: "data-widget", zIndex: 1, frame: { x: 390, y: 20, width: 98, height: 98 },
    widget: { type: "image", title: "真实图片", key: "image-real", unit: "", imageFit: "contain" } };
  document.application.pages[0].nodes = [text, image];
  const font = new Uint8Array(readFileSync(process.env.C2_FONT_PATH));
  const pixels = new Uint8Array(await sharp({ create: { width: 20, height: 10, channels: 4,
    background: { r: 20, g: 160, b: 220, alpha: 0.5 } } }).png().toBuffer());
  const result = await compileDashboardRasterContent({ document, packageId: "c2.real-pixels", packageVersion: "1.0.0", locale: "zh-CN",
    assets: { font: { bytes: font, sha256: hash(font), faceIndex: 0, mime: "font/collection", identity: { id: "test-only-system-font", revision: 1 } },
      image: { bytes: pixels, sha256: hash(pixels), mime: "image/png", identity: { id: "generated-test-pixels", revision: 1 } } },
    nodeAssets: { "text-real": { fonts: ["font"], textStyle: { fontSize: 24, fontWeight: 400, fontStyle: "normal",
      lineHeight: 30, color: [238, 242, 244, 255], align: "left" } }, "image-real": { image: "image" } } },
    createDashboardRasterHost({ nativeExecutable: process.env.C2_NATIVE_EXECUTABLE }));
  expect(result.capabilityReport.contentCompiled).toBe(2);
  expect(result.producerEvidence[0].usedFaces[0].sha256).toBe(hash(font));
  expect(result.producerEvidence[0].producerEvidence.executableSha256).toMatch(/^[0-9a-f]{64}$/);
  expect(result.producerEvidence[0].lines).toHaveLength(2);
  expect(result.publicationReady).toBe(false);
  if (process.env.C2_OUTPUT_PREFIX) {
    writeFileSync(`${process.env.C2_OUTPUT_PREFIX}.json`, JSON.stringify(result, null, 2));
    const content = Object.values(result.package.payloads).find(value => value.schema === "deep-engine.deep2d-runtime" && value.atlases[0]?.width === 320);
    const atlas = content.atlases[0];
    await sharp(Buffer.from(atlas.dataBase64, "base64"), { raw: { width: atlas.width, height: atlas.height, channels: 4 } })
      .png().toFile(`${process.env.C2_OUTPUT_PREFIX}.png`);
  }
}, 30_000);

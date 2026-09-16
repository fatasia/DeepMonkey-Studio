import { test, expect } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { runtimeContentSha256 } from "@bim-studio/deep-engine/runtime-package";
import { createDashboardRasterHost } from "./dashboardRasterHost.mjs";
import { compileDashboardRasterContent } from "../../apps/web/src/delivery/compileDashboardRasterContent.ts";
import { dataFixture } from "./dashboardDataEndToEndFixture.mjs";

const hash = bytes => createHash("sha256").update(bytes).digest("hex");
test.skipIf(!process.env.C2_NATIVE_EXECUTABLE || !process.env.C2_FONT_PATH || !process.env.C2_FALLBACK_FONT_PATH)("real Native font compiles frozen KPI, table and chart on one page", async () => {
  const document = JSON.parse(readFileSync(new URL("../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json", import.meta.url), "utf8"));
  const font = new Uint8Array(readFileSync(process.env.C2_FONT_PATH));
  const input = dataFixture(document, font, hash(font), runtimeContentSha256);
  const fallback = new Uint8Array(readFileSync(process.env.C2_FALLBACK_FONT_PATH));
  input.assets.fallback = { bytes: fallback, sha256: hash(fallback), faceIndex: 0, mime: "font/ttf", identity: { id: "test-only-fallback-font", revision: 1 } };
  for (const data of Object.values(input.data)) for (const box of data.layout?.textBoxes ?? []) box.fonts.push("fallback");
  const actual = createDashboardRasterHost({ nativeExecutable: process.env.C2_NATIVE_EXECUTABLE });
  const requests = [];
  const result = await compileDashboardRasterContent(input, { ...actual, async rasterizeText(request) {
    requests.push({ text: request.text, width: request.width, height: request.height });
    try { return await actual.rasterizeText(request); } catch (error) { throw new Error(`Text ${JSON.stringify(request.text)}: ${error.message}`, { cause: error }); }
  } });
  expect(requests.map(request => request.text).sort()).toEqual(["利用率", "81.7", "%", "区域统计", "region", "↕", "amount", "↕", "A", "5.0", "总计", "5.0"].sort());
  expect(result.capabilityReport.contentCompiled).toBe(3);
  expect(result.capabilityReport.blocked).toBe(0);
  expect(result.publicationReady).toBe(false);
  expect(result.producerEvidence).toHaveLength(12);
  for (const evidence of result.producerEvidence) {
    expect(evidence.usedFaces.some(face => [hash(font), hash(fallback)].includes(face.sha256) && face.faceIndex === 0)).toBe(true);
    expect(evidence.producerEvidence.executableSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(evidence.producerEvidence.pixelSha256).toBe(evidence.pixelSha256);
    expect(evidence.lines.length).toBeGreaterThan(0);
  }
  const dashboard = result.package.payloads[result.package.entrypoints.dashboard];
  expect(dashboard.pages).toHaveLength(1);
  expect(dashboard.pages[0].nodes.some(node => JSON.stringify(node.clip) === JSON.stringify([17.25, 12.5, 260.125, 170.75]))).toBe(true);
  const chartNode = dashboard.pages[0].nodes.find(node => node.chart);
  const chart = result.package.payloads[chartNode.chart];
  expect(chart.schema).toBe("deep-engine.chart-runtime");
  expect(chart.chart.datasets[0].rows).toEqual([["1", 7], ["2", 9]]);
  const atlases = Object.values(result.package.payloads).flatMap(value => value.atlases ?? []);
  expect(atlases).toHaveLength(12);
  for (const atlas of atlases) {
    const bytes = Buffer.from(atlas.dataBase64, "base64");
    expect(bytes.some((value, index) => index % 4 === 3 && value > 0)).toBe(true);
    expect(bytes.some((value, index) => index % 4 === 3 && value === 0)).toBe(true);
  }
  if (process.env.C2_OUTPUT_PREFIX) {
    writeFileSync(`${process.env.C2_OUTPUT_PREFIX}.json`, JSON.stringify(result, null, 2));
    writeFileSync(`${process.env.C2_OUTPUT_PREFIX}.package.json`, JSON.stringify(result.package, null, 2));
    writeFileSync(`${process.env.C2_OUTPUT_PREFIX}.requests.json`, JSON.stringify(requests, null, 2));
  }
}, 120_000);

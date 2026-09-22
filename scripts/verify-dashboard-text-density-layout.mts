import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createDashboardRasterHost } from "./lib/dashboardRasterHost.mjs";

const [priorArg, outputArg] = process.argv.slice(2);
assert(priorArg && outputArg, "Expected prior upgrade directory and output directory");
const prior = path.resolve(priorArg), output = path.resolve(outputArg); await mkdir(output);
const deployment = JSON.parse(await readFile(path.join(prior, "deployment-v2.json"), "utf8"));
const fonts = await Promise.all(deployment.fontCatalog.fonts.map(async (font: any) => ({
  bytes: new Uint8Array(await readFile(path.join(prior, "isolated-objects", font.objectKey))),
  sha256: font.sha256, faceIndex: font.faceIndex, mime: font.mime, identity: { id: font.id, revision: font.revision } })));
const host = createDashboardRasterHost({ nativeExecutable: deployment.nativeExecutable, signal: undefined });
const cases = [
  { id: "cjk-multiline", text: "冷热电联供园区运行总览检修二版机组功率实时统计", width: 117.25, height: 160.5 },
  { id: "mixed-wrap", text: "机组 A-01 Power 91.25 MW / 温度 36.8 °C — offline mode", width: 137.75, height: 180.25 },
  { id: "explicit-lines", text: "中文第一行\nEngine 2026 / 125%\nMW 91.25", width: 201.5, height: 120.25 },
  { id: "narrow-latin", text: "Engineering reliability and commissioning at 125 percent", width: 103.25, height: 180.5 },
];
const evidence = [];
for (const entry of cases) {
  const results = [];
  for (const density of [1, 2]) {
    const request = { text: entry.text, locale: "zh-CN", fontSize: 14.25 * density, lineHeight: 21.5 * density,
      fontWeight: 400, fontStyle: "normal", align: "left", verticalAlign: "top", wrap: "word-or-glyph",
      color: [238, 242, 244, 255], width: Math.ceil(entry.width) * density, height: Math.ceil(entry.height) * density, fonts };
    const requestHash = createHash("sha256").update(JSON.stringify({ ...request, fonts: fonts.map(font => font.sha256) })).digest("hex");
    const result = await host.rasterizeText({ ...request, requestHash });
    results.push({ density, pixelSha256: result.sha256, sourceSha256: result.sourceSha256,
      usedFaces: result.usedFaces, clipped: result.clipped,
      logicalLines: result.lines.map((line: any) => ({ ...line, baseline: line.baseline / density, top: line.top / density,
        height: line.height / density, width: line.width / density })) });
  }
  const a = results[0]!, b = results[1]!;
  assert.equal(a.logicalLines.length, b.logicalLines.length, `${entry.id}: line count changed`);
  assert.equal(a.clipped, b.clipped, `${entry.id}: clipping changed`);
  for (let line = 0; line < a.logicalLines.length; line++) for (const key of ["baseline", "top", "height", "width"]) {
    assert(Math.abs(a.logicalLines[line][key] - b.logicalLines[line][key]) < 0.001, `${entry.id}: logical ${key} drift on line ${line}`);
  }
  evidence.push({ ...entry, results });
  await writeFile(path.join(output, "evidence.json"), JSON.stringify(evidence, null, 2));
  console.log(`${entry.id}: ${a.logicalLines.length} identical logical lines`);
}

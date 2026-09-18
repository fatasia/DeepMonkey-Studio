import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertDashboardDocument, type DashboardDataWidgetNode, type DashboardDocument } from "@bim-studio/contracts";
import { validateDeep2dDisplayList } from "@bim-studio/deep-engine";
import source from "../../../../packages/deep-engine/fixtures/dashboard-layout-source-v1.json";
import { compileDashboardContent } from "./compileDashboardContent";
import { filterGlyphBundle } from "./dashboardFilterGlyphs";

/**
 * P0-01 收官切片端到端证据(需要本机产物,默认跳过;与 native GPU 测试的
 * #[ignore] 同一纪律):
 *   FILTER_GLYPH_RUN_E2E=1 pnpm vitest run src/delivery/filterGlyphRunEndToEnd.test.ts
 *
 * 链路:冻结字体字节(sha256 校验)→ native `--measure-glyph-run` 实测整形/光栅 →
 * filterGlyphBundle → compileDashboardContent 注入编译 → validateDeep2dDisplayList →
 * 显示列表与度量产物落 test-output/filter-glyph-run-20260918/,交 Native GPU 读回复核。
 * 无浏览器像素断言:那是 P0-08 矩阵的事,本测试只产出 TS 侧证据。
 */

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "../../../..");
const outputDirectory = resolve(repoRoot, "test-output/filter-glyph-run-20260918");
/** 冻结字体样本:多组件发布验收运行的隔离对象副本(SIL OFL 1.1,可再分发)。 */
const frozenFontPath = process.env.FILTER_GLYPH_RUN_FONT
  ?? resolve(repoRoot, "test-output/dashboard-http-multicomponent-20260917/isolated-objects/projects/afbfb45f-440d-4d02-9d29-a7c9bba52cb2/fonts/notocjk-400.otf");
/** 冻结字体目录身份:与该发布部署登记的 notocjk-400 一致。 */
const FROZEN_FONT_SHA256 = "2c76254f6fc379fddfce0a7e84fb5385bb135d3e399294f6eeb6680d0365b74b";
const nativeBinary = process.env.DEEP_ENGINE_NATIVE_BIN
  ?? resolve(repoRoot, "packages/deep-engine-native/target/release/deep-engine-native.exe");
const OPTIONS = ["华东", "华南", "华北", "西南"];
const FILTER_NODE_ID = "filter-region";
const FONT_SIZE = 14;

function filterDocument(): DashboardDocument {
  const input: unknown = structuredClone(source);
  assertDashboardDocument(input);
  const document: DashboardDocument = input;
  document.application.scripts = [];
  document.application.interactions = [];
  const node: DashboardDataWidgetNode = { id: FILTER_NODE_ID, kind: "data-widget", zIndex: 4, visible: true,
    frame: { x: 24, y: 24, width: 168, height: 132 },
    widget: { title: "区域筛选", key: "region", unit: "", type: "filter", options: [...OPTIONS],
      filterMode: "select", filterField: "region", textColor: "#eef2f4", fontSize: FONT_SIZE,
      textAlign: "left", backgroundColor: "#172126", backgroundOpacity: 0.86 } };
  document.application.pages[0]!.nodes = [node];
  return document;
}

async function measureGlyphRun(fontBytes: Uint8Array, fontSha256: string) {
  const request = {
    schema: "deep-engine.glyph-measure-request", schemaVersion: 1, locale: "zh-CN",
    fonts: [{ sha256: fontSha256, faceIndex: 0, dataBase64: Buffer.from(fontBytes).toString("base64") }],
    request: {
      atlasWidth: 512, atlasHeight: 512,
      lines: OPTIONS.map(text => ({
        text, font: { sha256: fontSha256, faceIndex: 0 }, weight: 400, style: "normal",
        fontSize: FONT_SIZE, lineHeight: 22,
      })),
    },
  };
  const requestPath = resolve(outputDirectory, "measure-request.json");
  const resultPath = resolve(outputDirectory, "measure-result.json");
  writeFileSync(requestPath, JSON.stringify(request));
  // producer 合同:create_new,失败结果不得覆盖旧产物;证据重跑由测试侧负责清理。
  rmSync(resultPath, { force: true });
  await execFileAsync(nativeBinary, ["--measure-glyph-run", requestPath, "--output", resultPath]);
  return JSON.parse(readFileSync(resultPath, "utf8")) as Record<string, unknown>;
}

describe.skipIf(!process.env.FILTER_GLYPH_RUN_E2E)("filter glyph run end to end (P1-18 + native measure)", () => {
  it("compiles measured option text into a native-consumable display list", async () => {
    expect(existsSync(nativeBinary), `先构建 native release 二进制: ${nativeBinary}`).toBe(true);
    expect(existsSync(frozenFontPath), `缺冻结字体样本: ${frozenFontPath}`).toBe(true);
    mkdirSync(outputDirectory, { recursive: true });
    const fontBytes = readFileSync(frozenFontPath);
    const fontSha256 = createHash("sha256").update(fontBytes).digest("hex");
    expect(fontSha256).toBe(FROZEN_FONT_SHA256);

    const measure = await measureGlyphRun(fontBytes, fontSha256);
    const fontResource = { kind: "font" as const, id: "font:notocjk-400", revision: 1,
      assetId: "notocjk-400", family: "Noto Sans CJK SC", weight: 400, style: "normal" as const };
    const bundle = filterGlyphBundle({ measure, fontResource, fontSize: FONT_SIZE,
      textColor: "#eef2f4", atlasId: "atlas:filter-options", atlasRevision: 1 });
    expect(bundle.metrics.measuredGlyphs.filter(Boolean)).toHaveLength(OPTIONS.length);

    const result = compileDashboardContent(filterDocument(), undefined, { [FILTER_NODE_ID]: bundle });
    const validation = validateDeep2dDisplayList(result.displayList);
    expect(validation.issues).toEqual([]);
    const textCommands = result.displayList.commands.filter(command => command.kind === "text");
    expect(textCommands).toHaveLength(OPTIONS.length);
    expect(textCommands.map(command => (command as { text: string }).text)).toEqual(OPTIONS);
    expect(result.capabilityReport.objects[0]!.compiledFields).toContain("widget.options.text");

    writeFileSync(resolve(outputDirectory, "content-display-list.json"),
      JSON.stringify(result.displayList, null, 2));
    writeFileSync(resolve(outputDirectory, "capability-report.json"),
      JSON.stringify(result.capabilityReport, null, 2));
    const atlas = result.displayList.atlases?.[0];
    const provenance = {
      slice: "P0-01 filter option glyph run (P1-18 contract)",
      generatedAt: new Date().toISOString(),
      font: { path: frozenFontPath, sha256: fontSha256, faceIndex: 0, license: "SIL OFL 1.1 (redistributable)" },
      measure: {
        producer: (measure as { producer?: string }).producer,
        sourceSha256: (measure as { sourceSha256?: string }).sourceSha256,
        atlas: { width: atlas?.width, height: atlas?.height, format: atlas?.format,
          coverageSha256: createHash("sha256")
            .update(Buffer.from(atlas?.dataBase64 ?? "", "base64")).digest("hex") },
        lines: (measure as { lines?: { text: string; layoutWidth: number; glyphs: unknown[] }[] })
          .lines?.map(line => ({ text: line.text, layoutWidth: line.layoutWidth, glyphs: line.glyphs.length })),
      },
      displayList: { id: result.displayList.id, sha256: createHash("sha256")
        .update(JSON.stringify(result.displayList)).digest("hex"),
        textCommands: textCommands.length, options: OPTIONS },
      gpuReadback: "packages/deep-engine-native/src/filter_glyph_gpu_tests.rs \
        (FILTER_GLYPH_RUN_DISPLAY_LIST_PATH=content-display-list.json)",
      browserPixelEvidence: "not produced here; that is the P0-08 matrix scope",
    };
    writeFileSync(resolve(outputDirectory, "evidence-summary.json"), JSON.stringify(provenance, null, 2));
    expect(atlas?.width).toBeGreaterThan(0);
  });
});

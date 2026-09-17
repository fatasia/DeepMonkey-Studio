// P0-08 跨端像素矩阵：fixture 变体生成（可复用）。
// 从 packages/deep-engine/fixtures/dashboard-composition-v1.json 派生
// 3 内容变体（base / data-b / layout-c）× 2 主题（dark=作者原配色 / light=改背景与图集文本色，
// 几何 destination/path verbs/atlas 字节一律不动），全部走生产 canonical hash 重算（draft+rehash 同语义）。
// 两端（Native producer / Web candidate host）吃同一份落盘 JSON 字节。
// 用法: node_modules/.bin/tsx scripts/p08-matrix-fixtures.mts [outputDir]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runtimeContentSha256, runtimePackageSha256 } from "../packages/deep-engine/src/runtimePackage/hash.js";

export interface P08CellMeta {
  id: string;
  content: "base" | "data-b" | "layout-c";
  theme: "dark" | "light";
  packageHash: string;
  page0NodeFrames: [number, number, number, number][];
  glyphDests: [number, number, number, number][];
  imageDests: [number, number, number, number][];
  /** page-0 static deep2d 填充 path 的逻辑包围盒（显示列表 path 动词求包围，供边界环带归因）。 */
  staticPathFrames: [number, number, number, number][];
  note: string;
}

const THEMES = {
  dark: { panelFill: [0.02, 0.04, 0.08, 0.94], glyph: [0.2, 0.9, 1, 1], image: [1, 1, 1, 1] },
  light: { panelFill: [0.93, 0.94, 0.96, 0.97], glyph: [0.07, 0.12, 0.2, 1], image: [0.12, 0.14, 0.18, 1] },
} as const;

function rehash(value: any): void {
  for (const resource of value.resources) resource.contentHash.value = runtimeContentSha256(value.payloads[resource.id]);
  value.packageHash.value = runtimePackageSha256(value);
}

/** 主题：只改 static deep2d 的面板填色与图集 quad 着色；几何（destination/path/atlas 字节）不动。 */
function applyTheme(value: any, theme: keyof typeof THEMES): void {
  const palette = THEMES[theme];
  for (const key of ["dashboard.static.a", "dashboard.static.b"]) {
    const static2d = value.payloads[key];
    if (!static2d) continue;
    for (const command of static2d.displayList.commands) {
      if (Array.isArray(command.fill)) command.fill = [...palette.panelFill];
    }
    for (const quad of static2d.quads ?? []) {
      if (String(quad.atlasId ?? "").startsWith("atlas:glyph")) quad.color = [...palette.glyph];
      else if (String(quad.atlasId ?? "").startsWith("atlas:image")) quad.color = [...palette.image];
    }
  }
}

/** 内容变体 data-b：两个 chart 数据行改值（bar/line 几何随 y 值变化，轴域 0–10 不变）。 */
function applyDataB(value: any): void {
  const rows = [[6, 0.66], [3, 0.42]];
  for (const key of ["dashboard.chart.a", "dashboard.chart.b"]) {
    const dataset = value.payloads[key].chart.datasets[0];
    dataset.rows[0][1] = rows[0]![0]; dataset.rows[0][2] = rows[0]![1];
    dataset.rows[1][1] = rows[1]![0]; dataset.rows[1][2] = rows[1]![1];
  }
}

/** 内容变体 layout-c：page-0 两个 chart node 的 frame 改位（布局几何变化，clip 不变）。 */
function applyLayoutC(value: any): void {
  const root = value.payloads[value.entrypoints.dashboard];
  root.pages[0].nodes[1].frame = [60, 120, 360, 280];
  root.pages[0].nodes[2].frame = [520, 220, 380, 260];
}

export function buildP08Fixtures(baseFixturePath: string): { id: string; json: string; meta: P08CellMeta }[] {
  const base = JSON.parse(readFileSync(baseFixturePath, "utf8"));
  const contents = [
    { content: "base", note: "作者原数据与布局", apply: undefined },
    { content: "data-b", note: "chart a/b 数据行改值（几何随 y 变）", apply: applyDataB },
    { content: "layout-c", note: "page-0 chart node frame 改位", apply: applyLayoutC },
  ] as const;
  const cells: { id: string; json: string; meta: P08CellMeta }[] = [];
  for (const entry of contents) {
    for (const theme of ["dark", "light"] as const) {
      const value = structuredClone(base);
      entry.apply?.(value);
      applyTheme(value, theme);
      rehash(value);
      const id = `composition-${entry.content}-${theme}`;
      const root = value.payloads[value.entrypoints.dashboard];
      const static0 = value.payloads["dashboard.static.a"];
      const staticPathFrames = (static0.displayList.resources ?? [])
        .filter((resource: any) => resource.kind === "path")
        .map((resource: any) => {
          const points: readonly (readonly [number, number])[] = (resource.verbs ?? [])
            .filter((verb: any) => typeof verb.x === "number" && typeof verb.y === "number")
            .map((verb: any): readonly [number, number] => [verb.x as number, verb.y as number]);
          const xs = points.map(point => point[0]), ys = points.map(point => point[1]);
          const x = Math.min(...xs), y = Math.min(...ys);
          return [x, y, Math.max(...xs) - x, Math.max(...ys) - y] as [number, number, number, number];
        });
      cells.push({
        id,
        json: JSON.stringify(value),
        meta: {
          id,
          content: entry.content,
          theme,
          packageHash: value.packageHash.value,
          page0NodeFrames: root.pages[0].nodes.filter((node: any) => node.chart).map((node: any) => node.frame),
          glyphDests: (static0.quads ?? []).filter((q: any) => String(q.atlasId ?? "").startsWith("atlas:glyph")).map((q: any) => q.destination),
          imageDests: (static0.quads ?? []).filter((q: any) => String(q.atlasId ?? "").startsWith("atlas:image")).map((q: any) => q.destination),
          staticPathFrames,
          note: `${entry.note}；主题=${theme === "dark" ? "作者原配色" : "light（背景/图集色改，几何不动）"}`,
        },
      });
    }
  }
  const canonical = structuredClone(base);
  rehash(canonical);
  if (canonical.packageHash.value !== base.packageHash.value) {
    throw new Error("原样 rehash 后 packageHash 变化：hash 口径与 committed fixture 不对齐，禁止继续");
  }
  return cells;
}

export function writeP08Fixtures(baseFixturePath: string, outputDir: string): P08CellMeta[] {
  mkdirSync(outputDir, { recursive: true });
  const cells = buildP08Fixtures(baseFixturePath);
  for (const cell of cells) writeFileSync(resolve(outputDir, `${cell.id}.json`), cell.json + "\n");
  writeFileSync(resolve(outputDir, "fixtures.json"), JSON.stringify(cells.map(cell => cell.meta), null, 2) + "\n");
  return cells.map(cell => cell.meta);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}` || process.argv[1]?.endsWith("p08-matrix-fixtures.mts")) {
  const repo = resolve(import.meta.dirname, "..");
  const output = process.argv[2] ? resolve(process.argv[2]) : resolve(repo, "test-output/p08-matrix-20260918/fixtures");
  const metas = writeP08Fixtures(resolve(repo, "packages/deep-engine/fixtures/dashboard-composition-v1.json"), output);
  for (const meta of metas) console.log(`${meta.id}: hash=${meta.packageHash.slice(0, 12)}… ${meta.note}`);
  console.log(`P08 fixtures: ${metas.length} written to ${output}`);
}

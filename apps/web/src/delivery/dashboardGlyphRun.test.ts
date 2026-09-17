import { describe, expect, it } from "vitest";
import {
  DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, validateDeep2dDisplayList,
  type Deep2dCommand, type Deep2dDisplayList,
} from "@bim-studio/deep-engine";
import { fontIdentity } from "./dashboardTextContent";
import { buildTextGlyphRunCommands, type BuildTextGlyphRunsInput, type MeasuredLineGlyphs } from "./dashboardGlyphRun";

const atlas = { id: "atlas:filter", revision: 2, width: 256, height: 64, dataBase64: "AAAA" };
const font = fontIdentity(1, 600, "normal");

/** 实测度量样例:每簇 28px 前进与 28×28 逻辑盒;仅用于形状组装测试,替代品是 P1-17 measure 产物。 */
function metrics(text: string): MeasuredLineGlyphs {
  return {
    text,
    glyphs: Array.from(text).map((_char, index) => ({
      cluster: index,
      source: [index * 28, 0, 28, 28] as const,
      destination: [index * 28, 4, 28, 28] as const,
    })),
  };
}

function input(patch: Partial<BuildTextGlyphRunsInput> = {}): BuildTextGlyphRunsInput {
  return {
    commandIdPrefix: "flt.option", zOrder: 4,
    lineOrigins: [{ x: 37, y: 47 }, { x: 37, y: 65 }],
    style: { fontId: font.id, fontSize: 14, color: [1, 1, 1, 1], align: "start" },
    atlas,
    lines: [{ text: "一线", top: 47 }, { text: "二线", top: 65 }],
    measuredGlyphs: [metrics("一线"), metrics("二线")],
    ...patch,
  };
}

describe("buildTextGlyphRunCommands (P1-18)", () => {
  it("assembles validator-clean glyph runs and passes a full display list end to end", () => {
    const result = buildTextGlyphRunCommands(input());
    expect(result.atlas).toEqual({ kind: "glyph", format: "r8unorm", sampling: "nearest", ...atlas });
    expect(result.commands).toHaveLength(2);
    expect(result.compiledLineIndexes).toEqual([0, 1]);
    expect(result.commands[0]).toMatchObject({
      kind: "text", id: "flt.option.line0", x: 37, y: 47, fontId: font.id, fontSize: 14,
      atlasId: atlas.id, baseline: "top",
    });
    // 联合类型收窄:text 命令才携带字形运行。
    const firstCommand = result.commands[0] as Extract<Deep2dCommand, { kind: "text" }>;
    expect(firstCommand.bakedGlyphs).toEqual([
      { cluster: 0, source: [0, 0, 28, 28], destination: [0, 4, 28, 28] },
      { cluster: 1, source: [28, 0, 28, 28], destination: [28, 4, 28, 28] },
    ]);
    const displayList: Deep2dDisplayList = {
      schemaVersion: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION, id: "dashboard:text", revision: 1,
      logicalWidth: 640, logicalHeight: 360, scaleFactor: 1,
      resources: [font], atlases: [result.atlas], commands: result.commands,
    };
    expect(validateDeep2dDisplayList(displayList)).toEqual({ valid: true, issues: [] });
    expect(validateDeep2dDisplayList(JSON.parse(JSON.stringify(displayList))).valid).toBe(true);
  });

  it("skips empty-text lines and rows without measured metrics instead of inventing glyphs", () => {
    const result = buildTextGlyphRunCommands(input({
      lines: [{ text: "一线", top: 47 }, { text: "", top: 65 }, { text: "三线", top: 83 }],
      lineOrigins: [{ x: 37, y: 47 }, { x: 37, y: 65 }, { x: 37, y: 83 }],
      measuredGlyphs: [metrics("一线"), undefined, metrics("三线")],
    }));
    expect(result.compiledLineIndexes).toEqual([0, 2]);
    expect(result.commands.map(command => command.id)).toEqual(["flt.option.line0", "flt.option.line2"]);
  });

  it("rejects metric tables misaligned with the line text", () => {
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [metrics("二线"), metrics("二线")] })))
      .toThrow(/第 0 行度量表文本与行文本不一致/);
  });

  it("rejects empty glyph runs for non-empty text, mirroring the native rule", () => {
    const empty: MeasuredLineGlyphs = { text: "一线", glyphs: [] };
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [empty, undefined] })))
      .toThrow(/非空文本需要至少一个实测字形/);
  });

  it("rejects clusters outside the text or out of order", () => {
    const outOfRange: MeasuredLineGlyphs = { text: "一线", glyphs: [{ cluster: 2, source: [0, 0, 28, 28], destination: [0, 0, 28, 28] }] };
    const decreasing: MeasuredLineGlyphs = {
      text: "一线", glyphs: [
        { cluster: 1, source: [0, 0, 28, 28], destination: [0, 0, 28, 28] },
        { cluster: 0, source: [28, 0, 28, 28], destination: [28, 0, 28, 28] },
      ],
    };
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [outOfRange, undefined] }))).toThrow(/递增的 UTF-16 偏移/);
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [decreasing, undefined] }))).toThrow(/递增的 UTF-16 偏移/);
  });

  it("rejects sources without positive area inside the atlas", () => {
    const zero: MeasuredLineGlyphs = { text: "一线", glyphs: [{ cluster: 0, source: [0, 0, 0, 28], destination: [0, 0, 28, 28] }] };
    const escaped: MeasuredLineGlyphs = { text: "一线", glyphs: [{ cluster: 0, source: [240, 0, 28, 28], destination: [0, 0, 28, 28] }] };
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [zero, undefined] }))).toThrow(/正面积的像素矩形/);
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [escaped, undefined] }))).toThrow(/正面积的像素矩形/);
  });

  it("rejects destinations that are not finite positive logical rects", () => {
    const collapsed: MeasuredLineGlyphs = { text: "一线", glyphs: [{ cluster: 0, source: [0, 0, 28, 28], destination: [0, 0, 0, 28] }] };
    const infinite: MeasuredLineGlyphs = { text: "一线", glyphs: [{ cluster: 0, source: [0, 0, 28, 28], destination: [Number.POSITIVE_INFINITY, 0, 28, 28] }] };
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [collapsed, undefined] }))).toThrow(/有限且正宽高/);
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [infinite, undefined] }))).toThrow(/有限且正宽高/);
  });

  it("requires parallel lines, origins and metric arrays", () => {
    expect(() => buildTextGlyphRunCommands(input({ lineOrigins: [{ x: 0, y: 0 }] }))).toThrow(/等长/);
    expect(() => buildTextGlyphRunCommands(input({ measuredGlyphs: [metrics("一线")] }))).toThrow(/等长/);
  });
});

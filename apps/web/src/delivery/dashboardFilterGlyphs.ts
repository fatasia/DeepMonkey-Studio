import type { Deep2dResource } from "@bim-studio/deep-engine";
import { cssSrgbToLinearColor } from "./dashboardColor";
import { parseHexColor } from "./dashboardShapeContent";
import type { FilterOptionGlyphMetrics } from "./dashboardWidgetContent";
import type { FrozenGlyphAtlasIdentity, MeasuredLineGlyphs } from "./dashboardGlyphRun";

/**
 * P1-18 筛选选项度量桥:把 native `--measure-glyph-run` 的结果线格式
 * (`deep-engine.glyph-measure-result` v1,cosmic-text 实测整形 + swash 实测光栅)
 * 转成 `FilterOptionGlyphMetrics`,供 `compileDashboardContent` 注入筛选编译。
 *
 * 诚实边界:本模块只信任**结构正确**的实测产物并逐字段搬运,不做任何字形估算;
 * 结构不符(错误的 schema、非 r8unorm 图集、越界矩形)一律抛错而不是降级——
 * 度量来源错了就该修来源,静默吞掉会退化成伪实测。零字形的行(纯空白)转成
 * undefined,该行由编译链保持 deferred。
 */

/** native measure 结果线格式;字段与 `raster_wire.rs` 的 JSON 输出一致。 */
export interface GlyphMeasureResultWire {
  readonly schema: string;
  readonly schemaVersion: number;
  readonly producer: string;
  readonly sourceSha256: string;
  readonly atlas: { readonly width: number; readonly height: number;
    readonly format: string; readonly dataBase64: string; readonly coverageSha256: string };
  readonly lines: readonly { readonly text: string; readonly layoutWidth: number;
    readonly glyphs: readonly { readonly cluster: number;
      readonly source: readonly [number, number, number, number];
      readonly destination: readonly [number, number, number, number] }[] }[];
}

/** 注入 `compileDashboardContent` 的筛选字形束:度量 + 命令 fontId 解析所需的字体资源。
 *  多个筛选节点共享同一 atlasId 会在显示列表里重复登记图集(TS/native 校验都拒绝
 *  duplicate-id)——共享图集必须先做按 id 去重,那是生产接线的显式步骤,不是本桥的隐式行为。 */
export interface FilterGlyphBundle {
  readonly metrics: FilterOptionGlyphMetrics;
  readonly fontResource: Deep2dResource;
}

export interface FilterGlyphMeasureInput {
  /** 已解析的 measure 结果 JSON;结构不符时抛错。 */
  readonly measure: unknown;
  /** 显示列表字体资源身份(冻结字体目录条目),命令 fontId 指向它。 */
  readonly fontResource: Deep2dResource & { readonly kind: "font" };
  readonly fontSize: number;
  /** 选项文字颜色;必须是解析后的十六进制(CSS 变量不编译)。 */
  readonly textColor: string;
  /** 字形图集身份;像素数据取 measure.atlas。 */
  readonly atlasId: string;
  readonly atlasRevision: number;
}

function fail(message: string): never { throw new Error(`筛选字形度量被拒绝: ${message}`); }

export function filterGlyphBundle(input: FilterGlyphMeasureInput): FilterGlyphBundle {
  const measure = validated(input.measure);
  const atlas: FrozenGlyphAtlasIdentity = {
    id: input.atlasId, revision: input.atlasRevision,
    width: measure.atlas.width, height: measure.atlas.height, dataBase64: measure.atlas.dataBase64,
  };
  return {
    metrics: {
      fontId: input.fontResource.id,
      fontSize: input.fontSize,
      color: cssSrgbToLinearColor(parseHexColor(input.textColor)),
      atlas,
      measuredGlyphs: measure.lines.map((line): MeasuredLineGlyphs | undefined => {
        if (line.glyphs.length === 0) return undefined;
        return {
          text: line.text,
          glyphs: line.glyphs.map(glyph => ({ cluster: glyph.cluster, source: glyph.source, destination: glyph.destination })),
        };
      }),
    },
    fontResource: input.fontResource,
  };
}

function validated(value: unknown): GlyphMeasureResultWire {
  if (typeof value !== "object" || value === null) fail("measure 结果必须是 JSON 对象");
  const measure = value as Record<string, unknown>;
  if (measure.schema !== "deep-engine.glyph-measure-result" || measure.schemaVersion !== 1) {
    fail("schema 必须是 deep-engine.glyph-measure-result v1");
  }
  const atlas = measure.atlas as GlyphMeasureResultWire["atlas"] | undefined;
  if (typeof atlas !== "object" || atlas === null) fail("图集必须是 JSON 对象");
  if (atlas.format !== "r8unorm"
    || !Number.isSafeInteger(atlas.width) || atlas.width <= 0
    || !Number.isSafeInteger(atlas.height) || atlas.height <= 0
    || typeof atlas.dataBase64 !== "string" || atlas.dataBase64.length === 0) {
    fail("图集必须是带像素数据的 r8unorm 尺寸对");
  }
  const { width, height } = atlas;
  if (!Array.isArray(measure.lines)) fail("lines 必须是数组");
  for (const [index, line] of (measure.lines as GlyphMeasureResultWire["lines"]).entries()) {
    if (typeof line?.text !== "string" || !Array.isArray(line.glyphs)) fail(`第 ${index} 行结构不完整`);
    for (const [glyphIndex, glyph] of line.glyphs.entries()) {
      const [sx, sy, sw, sh] = glyph.source;
      if (![sx, sy, sw, sh].every(Number.isInteger) || sw <= 0 || sh <= 0
        || sx + sw > width || sy + sh > height) {
        fail(`第 ${index} 行第 ${glyphIndex} 字形的 source 必须是图集内正面积像素矩形`);
      }
      const [dx, dy, dw, dh] = glyph.destination;
      if (![dx, dy, dw, dh].every(Number.isFinite) || dw <= 0 || dh <= 0) {
        fail(`第 ${index} 行第 ${glyphIndex} 字形的 destination 必须是有限正面积逻辑矩形`);
      }
    }
  }
  return measure as unknown as GlyphMeasureResultWire;
}

import {
  DEEP_2D_DISPLAY_LIST_BUDGETS,
  type Deep2dBakedGlyph, type Deep2dColor, type Deep2dCommand, type Deep2dDisplayListAtlas,
} from "@bim-studio/deep-engine";
import type { TextLineBox } from "./dashboardTextContent";

/**
 * P1-18 字形运行命令构造:把 TextLowering 的解算结果(lines/style)与**注入的实测字形度量**、
 * 冻结字形图集身份,组装成 native `deep2d::validate_text` 接受的 text 命令数组
 * (`atlasId + bakedGlyphs`,字段与 native `command_types.rs` BakedGlyphPlacement 逐一对齐)。
 *
 * 诚实边界:本函数只做形状组装,**度量表是必填参数**,且必须来自实测(P1-17 measure 产物或
 * 冻结字体目录)。禁止把声明式估算的字宽/位置伪装成度量表传进来——那会产出 native 拒收或
 * 位置错误的像素。结构守卫逐条镜像 `validate_text.rs`,产出保证通过 TS 校验器;
 * 是否真正渲染通过仍属 GPU 证据,不在本函数的承诺范围内。
 */

/** 单个实测字形放置:cluster 为行文本内的 UTF-16 偏移;source 为图集内像素矩形
 *  [x,y,w,h];destination 为相对命令原点的逻辑矩形 [x,y,w,h]。 */
export interface MeasuredGlyphPlacement {
  readonly cluster: number;
  readonly source: readonly [number, number, number, number];
  readonly destination: readonly [number, number, number, number];
}

/** 一行的实测字形度量;`text` 必须与目标行文本逐字符一致(防度量表错位)。 */
export interface MeasuredLineGlyphs {
  readonly text: string;
  readonly glyphs: readonly MeasuredGlyphPlacement[];
}

/** 冻结字形图集身份(像素数据由图集通道提供,这里只冻结资源身份与尺寸)。 */
export interface FrozenGlyphAtlasIdentity {
  readonly id: string;
  readonly revision: number;
  readonly width: number;
  readonly height: number;
  readonly dataBase64: string;
}

export interface TextGlyphRunStyle {
  readonly fontId: string;
  readonly fontSize: number;
  readonly color: Deep2dColor;
  readonly align: "start" | "center" | "end";
}

export interface BuildTextGlyphRunsInput {
  /** 生成命令 id 前缀;第 i 行命令 id 为 `${commandIdPrefix}.line${i}`。 */
  readonly commandIdPrefix: string;
  readonly zOrder: number;
  /** 每行命令原点(逻辑像素绝对坐标);实测 destination 相对它偏移。 */
  readonly lineOrigins: readonly { readonly x: number; readonly y: number }[];
  readonly style: TextGlyphRunStyle;
  readonly atlas: FrozenGlyphAtlasIdentity;
  readonly lines: readonly TextLineBox[];
  /** 与 lines 等长的实测度量表;某行为 undefined 时该行不产出命令(保持 deferred)。 */
  readonly measuredGlyphs: readonly (MeasuredLineGlyphs | undefined)[];
}

export interface TextGlyphRunResult {
  /** 恰好登记一次的 glyph 图集资源;无命令产出时仍返回该资源,由调用方决定是否登记。 */
  readonly atlas: Deep2dDisplayListAtlas;
  readonly commands: readonly Deep2dCommand[];
  /** 实际产出命令的行号(空文本行与缺度量的行不在其中)。 */
  readonly compiledLineIndexes: readonly number[];
}

const fail = (message: string): never => { throw new Error(`字形运行构造被拒绝: ${message}`); };

/** 行级守卫与组装;返回 undefined 表示该行不产出(空文本或缺度量)。 */
export function buildTextGlyphRunCommands(input: BuildTextGlyphRunsInput): TextGlyphRunResult {
  const { lines, measuredGlyphs, lineOrigins, style, atlas } = input;
  if (lineOrigins.length !== lines.length || measuredGlyphs.length !== lines.length) {
    fail("lineOrigins/measuredGlyphs 必须与 lines 等长");
  }
  const commands: Deep2dCommand[] = [];
  const compiledLineIndexes: number[] = [];
  for (const [index, line] of lines.entries()) {
    const measured = measuredGlyphs[index];
    if (line.text.length === 0 || measured === undefined) continue;
    if (measured.text !== line.text) fail(`第 ${index} 行度量表文本与行文本不一致`);
    const origin = lineOrigins[index]!;
    commands.push({
      kind: "text", id: `${input.commandIdPrefix}.line${index}`, zOrder: input.zOrder,
      transform: [1, 0, 0, 1, 0, 0], text: line.text, x: origin.x, y: origin.y,
      fontId: style.fontId, fontSize: style.fontSize, color: style.color, align: style.align,
      // TextLineBox.top 是行顶偏移,故基线取 top;字形实际纵向落点由实测 destination 承载。
      baseline: "top",
      atlasId: atlas.id, bakedGlyphs: checkedGlyphs(measured, line.text, atlas),
    });
    compiledLineIndexes.push(index);
  }
  return {
    atlas: { kind: "glyph", format: "r8unorm", sampling: "nearest", id: atlas.id, revision: atlas.revision, width: atlas.width, height: atlas.height, dataBase64: atlas.dataBase64 },
    commands, compiledLineIndexes,
  };
}

function checkedGlyphs(measured: MeasuredLineGlyphs, text: string, atlas: FrozenGlyphAtlasIdentity): readonly Deep2dBakedGlyph[] {
  if (measured.glyphs.length === 0) fail("非空文本需要至少一个实测字形");
  if (measured.glyphs.length > DEEP_2D_DISPLAY_LIST_BUDGETS.commands) fail("字形数超过命令预算");
  let previousCluster = 0;
  return measured.glyphs.map((placement, index) => {
    const { cluster, source, destination } = placement;
    if (!Number.isSafeInteger(cluster) || cluster < 0 || cluster >= text.length || cluster < previousCluster) {
      fail(`第 ${index} 个字形 cluster 必须是行文本内递增的 UTF-16 偏移`);
    }
    previousCluster = cluster;
    const [sx, sy, sw, sh] = source;
    if (![sx, sy, sw, sh].every(Number.isInteger) || sw <= 0 || sh <= 0 || sx + sw > atlas.width || sy + sh > atlas.height) {
      fail(`第 ${index} 个字形 source 必须是图集内正面积的像素矩形`);
    }
    const [dx, dy, dw, dh] = destination;
    if (![dx, dy, dw, dh].every(Number.isFinite) || dw <= 0 || dh <= 0) {
      fail(`第 ${index} 个字形 destination 必须是有限且正宽高的逻辑矩形`);
    }
    return placement;
  });
}

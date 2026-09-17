/**
 * 输入载荷 → 类型化 V1 结构的合同级解析。与 Native 侧 serde
 * `deny_unknown_fields + rename_all = camelCase` 同规则:未知字段、缺失字段、
 * 类型/长度/值域不符全部拒绝(fail-closed),`Option` 字段缺省或 null 皆可。
 * 错误文案刻意贴近 serde,便于跨语言比对。
 */

import type { Deep2dColor } from "../deep2dDisplayList.js";
import type { JsonNode } from "./canonicalJson.js";
import {
  type AnimationAbiInput, type AnimationKeyframe, type AnimationTrack, type AnimationValue,
  type ChartExtensionInput, type ChartOverlay, type InlineObject, type RichTextAlign,
  type RichTextInlineInput, type RichTextParagraph, type RichTextStyleSpan, type SvgInputV1,
  type SvgPathSpecV1,
} from "./types.js";
import { N1Rejection } from "./validation.js";

type Entries = ReadonlyMap<string, JsonNode>;

function describe(node: JsonNode): string {
  switch (node.kind) {
    case "null": return "null";
    case "bool": return `boolean \`${node.value}\``;
    case "int": return `integer \`${node.value}\``;
    case "float": return `floating point \`${node.value}\``;
    case "string": return "string";
    case "array": return "sequence";
    case "object": return "map";
  }
}

function object(node: JsonNode, expected: string): Entries {
  if (node.kind !== "object") throw new N1Rejection(`invalid type: ${describe(node)}, expected ${expected}`);
  return node.entries;
}

function field(entries: Entries, key: string): JsonNode {
  const node = entries.get(key);
  if (node === undefined) throw new N1Rejection(`missing field \`${key}\``);
  return node;
}

function denyUnknownFields(entries: Entries, allowed: readonly string[]): void {
  for (const key of entries.keys()) {
    if (!allowed.includes(key)) throw new N1Rejection(`unknown field \`${key}\`, expected one of ${allowed.map((name) => `\`${name}\``).join(", ")}`);
  }
}

function asString(node: JsonNode, expected: string): string {
  if (node.kind !== "string") throw new N1Rejection(`invalid type: ${describe(node)}, expected ${expected}`);
  return node.value;
}

function asNumber(node: JsonNode, what: string): number {
  if (node.kind !== "int" && node.kind !== "float") throw new N1Rejection(`invalid type: ${describe(node)}, expected ${what}`);
  return node.kind === "int" ? Number(node.value) : node.value;
}

function asInt(node: JsonNode, what: string, min: number, max: number): number {
  if (node.kind !== "int") throw new N1Rejection(`invalid type: ${describe(node)}, expected ${what}`);
  const value = Number(node.value);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new N1Rejection(`invalid value: integer \`${node.value}\`, expected ${what}`);
  return value;
}

function asColor(node: JsonNode, what: string): Deep2dColor {
  if (node.kind !== "array" || node.items.length !== 4) throw new N1Rejection(`invalid length, expected ${what} of length 4`);
  return [asNumber(node.items[0]!, what), asNumber(node.items[1]!, what), asNumber(node.items[2]!, what), asNumber(node.items[3]!, what)];
}

function arrayOf<T>(node: JsonNode, what: string, read: (item: JsonNode, index: number) => T): T[] {
  if (node.kind !== "array") throw new N1Rejection(`invalid type: ${describe(node)}, expected a sequence`);
  return node.items.map(read);
}

function asEnum<T extends string>(node: JsonNode, variants: readonly T[]): T {
  const value = asString(node, "a variant identifier");
  if (!variants.includes(value as T)) throw new N1Rejection(`unknown variant \`${value}\`, expected one of ${variants.map((name) => `\`${name}\``).join(", ")}`);
  return value as T;
}

function point2(node: JsonNode, what: string): readonly [number, number] {
  if (node.kind !== "array" || node.items.length !== 2) throw new N1Rejection(`invalid length, expected ${what} of length 2`);
  return [asNumber(node.items[0]!, what), asNumber(node.items[1]!, what)];
}

/** serde `Option`:缺省与 null 都归 None。 */
function optional<T>(entries: Entries, key: string, read: (node: JsonNode) => T): T | undefined {
  const node = entries.get(key);
  return node === undefined || node.kind === "null" ? undefined : read(node);
}

function defaultedArray<T>(entries: Entries, key: string, read: (item: JsonNode, index: number) => T): T[] {
  const node = entries.get(key);
  return node === undefined ? [] : arrayOf(node, key, read);
}

export function readSvgInput(node: JsonNode): SvgInputV1 {
  const entries = object(node, "struct SvgInputV1");
  denyUnknownFields(entries, ["id", "viewBox", "paths"]);
  const viewBoxNode = field(entries, "viewBox");
  if (viewBoxNode.kind !== "array" || viewBoxNode.items.length !== 4) throw new N1Rejection("invalid length, expected viewBox of length 4");
  const viewBox = viewBoxNode.items.map((item) => asNumber(item, "f64")) as [number, number, number, number];
  return {
    id: asString(field(entries, "id"), "a string"),
    viewBox,
    paths: arrayOf(field(entries, "paths"), "paths", (item) => {
      const path = object(item, "struct SvgPathSpecV1");
      denyUnknownFields(path, ["id", "data", "zOrder", "fill", "stroke", "strokeWidth"]);
      const spec: SvgPathSpecV1 = {
        id: asString(field(path, "id"), "a string"),
        data: asString(field(path, "data"), "a string"),
        zOrder: asInt(field(path, "zOrder"), "i32", -2_147_483_648, 2_147_483_647),
      };
      const fill = optional(path, "fill", (node) => asColor(node, "RGBA color"));
      const stroke = optional(path, "stroke", (node) => asColor(node, "RGBA color"));
      const strokeWidth = optional(path, "strokeWidth", (node) => asNumber(node, "f64"));
      return { ...spec, ...(fill !== undefined ? { fill } : {}), ...(stroke !== undefined ? { stroke } : {}), ...(strokeWidth !== undefined ? { strokeWidth } : {}) };
    }),
  };
}

export function readRichTextInlineInput(node: JsonNode): RichTextInlineInput {
  const entries = object(node, "struct RichTextInlineInputV1");
  denyUnknownFields(entries, ["id", "text", "styles", "paragraphs", "inlineObjects"]);
  return {
    id: asString(field(entries, "id"), "a string"),
    text: asString(field(entries, "text"), "a string"),
    styles: defaultedArray(entries, "styles", (item): RichTextStyleSpan => {
      const span = object(item, "struct RichTextStyleSpanV1");
      denyUnknownFields(span, ["startCluster", "endCluster", "style"]);
      return {
        startCluster: asInt(field(span, "startCluster"), "usize", 0, Number.MAX_SAFE_INTEGER),
        endCluster: asInt(field(span, "endCluster"), "usize", 0, Number.MAX_SAFE_INTEGER),
        style: asInt(field(span, "style"), "u16", 0, 65_535),
      };
    }),
    paragraphs: defaultedArray(entries, "paragraphs", (item): RichTextParagraph => {
      const paragraph = object(item, "struct RichTextParagraphV1");
      denyUnknownFields(paragraph, ["startCluster", "endCluster", "align"]);
      return {
        startCluster: asInt(field(paragraph, "startCluster"), "usize", 0, Number.MAX_SAFE_INTEGER),
        endCluster: asInt(field(paragraph, "endCluster"), "usize", 0, Number.MAX_SAFE_INTEGER),
        align: asEnum<RichTextAlign>(field(paragraph, "align"), ["start", "center", "end", "justify"]),
      };
    }),
    inlineObjects: defaultedArray(entries, "inlineObjects", (item): InlineObject => {
      const inline = object(item, "struct InlineObjectV1");
      denyUnknownFields(inline, ["atCluster", "objectId"]);
      return {
        atCluster: asInt(field(inline, "atCluster"), "usize", 0, Number.MAX_SAFE_INTEGER),
        objectId: asString(field(inline, "objectId"), "a string"),
      };
    }),
  };
}

export function readChartExtensionInput(node: JsonNode): ChartExtensionInput {
  const entries = object(node, "struct ChartExtensionInputV1");
  denyUnknownFields(entries, ["id", "overlays"]);
  return {
    id: asString(field(entries, "id"), "a string"),
    overlays: arrayOf(field(entries, "overlays"), "overlays", (item): ChartOverlay => {
      const overlay = object(item, "enum ChartOverlayV1");
      const tag = asEnum(overlay.get("overlay") ?? { kind: "null" } as JsonNode, ["trend-line", "threshold-band", "marker"] as const);
      if (tag === "trend-line") {
        denyUnknownFields(overlay, ["overlay", "id", "points", "stroke", "strokeWidth", "zOrder"]);
        const pointsNode = field(overlay, "points");
        if (pointsNode.kind !== "array" || pointsNode.items.length !== 2) throw new N1Rejection("invalid length, expected points of length 2");
        return {
          overlay: "trend-line", id: asString(field(overlay, "id"), "a string"),
          points: [point2(pointsNode.items[0]!, "point"), point2(pointsNode.items[1]!, "point")],
          stroke: asColor(field(overlay, "stroke"), "RGBA color"),
          strokeWidth: asNumber(field(overlay, "strokeWidth"), "f64"),
          zOrder: asInt(field(overlay, "zOrder"), "i32", -2_147_483_648, 2_147_483_647),
        };
      }
      if (tag === "threshold-band") {
        denyUnknownFields(overlay, ["overlay", "id", "x0", "y0", "x1", "y1", "fill", "zOrder"]);
        const number = (key: string) => asNumber(field(overlay, key), "f64");
        return {
          overlay: "threshold-band", id: asString(field(overlay, "id"), "a string"),
          x0: number("x0"), y0: number("y0"), x1: number("x1"), y1: number("y1"),
          fill: asColor(field(overlay, "fill"), "RGBA color"),
          zOrder: asInt(field(overlay, "zOrder"), "i32", -2_147_483_648, 2_147_483_647),
        };
      }
      denyUnknownFields(overlay, ["overlay", "id", "center", "radius", "fill", "zOrder"]);
      return {
        overlay: "marker", id: asString(field(overlay, "id"), "a string"),
        center: point2(field(overlay, "center"), "center"),
        radius: asNumber(field(overlay, "radius"), "f64"),
        fill: asColor(field(overlay, "fill"), "RGBA color"),
        zOrder: asInt(field(overlay, "zOrder"), "i32", -2_147_483_648, 2_147_483_647),
      };
    }),
  };
}

export function readAnimationAbiInput(node: JsonNode): AnimationAbiInput {
  const entries = object(node, "struct AnimationAbiInputV1");
  denyUnknownFields(entries, ["id", "tracks"]);
  return {
    id: asString(field(entries, "id"), "a string"),
    tracks: arrayOf(field(entries, "tracks"), "tracks", (item): AnimationTrack => {
      const track = object(item, "struct AnimationTrackV1");
      denyUnknownFields(track, ["nodeId", "property", "keyframes"]);
      return {
        nodeId: asString(field(track, "nodeId"), "a string"),
        property: asEnum(field(track, "property"), ["opacity", "rotation", "scale", "tint"] as const),
        keyframes: arrayOf(field(track, "keyframes"), "keyframes", (frame): AnimationKeyframe => {
          const keyframe = object(frame, "struct AnimationKeyframeV1");
          denyUnknownFields(keyframe, ["atMs", "value"]);
          return {
            atMs: asInt(field(keyframe, "atMs"), "u64 atMs within safe integer range", 0, Number.MAX_SAFE_INTEGER),
            value: readAnimationValue(field(keyframe, "value")),
          };
        }),
      };
    }),
  };
}

function readAnimationValue(node: JsonNode): AnimationValue {
  const entries = object(node, "enum AnimationValueV1");
  if (entries.size !== 1) throw new N1Rejection("expected exactly one variant field (`number`/`bool`/`index`)");
  const first = [...entries][0];
  if (first === undefined) throw new N1Rejection("expected exactly one variant field (`number`/`bool`/`index`)");
  const [tag, value] = first;
  if (tag === "number") return { kind: "number", value: asNumber(value, "f64") };
  if (tag === "bool") return { kind: "bool", value: value.kind === "bool" ? value.value : throwType(describe(value), "a boolean") };
  if (tag === "index") return { kind: "index", value: asInt(value, "u32", 0, 4_294_967_295) };
  throw new N1Rejection(`unknown variant \`${tag}\`, expected one of \`number\`, \`bool\`, \`index\``);
}

function throwType(actual: string, expected: string): never {
  throw new N1Rejection(`invalid type: ${actual}, expected ${expected}`);
}

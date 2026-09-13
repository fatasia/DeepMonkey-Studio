import { validateDeep2dDisplayList } from "../deep2dDisplayList.js";
import { array, fields, integer, record, requireValue, string } from "./primitives.js";

function id(input: unknown, path: string): string {
  const value = string(input, path);
  requireValue(/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$/.test(value)
    && !["prototype", "constructor", "__proto__"].includes(value), path, "Invalid Deep2d id.");
  return value;
}
function numbers(input: unknown, length: number, min: number, max: number, path: string): number[] {
  const value = array(input, path);
  requireValue(value.length === length && value.every(item => typeof item === "number" && item >= min && item <= max), path, "Invalid numeric vector.");
  return value as number[];
}
function decodedLength(input: unknown, path: string): number {
  const value = string(input, path);
  requireValue(value.length > 0 && value.length % 4 === 0 && /^[A-Za-z0-9+/]*={0,2}$/.test(value), path, "Invalid canonical base64.");
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  const last = alphabet.indexOf(value[value.length - padding - 1]!);
  requireValue((padding !== 2 || (last & 15) === 0) && (padding !== 1 || (last & 3) === 0), path, "Nonzero base64 padding bits.");
  return value.length / 4 * 3 - padding;
}
export function validateRuntimeDeep2d(input: unknown, expectedId: string, expectedRevision: number, path: string): void {
  const value = record(input, path);
  fields(value, ["schema", "schemaVersion", "id", "revision", "composition", "displayList", "atlases", "quads"], [], path);
  requireValue(value.schema === "deep-engine.deep2d-runtime" && (value.schemaVersion === 1 || value.schemaVersion === 2), path, "Unsupported Deep2d schema or version.");
  requireValue(value.id === expectedId && value.revision === expectedRevision, path, "Deep2d identity differs from resource index.");
  requireValue(value.composition === (value.schemaVersion === 1 ? "path-then-atlas" : "z-ordered"), path, "Deep2d composition differs from schema version.");
  const display = validateDeep2dDisplayList(value.displayList);
  requireValue(display.valid, `${path}.displayList`, display.issues[0]?.message ?? "Invalid display list.");
  const list = record(value.displayList, `${path}.displayList`);
  requireValue((list.commands as Record<string, unknown>[]).every(command => command.kind === "path"), path, "Text and images must be baked into atlas quads.");
  const atlases = new Map<string, { width: number; height: number }>();
  let totalBytes = 0;
  for (const [index, item] of array(value.atlases, `${path}.atlases`, 512).entries()) {
    const p = `${path}.atlases[${index}]`, atlas = record(item, p);
    fields(atlas, ["id", "revision", "kind", "format", "width", "height", "sampling", "dataBase64"], [], p);
    const atlasId = id(atlas.id, `${p}.id`);
    requireValue(!atlases.has(atlasId), p, "Duplicate atlas id.");
    integer(atlas.revision, 0, Number.MAX_SAFE_INTEGER, `${p}.revision`);
    const width = integer(atlas.width, 1, 8192, `${p}.width`), height = integer(atlas.height, 1, 8192, `${p}.height`);
    requireValue((atlas.kind === "glyph" && atlas.format === "r8unorm")
      || (atlas.kind === "image" && atlas.format === "rgba8unorm-srgb"), p, "Invalid atlas kind/format pair.");
    requireValue(atlas.sampling === "nearest" || atlas.sampling === "linear", p, "Invalid atlas sampling.");
    const bytes = decodedLength(atlas.dataBase64, `${p}.dataBase64`);
    requireValue(bytes === width * height * (atlas.kind === "glyph" ? 1 : 4), p, "Atlas byte length differs from dimensions.");
    totalBytes += bytes;
    requireValue(totalBytes <= 64 * 1024 * 1024, path, "Atlas resident budget exceeded.");
    atlases.set(atlasId, { width, height });
  }
  const ids = new Set<string>(), used = new Set<string>();
  for (const [index, item] of array(value.quads, `${path}.quads`, 262_144).entries()) {
    const p = `${path}.quads[${index}]`, quad = record(item, p);
    fields(quad, ["id", "zOrder", "transform", "atlasId", "source", "destination", "color"], ["opacity"], p);
    const quadId = id(quad.id, `${p}.id`);
    requireValue(!ids.has(quadId), p, "Duplicate quad id."); ids.add(quadId);
    integer(quad.zOrder, -2_147_483_648, 2_147_483_647, `${p}.zOrder`);
    numbers(quad.transform, 6, -16_777_216, 16_777_216, `${p}.transform`);
    const [x, y, width, height] = numbers(quad.source, 4, 0, 0xffff_ffff, `${p}.source`);
    requireValue((quad.source as number[]).every(Number.isInteger), p, "Atlas source requires integers.");
    const atlasId = id(quad.atlasId, `${p}.atlasId`), atlas = atlases.get(atlasId);
    requireValue(atlas && width! > 0 && height! > 0 && x! + width! <= atlas.width && y! + height! <= atlas.height, p, "Missing atlas or source outside its extent.");
    used.add(atlasId);
    const destination = numbers(quad.destination, 4, -16_777_216, 16_777_216, `${p}.destination`);
    requireValue(destination[2]! > 0 && destination[3]! > 0, p, "Destination dimensions must be positive.");
    numbers(quad.color, 4, 0, 1, `${p}.color`);
    if (Object.hasOwn(quad, "opacity")) requireValue(typeof quad.opacity === "number" && quad.opacity >= 0 && quad.opacity <= 1, p, "Invalid quad opacity.");
  }
  requireValue(used.size === atlases.size, path, "Unused atlas resources.");
}

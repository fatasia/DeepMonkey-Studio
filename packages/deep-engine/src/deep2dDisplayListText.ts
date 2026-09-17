/**
 * Text-command contract extension: optional baked glyph runs (`atlasId` + `bakedGlyphs`),
 * aligned field-by-field with the native validator:
 * - `deep-engine-native/src/deep2d/command_types.rs:168-193` — `TextCommand.atlas_id` /
 *   `baked_glyphs` and `BakedGlyphPlacement { cluster, source, destination }` (camelCase on
 *   the wire; there is deliberately no glyph id or advance field — clusters index the text).
 * - `deep-engine-native/src/deep2d/validate_text.rs:10-111` — both-or-neither rule, atlas
 *   resource resolution, glyph budget, non-empty-text rule, glyph-atlas kind, ordered UTF-16
 *   clusters, source rect inside the atlas, bounded destinations.
 * - `deep-engine-native/src/deep2d/validate_resources.rs:76-125` — top-level `atlases`
 *   budget, kind/format pairing, dimensions, pixel-data presence, duplicate ids.
 * Commands without glyph keys keep the legacy "unshaped text" path (backward compatible).
 */

import {
  DEEP_2D_DISPLAY_LIST_BUDGETS, MAX_DRAW_VALUE, MAX_IMAGE_DIMENSION,
  add, allowedKeys, denseArray, finite, record, validColor, validDrawNumber, validEnum,
  validId, validPositive, validRevision, wellFormedUnicode,
  type Deep2dDisplayListIssue,
} from "./deep2dValidationPrimitives.js";

/** One baked glyph: `cluster` is a UTF-16 offset into `text`; `source` is a pixel-space
 *  `[x, y, width, height]` inside the atlas; `destination` is a logical `[x, y, width, height]`
 *  relative to the command origin. Exactly the native `BakedGlyphPlacement` shape. */
export interface Deep2dBakedGlyph {
  readonly cluster: number;
  readonly source: readonly [number, number, number, number];
  readonly destination: readonly [number, number, number, number];
}

/** Top-level display-list atlas (`Deep2dDisplayList.atlases`); optional, absent on legacy
 *  display lists. Glyph atlases pair with `r8unorm`, image atlases with `rgba8unorm-srgb`. */
export interface Deep2dDisplayListAtlas {
  readonly id: string;
  readonly revision: number;
  readonly kind: "glyph" | "image";
  readonly format: "r8unorm" | "rgba8unorm-srgb";
  readonly width: number;
  readonly height: number;
  readonly sampling: "nearest" | "linear";
  readonly dataBase64: string;
}

/** Atlas identity a text command resolves its `atlasId` against (kind + extent). */
export interface Deep2dAtlasIdentity { readonly kind: "glyph" | "image"; readonly width: number; readonly height: number }

export interface Deep2dTextValidationContext {
  /** Resolves path/font/image/atlas resources by id; reports missing/kind-mismatch issues. */
  readonly requireResource: (id: unknown, kind: string, path: string) => void;
  /** Atlas identities declared by the display list, keyed by atlas id. */
  readonly atlases: ReadonlyMap<string, Deep2dAtlasIdentity>;
}

const ATLAS_KEYS = ["id", "revision", "kind", "format", "width", "height", "sampling", "dataBase64"] as const;
const GLYPH_KEYS = ["cluster", "source", "destination"] as const;

/** Mirrors native `atlas_resources` (validate_resources.rs:76-125): validates and registers
 *  atlas ids into the shared resource-kind index, returning identities for command checks. */
export function validateDisplayListAtlases(
  input: unknown, kindIndex: Map<string, string>, issues: Deep2dDisplayListIssue[],
): Map<string, Deep2dAtlasIdentity> {
  const atlases = new Map<string, Deep2dAtlasIdentity>();
  if (input === undefined) return atlases;
  if (!Array.isArray(input)) { add(issues, "invalid-structure", "atlases", "Expected an atlas array."); return atlases; }
  if (input.length > DEEP_2D_DISPLAY_LIST_BUDGETS.resources) {
    add(issues, "budget-exceeded", "atlases", `At most ${DEEP_2D_DISPLAY_LIST_BUDGETS.resources} atlases are allowed per display list.`);
  }
  for (const [index, candidate] of input.entries()) {
    const path = `atlases[${index}]`;
    if (!record(candidate)) { add(issues, "invalid-structure", path, "Expected an atlas object."); continue; }
    allowedKeys(candidate, ATLAS_KEYS, path, issues);
    const idValid = validId(candidate.id, `${path}.id`, issues);
    validRevision(candidate.revision, `${path}.revision`, issues);
    const kind = candidate.kind === "glyph" || candidate.kind === "image" ? candidate.kind : undefined;
    if ((kind !== "glyph" || candidate.format !== "r8unorm") && (kind !== "image" || candidate.format !== "rgba8unorm-srgb")) {
      add(issues, "invalid-structure", `${path}.format`, "Glyph atlases require r8unorm; image atlases require rgba8unorm-srgb.");
    }
    for (const key of ["width", "height"] as const) {
      const value = candidate[key];
      if (!Number.isSafeInteger(value) || (value as number) <= 0 || (value as number) > MAX_IMAGE_DIMENSION) {
        add(issues, "invalid-number", `${path}.${key}`, "Image dimension must be a positive bounded integer pixel count.");
      }
    }
    validEnum(candidate.sampling, ["nearest", "linear"], `${path}.sampling`, issues);
    if (typeof candidate.dataBase64 !== "string" || candidate.dataBase64.length === 0) {
      add(issues, "invalid-structure", `${path}.dataBase64`, "Atlas requires pixel data.");
    }
    if (idValid) {
      const id = candidate.id as string;
      if (kindIndex.has(id)) add(issues, "duplicate-id", `${path}.id`, `Duplicate resource id: ${id}.`);
      else { kindIndex.set(id, "atlas"); if (kind) atlases.set(id, { kind, width: candidate.width as number, height: candidate.height as number }); }
    }
  }
  return atlases;
}

/** Mirrors native `text_command` + `text_atlas`. Returns the UTF-16 code units and baked
 *  glyph count contributed by this command for the display-list budgets. */
export function validateTextCommand(
  command: Record<string, unknown>, path: string, context: Deep2dTextValidationContext, issues: Deep2dDisplayListIssue[],
): { textCodeUnits: number; bakedGlyphs: number } {
  context.requireResource(command.fontId, "font", `${path}.fontId`);
  validColor(command.color, `${path}.color`, issues);
  const text = command.text;
  const codeUnits = typeof text === "string" ? text.length : 0;
  if (typeof text !== "string" || text.length > DEEP_2D_DISPLAY_LIST_BUDGETS.textCodeUnitsPerCommand || !wellFormedUnicode(text)) {
    add(issues, "invalid-structure", `${path}.text`, "Expected bounded well-formed Unicode text.");
  }
  validDrawNumber(command.x, `${path}.x`, issues); validDrawNumber(command.y, `${path}.y`, issues);
  validPositive(command.fontSize, `${path}.fontSize`, issues, 65_536);
  if (command.maxWidth !== undefined) validPositive(command.maxWidth, `${path}.maxWidth`, issues);
  if (command.align !== undefined) validEnum(command.align, ["start", "center", "end"], `${path}.align`, issues);
  if (command.baseline !== undefined) validEnum(command.baseline, ["top", "middle", "alphabetic", "bottom"], `${path}.baseline`, issues);
  if (command.direction !== undefined) validEnum(command.direction, ["ltr", "rtl"], `${path}.direction`, issues);
  return { textCodeUnits: codeUnits, bakedGlyphs: validateGlyphRun(command, path, context, codeUnits, issues) };
}

function validateGlyphRun(
  command: Record<string, unknown>, path: string, context: Deep2dTextValidationContext, codeUnits: number, issues: Deep2dDisplayListIssue[],
): number {
  const atlasId = command.atlasId, glyphs = command.bakedGlyphs;
  if (atlasId === undefined && glyphs === undefined) return 0;
  if (atlasId === undefined || glyphs === undefined) {
    add(issues, "invalid-structure", path, "Baked text requires both atlasId and bakedGlyphs.");
    return 0;
  }
  context.requireResource(atlasId, "atlas", `${path}.atlasId`);
  if (!Array.isArray(glyphs)) {
    add(issues, "invalid-structure", `${path}.bakedGlyphs`, "Expected a baked glyph array.");
    return 0;
  }
  if (glyphs.length > DEEP_2D_DISPLAY_LIST_BUDGETS.commands) {
    add(issues, "budget-exceeded", `${path}.bakedGlyphs`, "Text command exceeds the baked glyph budget.");
    return 0;
  }
  if (typeof command.text === "string" && command.text.length > 0 && glyphs.length === 0) {
    add(issues, "invalid-structure", `${path}.bakedGlyphs`, "Non-empty text requires at least one baked glyph.");
  }
  const atlas = typeof atlasId === "string" ? context.atlases.get(atlasId) : undefined;
  if (atlas !== undefined && atlas.kind !== "glyph") {
    add(issues, "resource-kind-mismatch", `${path}.atlasId`, "Text command requires a glyph atlas.");
  }
  let previousCluster = 0;
  for (const [index, glyph] of glyphs.entries()) {
    const glyphPath = `${path}.bakedGlyphs[${index}]`;
    if (!record(glyph)) { add(issues, "invalid-structure", glyphPath, "Expected a baked glyph placement."); continue; }
    allowedKeys(glyph, GLYPH_KEYS, glyphPath, issues);
    const cluster = glyph.cluster;
    if (!Number.isSafeInteger(cluster) || (cluster as number) < 0 || (cluster as number) >= codeUnits
      || (index > 0 && (cluster as number) < previousCluster)) {
      add(issues, "invalid-structure", `${glyphPath}.cluster`, "Glyph clusters must be ordered UTF-16 offsets within the text.");
    }
    if (Number.isSafeInteger(cluster)) previousCluster = cluster as number;
    validateGlyphRect(glyph.source, glyph.destination, atlas, glyphPath, issues);
  }
  return glyphs.length;
}

function validateGlyphRect(
  source: unknown, destination: unknown, atlas: Deep2dAtlasIdentity | undefined, path: string, issues: Deep2dDisplayListIssue[],
): void {
  if (denseArray(source, 4) && source.every((value) => Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff)) {
    const [sx, sy, sw, sh] = source as [number, number, number, number];
    if (sw === 0 || sh === 0 || (atlas !== undefined && (sx + sw > atlas.width || sy + sh > atlas.height))) {
      add(issues, "invalid-number", `${path}.source`, "Glyph source must have positive area inside its atlas.");
    }
  } else {
    add(issues, "invalid-number", `${path}.source`, "Glyph source must be four u32 pixel coordinates.");
  }
  if (denseArray(destination, 4) && destination.every((value) => finite(value))) {
    const [dx, dy, dw, dh] = destination as [number, number, number, number];
    validDrawNumber(dx, `${path}.destination[0]`, issues);
    validDrawNumber(dy, `${path}.destination[1]`, issues);
    validPositive(dw, `${path}.destination[2]`, issues, MAX_DRAW_VALUE);
    validPositive(dh, `${path}.destination[3]`, issues, MAX_DRAW_VALUE);
  } else {
    add(issues, "invalid-number", `${path}.destination`, "Glyph destination must be four finite numbers with positive extent.");
  }
}

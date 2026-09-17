export const DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION = 1 as const;

export {
  DEEP_2D_DISPLAY_LIST_BUDGETS,
  type Deep2dDisplayListIssue,
  type Deep2dDisplayListIssueCode,
  type Deep2dDisplayListValidationResult,
} from "./deep2dValidationPrimitives.js";
export type { Deep2dAtlasIdentity, Deep2dBakedGlyph, Deep2dDisplayListAtlas } from "./deep2dDisplayListText.js";

import {
  DEEP_2D_DISPLAY_LIST_BUDGETS, MAX_DRAW_VALUE, MAX_IMAGE_DIMENSION,
  add, allowedKeys, denseArray, finite, record, validColor, validDrawNumber, validEnum,
  validId, validMatrix, validPositive, validRevision, wellFormedUnicode,
  type Deep2dDisplayListIssue, type Deep2dDisplayListValidationResult,
} from "./deep2dValidationPrimitives.js";
import {
  validateDisplayListAtlases, validateTextCommand,
  type Deep2dBakedGlyph, type Deep2dDisplayListAtlas, type Deep2dTextValidationContext,
} from "./deep2dDisplayListText.js";

export type Deep2dColor = readonly [number, number, number, number];
export type Deep2dMatrix = readonly [number, number, number, number, number, number];

export type Deep2dPathVerb =
  | { readonly op: "move" | "line"; readonly x: number; readonly y: number }
  | { readonly op: "quadratic"; readonly cx: number; readonly cy: number; readonly x: number; readonly y: number }
  | { readonly op: "cubic"; readonly c1x: number; readonly c1y: number; readonly c2x: number; readonly c2y: number; readonly x: number; readonly y: number }
  | { readonly op: "close" };

export type Deep2dResource =
  | { readonly kind: "path"; readonly id: string; readonly revision: number; readonly verbs: readonly Deep2dPathVerb[] }
  | { readonly kind: "font"; readonly id: string; readonly revision: number; readonly assetId: string; readonly family: string; readonly weight: number; readonly style: "normal" | "italic" }
  | { readonly kind: "image"; readonly id: string; readonly revision: number; readonly assetId: string; readonly width: number; readonly height: number; readonly colorSpace: "srgb" | "linear" };

interface Deep2dCommandBase {
  readonly id: string;
  readonly zOrder: number;
  readonly transform: Deep2dMatrix;
  readonly opacity?: number;
  /** Clip paths are intersected in array order and use the command transform. */
  readonly clipPathIds?: readonly string[];
  readonly hitId?: string;
}

export type Deep2dCommand =
  | (Deep2dCommandBase & {
      readonly kind: "path"; readonly pathId: string; readonly fill?: Deep2dColor; readonly fillRule?: "nonzero" | "evenodd";
      readonly stroke?: Deep2dColor; readonly strokeWidth?: number; readonly lineCap?: "butt" | "round" | "square";
      readonly lineJoin?: "miter" | "round" | "bevel"; readonly miterLimit?: number; readonly dash?: readonly number[]; readonly dashOffset?: number;
    })
  | (Deep2dCommandBase & {
      readonly kind: "text"; readonly text: string; readonly x: number; readonly y: number; readonly fontId: string;
      readonly fontSize: number; readonly color: Deep2dColor; readonly maxWidth?: number; readonly align?: "start" | "center" | "end";
      readonly baseline?: "top" | "middle" | "alphabetic" | "bottom"; readonly direction?: "ltr" | "rtl";
      /** Optional baked glyph run (P1-18): requires `bakedGlyphs`; resolves against `atlases`.
       *  Field shapes mirror native `command_types.rs` TextCommand exactly. */
      readonly atlasId?: string; readonly bakedGlyphs?: readonly Deep2dBakedGlyph[];
    })
  | (Deep2dCommandBase & {
      readonly kind: "image"; readonly imageId: string; readonly x: number; readonly y: number; readonly width: number; readonly height: number;
      readonly sampling?: "nearest" | "linear";
    });

export interface Deep2dDisplayList {
  readonly schemaVersion: typeof DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION;
  readonly id: string;
  readonly revision: number;
  readonly logicalWidth: number;
  readonly logicalHeight: number;
  readonly scaleFactor: number;
  readonly resources: readonly Deep2dResource[];
  /** Optional glyph/image atlases; absent on legacy display lists (native `types.rs:29-32`).
   *  Text `atlasId` references resolve here, sharing the resource id namespace. */
  readonly atlases?: readonly Deep2dDisplayListAtlas[];
  /** Equal zOrder values retain their commands-array order. */
  readonly commands: readonly Deep2dCommand[];
}

function validatePathVerbs(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): number {
  if (!Array.isArray(value) || value.length === 0) { add(issues, "invalid-path", path, "Path requires a non-empty verb array."); return 0; }
  if (value.length > DEEP_2D_DISPLAY_LIST_BUDGETS.pathVerbsPerResource) {
    add(issues, "budget-exceeded", path, `Path exceeds ${DEEP_2D_DISPLAY_LIST_BUDGETS.pathVerbsPerResource} verbs.`); return value.length;
  }
  let subpathOpen = false;
  for (const [index, candidate] of value.entries()) {
    const verbPath = `${path}[${index}]`;
    if (!record(candidate) || typeof candidate.op !== "string") { add(issues, "invalid-path", verbPath, "Expected a path verb object."); continue; }
    const coordinateKeys = candidate.op === "move" || candidate.op === "line" ? ["x", "y"]
      : candidate.op === "quadratic" ? ["cx", "cy", "x", "y"]
        : candidate.op === "cubic" ? ["c1x", "c1y", "c2x", "c2y", "x", "y"] : candidate.op === "close" ? [] : undefined;
    if (coordinateKeys === undefined) { add(issues, "invalid-path", `${verbPath}.op`, "Unsupported path verb."); continue; }
    allowedKeys(candidate, ["op", ...coordinateKeys], verbPath, issues);
    if (coordinateKeys.some((key) => !finite(candidate[key]) || Math.abs(candidate[key] as number) > MAX_DRAW_VALUE)) {
      add(issues, "invalid-path", verbPath, "Path coordinates must be present, finite and bounded.");
    }
    if (candidate.op === "move") subpathOpen = true;
    else if (!subpathOpen) add(issues, "invalid-path", verbPath, "Each subpath must start with move.");
    if (candidate.op === "close") subpathOpen = false;
  }
  return value.length;
}

function validateResource(value: unknown, path: string, issues: Deep2dDisplayListIssue[]): Deep2dResource | undefined {
  if (!record(value) || typeof value.kind !== "string" || !["path", "font", "image"].includes(value.kind)) { add(issues, "invalid-structure", path, "Expected a supported resource object."); return undefined; }
  validId(value.id, `${path}.id`, issues); validRevision(value.revision, `${path}.revision`, issues);
  if (value.kind === "path") {
    allowedKeys(value, ["kind", "id", "revision", "verbs"], path, issues);
    validatePathVerbs(value.verbs, `${path}.verbs`, issues);
  } else if (value.kind === "font") {
    allowedKeys(value, ["kind", "id", "revision", "assetId", "family", "weight", "style"], path, issues);
    validId(value.assetId, `${path}.assetId`, issues);
    if (typeof value.family !== "string" || value.family.trim().length === 0 || value.family.length > 256 || !wellFormedUnicode(value.family)) add(issues, "invalid-structure", `${path}.family`, "Font family must be bounded, non-blank well-formed Unicode.");
    if (!Number.isInteger(value.weight) || (value.weight as number) < 100 || (value.weight as number) > 900 || (value.weight as number) % 100 !== 0) add(issues, "invalid-number", `${path}.weight`, "Font weight must be 100..900 in steps of 100.");
    validEnum(value.style, ["normal", "italic"], `${path}.style`, issues);
  } else {
    allowedKeys(value, ["kind", "id", "revision", "assetId", "width", "height", "colorSpace"], path, issues);
    validId(value.assetId, `${path}.assetId`, issues);
    if (!Number.isSafeInteger(value.width) || (value.width as number) <= 0 || (value.width as number) > MAX_IMAGE_DIMENSION) add(issues, "invalid-number", `${path}.width`, "Image width must be a positive bounded integer pixel count.");
    if (!Number.isSafeInteger(value.height) || (value.height as number) <= 0 || (value.height as number) > MAX_IMAGE_DIMENSION) add(issues, "invalid-number", `${path}.height`, "Image height must be a positive bounded integer pixel count.");
    validEnum(value.colorSpace, ["srgb", "linear"], `${path}.colorSpace`, issues);
  }
  return value as Deep2dResource;
}

export function validateDeep2dDisplayList(input: unknown): Deep2dDisplayListValidationResult {
  const issues: Deep2dDisplayListIssue[] = [];
  if (!record(input)) return { valid: false, issues: [{ code: "invalid-structure", path: "displayList", message: "Expected a display-list object." }] };
  allowedKeys(input, ["schemaVersion", "id", "revision", "logicalWidth", "logicalHeight", "scaleFactor", "resources", "atlases", "commands"], "displayList", issues);
  if (input.schemaVersion !== DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION) add(issues, "invalid-schema-version", "schemaVersion", `Expected schema version ${DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION}.`);
  validId(input.id, "id", issues); validRevision(input.revision, "revision", issues);
  validPositive(input.logicalWidth, "logicalWidth", issues); validPositive(input.logicalHeight, "logicalHeight", issues); validPositive(input.scaleFactor, "scaleFactor", issues, 16);
  if (!Array.isArray(input.resources) || !Array.isArray(input.commands)) {
    if (!Array.isArray(input.resources)) add(issues, "invalid-structure", "resources", "Expected a resource array.");
    if (!Array.isArray(input.commands)) add(issues, "invalid-structure", "commands", "Expected a command array.");
    return { valid: false, issues };
  }
  if (input.resources.length > DEEP_2D_DISPLAY_LIST_BUDGETS.resources) add(issues, "budget-exceeded", "resources", `At most ${DEEP_2D_DISPLAY_LIST_BUDGETS.resources} resources are allowed.`);
  if (input.commands.length > DEEP_2D_DISPLAY_LIST_BUDGETS.commands) add(issues, "budget-exceeded", "commands", `At most ${DEEP_2D_DISPLAY_LIST_BUDGETS.commands} commands are allowed.`);
  if (input.resources.length > DEEP_2D_DISPLAY_LIST_BUDGETS.resources || input.commands.length > DEEP_2D_DISPLAY_LIST_BUDGETS.commands) return { valid: false, issues };

  const resources = new Map<string, Deep2dResource>();
  let totalPathVerbs = 0;
  for (const [index, candidate] of input.resources.entries()) {
    const path = `resources[${index}]`;
    const resource = validateResource(candidate, path, issues);
    if (resource?.kind === "path" && Array.isArray(resource.verbs)) totalPathVerbs += resource.verbs.length;
    if (resource && validId(resource.id, `${path}.id`, [])) {
      if (resources.has(resource.id)) add(issues, "duplicate-id", `${path}.id`, `Duplicate resource id: ${resource.id}.`); else resources.set(resource.id, resource);
    }
  }
  if (totalPathVerbs > DEEP_2D_DISPLAY_LIST_BUDGETS.pathVerbsTotal) add(issues, "budget-exceeded", "resources", `Display list exceeds ${DEEP_2D_DISPLAY_LIST_BUDGETS.pathVerbsTotal} total path verbs.`);

  // Atlases share the resource id namespace (native registers them after path/font/image).
  const kindIndex = new Map<string, string>();
  for (const resource of resources.values()) kindIndex.set(resource.id, resource.kind);
  const atlasIdentities = validateDisplayListAtlases(input.atlases, kindIndex, issues);
  const textContext: Deep2dTextValidationContext = {
    atlases: atlasIdentities,
    requireResource: (id, kind, path) => {
      const actual = typeof id === "string" ? kindIndex.get(id) : undefined;
      if (actual === undefined) add(issues, "missing-resource", path, `Missing ${kind} resource: ${String(id)}.`);
      else if (actual !== kind) add(issues, "resource-kind-mismatch", path, `Expected ${kind} resource: ${id}.`);
    },
  };

  const commandIds = new Set<string>();
  let totalTextCodeUnits = 0;
  let totalBakedGlyphs = 0;
  const requireResource = (id: unknown, kind: Deep2dResource["kind"], path: string): void => {
    if (typeof id !== "string" || !resources.has(id)) add(issues, "missing-resource", path, `Missing ${kind} resource: ${String(id)}.`);
    else if (resources.get(id)?.kind !== kind) add(issues, "resource-kind-mismatch", path, `Expected ${kind} resource: ${id}.`);
  };
  for (const [index, candidate] of input.commands.entries()) {
    const path = `commands[${index}]`;
    if (!record(candidate) || typeof candidate.kind !== "string" || !["path", "text", "image"].includes(candidate.kind)) { add(issues, "invalid-structure", path, "Expected a supported command object."); continue; }
    const baseKeys = ["kind", "id", "zOrder", "transform", "opacity", "clipPathIds", "hitId"];
    if (validId(candidate.id, `${path}.id`, issues)) {
      if (commandIds.has(candidate.id)) add(issues, "duplicate-id", `${path}.id`, `Duplicate command id: ${candidate.id}.`); else commandIds.add(candidate.id);
    }
    if (!Number.isInteger(candidate.zOrder) || (candidate.zOrder as number) < -2_147_483_648 || (candidate.zOrder as number) > 2_147_483_647) add(issues, "invalid-number", `${path}.zOrder`, "Expected a signed 32-bit integer z-order.");
    validMatrix(candidate.transform, `${path}.transform`, issues);
    if (candidate.opacity !== undefined && (!finite(candidate.opacity) || candidate.opacity < 0 || candidate.opacity > 1)) add(issues, "invalid-number", `${path}.opacity`, "Opacity must be in [0, 1].");
    if (candidate.hitId !== undefined) validId(candidate.hitId, `${path}.hitId`, issues);
    if (candidate.clipPathIds !== undefined) {
      if (!Array.isArray(candidate.clipPathIds)) add(issues, "invalid-structure", `${path}.clipPathIds`, "Expected a path id array.");
      else if (candidate.clipPathIds.length > DEEP_2D_DISPLAY_LIST_BUDGETS.clipsPerCommand) add(issues, "budget-exceeded", `${path}.clipPathIds`, `At most ${DEEP_2D_DISPLAY_LIST_BUDGETS.clipsPerCommand} clips are allowed per command.`);
      else for (let clipIndex = 0; clipIndex < candidate.clipPathIds.length; clipIndex += 1) requireResource(candidate.clipPathIds[clipIndex], "path", `${path}.clipPathIds[${clipIndex}]`);
    }
    if (candidate.kind === "path") {
      allowedKeys(candidate, [...baseKeys, "pathId", "fill", "fillRule", "stroke", "strokeWidth", "lineCap", "lineJoin", "miterLimit", "dash", "dashOffset"], path, issues);
      requireResource(candidate.pathId, "path", `${path}.pathId`);
      if (candidate.fill === undefined && candidate.stroke === undefined) add(issues, "empty-paint", path, "Path command requires fill or stroke.");
      if (candidate.fill !== undefined) validColor(candidate.fill, `${path}.fill`, issues);
      if (candidate.fillRule !== undefined) validEnum(candidate.fillRule, ["nonzero", "evenodd"], `${path}.fillRule`, issues);
      if (candidate.fill === undefined && candidate.fillRule !== undefined) add(issues, "invalid-structure", `${path}.fillRule`, "Fill rule requires fill paint.");
      if (candidate.stroke !== undefined) { validColor(candidate.stroke, `${path}.stroke`, issues); validPositive(candidate.strokeWidth, `${path}.strokeWidth`, issues, 65_536); }
      const strokeOptions = [candidate.lineCap, candidate.lineJoin, candidate.miterLimit, candidate.dash, candidate.dashOffset];
      if (candidate.stroke === undefined && strokeOptions.some((value) => value !== undefined)) add(issues, "invalid-structure", path, "Stroke style fields require stroke paint.");
      if (candidate.lineCap !== undefined) validEnum(candidate.lineCap, ["butt", "round", "square"], `${path}.lineCap`, issues);
      if (candidate.lineJoin !== undefined) validEnum(candidate.lineJoin, ["miter", "round", "bevel"], `${path}.lineJoin`, issues);
      if (candidate.miterLimit !== undefined) validPositive(candidate.miterLimit, `${path}.miterLimit`, issues, 65_536);
      if (candidate.dash !== undefined) {
        if (!denseArray(candidate.dash) || candidate.dash.length === 0 || candidate.dash.length > DEEP_2D_DISPLAY_LIST_BUDGETS.dashEntries || candidate.dash.some((item) => !finite(item) || item < 0 || item > MAX_DRAW_VALUE) || !candidate.dash.some((item) => finite(item) && item > 0)) add(issues, "invalid-number", `${path}.dash`, "Dash must be a bounded non-empty dense array of non-negative finite lengths with at least one positive entry.");
      }
      if (candidate.dashOffset !== undefined) validDrawNumber(candidate.dashOffset, `${path}.dashOffset`, issues);
    } else if (candidate.kind === "text") {
      allowedKeys(candidate, [...baseKeys, "text", "x", "y", "fontId", "fontSize", "color", "maxWidth", "align", "baseline", "direction", "atlasId", "bakedGlyphs"], path, issues);
      const counted = validateTextCommand(candidate, path, textContext, issues);
      totalTextCodeUnits += counted.textCodeUnits;
      totalBakedGlyphs += counted.bakedGlyphs;
    } else {
      allowedKeys(candidate, [...baseKeys, "imageId", "x", "y", "width", "height", "sampling"], path, issues);
      requireResource(candidate.imageId, "image", `${path}.imageId`);
      validDrawNumber(candidate.x, `${path}.x`, issues); validDrawNumber(candidate.y, `${path}.y`, issues);
      validPositive(candidate.width, `${path}.width`, issues); validPositive(candidate.height, `${path}.height`, issues);
      if (candidate.sampling !== undefined) validEnum(candidate.sampling, ["nearest", "linear"], `${path}.sampling`, issues);
    }
  }
  if (totalTextCodeUnits > DEEP_2D_DISPLAY_LIST_BUDGETS.textCodeUnitsTotal) add(issues, "budget-exceeded", "commands", `Display list exceeds ${DEEP_2D_DISPLAY_LIST_BUDGETS.textCodeUnitsTotal} total text code units.`);
  if (totalBakedGlyphs > DEEP_2D_DISPLAY_LIST_BUDGETS.commands) add(issues, "budget-exceeded", "commands", `Display list exceeds ${DEEP_2D_DISPLAY_LIST_BUDGETS.commands} baked glyphs.`);
  return { valid: issues.length === 0, issues };
}

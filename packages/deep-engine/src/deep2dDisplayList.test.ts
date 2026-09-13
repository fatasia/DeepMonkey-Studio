import { describe, expect, it } from "vitest";
import {
  DEEP_2D_DISPLAY_LIST_BUDGETS,
  DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
  validateDeep2dDisplayList,
  type Deep2dDisplayList,
} from "./deep2dDisplayList.js";

const identity = [1, 0, 0, 1, 0, 0] as const;
const list: Deep2dDisplayList = {
  schemaVersion: DEEP_2D_DISPLAY_LIST_SCHEMA_VERSION,
  id: "chart:temperature",
  revision: 4,
  logicalWidth: 640,
  logicalHeight: 360,
  scaleFactor: 1.5,
  resources: [
    { kind: "path", id: "series:line", revision: 2, verbs: [{ op: "move", x: 0, y: 20 }, { op: "line", x: 640, y: 100 }] },
    { kind: "font", id: "font:ui", revision: 0, assetId: "asset:noto-sans-sc", family: "Noto Sans SC", weight: 400, style: "normal" },
    { kind: "image", id: "image:logo", revision: 1, assetId: "asset:logo", width: 64, height: 64, colorSpace: "srgb" },
  ],
  commands: [
    { kind: "path", id: "draw:line", zOrder: 0, transform: identity, pathId: "series:line", stroke: [0.1, 0.6, 0.9, 1], strokeWidth: 2, dash: [4, 2], lineJoin: "round", hitId: "series:temperature" },
    { kind: "text", id: "draw:title", zOrder: 1, transform: identity, text: "温度 / °C", x: 16, y: 24, fontId: "font:ui", fontSize: 14, color: [1, 1, 1, 1], direction: "ltr" },
    { kind: "image", id: "draw:logo", zOrder: 2, transform: identity, imageId: "image:logo", x: 560, y: 16, width: 64, height: 64, opacity: 0.8, sampling: "linear" },
  ],
};

describe("validateDeep2dDisplayList", () => {
  it("accepts a JSON-round-trippable batch with path, CJK text, image and hit identity", () => {
    expect(validateDeep2dDisplayList(JSON.parse(JSON.stringify(list)))).toEqual({ valid: true, issues: [] });
  });

  it.each([null, [], {}, { ...list, resources: null }, { ...list, commands: null }])("rejects malformed envelopes without throwing: %j", (value) => {
    expect(validateDeep2dDisplayList(value).valid).toBe(false);
  });

  it("rejects stale schema, invalid dimensions and duplicate stable ids", () => {
    const result = validateDeep2dDisplayList({ ...list, schemaVersion: 2, logicalWidth: 0, resources: [...list.resources, list.resources[0]] });
    expect(result.issues.map((entry) => entry.code)).toEqual(["invalid-schema-version", "invalid-number", "duplicate-id"]);
  });

  it("checks resource type, clips, colors, transforms and paint", () => {
    const result = validateDeep2dDisplayList({
      ...list,
      commands: [
        { kind: "path", id: "bad:path", zOrder: 0, transform: [1, 0, Number.NaN, 1, 0, 0], pathId: "font:ui", clipPathIds: ["missing"], fill: [2, 0, 0, 1] },
        { kind: "path", id: "empty:path", zOrder: 1, transform: identity, pathId: "series:line" },
      ],
    });
    expect(result.issues.map((entry) => entry.code)).toEqual([
      "invalid-transform", "missing-resource", "resource-kind-mismatch", "invalid-color", "empty-paint",
    ]);
  });

  it("requires positive stroke, text and image sizes and existing typed resources", () => {
    const result = validateDeep2dDisplayList({
      ...list,
      commands: [
        { kind: "path", id: "draw:a", zOrder: 0, transform: identity, pathId: "series:line", stroke: [1, 1, 1, 1], strokeWidth: 0 },
        { kind: "text", id: "draw:b", zOrder: 1, transform: identity, text: "x", x: 0, y: 0, fontId: "series:line", fontSize: -1, color: [1, 1, 1, 1] },
        { kind: "image", id: "draw:c", zOrder: 2, transform: identity, imageId: "missing", x: 0, y: 0, width: 0, height: 1 },
      ],
    });
    expect(result.issues.map((entry) => entry.code)).toEqual([
      "invalid-number", "resource-kind-mismatch", "invalid-number", "missing-resource", "invalid-number",
    ]);
  });

  it("validates exact path verb shapes and subpath grammar", () => {
    const resources = [
      ...list.resources.slice(1),
      { kind: "path", id: "bad:missing", revision: 0, verbs: [{ op: "move", x: 0 }] },
      { kind: "path", id: "bad:first", revision: 0, verbs: [{ op: "line", x: 0, y: 1 }] },
      { kind: "path", id: "bad:close", revision: 0, verbs: [{ op: "move", x: 0, y: 0 }, { op: "close", x: 1 }] },
    ];
    const result = validateDeep2dDisplayList({ ...list, resources, commands: [] });
    expect(result.issues.map((entry) => [entry.code, entry.path])).toEqual([
      ["invalid-path", "resources[2].verbs[0]"],
      ["invalid-path", "resources[3].verbs[0]"],
      ["invalid-structure", "resources[4].verbs[1].x"],
    ]);
  });

  it("rejects malformed runtime values without throwing", () => {
    const malformed = {
      ...list,
      extra: true,
      resources: [
        { kind: "font", id: "font:a", revision: 0, assetId: "asset:a", family: 42, weight: 450, style: "oblique" },
        { kind: "image", id: "image:a", revision: 0, assetId: "asset:a", width: 0.5, height: 1, colorSpace: "display-p3" },
      ],
      commands: [{ kind: "text", id: "draw:a", zOrder: 2 ** 31, transform: identity, text: "\ud800", x: Infinity, y: 0, fontId: "font:a", fontSize: 12, color: [1, 1, 1, 1], align: "left" }],
    };
    expect(() => validateDeep2dDisplayList(malformed)).not.toThrow();
    expect(validateDeep2dDisplayList(malformed).valid).toBe(false);
    expect(() => validateDeep2dDisplayList({ ...list, resources: [{ kind: Symbol("path") }], commands: [{ kind: Symbol("text") }] })).not.toThrow();
  });

  it("bounds clip and dash arrays before traversing their contents", () => {
    const result = validateDeep2dDisplayList({
      ...list,
      commands: [{
        kind: "path", id: "draw:bounded", zOrder: 0, transform: identity, pathId: "series:line", stroke: [1, 1, 1, 1], strokeWidth: 1,
        clipPathIds: Array(DEEP_2D_DISPLAY_LIST_BUDGETS.clipsPerCommand + 1).fill("missing"),
        dash: Array(DEEP_2D_DISPLAY_LIST_BUDGETS.dashEntries + 1).fill(1),
      }],
    });
    expect(result.issues.map((entry) => entry.code)).toEqual(["budget-exceeded", "invalid-number"]);
  });

  it("rejects stroke-only options without a stroke and invalid style enums", () => {
    const result = validateDeep2dDisplayList({
      ...list,
      commands: [{ kind: "path", id: "draw:style", zOrder: 0, transform: identity, pathId: "series:line", fill: [1, 1, 1, 1], lineCap: "flat", dashOffset: 2 }],
    });
    expect(result.issues.map((entry) => entry.code)).toEqual(["invalid-structure", "invalid-structure"]);
  });

  it("rejects sparse arrays and objects that would change across a JSON boundary", () => {
    const sparseColor = Array(4); sparseColor[3] = 1;
    const sparseMatrix = Array(6); sparseMatrix[0] = 1; sparseMatrix[3] = 1;
    const inheritedCommand = Object.create({ kind: "image", id: "draw:inherited", zOrder: 0, transform: identity, imageId: "image:logo", x: 0, y: 0, width: 1, height: 1 });
    const result = validateDeep2dDisplayList({
      ...list,
      commands: [
        { kind: "text", id: "draw:sparse-color", zOrder: 0, transform: identity, text: "x", x: 0, y: 0, fontId: "font:ui", fontSize: 12, color: sparseColor },
        { kind: "image", id: "draw:sparse-matrix", zOrder: 0, transform: sparseMatrix, imageId: "image:logo", x: 0, y: 0, width: 1, height: 1 },
        inheritedCommand,
      ],
    });
    expect(result.issues.map((entry) => entry.code)).toEqual(["invalid-color", "invalid-transform", "invalid-structure"]);
  });
});

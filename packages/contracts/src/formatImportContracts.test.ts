import { describe, expect, it } from "vitest";
import {
  assertCoordinateFrameV1,
  assertImportRecipe,
  assertQualityReport,
  assertSourceBundleRecord,
  SCENE_LOCAL_COORDINATE_PROFILE_V1,
  type ImportRecipe,
  type QualityReport,
  type SourceBundleRecord,
} from "./formatImportContracts.js";

const hash = "a".repeat(64);

/** exactOptionalPropertyTypes 下显式抹掉可选字段需要允许 undefined 的 overrides 类型。 */
type Overrides<T> = { [K in keyof T]?: T[K] | undefined };

function sourceBundle(overrides: Overrides<SourceBundleRecord> = {}): SourceBundleRecord {
  return { schemaVersion: 1, sourceName: "pump-house-sample", sourceFormat: "jt", contentHash: hash,
    bundledPath: "samples/jt/pump-house.jt", licenseReference: "LicenseRef-Internal-Corpus", ...overrides };
}

function importRecipe(overrides: Partial<ImportRecipe> = {}): ImportRecipe {
  return { schemaVersion: 1, sourceFormat: "jt",
    targetVariant: { container: "glb", variantId: "lod0" },
    unitPolicy: { sourceUnit: "millimeter", scaleToTarget: 1 },
    coordinatePolicy: { sourceUpAxis: "z", sourceHandedness: "right-handed", targetProfile: SCENE_LOCAL_COORDINATE_PROFILE_V1.id },
    decimation: { rule: "none" },
    steps: [{ index: 1, name: "decode", command: "worker jt-decode --profile jt-9.5-tristrip" }], ...overrides };
}

function qualityReport(overrides: Partial<QualityReport> = {}): QualityReport {
  return { schemaVersion: 1,
    counters: { inputPoints: 0, inputTriangles: 1200, droppedPoints: 0, droppedTriangles: 12 },
    decimation: { rule: "none", inputTriangles: 1200, outputTriangles: 1200 },
    warnings: ["缺失材质引用 12 处"], ...overrides };
}

describe("SourceBundleRecord v1", () => {
  it("accepts an uri-based bundle and a bundled-path bundle", () => {
    expect(() => assertSourceBundleRecord(sourceBundle())).not.toThrow();
    expect(() => assertSourceBundleRecord(sourceBundle({ bundledPath: undefined,
      sourceUri: "https://corpus.example/jt/pump-house.jt" }))).not.toThrow();
  });
  it("rejects unknown fields, bad hashes and invalid formats", () => {
    expect(() => assertSourceBundleRecord({ ...sourceBundle(), future: true })).toThrow("未知字段");
    expect(() => assertSourceBundleRecord(sourceBundle({ contentHash: hash.toUpperCase() }))).toThrow("SHA-256");
    expect(() => assertSourceBundleRecord(sourceBundle({ contentHash: "a".repeat(63) }))).toThrow("SHA-256");
    expect(() => assertSourceBundleRecord(sourceBundle({ contentHash: `sha256-${hash}` }))).toThrow("SHA-256");
    expect(() => assertSourceBundleRecord(sourceBundle({ sourceFormat: "step" }))).toThrow("来源格式");
  });
  it("requires a source location and a license reference", () => {
    expect(() => assertSourceBundleRecord(sourceBundle({ bundledPath: undefined }))).toThrow("sourceUri 或 bundledPath");
    expect(() => assertSourceBundleRecord(sourceBundle({ bundledPath: "/abs/pump-house.jt" }))).toThrow("相对路径");
    expect(() => assertSourceBundleRecord(sourceBundle({ bundledPath: "../escape.jt" }))).toThrow("相对路径");
    expect(() => assertSourceBundleRecord(sourceBundle({ licenseReference: "" }))).toThrow("许可标识");
  });
});

describe("ImportRecipe v1", () => {
  it("accepts a declarative recipe with reproducible steps", () => {
    expect(() => assertImportRecipe(importRecipe())).not.toThrow();
    expect(() => assertImportRecipe(importRecipe({
      decimation: { rule: "triangle-budget", maxTriangles: 500000 },
      steps: [ { index: 1, name: "decode", command: "worker jt-decode" }, { index: 2, name: "simplify", command: "worker simplify --budget 500000" } ],
    }))).not.toThrow();
  });
  it("rejects unknown fields, invalid enums and non-positive scale", () => {
    expect(() => assertImportRecipe({ ...importRecipe(), future: true })).toThrow("未知字段");
    expect(() => assertImportRecipe(importRecipe({ sourceFormat: "step" }))).toThrow("来源格式");
    expect(() => assertImportRecipe(importRecipe({ decimation: { rule: "vertex-clustering" } }))).toThrow("decimation rule");
    expect(() => assertImportRecipe(importRecipe({ decimation: { rule: "triangle-budget" } }))).toThrow("maxTriangles");
    expect(() => assertImportRecipe(importRecipe({ decimation: { rule: "none", maxTriangles: 10 } }))).toThrow("maxTriangles");
    expect(() => assertImportRecipe(importRecipe({ unitPolicy: { sourceUnit: "millimeter", scaleToTarget: 0 } }))).toThrow("正有限数");
    expect(() => assertImportRecipe(importRecipe({ targetVariant: { container: "usdz", variantId: "lod0" } }))).toThrow("glb");
    expect(() => assertImportRecipe(importRecipe({ coordinatePolicy: { sourceUpAxis: "x", sourceHandedness: "right-handed",
      targetProfile: SCENE_LOCAL_COORDINATE_PROFILE_V1.id } }))).toThrow("sourceUpAxis");
    expect(() => assertImportRecipe(importRecipe({ coordinatePolicy: { sourceUpAxis: "z", sourceHandedness: "right-handed",
      targetProfile: "scene-local-coordinates-v2" } }))).toThrow("targetProfile");
  });
  it("requires continuous step indexes and non-empty commands", () => {
    expect(() => assertImportRecipe(importRecipe({ steps: [] }))).toThrow("至少一个步骤");
    expect(() => assertImportRecipe(importRecipe({ steps: [ { index: 2, name: "decode", command: "worker" } ] }))).toThrow("从 1 连续递增");
    expect(() => assertImportRecipe(importRecipe({ steps: [ { index: 1, name: "decode", command: "" } ] }))).toThrow("可复现命令");
  });
});

describe("CoordinateFrameV1", () => {
  it("accepts the scene-local frame shared with delivery code", () => {
    const frame = { schemaVersion: 1 as const, profile: SCENE_LOCAL_COORDINATE_PROFILE_V1, origin: { x: 1000, y: -0, z: 0 } };
    expect(() => assertCoordinateFrameV1(frame)).not.toThrow();
    expect(() => assertCoordinateFrameV1(JSON.parse(JSON.stringify(frame)))).not.toThrow();
  });
  it("rejects loosened profiles, off-grid origins and unknown fields", () => {
    const base = { schemaVersion: 1, profile: SCENE_LOCAL_COORDINATE_PROFILE_V1, origin: { x: 1000, y: 0, z: 0 } };
    expect(() => assertCoordinateFrameV1({ ...base, profile: { ...SCENE_LOCAL_COORDINATE_PROFILE_V1, originGrid: 500 } })).toThrow("profile.originGrid");
    expect(() => assertCoordinateFrameV1({ ...base, profile: { ...SCENE_LOCAL_COORDINATE_PROFILE_V1, id: "scene-local-coordinates-v2" } })).toThrow("profile.id");
    expect(() => assertCoordinateFrameV1({ ...base, profile: { ...SCENE_LOCAL_COORDINATE_PROFILE_V1, unknownTolerance: 1 } })).toThrow("profile 包含未知字段");
    expect(() => assertCoordinateFrameV1({ ...base, origin: { x: 1234, y: 0, z: 0 } })).toThrow("网格");
    expect(() => assertCoordinateFrameV1({ ...base, origin: { x: Number.NaN, y: 0, z: 0 } })).toThrow("有限数值");
    expect(() => assertCoordinateFrameV1({ ...base, future: true })).toThrow("未知字段");
  });
});

describe("QualityReport v1", () => {
  it("accepts none-rule and decimated reports consistent with counters", () => {
    expect(() => assertQualityReport(qualityReport())).not.toThrow();
    expect(() => assertQualityReport(qualityReport({
      counters: { inputPoints: 4000000, inputTriangles: 0, droppedPoints: 1200, droppedTriangles: 0 },
      decimation: { rule: "equal-stride-first-last", inputTriangles: 0, outputTriangles: 0 },
    }))).not.toThrow();
  });
  it("rejects rule drift and arithmetic contradictions", () => {
    expect(() => assertQualityReport(qualityReport({ decimation: { rule: "vertex-clustering", inputTriangles: 1200, outputTriangles: 600 } }))).toThrow("decimation rule");
    expect(() => assertQualityReport(qualityReport({ counters: { inputPoints: 10, inputTriangles: 1200, droppedPoints: 11, droppedTriangles: 0 } }))).toThrow("丢弃点数");
    expect(() => assertQualityReport(qualityReport({ counters: { inputPoints: 0, inputTriangles: 1200, droppedPoints: 0, droppedTriangles: 1201 } }))).toThrow("丢弃三角数");
    expect(() => assertQualityReport(qualityReport({ decimation: { rule: "triangle-budget", inputTriangles: 1000, outputTriangles: 600 } }))).toThrow("counters.inputTriangles 一致");
    expect(() => assertQualityReport(qualityReport({ decimation: { rule: "triangle-budget", inputTriangles: 1200, outputTriangles: 1300 } }))).toThrow("不能超过");
    expect(() => assertQualityReport(qualityReport({ decimation: { rule: "none", inputTriangles: 1200, outputTriangles: 600 } }))).toThrow("不得改变三角数");
    expect(() => assertQualityReport(qualityReport({ counters: { inputPoints: -1, inputTriangles: 0, droppedPoints: 0, droppedTriangles: 0 } }))).toThrow("非负整数");
    expect(() => assertQualityReport(qualityReport({ warnings: [""] }))).toThrow("非空字符串");
    expect(() => assertQualityReport({ ...qualityReport(), future: true })).toThrow("未知字段");
  });
});

import { describe, expect, it } from "vitest";
import { PARAMETRIC_CAD_TEMPLATES } from "@bim-studio/parametric-modeling-plugin";
import type { ModelRecord } from "@bim-studio/contracts";
import { assertParametricModelLineage, parseParametricModelGeneration } from "./parametricModelMetadata.js";

const generation = () => ({
  kind: "parametric", generatorId: "bim.parametric-modeling", generatorVersion: "1.0.0",
  definition: PARAMETRIC_CAD_TEMPLATES[0]!.definition, revision: 1, generatedAt: "2026-08-28T00:00:00.000Z",
  build: { durationMs: 120, volumeMm3: 100, faceCount: 6, edgeCount: 12, triangleCount: 24, bounds: [[0, 0, 0], [10, 10, 10]], warnings: [] }
});

describe("parametric model metadata", () => {
  it("parses the strict multipart generation record", () => {
    expect(parseParametricModelGeneration({ value: JSON.stringify(generation()) })).toMatchObject({ kind: "parametric", revision: 1, definition: { name: "设备安装板" } });
  });

  it("rejects unknown audit fields and invalid definitions", () => {
    expect(() => parseParametricModelGeneration(JSON.stringify({ ...generation(), debug: true }))).toThrow("未知字段");
    const invalid = generation();
    invalid.definition = { ...invalid.definition, schemaVersion: 2 as 1 };
    expect(() => parseParametricModelGeneration(JSON.stringify(invalid))).toThrow("schemaVersion");
  });

  it("keeps revisions connected to an immutable previous asset", () => {
    const previousGeneration = parseParametricModelGeneration(JSON.stringify(generation()))!;
    const previous = { id: "model-v1", generation: previousGeneration } as ModelRecord;
    const next = { ...previousGeneration, revision: 2, supersedesModelId: previous.id };
    expect(() => assertParametricModelLineage(next, [previous])).not.toThrow();
    expect(() => assertParametricModelLineage({ ...next, revision: 3 }, [previous])).toThrow("必须为 2");
    expect(() => assertParametricModelLineage({ ...next, supersedesModelId: "missing" }, [previous])).toThrow("上一版本不存在");
    expect(() => assertParametricModelLineage({ ...previousGeneration, revision: 2 }, [])).toThrow("从 1 开始");
  });
});

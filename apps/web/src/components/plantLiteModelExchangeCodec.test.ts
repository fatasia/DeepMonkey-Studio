import { describe, expect, it } from "vitest";
import { createAgvLinePlantLiteModel } from "@bim-studio/plant-lite-simulation";
import { createDefaultPlantLiteRequest } from "./plantLiteModelEditing";
import {
  PLANT_LITE_MODEL_EXCHANGE_SCHEMA,
  PLANT_LITE_MODEL_IMPORT_MAX_BYTES,
  applyPlantLiteModelImport,
  createPlantLiteModelExchange,
  parsePlantLiteModelExchange,
  plantLiteModelExchangeFileName,
  serializePlantLiteModelExchange,
} from "./plantLiteModelExchangeCodec";

describe("Plant Lite model exchange", () => {
  it("exports only the versioned portable model and explicit source/unit declarations", () => {
    const model = createAgvLinePlantLiteModel() as ReturnType<typeof createAgvLinePlantLiteModel> & Record<string, unknown>;
    model.apiKey = "must-not-leak";
    Object.assign(model.nodes[0]!, { credential: "node-secret" });
    Object.assign(model.nodes.find((node) => node.kind === "station") ?? {}, { yieldRate: 0.97 });
    Object.assign(model.resources?.[0] ?? {}, { accessToken: "resource-secret" });

    const exchange = createPlantLiteModelExchange(model);
    const text = serializePlantLiteModelExchange(exchange);

    expect(exchange).toMatchObject({
      schema: PLANT_LITE_MODEL_EXCHANGE_SCHEMA,
      version: 1,
      source: { application: "Industrial Studio", kind: "authoring-draft" },
      units: {
        time: "minute",
        power: "kilowatt",
        energy: "kilowatt-hour",
        electricityPrice: "CNY-per-kilowatt-hour",
        carbonEmissionFactor: "kilogram-co2e-per-kilowatt-hour",
      },
    });
    expect(Object.keys(exchange).sort()).toEqual(["model", "schema", "source", "units", "version"]);
    expect(text).not.toContain("must-not-leak");
    expect(text).not.toContain("node-secret");
    expect(text).not.toContain("resource-secret");
    expect(text).toContain('"yieldRate": 0.97');
    expect(text.endsWith("\n")).toBe(true);
  });

  it("parses and validates a compatible file before exposing an import preview", () => {
    const model = createAgvLinePlantLiteModel({ agvCount: 3 });
    Object.assign(model.nodes.find((node) => node.kind === "station") ?? {}, { yieldRate: 0.985 });
    model.resources?.push({
      id: "shared-workers",
      name: "共享装配班组",
      kind: "worker",
      capacity: 5,
      availability: { shifts: [{ startMinute: 360, endMinute: 840 }] },
    });
    const station = model.nodes.find((node) => node.kind === "station");
    if (!station || station.kind !== "station") throw new Error("missing station fixture");
    station.workerResourceId = "shared-workers";
    const result = parsePlantLiteModelExchange(
      serializePlantLiteModelExchange(createPlantLiteModelExchange(model)),
      "line.plant-lite.json",
    );

    expect(result).toMatchObject({
      status: "ready",
      preview: {
        fileName: "line.plant-lite.json",
        sourceApplication: "Industrial Studio",
        nodeCount: model.nodes.length,
        resourceCount: 2,
        resourceUnitCount: 8,
        model: { id: model.id, name: model.name },
      },
    });
    if (result.status === "ready") {
      expect(result.preview.model.nodes.find((node) => node.kind === "station")).toMatchObject({ yieldRate: 0.985 });
      expect(result.preview.model.nodes.find((node) => node.kind === "station")).toMatchObject({ workerResourceId: "shared-workers" });
      expect(result.preview.model.resources).toContainEqual(expect.objectContaining({ id: "shared-workers", kind: "worker", capacity: 5 }));
    }
  });

  it("reports JSON, version, unit and model validation errors without producing a draft", () => {
    expect(parsePlantLiteModelExchange("{", "broken.json")).toEqual({
      status: "invalid",
      fileName: "broken.json",
      issues: ["不是有效的 JSON 文件"],
    });

    const wrongEnvelope = createPlantLiteModelExchange(createAgvLinePlantLiteModel()) as unknown as Record<string, unknown>;
    wrongEnvelope.version = 2;
    wrongEnvelope.units = { ...(wrongEnvelope.units as object), time: "second" };
    const incompatible = parsePlantLiteModelExchange(JSON.stringify(wrongEnvelope), "future.json");
    expect(incompatible.status).toBe("invalid");
    if (incompatible.status === "invalid") {
      expect(incompatible.issues).toContain("模型文件版本不受支持，当前仅支持 v1");
      expect(incompatible.issues).toContain("单位声明 time 必须为 minute");
    }

    const invalidModel = createPlantLiteModelExchange(createAgvLinePlantLiteModel()) as unknown as Record<string, unknown>;
    (invalidModel.model as { nodes: unknown[] }).nodes = [];
    const rejected = parsePlantLiteModelExchange(JSON.stringify(invalidModel), "empty-line.json");
    expect(rejected.status).toBe("invalid");
    if (rejected.status === "invalid") expect(rejected.issues.join(" ")).toContain("$.nodes：必须包含至少一个节点");
  });

  it("rejects oversized files before parsing", () => {
    const result = parsePlantLiteModelExchange("x".repeat(PLANT_LITE_MODEL_IMPORT_MAX_BYTES + 1), "huge.json");
    expect(result).toEqual({ status: "invalid", fileName: "huge.json", issues: ["文件超过 2 MB 上限"] });
  });

  it("replaces only the model while preserving every Study run and decision condition", () => {
    const request = {
      ...createDefaultPlantLiteRequest(),
      name: "现有 Study 名称",
      seed: "fixed-seed",
      replications: 18,
      limits: { durationMinutes: 1_440, warmupMinutes: 120, maxEvents: 90_000, maxResources: 250 },
      trace: { replication: 2, maxEvents: 4_000, maxItems: 800 },
      acceptanceTargets: { basis: "产能协议", minimumThroughputPerHour: 58 },
      comparison: { groupId: "group", baselineStudyId: "base", parameterLabel: "布局", candidateLabel: "方案 B" },
      agvCount: 9,
      bufferCapacity: 99,
    };
    const imported = createAgvLinePlantLiteModel({ agvCount: 2, bufferCapacity: 6 });
    imported.id = "imported-model";
    imported.name = "导入产线";

    const next = applyPlantLiteModelImport(request, imported);

    expect(next).toMatchObject({
      name: request.name,
      seed: request.seed,
      replications: request.replications,
      limits: request.limits,
      trace: request.trace,
      acceptanceTargets: request.acceptanceTargets,
      comparison: request.comparison,
      templateId: "agv-line-v1",
      model: { id: "imported-model", name: "导入产线" },
    });
    expect(next.agvCount).toBeUndefined();
    expect(next.bufferCapacity).toBeUndefined();
  });

  it("creates an operating-system-safe model filename", () => {
    const model = createAgvLinePlantLiteModel();
    model.name = "A/B:*? 产线.";
    expect(plantLiteModelExchangeFileName(model)).toBe("A-B- 产线.plant-lite.json");
  });
});

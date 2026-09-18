import { assessBatteryDataContract, type DataDatasetRecord } from "@bim-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api";
import { batteryExampleById } from "../ai/batterySample";
import { BATTERY_RUN_POLICIES } from "./batteryIntelligenceConfig";
import { executeSingleBatteryPrediction } from "./batteryPredictionExecution";

vi.mock("../api", () => ({ api: {
  saveAiDataBinding: vi.fn(),
  predictBatteryFromFile: vi.fn(),
  predictBatteryFromDataset: vi.fn(),
} }));

function input(signal = new AbortController().signal): Parameters<typeof executeSingleBatteryPrediction>[0] {
  const example = batteryExampleById("lfp-engineering");
  return {
    projectId: "project-1", sourceMode: "file", selectedExample: example,
    sourceFile: new File(["cycle,capacity\n1,100"], "battery.csv"), datasetId: "data-1",
    nominalCapacity: "100", chemistry: "lfp", targetRetention: "80", dynamicRouting: false,
    selectedTask: { id: "soh", model: "bmsformer", label: "SOH" }, selectedDataset: undefined,
    bindings: [], runPolicy: BATTERY_RUN_POLICIES.soh,
    dataContract: assessBatteryDataContract("bmsformer", example.headers.map(key => ({ key }))), signal,
  };
}

describe("single battery prediction execution", () => {
  beforeEach(() => vi.resetAllMocks());

  it("returns validated structured output with request evidence intact", async () => {
    const output = { soh: 0.95 };
    vi.mocked(api.predictBatteryFromFile).mockResolvedValue({ output, requestId: "request-1" } as never);
    const result = await executeSingleBatteryPrediction(input());
    expect(result.response.output).toBe(output);
    expect(result.response.requestId).toBe("request-1");
    expect(result.bindingCreated).toBe(false);
  });

  it.each([
    [{ requestId: "empty" }, "模型没有返回结构化结果"],
    [{ requestId: "failed", error: { message: "预测服务不可用" } }, "预测服务不可用"],
  ])("rejects an absent output instead of publishing evidence", async (response, message) => {
    vi.mocked(api.predictBatteryFromFile).mockResolvedValue(response as never);
    await expect(executeSingleBatteryPrediction(input())).rejects.toThrow(message);
  });

  it("does not start work after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(executeSingleBatteryPrediction(input(controller.signal))).rejects.toMatchObject({ name: "AbortError" });
    expect(api.predictBatteryFromFile).not.toHaveBeenCalled();
    expect(api.saveAiDataBinding).not.toHaveBeenCalled();
  });

  it("does not launch a dataset prediction when cancelled during binding save", async () => {
    const controller = new AbortController();
    const args = input(controller.signal);
    args.sourceMode = "dataset";
    args.selectedDataset = { id: "data-1", name: "Battery" } as DataDatasetRecord;
    vi.mocked(api.saveAiDataBinding).mockImplementation(async () => {
      controller.abort();
      return { id: "binding-1" } as never;
    });
    await expect(executeSingleBatteryPrediction(args)).rejects.toMatchObject({ name: "AbortError" });
    expect(api.predictBatteryFromDataset).not.toHaveBeenCalled();
  });
});

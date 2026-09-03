import type { PlantLiteStudyRequest } from "@bim-studio/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  executePlantLiteBatch,
  isPlantLiteCancellation,
  plantLiteRunProgressLabel,
} from "./plantLiteRunController";

describe("Plant Lite run orchestration", () => {
  it("reports compact single and batch progress copy", () => {
    expect(plantLiteRunProgressLabel({ kind: "single", phase: "running", current: 1, total: 1, saved: 0 })).toBe("仿真运行中");
    expect(plantLiteRunProgressLabel({ kind: "reproduce", phase: "cancelling", current: 1, total: 1, saved: 0 })).toBe("正在取消复现");
    expect(plantLiteRunProgressLabel({ kind: "batch", phase: "running", current: 3, total: 4, saved: 2 })).toBe("运行 3/4 · 已保存 2");
    expect(plantLiteRunProgressLabel({ kind: "batch", phase: "refreshing", current: 4, total: 4, saved: 3 })).toBe("刷新结果 · 已保存 3/4");
  });

  it("keeps successful results when one batch candidate fails", async () => {
    const requests = [{ name: "基线" }, { name: "失败候选" }, { name: "扩容候选" }] as PlantLiteStudyRequest[];
    const progress = vi.fn();
    const result = await executePlantLiteBatch({
      requests,
      signal: new AbortController().signal,
      run: async (request) => {
        if (request.name === "失败候选") throw new Error("服务暂时不可用");
      },
      onProgress: progress,
    });

    expect(result).toEqual({
      total: 3,
      current: 3,
      saved: 2,
      cancelled: false,
      failures: [{ name: "失败候选", message: "服务暂时不可用" }],
    });
    expect(progress).toHaveBeenLastCalledWith({ current: 3, total: 3, saved: 2 });
  });

  it("cancels the current request and never starts the remaining queue", async () => {
    const controller = new AbortController();
    const calls: string[] = [];
    const requests = [{ name: "已完成" }, { name: "当前请求" }, { name: "不应启动" }] as PlantLiteStudyRequest[];
    const result = await executePlantLiteBatch({
      requests,
      signal: controller.signal,
      run: async (request) => {
        calls.push(request.name ?? "");
        if (request.name === "当前请求") {
          controller.abort();
          throw new DOMException("cancelled", "AbortError");
        }
      },
    });

    expect(calls).toEqual(["已完成", "当前请求"]);
    expect(result).toEqual({ total: 3, current: 2, saved: 1, cancelled: true, failures: [] });
    expect(isPlantLiteCancellation(new Error("network"), controller.signal)).toBe(true);
  });
});

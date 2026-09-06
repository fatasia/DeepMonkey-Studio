import { describe, expect, it, vi } from "vitest";
import { getSdkExample } from "./sdkExamples";

function instantiate(id: string, value?: unknown) {
  const example = getSdkExample(id)!;
  const studio = { version: "1.0", log: vi.fn(), getData: vi.fn(() => value) };
  const lifecycle = new Function("studio", `${example.code}; return { ${example.lifecycle.join(",")} };`)(studio) as Record<string, (ctx?: unknown) => void>;
  return { lifecycle, studio };
}

describe("SDK runnable source", () => {
  it("logs current context at start and keeps disposal free of side effects", () => {
    const { lifecycle, studio } = instantiate("lifecycle");
    lifecycle.onStart!({ sceneId: "scene-1" });
    lifecycle.onDispose!();
    expect(studio.log.mock.calls).toEqual([["SDK 样例已启动", { apiVersion: "1.0", sceneId: "scene-1" }]]);
  });

  it.each([undefined, null, ""])("reports missing input %j without inventing a reading", value => {
    const { lifecycle, studio } = instantiate("read-variable", value);
    lifecycle.onStart!();
    expect(studio.log).toHaveBeenCalledWith("变量尚无数据", { dataKey: "device.temperature" });
  });

  it.each([false, {}, [], " ", "bad", Infinity, NaN])("rejects non-numeric input %j", value => {
    const { lifecycle, studio } = instantiate("read-variable", value);
    lifecycle.onData!();
    expect(studio.log).toHaveBeenCalledWith("变量不是有效数值", { dataKey: "device.temperature" });
  });

  it.each([[0, false], [80, false], [80.1, true], ["81.5", true]])("reads number %j and threshold state %j", (value, aboveThreshold) => {
    const { lifecycle, studio } = instantiate("read-variable", value);
    lifecycle.onData!();
    expect(studio.getData).toHaveBeenCalledExactlyOnceWith("device.temperature");
    expect(studio.log).toHaveBeenCalledWith("变量读取结果", { dataKey: "device.temperature", value: Number(value), threshold: 80, aboveThreshold });
  });

  it("ignores unrelated events and safely logs missing/available click targets", () => {
    const { lifecycle, studio } = instantiate("scene-events");
    lifecycle.onStart!();
    studio.log.mockClear();
    lifecycle.onEvent!({});
    lifecycle.onEvent!({ event: { name: "pointermove" } });
    expect(studio.log).not.toHaveBeenCalled();
    lifecycle.onEvent!({ event: { name: "click" } });
    lifecycle.onEvent!({ event: { name: "click", target: { kind: "object", objectId: "object-1", sceneId: "scene-1" } } });
    expect(studio.log.mock.calls).toEqual([
      ["收到场景事件", { name: "click", target: null }],
      ["收到场景事件", { name: "click", target: { kind: "object", objectId: "object-1", sceneId: "scene-1" } }],
    ]);
  });
});

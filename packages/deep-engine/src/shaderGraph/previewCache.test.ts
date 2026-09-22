import { describe, expect, it } from "vitest";
import type { ShaderGraphAssetV1 } from "./graphTypes.js";
import { ShaderGraphPreviewCache } from "./previewCache.js";

function graph(op: "literal" | "normalize" = "literal"): ShaderGraphAssetV1 {
  return { schemaVersion: 1, id: "preview", target: "webgpu-forward", properties: [],
    stages: [{ stage: "vertex", nodes: [{ id: "value", op, type: "f32", config: { value: 1 } }],
      edges: [], outputs: [] }] };
}

describe("预览降级结果缓存", () => {
  it("复用相同图，不重复推进代次", () => {
    const cache = new ShaderGraphPreviewCache();
    const first = cache.prepare(graph());
    expect(first.status).toBe("committed");
    expect(cache.prepare(graph())).toMatchObject({ status: "reused", current: { generation: 1 } });
  });
  it("缺少输入导致降级异常时保留上一份结果", () => {
    const cache = new ShaderGraphPreviewCache();
    cache.prepare(graph());
    const previous = cache.current;
    const failed = cache.prepare(graph("normalize"));
    expect(failed.status).toBe("failed");
    expect(failed.candidate.diagnostics[0]?.message).toContain("expects 1 inputs");
    expect(cache.current).toBe(previous);
  });
  it("首次失败不创建成功快照，清理后不复用旧结果", () => {
    const cache = new ShaderGraphPreviewCache();
    expect(cache.prepare(graph("normalize")).status).toBe("failed");
    expect(cache.current).toBeUndefined();
    cache.prepare(graph());
    cache.clear();
    expect(cache.current).toBeUndefined();
    expect(cache.prepare(graph())).toMatchObject({ status: "committed", current: { generation: 2 } });
  });
});

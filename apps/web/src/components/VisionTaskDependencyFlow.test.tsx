import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VisionModelRecord, VisionSourceRecord, VisionTaskRecord } from "@bim-studio/contracts";
import { VisionTaskDependencyFlow } from "./VisionTaskDependencyFlow";

const task = {
  id: "task-1",
  name: "产线安全帽识别",
  mode: "video",
  sourceId: "source-1",
  modelId: "model-1",
  binding: { sceneId: "scene-1", objectIds: ["camera-1", "line-1"], actions: ["highlight"] },
} as VisionTaskRecord;

describe("VisionTaskDependencyFlow", () => {
  it("shows the real input, model and scene output dependency", () => {
    const html = renderToStaticMarkup(
      <VisionTaskDependencyFlow
        task={task}
        sources={[{ id: "source-1", name: "装配线相机 A" } as VisionSourceRecord]}
        models={[{ id: "model-1", name: "PPE 检测模型" } as VisionModelRecord]}
        locale="zh-CN"
      />,
    );

    expect(html).toContain("任务处理链");
    expect(html).toContain("装配线相机 A");
    expect(html).toContain("PPE 检测模型");
    expect(html).toContain("2 个场景对象");
  });

  it("marks a video task without a source as needing input", () => {
    const { sourceId: _sourceId, ...taskWithoutSource } = task;
    const html = renderToStaticMarkup(
      <VisionTaskDependencyFlow task={taskWithoutSource} sources={[]} models={[]} locale="zh-CN" />,
    );

    expect(html).toContain("needs-input");
    expect(html).toContain("未连接视觉源");
  });
});

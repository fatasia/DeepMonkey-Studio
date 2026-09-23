import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { SceneProbeGridBakePanel, validateProbeGridInputs } from "./SceneProbeGridBakePanel";

function render(state: Parameters<typeof SceneProbeGridBakePanel>[0]["state"], disabled = false) {
  return renderToStaticMarkup(<SceneProbeGridBakePanel
    locale="zh-CN" state={state} disabled={disabled} onBake={vi.fn()} />);
}

describe("SceneProbeGridBakePanel", () => {
  it("idle 态渲染参数输入与烘焙动作，无进度/结果", () => {
    const html = render({ kind: "idle" });
    expect(html).toContain("GI 烘焙");
    expect(html).toContain("烘焙探针网格");
    expect(html).toContain("网格原点X");
    expect(html).toContain("探针间距（世界单位）");
    expect(html).toContain("网格数量Z");
    expect(html).toContain('value="4"');
    expect(html).not.toContain("role=\"status\"");
  });

  it("running 态禁用动作并显示阶段进度", () => {
    const html = render({ kind: "running", phase: "capture" });
    expect(html).toContain("正在 GPU 捕获探针辐射");
    expect(html).toContain("disabled");
    expect(html).toContain("role=\"status\"");
  });

  it("done 态显示探针数与覆盖率摘要", () => {
    const html = render({ kind: "done", probeCount: 64, coveredCount: 60, coverage: 60 / 64 });
    expect(html).toContain("探针 64 · 覆盖 60/64（94%）· Deep Native 打包将携带");
  });

  it("error 态以 alert 呈现失败原因", () => {
    const html = render({ kind: "error", message: "当前浏览器不支持 WebGPU" });
    expect(html).toContain("role=\"alert\"");
    expect(html).toContain("当前浏览器不支持 WebGPU");
  });

  it("外部 disabled（GI 关闭）同样禁用动作", () => {
    expect(render({ kind: "idle" }, true)).toContain("disabled");
  });
});

describe("validateProbeGridInputs（客户端预检；服务侧另有 fail-closed 校验）", () => {
  const valid: [string, string, string] = ["0", "0", "0"];
  it("合法输入通过", () => {
    expect(validateProbeGridInputs(valid, "4", ["4", "4", "4"])).toBeUndefined();
    expect(validateProbeGridInputs(["-12.5", "0", "3e2"], "0.5", ["2", "64", "8"])).toBeUndefined();
  });
  it("原点非有限/超界拒绝", () => {
    expect(validateProbeGridInputs(["abc", "0", "0"], "4", ["4", "4", "4"])).toContain("原点");
    expect(validateProbeGridInputs(["1e10", "0", "0"], "4", ["4", "4", "4"])).toContain("超出范围");
  });
  it("间距必须为正", () => {
    expect(validateProbeGridInputs(valid, "0", ["4", "4", "4"])).toContain("间距");
    expect(validateProbeGridInputs(valid, "-1", ["4", "4", "4"])).toContain("间距");
  });
  it("网格数量每轴 2..64 整数（小数四舍五入后判）", () => {
    expect(validateProbeGridInputs(valid, "4", ["1", "4", "4"])).toContain("2..64");
    expect(validateProbeGridInputs(valid, "4", ["65", "4", "4"])).toContain("2..64");
    expect(validateProbeGridInputs(valid, "4", ["4.6", "4", "4"])).toBeUndefined();
  });
});

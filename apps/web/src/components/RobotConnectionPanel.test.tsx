import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RobotConnectionPanel } from "./RobotConnectionPanel";
describe("RobotConnectionPanel presentation", () => {
  it("starts disconnected, leaves command settings collapsed and never performs connection/pose side effects during render", () => {
    const onTelemetry = vi.fn(), onRestorePose = vi.fn(), readPose = vi.fn();
    const html = renderToStaticMarkup(<RobotConnectionPanel locale="zh-CN" modelId="robot" jointNames={["axis"]} onTelemetry={onTelemetry} onRestorePose={onRestorePose} readPose={readPose} />);
    expect(html).toContain("未连接"); expect(html).toContain("/joint_states"); expect(html).toContain("<details>"); expect(html).not.toContain("<details open");
    expect(html).toContain("启用本次姿态发送"); expect(html).toContain('checked=""/>跟随遥测');
    expect(html).not.toContain('checked=""/>启用本次姿态发送');
    expect(html).toContain("发送目标姿态"); expect(html).toContain("不代表设备接受或完成");
    for (const callback of [onTelemetry, onRestorePose, readPose]) expect(callback).not.toHaveBeenCalled();
  });
  it("provides English labels and disables connection for models with no controllable joints", () => {
    const html = renderToStaticMarkup(<RobotConnectionPanel locale="en-US" modelId="robot" jointNames={[]} onTelemetry={vi.fn()} onRestorePose={vi.fn()} readPose={() => ({})} />);
    expect(html).toContain("ROS connection"); expect(html).toContain("Not connected"); expect(html).toContain('disabled="">Connect'); expect(html).not.toContain("未连接");
  });
});

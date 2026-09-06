import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { robotDefinition } from "../viewer/robotPoseTestFixture";
import { RobotJointPreview, robotJointDisplay, robotJointSI } from "./RobotJointPreview";

describe("RobotJointPreview", () => {
  it("shows compact independent joint controls with explicit units and passive joints collapsed", () => {
    const html = renderToStaticMarkup(<RobotJointPreview locale="zh-CN" modelId="instance" onChange={vi.fn()} engine={{
      getRobotDefinition: () => robotDefinition(), getRobotPose: () => ({ turn: Math.PI / 2, hinge: .4, slide: .025 }), setRobotPose: vi.fn(),
    }} />);
    expect(html).toContain('aria-label="turn (°)"'); expect(html).toContain('value="90"');
    expect(html).toContain('aria-label="slide (m)"'); expect(html).toContain('value="0.025"');
    expect(html).toContain("固定与联动"); expect(html).toContain("零位"); expect(html).toContain("复位");
    expect(html).not.toContain('aria-label="follower'); expect(html).not.toContain("<svg");
    expect((html.match(/type="number"/g) ?? [])).toHaveLength(3);
  });
  it("disables authored controls and renders English without Chinese explanatory text", () => {
    const html = renderToStaticMarkup(<RobotJointPreview locale="en-US" modelId="instance" disabled onChange={vi.fn()} engine={{
      getRobotDefinition: () => robotDefinition(), getRobotPose: () => ({}), setRobotPose: vi.fn(),
    }} />);
    expect(html).toContain("Fixed &amp; mimic"); expect(html).toContain("This instance is not editable");
    expect((html.match(/disabled=""/g) ?? []).length).toBe(8);
  });
  it("explains telemetry-driven disabled state through tooltips only", () => {
    const html = renderToStaticMarkup(<RobotJointPreview locale="zh-CN" modelId="instance" disabled disabledReason="取消跟随遥测后可编辑" onChange={vi.fn()} engine={{
      getRobotDefinition: () => robotDefinition(), getRobotPose: () => ({}), setRobotPose: vi.fn(),
    }} />);
    expect((html.match(/title="取消跟随遥测后可编辑"/g) ?? [])).toHaveLength(8);
    expect(html).not.toContain(">取消跟随遥测后可编辑<");
  });
  it("returns nothing for normal model assets", () => {
    expect(renderToStaticMarkup(<RobotJointPreview locale="zh-CN" modelId="normal" onChange={vi.fn()} engine={{
      getRobotDefinition: () => undefined, getRobotPose: () => undefined, setRobotPose: vi.fn(),
    }} />)).toBe("");
  });
  it("converts angular display values but never converts prismatic meters", () => {
    const definition = robotDefinition(), hinge = definition.joints[1]!, slide = definition.joints[2]!;
    expect(robotJointSI(hinge, 180)).toBe(Math.PI); expect(robotJointDisplay(hinge, Math.PI / 2)).toBe(90);
    expect(robotJointSI(slide, .125)).toBe(.125); expect(robotJointDisplay(slide, .125)).toBe(.125);
  });
});

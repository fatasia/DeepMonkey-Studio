import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { ScenePhysicsPanel } from "./ScenePhysicsPanel";

const body = { type: "dynamic" as const, mass: 2, friction: 0.5, restitution: 0.1 };
const callbacks = { onChange: vi.fn(), onSelectedBodyChange: vi.fn(), onReset: vi.fn(), onClose: vi.fn() };

describe("ScenePhysicsPanel joints", () => {
  it("offers a world revolute mount for a selected dynamic body", () => {
    const html = renderToStaticMarkup(<ScenePhysicsPanel
      locale="zh-CN"
      value={{ enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } }}
      selectedId="arm"
      selectedName="机械臂"
      selectedPosition={{ x: 2, y: 3, z: 4 }}
      selectedBody={body}
      bodyOptions={[{ id: "arm", name: "机械臂", type: "dynamic" }, { id: "base", name: "底座", type: "fixed" }]}
      {...callbacks}
    />);

    expect(html).toContain("挂载旋转关节");
    expect(html).not.toContain("目标速度 rad/s");
  });

  it("renders persisted limits and velocity motor controls", () => {
    const html = renderToStaticMarkup(<ScenePhysicsPanel
      locale="zh-CN"
      value={{
        enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 },
        joints: [{
          id: "joint-arm", kind: "revolute", bodyId: "arm",
          worldAnchor: { x: 2, y: 3, z: 4 }, localAnchor: { x: 0, y: 0, z: 0 }, axis: { x: 0, y: 0, z: 1 },
          limits: { enabled: true, min: -0.5, max: 0.5 }, motor: { enabled: true, targetVelocity: 2, strength: 4 },
        }],
      }}
      selectedId="arm"
      selectedName="机械臂"
      selectedPosition={{ x: 2, y: 3, z: 4 }}
      selectedBody={body}
      bodyOptions={[{ id: "arm", name: "机械臂", type: "dynamic" }, { id: "base", name: "底座", type: "fixed" }]}
      {...callbacks}
    />);

    expect(html).toContain("目标速度 rad/s");
    expect(html).toContain("连接目标");
    expect(html).toContain("底座");
    expect(html).toContain("MultibodyJoint");
    expect(html).toContain("马达强度");
    expect(html).toContain("移除关节");
    expect(html).toContain("Rapier 速度约束求解强度，不代表额定扭矩");
  });

  it("keeps the expanded authoring panel scrollable at desktop and narrow widths", async () => {
    const css = await readFile(new URL("../styles/scene-environment.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.physics-panel\s*\{[^}]*max-height:[^;}]+;[^}]*overflow:\s*auto/);
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.physics-panel\s*\{[^}]*width:\s*min\(300px,calc\(100% - 16px\)\)/);
  });
});

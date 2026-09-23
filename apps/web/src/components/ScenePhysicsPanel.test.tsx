import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { ScenePhysicsBodyState } from "@bim-studio/contracts";
import { DeferredNumberInput } from "./AppFormControls";
import { ScenePhysicsPanel } from "./ScenePhysicsPanel";

vi.mock("../hooks/useFloatingPanelDrag", () => ({
  useFloatingPanelDrag: () => ({
    panelRef: { current: null }, style: undefined,
    onPointerDown: () => undefined, onPointerMove: () => undefined,
    onPointerUp: () => undefined, onPointerCancel: () => undefined,
  }),
}));

const body = { type: "dynamic" as const, mass: 2, friction: 0.5, restitution: 0.1 };
const callbacks = {
  onChange: vi.fn(),
  onSelectedBodyChange: vi.fn(),
  onReset: vi.fn(),
  onClose: vi.fn(),
  onDebugVisibleChange: vi.fn(),
};

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
    expect(css).toMatch(/@media \(max-width: 760px\)[\s\S]*\.physics-panel\s*\{[^}]*position:\s*fixed;[^}]*top:\s*152px;[^}]*left:\s*8px;[^}]*right:\s*8px;[^}]*width:\s*auto/);
  });

  it("B3 缺口 5：提供碰撞体调试线框开关，随状态切换文案与高亮", () => {
    const base = { locale: "zh-CN" as const, value: { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } }, ...callbacks };
    const off = renderToStaticMarkup(<ScenePhysicsPanel {...base} />);
    expect(off).toContain("显示碰撞体");
    expect(off).not.toContain("隐藏碰撞体");
    const on = renderToStaticMarkup(<ScenePhysicsPanel {...base} debugVisible />);
    expect(on).toContain("隐藏碰撞体");
    // 启用按钮 + 碰撞体开关共两处高亮，静态标记即可确认开关拿到了 active 态。
    expect(on.match(/class="active"/g)).toHaveLength(2);
  });
});

describe("ScenePhysicsPanel kinematic authoring", () => {
  it("routes the kinematic body type through the selected-body change callback", () => {
    const { tree, onSelectedBodyChange } = renderPhysicsPanel(body);
    const typeSelect = findElement(tree, (element) => element.type === "select" && element.props.value === "dynamic");
    expect(collectElements(typeSelect).some((element) => element.type === "option" && element.props.value === "kinematic")).toBe(true);
    invoke(typeSelect, "onChange", { target: { value: "kinematic" } });
    expect(onSelectedBodyChange).toHaveBeenCalledWith({ type: "kinematic" });
  });

  it("clears controller data when leaving kinematic so the runtime accepts the type change", () => {
    const kinematic = { ...body, type: "kinematic" as const, character: { offset: 0.04 } };
    const { tree, onSelectedBodyChange } = renderPhysicsPanel(kinematic);
    const typeSelect = findElement(tree, (element) => element.type === "select" && element.props.value === "kinematic");
    invoke(typeSelect, "onChange", { target: { value: "dynamic" } });
    expect(onSelectedBodyChange).toHaveBeenCalledWith({ type: "dynamic" });
  });

  it("creates the documented lightweight defaults when enabling a controller", () => {
    const { tree, onSelectedBodyChange } = renderPhysicsPanel({ ...body, type: "kinematic" });
    const toggle = findElement(tree, (element) => element.type === "input" && element.props["aria-label"] === "启用角色控制器");
    invoke(toggle, "onChange", { target: { checked: true } });
    expect(onSelectedBodyChange).toHaveBeenCalledWith({ character: {
      offset: 0.01,
      maxSlopeClimbAngle: Math.PI / 4,
      minSlopeSlideAngle: Math.PI / 4,
      autostep: { enabled: false, maxHeight: 0.3, minWidth: 0.2, includeDynamicBodies: false },
      snapToGround: { enabled: true, distance: 0.2 },
    } });
    expect(renderToStaticMarkup(ScenePhysicsPanel({
      locale: "zh-CN", value: { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } },
      selectedId: "equipment", selectedName: "设备", selectedBody: { ...body, type: "kinematic" },
      bodyOptions: [], onChange: vi.fn(), onSelectedBodyChange: vi.fn(), onReset: vi.fn(), onClose: vi.fn(), onDebugVisibleChange: vi.fn(),
    }))).toContain("Native 运行时当前不执行角色控制器参数。");
  });

  it("commits angles in degrees as radians and preserves sibling controller settings", () => {
    const character = {
      offset: 0.04,
      maxSlopeClimbAngle: Math.PI / 4,
      minSlopeSlideAngle: Math.PI / 5,
      autostep: { enabled: true, maxHeight: 0.35, minWidth: 0.18, includeDynamicBodies: false },
      snapToGround: { enabled: true, distance: 0.25 },
    };
    const { tree, onSelectedBodyChange } = renderPhysicsPanel({ ...body, type: "kinematic", character });
    const maxSlope = findElement(tree, (element) => element.type === DeferredNumberInput && element.props.ariaLabel === "最大可爬坡度（度）");
    invoke(maxSlope, "onCommit", 35);
    expect(onSelectedBodyChange).toHaveBeenCalledWith({ character: { ...character, maxSlopeClimbAngle: degreesToRadians(35) } });

    const autostep = findElement(tree, (element) => element.type === "input" && element.props["aria-label"] === "自动跨越台阶");
    invoke(autostep, "onChange", { target: { checked: false } });
    expect(onSelectedBodyChange).toHaveBeenLastCalledWith({ character: { ...character,
      autostep: { ...character.autostep, enabled: false } } });
  });
});

function renderPhysicsPanel(selectedBody: ScenePhysicsBodyState): { tree: ReactNode; onSelectedBodyChange: ReturnType<typeof vi.fn> } {
  const onSelectedBodyChange = vi.fn();
  const tree = ScenePhysicsPanel({
    locale: "zh-CN",
    value: { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } },
    selectedId: "equipment",
    selectedName: "设备",
    selectedBody,
    bodyOptions: [],
    onChange: vi.fn(),
    onSelectedBodyChange,
    onReset: vi.fn(),
    onClose: vi.fn(),
    onDebugVisibleChange: vi.fn(),
  });
  return { tree, onSelectedBodyChange };
}

type TestElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function collectElements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (!isValidElement(node)) return [];
  const element = node as TestElement;
  const children = typeof element.type === "function" && element.type.name === "CharacterControllerEditor"
    ? (element.type as (props: Record<string, unknown>) => ReactNode)(element.props)
    : element.props.children;
  return [element, ...collectElements(children)];
}

function findElement(node: ReactNode, predicate: (element: TestElement) => boolean): TestElement {
  const element = collectElements(node).find(predicate);
  if (!element) throw new Error("Expected control was not rendered.");
  return element;
}

function invoke(element: TestElement, property: string, argument: unknown): void {
  const handler = element.props[property];
  if (typeof handler !== "function") throw new Error(`Expected ${property} handler.`);
  (handler as (value: unknown) => void)(argument);
}

function degreesToRadians(degrees: number): number { return degrees * Math.PI / 180; }

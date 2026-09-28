import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { DeferredNumberInput } from "./AppFormControls";
import { PhysicsCompareSection, PhysicsDebugPanel, PhysicsDebugPanelView, PhysicsRosterSection } from "./PhysicsDebugPanel";
import type { PhysicsDebugBodySnapshot, PhysicsDebugJointSnapshot } from "../viewer/physicsDebugSnapshot";
import type { ParsedPoseSeries } from "../viewer/physicsPoseRecorder";
import { comparePoseSeries } from "../viewer/physicsPoseCompare";

vi.mock("../hooks/useFloatingPanelDrag", () => ({
  useFloatingPanelDrag: () => ({
    panelRef: { current: null }, style: undefined,
    onPointerDown: () => undefined, onPointerMove: () => undefined,
    onPointerUp: () => undefined, onPointerCancel: () => undefined,
  }),
}));

const basePhysics = { enabled: true, playing: false, gravity: { x: 0, y: -9.81, z: 0 } };

const body = (overrides: Partial<PhysicsDebugBodySnapshot> = {}): PhysicsDebugBodySnapshot => ({
  id: "box-1", name: "货箱", type: "dynamic",
  position: { x: 0.12345, y: 0.25, z: 0 }, quaternion: { x: 0, y: 0, z: 0, w: 1 },
  linvel: { x: 0.4, y: 0, z: 0 }, angvel: { x: 0, y: 0.1, z: 0 },
  speed: 0.4, angularSpeed: 0.1, sleeping: false, ...overrides,
});

const joint = (overrides: Partial<PhysicsDebugJointSnapshot> = {}): PhysicsDebugJointSnapshot => ({
  id: "joint-arm", kind: "revolute", solver: "impulse",
  bodyName: "机械臂", connectedBodyName: "底座", axis: { x: 0, y: 0, z: 1 },
  limits: { enabled: true, min: -0.5, max: 0.5 },
  motor: { enabled: true, targetVelocity: 2, strength: 10 },
  travel: 0.499999, rate: 1.98, limitState: "at-limit", ...overrides,
});

const viewProps = {
  locale: "zh-CN" as const,
  open: true,
  onOpenChange: vi.fn(),
  engine: undefined,
  physics: basePhysics,
  onPhysicsChange: vi.fn(),
  debugVisible: false,
  onDebugVisibleChange: vi.fn(),
  snapshot: undefined,
  recording: undefined,
  isRecording: false,
  isReplaying: false,
  capacity: 600,
  onCapacityChange: vi.fn(),
  manualSteps: 10,
  onManualStepsChange: vi.fn(),
  replayStep: null,
  onApplyReplayFrame: vi.fn(),
  onExitReplay: vi.fn(),
  onToggleRecording: vi.fn(),
  onExport: vi.fn(),
  onClearRecording: vi.fn(),
  seriesA: undefined,
  seriesB: undefined,
  importError: undefined,
  toleranceMm: 5,
  onToleranceMmChange: vi.fn(),
  toleranceMrad: 20,
  onToleranceMradChange: vi.fn(),
  curveMetric: "position" as const,
  onCurveMetricChange: vi.fn(),
  onImport: vi.fn(async () => undefined),
  onUseRecordingForSlotA: vi.fn(),
};

describe("PhysicsDebugPanel 容器静态结构", () => {
  it("关闭态渲染启动芯片而不渲染面板内容", () => {
    const html = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} open={false} />);
    expect(html).toContain("物理调试");
    expect(html).toContain("pdbg-launcher");
    expect(html).not.toContain("步进控制");
  });

  it("打开态渲染七组功能区且碰撞体线框开关随状态翻转", () => {
    const html = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} />);
    for (const label of ["步进控制", "录制", "回放", "跨端位姿比对", "碰撞体线框", "固定步"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("显示碰撞体");
    const on = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} debugVisible />);
    expect(on).toContain("隐藏碰撞体");
  });

  it("物理未启用时播放/单步禁用并给出原因提示", () => {
    const html = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} physics={{ ...basePhysics, enabled: false }} />);
    expect(html).toMatch(/disabled/);
    expect(html).toContain("先启用物理系统");
    expect(html).toContain("物理未挂载");
  });

  it("回放区在播放中给出暂停后再回放的提示、无录制时提示空态", () => {
    const html = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} physics={{ ...basePhysics, playing: true }} />);
    expect(html).toContain("暂停物理后可回放");
    expect(html).toContain("暂无录制帧");
  });

  it("录制区展示容量输入（默认 600 步）与环形缓冲提示", () => {
    const html = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} />);
    expect(html).toContain("容量 (步)");
    expect(html).toContain("600");
    expect(html).toContain("已录");
  });

  it("比对区呈现双槽导入、T17 默认容差与引导空态", () => {
    const html = renderToStaticMarkup(<PhysicsDebugPanel {...viewProps} />);
    expect(html).toContain("槽 A");
    expect(html).toContain("槽 B");
    expect(html).toContain("位置容差 (mm)");
    expect(html).toContain("旋转容差 (mrad)");
    expect(html).toContain("导入两份 T17 位姿 JSON");
    expect(html).toContain('value="5"');
    expect(html).toContain('value="20"');
  });
});

type TestElement = ReactElement<Record<string, unknown> & { children?: ReactNode }>;

function collectElements(node: ReactNode): TestElement[] {
  if (Array.isArray(node)) return node.flatMap(collectElements);
  if (!isValidElement(node)) return [];
  const element = node as TestElement;
  // 无 hooks 的展示组件（View/花名册/比对区）直接展开函数体以遍历其子树；
  // DeferredNumberInput 等带 hooks 的控件保持元素形态，只断言/触发 props。
  const expandable = element.type === PhysicsDebugPanelView || element.type === PhysicsRosterSection || element.type === PhysicsCompareSection;
  const children = expandable
    ? (element.type as (props: Record<string, unknown>) => ReactNode)(element.props)
    : element.props.children;
  return [element, ...collectElements(children)];
}

function findElements(node: ReactNode, predicate: (element: TestElement) => boolean): TestElement[] {
  return collectElements(node).filter(predicate);
}

function invoke(element: TestElement, property: string, argument: unknown): void {
  const handler = element.props[property];
  if (typeof handler !== "function") throw new Error(`Expected ${property} handler.`);
  (handler as (value: unknown) => void)(argument);
}

function buttonText(element: TestElement): string {
  return JSON.stringify(element.props.children ?? "");
}

describe("PhysicsDebugPanelView 交互回调（直接展开组件树）", () => {
  it("单步按钮调用引擎 stepPhysicsFrames(1)", () => {
    const engine = { stepPhysicsFrames: vi.fn() };
    const tree = <PhysicsDebugPanelView {...viewProps} engine={engine as never} />;
    const stepButton = findElements(tree, (element) => element.type === "button").find((element) => buttonText(element).includes("单步"));
    expect(stepButton).toBeDefined();
    invoke(stepButton!, "onClick", undefined);
    expect(engine.stepPhysicsFrames).toHaveBeenCalledWith(1);
  });

  it("×N 步按钮以步数输入值调用引擎，步数输入提交钳制到 [1,600]", () => {
    const engine = { stepPhysicsFrames: vi.fn() };
    const tree = <PhysicsDebugPanelView {...viewProps} engine={engine as never} />;
    const nButton = findElements(tree, (element) => element.type === "button").find((element) => buttonText(element).includes("×"));
    expect(nButton).toBeDefined();
    invoke(nButton!, "onClick", undefined);
    expect(engine.stepPhysicsFrames).toHaveBeenCalledWith(10);
    const stepsInput = findElements(tree, (element) => element.type === DeferredNumberInput)[0]!;
    invoke(stepsInput, "onCommit", 700);
    expect(viewProps.onManualStepsChange).toHaveBeenCalledWith(600);
    invoke(stepsInput, "onCommit", Number.NaN);
    expect(viewProps.onManualStepsChange).toHaveBeenLastCalledWith(1);
  });

  it("播放/连续按钮经 onPhysicsChange 切换 playing，与物理面板共用一条状态路径", () => {
    const onPhysicsChange = vi.fn();
    const tree = <PhysicsDebugPanelView {...viewProps} onPhysicsChange={onPhysicsChange} />;
    const runButton = findElements(tree, (element) => element.type === "button").find((element) => buttonText(element).includes("连续"));
    expect(runButton).toBeDefined();
    invoke(runButton!, "onClick", undefined);
    expect(onPhysicsChange).toHaveBeenCalledWith({ ...basePhysics, playing: true });
  });

  it("录制开关调用引擎 setPhysicsRecording，回放滑块上行 onApplyReplayFrame", () => {
    const engine = { stepPhysicsFrames: vi.fn() };
    const onApplyReplayFrame = vi.fn();
    const tree = <PhysicsDebugPanelView
      {...viewProps}
      engine={engine as never}
      onApplyReplayFrame={onApplyReplayFrame}
      recording={{ frameCount: 3, capacity: 600, frames: [] }}
    />;
    const recordButton = findElements(tree, (element) => element.type === "button").find((element) => buttonText(element).includes("开始录制"));
    expect(recordButton).toBeDefined();
    invoke(recordButton!, "onClick", undefined);
    expect(viewProps.onToggleRecording).toHaveBeenCalled();

    const slider = findElements(tree, (element) => element.type === "input" && element.props["aria-label"] === "回放时间轴")[0]!;
    invoke(slider, "onChange", { target: { value: "2" } });
    expect(onApplyReplayFrame).toHaveBeenCalledWith(2);
  });
});

describe("PhysicsRosterSection 花名册", () => {
  it("刚体行渲染类型徽章、速度与位置，睡眠态有独立徽章", () => {
    const tree = <PhysicsRosterSection locale="zh-CN" available bodies={[body(), body({ id: "lid", name: "箱盖", type: "fixed", sleeping: true })]} joints={[]} />;
    const html = renderToStaticMarkup(tree);
    expect(html).toContain("货箱");
    expect(html).toContain("0.400 m/s");
    expect(html).toContain("0.123, 0.250, 0.000");
    expect(html).toContain("pdbg-sleep");
    expect(html).toContain("睡眠");
    expect(html).toContain("pdbg-dynamic");
    expect(html).toContain("pdbg-fixed");
  });

  it("关节行渲染角度、限位区间与限位中/马达徽章，prismatic 用米与米单位", () => {
    const revolute = renderToStaticMarkup(<PhysicsRosterSection locale="zh-CN" available bodies={[]} joints={[joint()]} />);
    expect(revolute).toContain("28.6°");
    expect(revolute).toContain("-29~29°");
    expect(revolute).toContain("限位中");
    expect(revolute).toContain("马达 2.0");
    expect(revolute).toContain("1.98 rad/s");
    const prismatic = renderToStaticMarkup(<PhysicsRosterSection locale="zh-CN" available bodies={[]} joints={[
      joint({ kind: "prismatic", limits: { enabled: true, min: -0.08, max: 0.08 }, travel: 0.0801, rate: 0.4, limitState: "at-limit" }),
    ]} />);
    expect(prismatic).toContain("0.080 m");
    expect(prismatic).toContain("-0.08~0.08 m");
    expect(prismatic).toContain("0.400 m/s");
  });

  it("世界锚定关节显示“世界”，空态给引导文案", () => {
    const html = renderToStaticMarkup(<PhysicsRosterSection locale="zh-CN" available={false} bodies={[]} joints={[
      joint({ connectedBodyName: "" }),
    ]} />);
    expect(html).toContain("世界");
    expect(html).toContain("在物理面板启用物理系统后观察刚体");
  });
});

const poseSeries = (end: string, source: string, offsets: number[]): ParsedPoseSeries => ({
  end,
  steps: offsets.length,
  bodies: ["box-1"],
  fixedStepSeconds: 1 / 60,
  frames: offsets.map((offset, index) => ({
    step: index + 1,
    bodies: [{ id: "box-1", p: [offset, 0, 0], q: [0, 0, 0, 1] }],
  })),
  source,
});

describe("PhysicsCompareSection 比对视图", () => {
  const result = comparePoseSeries(poseSeries("web", "web.json", [0, 0.001, 0.008]), poseSeries("native", "native.json", [0, 0.001, 0]));

  it("结果摘要含最大差、首超差帧与通过/超差判定", () => {
    const html = renderToStaticMarkup(
      <PhysicsCompareSection
        locale="zh-CN"
        seriesA={poseSeries("web", "web.json", [0])}
        seriesB={poseSeries("native", "native.json", [0])}
        comparison={result}
        importError={undefined}
        curveMetric="position"
        toleranceMm={5}
        toleranceMrad={20}
        recordingAvailable
        onCurveMetricChange={() => undefined}
        onToleranceMmChange={() => undefined}
        onToleranceMradChange={() => undefined}
        onImport={async () => undefined}
        onUseRecordingForSlotA={() => undefined}
      />,
    );
    expect(html).toContain("8.00 mm");
    expect(html).toContain("首超差帧 3");
    expect(html).toContain("存在超差帧");
    expect(html).toContain("1/3 帧超差");
    expect(html).toContain("pdbg-curve");
    expect(html).toContain("pdbg-exceed");
    expect(html).toContain("帧 3");
  });

  it("无超差结果给出通过判定", () => {
    const pass = comparePoseSeries(poseSeries("web", "web.json", [0, 0.001]), poseSeries("native", "native.json", [0, 0.0012]));
    const html = renderToStaticMarkup(
      <PhysicsCompareSection
        locale="zh-CN"
        seriesA={undefined}
        seriesB={undefined}
        comparison={pass}
        importError={undefined}
        curveMetric="rotation"
        toleranceMm={5}
        toleranceMrad={20}
        recordingAvailable={false}
        onCurveMetricChange={() => undefined}
        onToleranceMmChange={() => undefined}
        onToleranceMradChange={() => undefined}
        onImport={async () => undefined}
        onUseRecordingForSlotA={() => undefined}
      />,
    );
    expect(html).toContain("通过容差");
    expect(html).not.toContain("pdbg-exceed");
  });

  it("红点跟随当前指标：仅位置超差时旋转差曲线不标红点", () => {
    const html = renderToStaticMarkup(
      <PhysicsCompareSection
        locale="zh-CN"
        seriesA={undefined}
        seriesB={undefined}
        comparison={result}
        importError={undefined}
        curveMetric="rotation"
        toleranceMm={5}
        toleranceMrad={20}
        recordingAvailable={false}
        onCurveMetricChange={() => undefined}
        onToleranceMmChange={() => undefined}
        onToleranceMradChange={() => undefined}
        onImport={async () => undefined}
        onUseRecordingForSlotA={() => undefined}
      />,
    );
    expect(html).toContain("存在超差帧");
    expect(html).not.toMatch(/class="pdbg-exceed"/);
  });

  it("导入错误以可操作错误态呈现且槽位显示来源", () => {
    const html = renderToStaticMarkup(
      <PhysicsCompareSection
        locale="zh-CN"
        seriesA={poseSeries("web", "capture.json", [0])}
        seriesB={undefined}
        comparison={undefined}
        importError="a.json 不是合法 JSON"
        curveMetric="position"
        toleranceMm={5}
        toleranceMrad={20}
        recordingAvailable={false}
        onCurveMetricChange={() => undefined}
        onToleranceMmChange={() => undefined}
        onToleranceMradChange={() => undefined}
        onImport={async () => undefined}
        onUseRecordingForSlotA={() => undefined}
      />,
    );
    expect(html).toContain("不是合法 JSON");
    expect(html).toContain("web · 1 步");
    expect(html).toContain("未导入");
    expect(html).toContain("alert");
  });

  it("容差输入挂接 DeferredNumberInput 并提交数值", () => {
    const onToleranceMmChange = vi.fn();
    const tree = (
      <PhysicsCompareSection
        locale="zh-CN"
        seriesA={undefined}
        seriesB={undefined}
        comparison={undefined}
        importError={undefined}
        curveMetric="position"
        toleranceMm={5}
        toleranceMrad={20}
        recordingAvailable={false}
        onCurveMetricChange={() => undefined}
        onToleranceMmChange={onToleranceMmChange}
        onToleranceMradChange={() => undefined}
        onImport={async () => undefined}
        onUseRecordingForSlotA={() => undefined}
      />
    );
    const inputs = findElements(tree, (element) => element.type === DeferredNumberInput);
    expect(inputs.length).toBe(2);
    invoke(inputs[0]!, "onCommit", 8);
    expect(onToleranceMmChange).toHaveBeenCalledWith(8);
  });
});

describe("令牌合规（T17 硬编码清剿教训的同族防线）", () => {
  it("PhysicsDebugPanel.css 不含硬编码十六进制颜色，数字用 tabular-nums", async () => {
    const css = await readFile(new URL("./PhysicsDebugPanel.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(css).toContain("tabular-nums");
    expect(css).toContain("var(--accent)");
    expect(css).toContain("var(--on-accent)");
  });

  it("面板滚动与窄断点规则齐备", async () => {
    const css = await readFile(new URL("./PhysicsDebugPanel.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.pdbg-panel\s*\{[^}]*max-height:[^;}]+;[^}]*overflow:\s*auto/s);
    expect(css).toMatch(/@media \(max-width: 760px\)/);
  });
});

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RobotWorkcellPathEditor } from "./RobotWorkcellPathEditor";
import {
  activeRobotPathTargets,
  changeRobotPathPointMode,
  moveRobotPathPoint,
  moveRobotPathPointBefore,
  robotPathPointMode,
} from "./robotWorkcellPathEditing";
import type { RobotAssistantTargetInput } from "./robotWorkcellAssistantTypes";

describe("robot workcell path editing", () => {
  it("reorders without mutating the source and ignores missing destinations", () => {
    const source = targets();
    const keyboardMoved = moveRobotPathPoint(source, "b", -1);
    const dragged = moveRobotPathPointBefore(source, "c", "a");

    expect(keyboardMoved.map((item) => item.id)).toEqual(["b", "a", "c"]);
    expect(dragged.map((item) => item.id)).toEqual(["c", "a", "b"]);
    expect(source.map((item) => item.id)).toEqual(["a", "b", "c"]);
    expect(moveRobotPathPointBefore(source, "c", "missing")).toBe(source);
  });

  it("maps action choices onto the existing process and settle timing fields", () => {
    const base = targets()[0]!;
    const process = changeRobotPathPointMode(base, "process");
    const waiting = changeRobotPathPointMode(process, "settle");
    const combined = changeRobotPathPointMode(waiting, "process-settle");
    const moving = changeRobotPathPointMode(combined, "move");

    expect(process).toMatchObject({ processTimeSec: 1 });
    expect(process).not.toHaveProperty("settleTimeSec");
    expect(waiting).toMatchObject({ settleTimeSec: 1 });
    expect(waiting).not.toHaveProperty("processTimeSec");
    expect(robotPathPointMode(combined)).toBe("process-settle");
    expect(moving).not.toHaveProperty("processTimeSec");
    expect(moving).not.toHaveProperty("settleTimeSec");
  });

  it("keeps disabled points in the draft but excludes them from the active sequence", () => {
    const source = targets();
    source[1] = { ...source[1]!, enabled: false };
    expect(activeRobotPathTargets({ targets: source }).map((item) => item.id)).toEqual(["a", "c"]);
  });

  it("renders drag, keyboard, enable, mode, timing and delete controls accessibly", () => {
    const source = targets();
    const html = renderToStaticMarkup(<RobotWorkcellPathEditor targets={source} onChange={vi.fn()} />);

    expect(html).toContain("aria-label=\"工艺点与路径序列\"");
    expect(html).toContain("第 1 个工艺点：点 A");
    expect(html).toContain("draggable=\"true\"");
    expect(html).toContain("拖动 点 A 调整顺序");
    expect(html).toContain("停用 点 A");
    expect(html).toContain("点 A 动作类型");
    expect(html).toContain("工艺驻留秒数");
    expect(html).toContain("稳定等待秒数");
    expect((html.match(/aria-label="工艺驻留秒数"/g) ?? []).length).toBe(source.length);
    expect((html.match(/aria-label="稳定等待秒数"/g) ?? []).length).toBe(source.length);
    expect(html).toContain("上移 点 A");
    expect(html).toContain("下移 点 A");
    expect(html).toContain("删除 点 A");
    expect(html).toContain("旧验证和时间轴会失效");
  });
});

function targets(): RobotAssistantTargetInput[] {
  return [
    { id: "a", name: "点 A", position: { x: 1, y: 0, z: 0 } },
    { id: "b", name: "点 B", position: { x: 2, y: 0, z: 0 } },
    { id: "c", name: "点 C", position: { x: 3, y: 0, z: 0 } },
  ];
}

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SceneEditRound, SceneEditSession } from "../ai/sceneEditSession";
import { SceneEditLoopCard } from "./SceneEditLoopCard";

const noop = () => undefined;
const diffRound = (patch: Partial<SceneEditRound> = {}): SceneEditRound => ({
  index: 1, status: "awaiting-approval", summary: "右移并新增", commands: [], fingerprint: "ab12cd34",
  diff: {
    counts: { add: 1, modify: 1, delete: 0, action: 1 }, blockers: [], irreversibleCount: 1,
    entries: [
      { commandId: "1", type: "object.create-primitive", kind: "add", subject: "新方块 (n)", fields: [{ key: "color", label: "颜色", after: "#00ff00" }] },
      { commandId: "2", type: "object.set-transform", kind: "modify", subject: "泵 (a)", fields: [{ key: "position", label: "位置", before: "(0, 0, 0)", after: "(4, 0, 0)" }] },
      { commandId: "3", type: "animation.control", kind: "action", subject: "动画", irreversible: true, fields: [{ key: "action", label: "动作", after: "play" }] },
    ],
  },
  ...patch,
});
const session = (patch: Partial<SceneEditSession> = {}): SceneEditSession => ({ id: "se-1", objective: "把泵右移", mode: "confirm", maxCorrections: 2, status: "awaiting-approval", rounds: [diffRound()], ...patch });
const render = (value: SceneEditSession, busy = false) => renderToStaticMarkup(
  <SceneEditLoopCard locale="zh-CN" session={value} busy={busy} onApprove={noop} onReject={noop} onCancel={noop} onUndo={noop} onNew={noop} />,
);

describe("SceneEditLoopCard", () => {
  it("shows a readable before→after diff with status encoded as icon + text and an apply/discard decision", () => {
    const html = render(session());
    expect(html).toContain("待确认");
    expect(html).toContain("新增");
    expect(html).toContain("修改");
    expect(html).toContain("(0, 0, 0)");
    expect(html).toContain("(4, 0, 0)");
    expect(html).toContain("不可撤销");
    expect(html).toContain("应用改动");
    expect(html).toContain("放弃");
    expect(html).toContain("修正上限 2");
    expect(html).not.toContain("撤销改动");
  });

  it("disables decisions while busy", () => {
    expect(render(session(), true).match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("renders verification: screenshots, failed checks expanded, verdict with source, and the undo entry point", () => {
    const shot = (name: string) => ({ dataUrl: `data:image/jpeg;base64,${name}`, capturedAt: "t", metrics: { width: 1920, height: 1080, meanLuma: 10, contentRatio: 0.3, grid: [], fingerprint: "deadbeefcafe" } });
    const html = render(session({
      status: "unachieved", error: "已达修正轮次上限(2)",
      rounds: [diffRound({
        status: "verified",
        applied: { label: "AI 改动", undoable: true, beforeShot: shot("before"), afterShot: shot("after"),
          checks: [{ key: "k1", label: "泵 · 位置", expected: "(4, 0, 0)", actual: "(4, 0, 0)", ok: true }, { key: "k2", label: "泵 · 可见性", expected: "否", actual: "是", ok: false }] },
        verdict: { outcome: "unachieved", reason: "泵仍可见", source: "model" },
      })],
    }));
    expect(html).toContain("应用前视口截图");
    expect(html).toContain("应用后视口截图");
    expect(html).toContain("1920×1080");
    expect(html).toContain("状态核对");
    expect(html).toContain("1/2");
    expect(html).toContain("不一致");
    expect(html).toContain("预期");
    expect(html).toContain("未达成");
    expect(html).toContain("模型自检");
    expect(html).toContain("撤销改动");
    expect(html).toContain("已达修正轮次上限");
    expect(html).toMatch(/<details[^>]*class="scene-edit-checks"[^>]*open/);
  });

  it("covers loading skeleton, plan-only and undone terminal states", () => {
    expect(render(session({ status: "proposing", rounds: [{ index: 1, status: "proposing", summary: "", commands: [] }] }))).toContain("scene-edit-skeleton");
    expect(render(session({ status: "plan-only", rounds: [diffRound({ status: "plan-only" })] }))).toContain("尚未改动场景");
    const undone = render(session({ status: "undone", rounds: [diffRound({ status: "undone", applied: { label: "x", undoable: true, checks: [] }, undone: { ok: true, restored: true } })] }));
    expect(undone).toContain("已撤销");
    expect(undone).toContain("校验还原");
    expect(undone).not.toContain(">撤销改动<");
  });

  it("is English-complete and uses no hard-coded colors", async () => {
    const html = renderToStaticMarkup(<SceneEditLoopCard locale="en-US" session={session()} busy={false} onApprove={noop} onReject={noop} onCancel={noop} onUndo={noop} onNew={noop} />);
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("Apply changes");
    expect(html).not.toContain("待确认");
    expect(html).not.toContain("应用改动");
    const { readFileSync } = await import("node:fs");
    const css = readFileSync(new URL("./SceneEditLoopCard.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

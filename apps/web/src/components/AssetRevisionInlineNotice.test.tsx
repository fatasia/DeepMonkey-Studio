import { isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { AssetRevisionInlineNotice } from "./ProjectAssetInventory";

type Element = ReactElement<Record<string, any>>;

function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}

describe("AssetRevisionInlineNotice", () => {
  it("shows a restrained stale revision prompt with semantic status text", () => {
    const nodes = walk(AssetRevisionInlineNotice({ locale: "zh-CN", staleCount: 2, oldestSceneRevision: 1, latestRevision: 3, busy: false, disabled: false, onUpdate: vi.fn() }));
    expect(nodes.find(node => node.props.role === "status")).toBeDefined();
    expect(nodes.some(node => node.props.children === "资产修订陈旧")).toBe(true);
    expect(nodes.some(node => String(node.props.children).includes("场景 r1 → 最新 r3"))).toBe(true);
  });

  it("invokes the one-click update action immediately from the inline button", () => {
    const onUpdate = vi.fn();
    const button = walk(AssetRevisionInlineNotice({ locale: "zh-CN", staleCount: 1, oldestSceneRevision: 2, latestRevision: 4, busy: false, disabled: false, onUpdate }))
      .find(node => node.type === "button")!;
    button.props.onClick();
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("keeps a retry affordance visible on failures", () => {
    const nodes = walk(AssetRevisionInlineNotice({ locale: "zh-CN", staleCount: 1, oldestSceneRevision: 2, latestRevision: 4, busy: false, disabled: false, notice: { kind: "error", message: "网络不可达" }, onUpdate: vi.fn() }));
    expect(nodes.find(node => node.props.role === "alert")).toBeDefined();
    expect(String(nodes.find(node => node.type === "button")!.props.children)).toContain("重试更新");
    expect(nodes.some(node => node.props.title === "网络不可达")).toBe(true);
  });

  it("offers keep-current next to the update action and disables update while busy", () => {
    const onKeep = vi.fn();
    const nodes = walk(AssetRevisionInlineNotice({ locale: "zh-CN", staleCount: 1, oldestSceneRevision: 1, latestRevision: 2, busy: true, disabled: true, onUpdate: vi.fn(), onKeep }));
    const buttons = nodes.filter(node => node.type === "button");
    expect(buttons).toHaveLength(2);
    expect(buttons[0]!.props.disabled).toBe(true);
    expect(buttons[0]!.props["aria-busy"]).toBe(true);
    expect(String(buttons[0]!.props.children)).toContain("更新中");
    expect(String(buttons[1]!.props.children)).toBe("保持当前");
    expect(buttons[1]!.props.disabled).toBe(true);
  });

  it("invokes keep-current when idle", () => {
    const onKeep = vi.fn();
    const keep = walk(AssetRevisionInlineNotice({ locale: "zh-CN", staleCount: 1, oldestSceneRevision: 1, latestRevision: 2, busy: false, disabled: false, onUpdate: vi.fn(), onKeep }))
      .filter(node => node.type === "button")[1]!;
    expect(keep.props.disabled).toBe(false);
    keep.props.onClick();
    expect(onKeep).toHaveBeenCalledOnce();
  });
});

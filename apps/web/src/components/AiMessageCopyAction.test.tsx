import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ status: "idle", copy: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useState: () => [state.status, (value: string) => { state.status = value; }] }));
vi.mock("./DocsCenterClipboard", () => ({ copyDocumentationCode: state.copy }));
import { AiMessageCopyAction } from "./AiMessageCopyAction";
function walk(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...walk(node.props.children)];
}
function render(text = "第一行\n第二行") { return walk(AiMessageCopyAction({ locale: "zh-CN", text })); }
beforeEach(() => { state.status = "idle"; state.copy.mockReset(); });
it("copies the exact answer including line breaks and announces success", async () => {
  state.copy.mockResolvedValue(undefined);
  render().find(node => node.type === "button")!.props.onClick();
  expect(render().find(node => node.type === "button")!.props.disabled).toBe(true);
  await vi.waitFor(() => expect(state.status).toBe("copied"));
  expect(state.copy).toHaveBeenCalledExactlyOnceWith("第一行\n第二行");
  expect(render().find(node => node.props.role === "status")!.props.children).toBe("回答已复制");
});
it("shows a useful failure and permits retry", async () => {
  state.copy.mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
  render().find(node => node.type === "button")!.props.onClick();
  await vi.waitFor(() => expect(state.status).toBe("failed"));
  expect(render().find(node => node.props.role === "status")!.props.children).toContain("复制失败");
  render().find(node => node.type === "button")!.props.onClick();
  await vi.waitFor(() => expect(state.status).toBe("copied"));
});
it("does not expose an empty copy action", () => { expect(render("")).toEqual([]); });

import { isValidElement, type ComponentProps, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SceneArtifactRecord } from "../controllers/scenePublicationArtifactRecord";

const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[], escape: () => undefined as void }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => harness.cells[harness.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.cells)) harness.cells[index] = typeof initial === "function" ? initial() : initial;
    return [harness.cells[index], (next: unknown) => {
      harness.cells[index] = typeof next === "function" ? next(harness.cells[index]) : next;
    }];
  },
  useEffect: () => undefined,
  useLayoutEffect: () => undefined,
}));
vi.mock("../hooks/useGlobalDialogEscape", () => ({
  useDialogEscape: (cancel: () => void, disabled: boolean) => {
    harness.escape = () => { if (!disabled) cancel(); }; return () => undefined;
  },
}));
import { ScenePublicationDialog } from "./ScenePublicationDialog";

type Props = Record<string, unknown> & { children?: ReactNode };
type Element = ReactElement<Props>;
// 执行真实函数组件与事件处理器；仅替换 React 状态调度和宿主按钮禁用行为。
function expand(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(expand);
  if (!isValidElement<Props>(node)) return [];
  if (typeof node.type === "function") return expand((node.type as (props: Props) => ReactNode)(node.props));
  return [node, ...expand(node.props.children)];
}
function label(node: ReactNode): string {
  if (Array.isArray(node)) return node.map(label).join("");
  if (typeof node === "string" || typeof node === "number") return String(node);
  return isValidElement<Props>(node) ? label(node.props.children) : "";
}
function click(button: Element) { if (!button.props.disabled) (button.props.onClick as () => void)(); }
function deferred() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => { harness.cells = []; harness.cursor = 0; vi.clearAllMocks(); });

function fixture(patch: Partial<ComponentProps<typeof ScenePublicationDialog>> = {}) {
  const props: ComponentProps<typeof ScenePublicationDialog> = {
    locale: "zh-CN", sceneName: "场景", mode: "webgl", performance: "standard", defaultToolbarVisible: true,
    cloudConfigured: true, onModeChange: vi.fn(), onPerformanceChange: vi.fn(), onClientTargetChange: vi.fn(),
    onCancel: vi.fn(), onPublish: vi.fn().mockResolvedValue(undefined), ...patch,
  };
  let tree: Element[] = [];
  const render = () => { harness.cursor = 0; tree = expand(ScenePublicationDialog(props)); };
  const button = (name: string) => {
    const value = tree.find(item => item.type === "button" && label(item.props.children) === name);
    if (!value) throw new Error(`Missing button: ${name}`); return value;
  };
  render(); return { props, render, button, nodes: () => tree };
}

describe("publication dialog interaction", () => {
  it("deduplicates same-tick clicks and freezes choices and dismissal until settlement", async () => {
    const pending = deferred(), onPublish = vi.fn(() => pending.promise), app = fixture({ onPublish });
    const submit = app.button("发布"); click(submit); click(submit);
    expect(onPublish).toHaveBeenCalledExactlyOnceWith(true, "none");
    app.render();
    const buttons = app.nodes().filter(item => item.type === "button");
    expect(buttons).toHaveLength(12); expect(buttons.every(item => item.props.disabled)).toBe(true);
    for (const item of buttons) click(item);
    (app.nodes().find(item => item.props.className === "dialog-backdrop")!.props.onMouseDown as () => void)();
    harness.escape();
    expect(app.props.onCancel).not.toHaveBeenCalled(); expect(app.props.onModeChange).not.toHaveBeenCalled();
    expect(app.props.onPerformanceChange).not.toHaveBeenCalled(); expect(app.props.onClientTargetChange).not.toHaveBeenCalled();
    pending.resolve(); await flush(); app.render();
    click(app.button("取消")); expect(app.props.onCancel).toHaveBeenCalledOnce();
  });

  it("shows submission failure and permits an explicit retry with retained choices", async () => {
    const pending = deferred(), onPublish = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(undefined);
    const app = fixture({ onPublish, clientTarget: "three-webview" }); click(app.button("隐藏")); app.render();
    click(app.button("发布")); pending.reject(new Error("发布存储不可用")); await flush(); app.render();
    expect(app.nodes().filter(item => item.props.role === "alert").map(item => label(item.props.children))).toEqual(["发布存储不可用"]);
    expect(app.button("发布").props.disabled).toBeFalsy(); click(app.button("发布"));
    expect(onPublish).toHaveBeenNthCalledWith(2, false, "three-webview");
    app.render(); expect(app.nodes().some(item => item.props.role === "alert")).toBe(false);
    await flush();
  });

  it.each([false, true])("blocks another publication while packaging and keeps cancel reachable with parent busy=%s", busy => {
    const record = { key: "artifact", projectId: "project", sceneId: "scene", status: "building", publicationVersion: 1,
      target: "three-webview" } as SceneArtifactRecord;
    const cancel = vi.fn();
    const app = fixture({ busy, projectId: "project", sceneId: "scene", artifacts: { records: [record], loading: false, error: undefined,
      begin: vi.fn(), retry: vi.fn(), cancel, load: vi.fn().mockResolvedValue([record]) } });
    expect(app.button("发布").props.disabled).toBe(true); click(app.button("发布"));
    // 连续事件也必须在 submit 内拒绝，而不只依靠 HTML disabled。
    (app.button("发布").props.onClick as () => void)(); expect(app.props.onPublish).not.toHaveBeenCalled();
    const cancelBuild = app.button("取消打包"); expect(cancelBuild.props.disabled).toBeFalsy(); click(cancelBuild);
    expect(cancel).toHaveBeenCalledExactlyOnceWith("artifact");
  });
});

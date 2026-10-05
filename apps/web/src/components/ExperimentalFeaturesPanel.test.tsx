import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// 面板为 hooks 组件;仓内无 DOM 测试环境,按 AiMessageCopyAction.test.tsx 惯例
// 以槽位化 useState mock 直接调用组件函数,交互经 props 触发,断言 setter 收到的值。
const state = vi.hoisted(() => ({
  /** useState 槽位:0=collapsed 1=draft 2=current 3=copyState;undefined 槽位走组件真实惰性初值(读 URL)。 */
  slots: [] as unknown[],
  setCalls: [] as Array<[number, unknown]>,
  slotCursor: 0,
  copy: vi.fn(),
  hrefWrites: [] as string[],
}));

vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: <T,>(initial: T | (() => T)): [T, (value: T | ((current: T) => T)) => void] => {
      const index = state.slotCursor++;
      const current = state.slots[index] !== undefined ? state.slots[index] : (typeof initial === "function" ? (initial as () => T)() : initial);      return [
        current as T,
        (value: T | ((currentValue: T) => T)) => {
          state.setCalls.push([index, typeof value === "function" ? (value as (c: T) => T)(current as T) : value]);
        },
      ];
    },
    useMemo: <T,>(factory: () => T) => factory(),
    useEffect: () => undefined,
    useId: () => "ef-test-id",
    useRef: <T,>(initial: T) => ({ current: initial }),
  };
});
vi.mock("../hooks/useFloatingPanelDrag", () => ({
  useFloatingPanelDrag: () => ({
    panelRef: { current: null },
    style: undefined,
    onPointerDown: () => undefined,
    onPointerMove: () => undefined,
    onPointerUp: () => undefined,
    onPointerCancel: () => undefined,
    reset: () => undefined,
  }),
}));
vi.mock("./DocsCenterClipboard", () => ({ copyDocumentationCode: state.copy }));

// 组件直接读 window.location(search 初值 + 链接基底 + 应用重载写入);node 环境给可观测桩。
const locationState = vi.hoisted(() => ({ href: "http://localhost/studio/new", search: "" }));

beforeEach(() => {
  state.slotCursor = 0;
  state.slots.length = 0; // 未注入槽位一律走组件真实惰性初值(读当前 URL)
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        get href() { return locationState.href; },
        set href(value: string) { state.hrefWrites.push(value); locationState.href = value; },
        get search() { return locationState.search; },
      },
    },
  });
});

afterEach(() => {
  state.hrefWrites.length = 0;
  state.setCalls.length = 0;
  state.copy.mockReset();
});

import { ExperimentalFeaturesPanel } from "./ExperimentalFeaturesPanel";

type Element = ReactElement<Record<string, any>>;

function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node as Element, ...walk(node.props.children)];
}

function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<Record<string, any>>(node)) return textOf(node.props.children);
  return "";
}

function readStates(): Record<string, boolean> {
  const states: Record<string, boolean> = {};
  for (const spec of [
    "t07-dynamic-resolution", "f4-temporal-upscale", "f3-virtual-textures", "b4-hlod-cluster",
    "g1-cluster-lod", "mega-lights", "ray-traced-shadows", "sdf-gi", "t25-gpu-pass-timing",
    "debug-full-render", "t11-critical-pipelines", "t11-defer-deformation",
  ]) states[spec] = false;
  return states;
}

function findByTestId(tree: Element[], testId: string): Element | undefined {
  return tree.find((node) => node.props["data-testid"] === testId);
}

function footerButtons(tree: Element[]): Element[] {
  const footer = tree.find((node) => node.props.className === "ef-footer")!;
  return walk(footer.props.children).filter((node) => node.type === "button") as Element[];
}

/** 直接调用组件函数(仓内无 DOM 环境的既定做法);每次调用重置 useState 槽位游标。 */
function renderPanel(): Element[] {
  state.slotCursor = 0;
  return walk(ExperimentalFeaturesPanel({ locale: "zh-CN", onClose: () => undefined }));
}

describe("ExperimentalFeaturesPanel", () => {
  it("渲染:全部 13 个开关行(名称+参数徽章+说明+复选框),两组标题与引导语齐备", () => {
    locationState.search = "?mega-lights=1";
    const tree = renderPanel();
    const rows = tree.filter((node) => typeof node.props["data-testid"] === "string" && String(node.props["data-testid"]).startsWith("ef-row-"));
    expect(rows).toHaveLength(13);
    const text = textOf(tree.map((node) => node as unknown as ReactNode));
    expect(text).toContain("渲染路径");
    expect(text).toContain("调试与首帧");
    expect(text).toContain("MegaLights 万灯");
    expect(text).toContain("t25-gpu-pass-timing");
    expect(text).toContain("以下引擎开关只能经 URL 参数启用");
  });

  it("当前态:URL 已开参数复选框 checked=true,未开的为 false(不伪开)", () => {
    locationState.search = "?mega-lights=1&t11-critical-pipelines=0";
    const tree = renderPanel();
    const checkedOf = (testId: string): boolean => {
      const row = findByTestId(tree, testId)!;
      return walk(row.props.children).find((node) => node.props.type === "checkbox")!.props.checked;
    };
    expect(checkedOf("ef-row-mega-lights")).toBe(true);
    expect(checkedOf("ef-row-t11-critical-pipelines")).toBe(false);
    expect(checkedOf("ef-row-t25-gpu-pass-timing")).toBe(false);
  });

  it("切换:勾选触发草稿更新;「应用并重载」把带参链接写入 location.href(重载生效路径)", () => {
    locationState.search = "";
    const tree = renderPanel();
    const t25Row = findByTestId(tree, "ef-row-t25-gpu-pass-timing")!;
    const checkbox = walk(t25Row.props.children).find((node) => node.props.type === "checkbox")!;
    checkbox.props.onChange({ target: { checked: true } });
    // slot 1 = draft:收到含 t25=true 的完整草稿
    const draftUpdate = state.setCalls.find(([index]) => index === 1)![1] as Record<string, boolean>;
    expect(draftUpdate["t25-gpu-pass-timing"]).toBe(true);
    // 重渲染(草稿生效)后按「应用并重载」
    state.slots[1] = { ...readStates(), "t25-gpu-pass-timing": true };
    const tree2 = renderPanel();
    const apply = footerButtons(tree2).find((node) => textOf(node.props.children).includes("应用并重载"))!;
    apply.props.onClick();
    expect(state.hrefWrites).toHaveLength(1);
    const written = new URL(state.hrefWrites[0]!);
    expect(written.pathname).toBe("/studio/new"); // 场景路由保留
    expect(written.searchParams.get("t25-gpu-pass-timing")).toBe("1");
    expect(written.searchParams.has("mega-lights")).toBe(false); // 未开的 opt-in 不写入
  });

  it("链接生成:复制按钮把草稿态带参链接交给剪贴板,并勾选未开项;成功转「已复制」", async () => {
    state.copy.mockResolvedValue(undefined);
    locationState.search = "?sdf-gi=1";
    state.slots[1] = { ...readStates(), "sdf-gi": true, "mega-lights": true };
    const tree = renderPanel();
    const copy = footerButtons(tree).find((node) => textOf(node.props.children).includes("复制带参链接"))!;
    copy.props.onClick();
    await vi.waitFor(() => expect(state.copy).toHaveBeenCalledTimes(1));
    const copiedHref = state.copy.mock.calls[0]![0] as string;
    const params = new URL(copiedHref).searchParams;
    expect(params.get("sdf-gi")).toBe("1");
    expect(params.get("mega-lights")).toBe("1");
    // 成功后 slot 3 转 copied,重渲染出现「已复制」
    state.slots[3] = "copied";
    const rerendered = renderPanel();
    expect(textOf(rerendered.map((node) => node as unknown as ReactNode))).toContain("已复制");
  });

  it("依赖提示:f4 开而 t07 关时行内警告出现;t07 同开后警告消失", () => {
    locationState.search = "";
    state.slots[1] = { ...readStates(), "f4-temporal-upscale": true };
    const warned = renderPanel();
    const f4Row = findByTestId(warned, "ef-row-f4-temporal-upscale")!;
    expect(String(f4Row.props.className)).toContain("warn");
    expect(textOf(f4Row.props.children as ReactNode)).toContain("需与「动态内部分辨率」同开");
    state.slots[1] = { ...readStates(), "f4-temporal-upscale": true, "t07-dynamic-resolution": true };
    const clean = renderPanel();
    const f4RowClean = findByTestId(clean, "ef-row-f4-temporal-upscale")!;
    expect(String(f4RowClean.props.className)).not.toContain("warn");
  });

  it("复制失败:降级为可见失败文案(role=status),不静默", async () => {
    state.copy.mockRejectedValue(new Error("denied"));
    locationState.search = "";
    const tree = renderPanel();
    const copy = footerButtons(tree).find((node) => textOf(node.props.children).includes("复制带参链接"))!;
    copy.props.onClick();
    await vi.waitFor(() => expect(state.copy).toHaveBeenCalledTimes(1));
    state.slots[3] = "failed";
    const rerendered = renderPanel();
    const statusNode = rerendered.find((node) => node.props.role === "status")!;
    expect(textOf(statusNode.props.children as ReactNode)).toContain("复制失败");
  });

  it("样式纪律:数值 tabular-nums,不引入硬编码色值(令牌唯一来源 base.css),面板层级用 --layer-panel", async () => {
    const { readFile } = await import("node:fs/promises");
    const css = await readFile(new URL("./ExperimentalFeaturesPanel.css", import.meta.url), "utf8");
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/); // 颜色一律 var()/color-mix,阴影允许黑色 alpha
    expect(css).toContain("var(--layer-panel)");
  });
});

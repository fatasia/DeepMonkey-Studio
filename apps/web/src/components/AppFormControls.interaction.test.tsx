import { isValidElement, type ReactNode, type ReactElement } from "react";
import { beforeEach, expect, it, vi } from "vitest";
// F6 对抗修复的交互回归：非法数字输入不再静默回退——保留草稿、红框标记、回调一次性提示；
// 合法提交清除标记并按界限钳制。状态单元与 DashboardLayerList.interaction.test 同款自制夹具。
const state = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => state.cells[state.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.cells)) state.cells[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [state.cells[index], (next: any) => { state.cells[index] = typeof next === "function" ? next(state.cells[index]) : next; }];
  },
  // 组件外同步直调不经过 React 渲染器,副作用钩子按收集器口径空转(夹具不走 effect 重放)。
  useEffect: () => undefined,
}));
import { DeferredNumberInput, TransformFields } from "./AppFormControls";
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  // 函数组件在夹具里同步展开(mock hooks 下安全),穿透到原生元素。
  if (typeof node.type === "function") return walk((node.type as (props: Record<string, any>) => ReactNode)(node.props));
  return [node as Element, ...walk(node.props.children)];
}
function renderInput(props: Record<string, any>) { state.cursor = 0; return walk(DeferredNumberInput(props as any))[0]!; }

beforeEach(() => {
  state.cells = [];
  state.cursor = 0;
});

it("keeps an invalid draft, flags red border and calls the invalid callback instead of silently reverting", () => {
  const onCommit = vi.fn();
  const onInvalidInput = vi.fn();
  // 夹具 setState 直接写 cells、不重放渲染,事件闭包须从最新一次 render 取。
  let input = renderInput({ ariaLabel: "位置 X", value: 0, onCommit, onInvalidInput });
  input.props.onChange({ currentTarget: { value: "abc" } });
  input = renderInput({ ariaLabel: "位置 X", value: 0, onCommit, onInvalidInput });
  input.props.onBlur();
  expect(onInvalidInput).toHaveBeenCalledWith("abc");
  expect(onCommit).not.toHaveBeenCalled();
  input = renderInput({ ariaLabel: "位置 X", value: 0, onCommit, onInvalidInput });
  expect(input.props.className).toContain("numeric-input-invalid");
  expect(input.props["aria-invalid"]).toBe(true);
  expect(input.props.value).toBe("abc");
});

it("clears the invalid flag after a valid commit and clamps to the transform bounds", () => {
  const onCommit = vi.fn();
  const props = { ariaLabel: "位置 X", value: 0, min: -1e6, max: 1e6, onCommit };
  let input = renderInput(props);
  input.props.onChange({ currentTarget: { value: "abc" } });
  input = renderInput(props);
  input.props.onBlur();
  input = renderInput(props);
  expect(input.props.className).toContain("numeric-input-invalid");
  input.props.onChange({ currentTarget: { value: "5" } });
  input = renderInput(props);
  input.props.onBlur();
  expect(onCommit).toHaveBeenCalledWith(5);
  input = renderInput(props);
  expect(input.props.className).not.toContain("numeric-input-invalid");
  input.props.onChange({ currentTarget: { value: "-99999999999" } });
  input = renderInput(props);
  input.props.onBlur();
  expect(onCommit).toHaveBeenCalledWith(-1e6);
});

it("bounds every transform axis to the scene-scale limit by default", () => {
  state.cells = [];
  state.cursor = 0;
  const fields = walk(TransformFields({ title: "位置", transform: { x: 1, y: 2, z: 3 }, onChange: vi.fn() }));
  const inputs = fields.filter(item => item.type === "input");
  expect(inputs).toHaveLength(3);
  for (const input of inputs) {
    expect(input.props["data-min"]).toBe(-1e6);
    expect(input.props["data-max"]).toBe(1e6);
  }
});

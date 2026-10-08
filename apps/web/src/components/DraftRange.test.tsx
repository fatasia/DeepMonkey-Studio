import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const hooks = vi.hoisted(() => ({ cursor: 0, cells: [] as any[], effects: [] as (() => void)[], cleanup: [] as (() => void)[] }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => hooks.cells[hooks.cursor++] ??= { current: value },
  useState: (value: unknown) => { const i = hooks.cursor++; if (!(i in hooks.cells)) hooks.cells[i] = value;
    return [hooks.cells[i], (next: unknown) => { hooks.cells[i] = next; }]; },
  useEffect: (effect: () => (() => void) | void, deps: unknown[]) => {
    const i = hooks.cursor++;
    const old = hooks.cells[i];
    if (old && deps.every((value, index) => Object.is(old[index], value))) return;
    hooks.cells[i] = deps;
    hooks.effects.push(() => { const clean = effect(); if (clean) hooks.cleanup.push(clean); });
  },
}));
import { DraftRange } from "./DraftRange";
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node as Element, ...walk(node.props.children)];
}
function render(props: Parameters<typeof DraftRange>[0]) {
  hooks.cursor = 0;
  const tree = walk(DraftRange(props));
  hooks.effects.splice(0).forEach(effect => effect());
  return { input: tree.find(node => node.type === "input")!, output: tree.find(node => node.type === "output")!, tree };
}
const change = (input: Element, next: number) => input.props.onChange({ currentTarget: { valueAsNumber: next } });
function fixture(overrides: Partial<Parameters<typeof DraftRange>[0]> = {}) {
  return { value: 1, min: 0, max: 20, step: 0.05, label: "强度", onChange: vi.fn(), onPreview: vi.fn(), ...overrides };
}
beforeEach(() => { hooks.cells = []; hooks.effects = []; hooks.cleanup = []; hooks.cursor = 0; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it("previews all 121 input events while keeping application commits at one and the thumb local", () => {
  const props = fixture();
  for (let i = 0; i <= 120; i++) change(render(props).input, i / 10);
  expect(props.onPreview).toHaveBeenCalledTimes(121);
  expect(props.onChange).not.toHaveBeenCalled();
  expect(render(props).input.props.value).toBe(12);
  expect(render(props).output.props.children).toBe("12.00");
  render(props).input.props.onPointerUp();
  expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(props.onChange).toHaveBeenCalledWith(12);
  render({ ...props, value: 12 }).input.props.onBlur();
  expect(props.onChange).toHaveBeenCalledTimes(1);
});
it("ignores stale controlled values during drag and synchronizes external updates while idle", () => {
  const props = fixture(); change(render(props).input, 9);
  expect(render({ ...props, value: 2 }).input.props.value).toBe(9);
  render(props).input.props.onPointerUp();
  render({ ...props, value: 6 });
  expect(render({ ...props, value: 6 }).input.props.value).toBe(6);
});
it("Esc and pointer cancellation restore the gesture origin in both the engine and thumb", () => {
  const props = fixture(); change(render(props).input, 9);
  const stopPropagation = vi.fn();
  render(props).input.props.onKeyDown({ key: "Escape", stopPropagation });
  expect(stopPropagation).toHaveBeenCalled();
  expect(props.onChange).toHaveBeenLastCalledWith(1);
  expect(render(props).input.props.value).toBe(1);
  change(render(props).input, 8); render(props).input.props.onPointerCancel();
  expect(props.onChange).toHaveBeenLastCalledWith(1);
});
it("finishes keyboard arrows and Enter immediately and clamps nonfinite/extreme input", () => {
  const props = fixture(); change(render(props).input, NaN);
  expect(props.onPreview).not.toHaveBeenCalled();
  change(render(props).input, 50); render(props).input.props.onKeyUp({ key: "End" });
  expect(props.onChange).toHaveBeenLastCalledWith(20);
  change(render(props).input, -3);
  const blur = vi.fn(); render(props).input.props.onKeyDown({ key: "Enter", currentTarget: { blur } });
  expect(props.onChange).toHaveBeenLastCalledWith(0); expect(blur).toHaveBeenCalled();
});
it("coalesces fallback preview callbacks but flushes the final value without waiting", () => {
  const props = fixture({ onPreview: undefined }); change(render(props).input, 3); change(render(props).input, 4);
  vi.advanceTimersByTime(100); expect(props.onChange).toHaveBeenCalledTimes(1);
  expect(props.onChange).toHaveBeenCalledWith(4);
  change(render(props).input, 8); render(props).input.props.onBlur();
  expect(props.onChange).toHaveBeenLastCalledWith(8);
  vi.advanceTimersByTime(500); expect(props.onChange).toHaveBeenCalledTimes(2);
});
it("keeps the original object's callback on teardown instead of writing to a new selection", () => {
  const props = fixture(); change(render(props).input, 5);
  const otherCommit = vi.fn(); render({ ...props, onChange: otherCommit });
  hooks.cleanup.forEach(clean => clean());
  expect(props.onChange).toHaveBeenCalledWith(5); expect(otherCommit).not.toHaveBeenCalled();
});
it("disabling cancels a pending gesture and numeric entry retains the established deferred commit path", () => {
  const props = fixture({ numeric: true }); change(render(props).input, 5);
  render({ ...props, disabled: true });
  expect(props.onChange).toHaveBeenLastCalledWith(1);
  const number = render(props).tree.find(node => typeof node.type === "function")!;
  number.props.onCommit(7); expect(props.onChange).toHaveBeenLastCalledWith(7);
});

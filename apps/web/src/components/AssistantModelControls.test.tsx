import { isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ cursor: 0, catalog: undefined as any, revision: vi.fn(), effects: [] as Array<() => void> }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(), useEffect: (effect: () => void) => { state.effects.push(effect); },
  useState: () => { const index = state.cursor++; return index === 0 ? [state.catalog, vi.fn()] : index === 1 ? [false, vi.fn()] : [0, state.revision]; },
}));
vi.mock("../api", () => ({ api: { getAssistantModels: vi.fn() } }));
import { AssistantModelControls } from "./AssistantModelControls";
function walk(node: ReactNode): ReactElement<Record<string, any>>[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  if (!isValidElement<Record<string, any>>(node)) return [];
  return [node, ...walk(node.props.children)];
}
beforeEach(() => { state.cursor = 0; state.effects = []; state.revision.mockClear(); state.catalog = { defaultModel: "primary", catalogAvailable: true,
  models: [{ id: "primary", reasoningEfforts: ["minimal", "standard", "deep"] }, { id: "other", reasoningEfforts: [] }] }; });
it("offers retry when the authenticated route succeeds with a degraded provider catalog", () => {
  state.catalog.catalogAvailable = false;
  const nodes = walk(AssistantModelControls({ locale: "zh-CN", mode: "platform", value: {}, onChange: vi.fn() }));
  const retry = nodes.find(node => node.type === "button")!;
  expect(retry.props.children).toContain("重试"); retry.props.onClick();
  expect(state.revision).toHaveBeenCalled();
  expect(nodes.find(node => node.props["aria-label"] === "会话模型")?.props.disabled).toBe(false);
});
it("drops the previous model's effort when switching and disables unsupported reasoning", () => {
  const onChange = vi.fn();
  const nodes = walk(AssistantModelControls({ locale: "zh-CN", mode: "platform", value: { model: "other", reasoningEffort: "deep" }, onChange }));
  expect(nodes.find(node => node.props["aria-label"] === "会话思考档位")?.props.disabled).toBe(true);
  nodes.find(node => node.props["aria-label"] === "会话模型")!.props.onChange({ target: { value: "primary" } });
  expect(onChange).toHaveBeenCalledWith({ model: "primary" });
});
it("disables both controls for SQL's independent managed query service", () => {
  const nodes = walk(AssistantModelControls({ locale: "zh-CN", mode: "sql", value: {}, onChange: vi.fn() }));
  expect(nodes.filter(node => node.type === "select").every(node => node.props.disabled)).toBe(true);
});
it("clears options removed by a successful catalog refresh but preserves them during an outage", () => {
  const onChange = vi.fn();
  AssistantModelControls({ locale: "zh-CN", mode: "platform", value: { model: "removed" }, onChange });
  state.effects.at(-1)?.(); expect(onChange).toHaveBeenCalledWith({});
  onChange.mockClear(); state.cursor = 0; state.catalog.catalogAvailable = false;
  AssistantModelControls({ locale: "zh-CN", mode: "platform", value: { model: "removed" }, onChange });
  state.effects.at(-1)?.(); expect(onChange).not.toHaveBeenCalled();
});
it("compact mode keeps only the model picker and shows reasoning only when the model supports it", () => {
  const withEfforts = walk(AssistantModelControls({ locale: "zh-CN", mode: "platform", value: {}, onChange: vi.fn(), compact: true }));
  expect(withEfforts.filter(node => node.type === "select").map(node => node.props["aria-label"])).toEqual(["会话模型", "会话思考档位"]);
  expect(withEfforts.some(node => node.type === "small")).toBe(false);
  state.cursor = 0;
  const without = walk(AssistantModelControls({ locale: "zh-CN", mode: "platform", value: { model: "other" }, onChange: vi.fn(), compact: true }));
  expect(without.filter(node => node.type === "select").map(node => node.props["aria-label"])).toEqual(["会话模型"]);
  state.cursor = 0;
  expect(AssistantModelControls({ locale: "zh-CN", mode: "sql", value: {}, onChange: vi.fn(), compact: true })).toBeNull();
});
it("compact mode offers Auto only when allowed and configured, shows the actual route, and preserves it across effort changes", () => {
  state.catalog.routing = { autoAvailable: true, fastModel: "mini", strongModel: "primary" };
  const onChange = vi.fn();
  const selects = (value: any, extra: Record<string, unknown> = {}) => { state.cursor = 0; return walk(AssistantModelControls({ locale: "zh-CN", mode: "platform", value, onChange, compact: true, ...extra })); };
  const options = (nodes: ReturnType<typeof walk>) => nodes.filter(node => node.type === "option").map(node => node.props.value);
  expect(options(selects({}))).not.toContain("__auto__");
  const offered = selects({}, { allowAuto: true });
  expect(options(offered).slice(0, 3)).toEqual(["", "__auto__", "other"]);
  const picker = offered.find(node => node.props["aria-label"] === "会话模型")!;
  picker.props.onChange({ target: { value: "__auto__" } });
  expect(onChange).toHaveBeenLastCalledWith({ routing: "auto" });
  picker.props.onChange({ target: { value: "" } });
  expect(onChange).toHaveBeenLastCalledWith({});
  const active = selects({ routing: "auto" }, { allowAuto: true, lastRoute: { mode: "auto", tier: "fast", model: "mini", reason: "simple-question" } });
  const activePicker = active.find(node => node.props["aria-label"] === "会话模型")!;
  expect(activePicker.props.value).toBe("__auto__");
  expect(activePicker.props.title).toContain("mini");
  expect(active.find(node => node.type === "option" && node.props.value === "__auto__")!.props.children).toBe("自动 · mini");
  active.find(node => node.props["aria-label"] === "会话思考档位")!.props.onChange({ target: { value: "deep" } });
  expect(onChange).toHaveBeenLastCalledWith({ routing: "auto", reasoningEffort: "deep" });
});

it("drops a stale Auto choice when the service no longer offers it", () => {
  const onChange = vi.fn();
  state.cursor = 0;
  AssistantModelControls({ locale: "zh-CN", mode: "platform", value: { routing: "auto", reasoningEffort: "deep" }, onChange, compact: true, allowAuto: true });
  state.effects.at(-1)?.();
  expect(onChange).toHaveBeenCalledWith({ reasoningEffort: "deep" });
});

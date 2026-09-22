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

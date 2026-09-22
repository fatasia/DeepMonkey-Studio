import { isValidElement, type ReactNode, type ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({ cursor: 0, cells: [] as any[], effects: [] as Array<() => void>, get: vi.fn(), save: vi.fn() }));
vi.mock("../api", () => ({ api: { getBranding: h.get, saveBranding: h.save } }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (initial: unknown) => { const i = h.cursor++; return h.cells[i] ??= { current: initial }; },
  useState: (initial: unknown) => { const i = h.cursor++; if (!(i in h.cells)) h.cells[i] = initial;
    return [h.cells[i], (value: unknown) => { h.cells[i] = value; }]; },
  useEffect: (effect: () => void) => { const i = h.cursor++; if (!h.cells[i]) { h.cells[i] = true; h.effects.push(effect); } },
}));
import { PerformanceMaintenancePanel } from "./PerformanceMaintenancePanel";
type Element = ReactElement<Record<string, any>>;
function walk(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(walk);
  return isValidElement<Record<string, any>>(node) ? [node, ...walk(node.props.children)] : [];
}
function render(onError = vi.fn()) {
  h.cursor = 0;
  const nodes = walk(PerformanceMaintenancePanel({ locale: "zh-CN", onError }));
  h.effects.splice(0).forEach(effect => effect());
  return { toggle: nodes.find(node => node.props.type === "checkbox")!, message: nodes.find(node => node.type === "input" && node.props.type !== "checkbox")! };
}
async function flush() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
beforeEach(() => { h.cells = []; h.effects = []; vi.resetAllMocks(); h.get.mockResolvedValue({ maintenanceEnabled: false, maintenanceMessage: "已保存" }); });
describe("maintenance save state", () => {
  it("keeps confirmed mode after failure and prevents duplicate in-flight saves", async () => {
    const error = vi.fn(); let reject!: (error: Error) => void;
    h.save.mockImplementation(() => new Promise((_resolve, fail) => { reject = fail; }));
    render(error); await flush(); const current = render(error);
    current.toggle.props.onChange({ currentTarget: { checked: true } });
    current.toggle.props.onChange({ currentTarget: { checked: true } });
    expect(h.save).toHaveBeenCalledTimes(1);
    expect(render(error).toggle.props.checked).toBe(false);
    reject(new Error("offline")); await flush();
    expect(render(error).toggle.props.disabled).toBe(false);
    expect(render(error).toggle.props.checked).toBe(false);
    expect(error).toHaveBeenCalledWith("offline");
  });
  it("does not save unchanged text or reload on a new error callback", async () => {
    render(); await flush(); render().message.props.onBlur();
    expect(h.save).not.toHaveBeenCalled(); expect(h.get).toHaveBeenCalledTimes(1);
  });
  it("restores saved text after a rejected edit, and applies confirmed successful mode", async () => {
    render(); await flush(); render().message.props.onChange({ currentTarget: { value: "未保存" } });
    h.save.mockRejectedValueOnce(new Error("failed")); render().message.props.onBlur(); await flush();
    expect(render().message.props.value).toBe("已保存");
    h.save.mockResolvedValueOnce({ maintenanceEnabled: true, maintenanceMessage: "已保存" });
    render().toggle.props.onChange({ currentTarget: { checked: true } }); await flush();
    expect(render().toggle.props.checked).toBe(true);
  });
});

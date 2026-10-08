import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as any[], effects: [] as Array<() => void>,
  cleanups: [] as Array<(() => void) | undefined>, start: vi.fn(), catalog: vi.fn(), settings: vi.fn() }));
vi.mock("react", async original => ({ ...await original<typeof import("react")>(),
  useRef: (value: unknown) => harness.cells[harness.cursor++] ??= { current: value },
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.cells)) harness.cells[index] = initial;
    return [harness.cells[index], (value: any) => { harness.cells[index] = typeof value === "function" ? value(harness.cells[index]) : value; }];
  },
  useMemo: (compute: () => unknown) => compute(),
  useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
    const index = harness.cursor++, prior = harness.cells[index] as unknown[] | undefined;
    if (!prior || prior.some((value, slot) => !Object.is(value, deps[slot]))) {
      harness.cells[index] = deps;
      harness.effects.push(() => { harness.cleanups[index]?.(); harness.cleanups[index] = effect() || undefined; });
    }
  },
}));
vi.mock("../hooks/useSceneEditLoop", () => ({ useSceneEditLoop: () => ({ busy: false }) }));
vi.mock("../api", () => ({ api: { startIndustrialAgentRun: harness.start,
  listIndustrialAgentTools: harness.catalog, getAgentAutonomySettings: harness.settings } }));
import { IndustrialAgentWorkspace } from "./IndustrialAgentWorkspace";

function render(projectId = "project-A") {
  harness.cursor = 0;
  const tree = IndustrialAgentWorkspace({ locale: "zh-CN", projectId, context: { source: "test" } });
  harness.effects.splice(0).forEach(effect => effect());
  return tree;
}
function find(tree: any, predicate: (node: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) { for (const node of tree) { const found = find(node, predicate); if (found) return found; } return; }
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function limit(tree: unknown) { return find(tree, node => node.type === "select" && node.props["aria-label"] === "运行预算")!.props; }
async function flush() { for (let n = 0; n < 25; n++) await Promise.resolve(); }
async function ready() { render(); await flush(); return render(); }
async function run() {
  const tree = render();
  find(tree, node => node.type === "textarea")!.props.onChange({ target: { value: "Read the project data" } });
  const button = find(render(), node => node.type === "button" && node.props["aria-label"] === "预览并运行")!;
  expect(button.props.disabled).toBe(false);
  button.props.onClick();
  await flush();
}

beforeEach(() => {
  harness.cleanups.forEach(cleanup => cleanup?.());
  harness.cursor = 0; harness.cells = []; harness.effects = []; harness.cleanups = []; vi.resetAllMocks();
  harness.catalog.mockResolvedValue({ tools: [{ id: "data.query.read", effect: "read", risk: "low", requiresApproval: false }] });
  harness.settings.mockResolvedValue({ settings: { mode: "confirm" } });
  harness.start.mockResolvedValue({ id: "run-A", projectId: "project-A", status: "completed", revision: 1 });
});

describe("Agent run time limit consumer", () => {
  it("keeps the historical 90-second default in the actual start request", async () => {
    expect(limit(await ready()).value).toBe(90_000);
    await run();
    expect(harness.start).toHaveBeenCalledWith("project-A", expect.objectContaining({
      budget: { maxSteps: 10, maxToolCalls: 6, maxDurationMs: 90_000 },
    }));
  });
  it.each([180_000, 300_000])("sends an explicitly chosen %i ms limit to the existing API", async value => {
    limit(await ready()).onChange({ target: { value: String(value) } });
    expect(limit(render()).value).toBe(value);
    await run();
    expect(harness.start.mock.calls[0]![1].budget).toEqual({ maxSteps: 10, maxToolCalls: 6, maxDurationMs: value });
  });
  it("rejects unsupported values and resets the choice on project change", async () => {
    limit(await ready()).onChange({ target: { value: "300000" } });
    limit(render()).onChange({ target: { value: "900001" } });
    expect(limit(render()).value).toBe(300_000);
    render("project-B"); await flush();
    expect(limit(render("project-B")).value).toBe(90_000);
  });
  it("locks the time limit while the start request is pending", async () => {
    await ready();
    harness.start.mockReturnValue(new Promise(() => undefined));
    await run();
    expect(limit(render()).disabled).toBe(true);
  });
});

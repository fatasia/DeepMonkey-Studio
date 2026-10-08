import type { ReactElement } from "react";
import type { DataPipelineDefinition } from "@bim-studio/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({ cursor: 0, cells: [] as any[], effects: [] as Array<() => void>,
  cleanups: [] as Array<(() => void) | undefined>, list: vi.fn(), save: vi.fn(), preview: vi.fn(), error: vi.fn() }));
vi.mock("react", async importOriginal => ({ ...await importOriginal<typeof import("react")>(),
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
vi.mock("../api", () => ({ api: { listDataPipelines: harness.list, saveDataPipeline: harness.save, previewDataPipeline: harness.preview } }));
vi.mock("./DataPipelineCanvas", () => ({ DataPipelineCanvas: "graph" }));
vi.mock("./DataPipelineLibrary", () => ({ DataPipelineLibrary: "library" }));
vi.mock("./DataPipelineDebugPanel", () => ({ DataPipelineDebugPanel: "debug" }));
vi.mock("./usePipelineHistory", () => ({ usePipelineHistory: (_: unknown, change: unknown) => ({ commit: change, canUndo: false, canRedo: false }) }));
import { DataPipelineStudio } from "./DataPipelineStudio";

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { resolve, reject, promise }; }
function definition(projectId: string): DataPipelineDefinition {
  return { id: `${projectId}-flow`, projectId, name: "flow", createdAt: "2026-10-07", updatedAt: "2026-10-07",
    nodes: [{ id: "source", type: "source", datasetId: "data", name: "source", position: { x: 0, y: 0 } },
      { id: "output", type: "output", name: "output", position: { x: 240, y: 0 } }],
    edges: [{ id: "edge", sourceNodeId: "source", targetNodeId: "output" }] };
}
const datasets = [{ id: "data", name: "data", fields: [] }] as any;
function render(projectId = "A") {
  harness.cursor = 0;
  const tree = DataPipelineStudio({ projectId, locale: "zh-CN", datasets, onError: harness.error, onOpenEndpoints: vi.fn() });
  harness.effects.splice(0).forEach(effect => effect()); return tree;
}
function find(tree: any, predicate: (node: ReactElement<any>) => boolean): ReactElement<any> | undefined {
  if (!tree || typeof tree !== "object") return;
  if (Array.isArray(tree)) { for (const item of tree) { const found = find(item, predicate); if (found) return found; } return; }
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}
function graph(tree: any) { return find(tree, node => node.type === "graph")?.props; }
function button(tree: any, text: string) { return find(tree, node => node.type === "button" && Array.isArray(node.props.children) && node.props.children.includes(text))!.props; }
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
beforeEach(() => { harness.cleanups.forEach(cleanup => cleanup?.()); harness.cursor = 0; harness.cells = [];
  harness.effects = []; harness.cleanups = []; vi.resetAllMocks(); });

describe("pipeline async ownership", () => {
  it("ignores an earlier load after leaving and returning to the same project", async () => {
    const first = deferred<DataPipelineDefinition[]>();
    harness.list.mockReturnValueOnce(first.promise).mockResolvedValueOnce([definition("B")]).mockResolvedValueOnce([{ ...definition("A"), name: "latest" }]);
    render("A"); render("B"); await flush(); render("A"); await flush();
    first.resolve([{ ...definition("A"), name: "stale" }]); await flush();
    expect(graph(render("A")).definition.name).toBe("latest");
  });
  it("keeps edits made while save is pending", async () => {
    harness.list.mockResolvedValue([definition("A")]); const saving = deferred<DataPipelineDefinition>();
    harness.save.mockReturnValue(saving.promise); render(); await flush(); const tree = render();
    button(tree, "保存").onClick(); graph(tree).onChange({ ...graph(tree).definition, name: "new edit" }); render();
    saving.resolve({ ...definition("A"), updatedAt: "saved" }); await flush();
    expect(graph(render()).definition.name).toBe("new edit");
  });
  it("drops a preview after the graph changes", async () => {
    harness.list.mockResolvedValue([definition("A")]); harness.save.mockResolvedValue({ ...definition("A"), updatedAt: "saved" });
    const preview = deferred<any>(); harness.preview.mockReturnValue(preview.promise);
    render(); await flush(); button(render(), "运行").onClick(); await flush();
    const tree = render(); graph(tree).onChange({ ...graph(tree).definition, name: "changed" }); render();
    preview.resolve({ status: "error", error: "stale failure", diagnostics: [], rows: [] }); await flush();
    expect(find(render(), node => node.type === "debug")!.props.preview).toBeUndefined();
    expect(harness.error).not.toHaveBeenCalledWith("stale failure");
  });
  it("does not apply a save response to a different project", async () => {
    harness.list.mockImplementation((id: string) => Promise.resolve([definition(id)]));
    const saving = deferred<DataPipelineDefinition>(); harness.save.mockReturnValue(saving.promise);
    render(); await flush(); button(render(), "保存").onClick(); render("B"); await flush();
    saving.resolve({ ...definition("A"), name: "old" }); await flush();
    expect(graph(render("B")).definition.projectId).toBe("B");
  });
});

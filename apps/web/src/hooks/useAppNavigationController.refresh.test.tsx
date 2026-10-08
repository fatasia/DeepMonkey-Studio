import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@bim-studio/contracts";
import type { AppState } from "./useAppState";
import { useAppNavigationController } from "./useAppNavigationController";

const getProject = vi.hoisted(() => vi.fn());
const hooks = vi.hoisted(() => ({ cursor: 0, cells: [] as unknown[] }));
vi.mock("react", () => ({
  useEffect: () => undefined,
  useRef: (value: unknown) => hooks.cells[hooks.cursor++] ??= { current: value },
  useCallback: (callback: unknown, deps: unknown[]) => {
    const index = hooks.cursor++;
    const previous = hooks.cells[index] as { callback: unknown; deps: unknown[] } | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return previous.callback;
    hooks.cells[index] = { callback, deps };
    return callback;
  },
}));
vi.mock("../api", () => ({ api: { getProject } }));
vi.mock("./useManagerDirectoryController", () => ({ useManagerDirectoryController: () => undefined }));
vi.mock("../delivery/sceneViewerDelivery", () => ({ sceneViewerDeliveryRoute: () => undefined }));

const project: ProjectRecord = {
  id: "one", name: "Factory", description: "", models: [],
  createdAt: "2026-10-07T00:00:00Z", updatedAt: "2026-10-07T00:00:00Z",
};

function fixture() {
  const setProject = vi.fn(), setProjects = vi.fn();
  const state = { project, setProject, setProjects, route: { view: "studio" } } as unknown as AppState;
  const result = { current: undefined as unknown as ReturnType<typeof useAppNavigationController> };
  const rerender = ({ value }: { value: AppState }) => {
    hooks.cursor = 0;
    result.current = useAppNavigationController({ state: value, sceneSnapshotFactoryRef: { current: undefined } });
  };
  rerender({ value: state });
  const hook = { result, rerender };
  return { ...hook, state, setProject, setProjects };
}

beforeEach(() => { getProject.mockReset(); hooks.cells = []; hooks.cursor = 0; });

describe("project polling preserves unchanged editor state", () => {
  it("reads the server without scheduling React when the snapshot is unchanged", async () => {
    const f = fixture();
    getProject.mockResolvedValue(structuredClone(project));
    await f.result.current.refreshProject();
    expect(getProject).toHaveBeenCalledExactlyOnceWith("one");
    expect(f.setProject).not.toHaveBeenCalled();
    expect(f.setProjects).not.toHaveBeenCalled();
  });

  it("publishes progress changes even when project updatedAt stays the same", async () => {
    const f = fixture();
    const next = { ...project, models: [{ id: "model", progress: 41 }] } as ProjectRecord;
    getProject.mockResolvedValue(next);
    await f.result.current.refreshProject();
    expect(f.setProject).toHaveBeenCalledExactlyOnceWith(next);
    const update = f.setProjects.mock.calls[0]![0];
    const other = { ...project, id: "other" };
    expect(update([project, other])).toEqual([next, other]);
  });

  it("compares with the latest committed project rather than the callback closure", async () => {
    const f = fixture();
    const next = { ...project, name: "Renamed" };
    f.rerender({ value: { ...f.state, project: next } });
    getProject.mockResolvedValue(structuredClone(next));
    await f.result.current.refreshProject();
    expect(f.setProject).not.toHaveBeenCalled();
    expect(f.setProjects).not.toHaveBeenCalled();
  });

  it("discards an old project's late response after switching projects", async () => {
    const f = fixture();
    let resolve!: (value: ProjectRecord) => void;
    getProject.mockReturnValue(new Promise<ProjectRecord>(done => { resolve = done; }));
    const pending = f.result.current.refreshProject();
    f.rerender({ value: { ...f.state, project: { ...project, id: "other" } } });
    resolve({ ...project, name: "Late" }); await pending;
    expect(f.setProject).not.toHaveBeenCalled();
    expect(f.setProjects).not.toHaveBeenCalled();
  });

  it("publishes an identical new snapshot only once before React renders again", async () => {
    const f = fixture(), next = { ...project, name: "Renamed" };
    getProject.mockImplementation(() => Promise.resolve(structuredClone(next)));
    await f.result.current.refreshProject();
    await f.result.current.refreshProject();
    expect(f.setProject).toHaveBeenCalledExactlyOnceWith(next);
    expect(f.setProjects).toHaveBeenCalledOnce();
  });

  it("does not let a slower poll replace a newer manual refresh", async () => {
    const f = fixture();
    let resolve!: (value: ProjectRecord) => void;
    getProject.mockReturnValueOnce(new Promise<ProjectRecord>(done => { resolve = done; }));
    const pending = f.result.current.refreshProject();
    const next = { ...project, name: "Latest" };
    getProject.mockResolvedValueOnce(next);
    await f.result.current.refreshProject();
    resolve({ ...project, name: "Old poll" }); await pending;
    expect(f.setProject).toHaveBeenCalledExactlyOnceWith(next);
    expect(f.setProjects).toHaveBeenCalledOnce();
  });

  it("invalidates a poll after switching away and back to the same project", async () => {
    const f = fixture();
    let resolve!: (value: ProjectRecord) => void;
    getProject.mockReturnValueOnce(new Promise<ProjectRecord>(done => { resolve = done; }));
    const pending = f.result.current.refreshProject();
    f.rerender({ value: { ...f.state, project: { ...project, id: "other" } } });
    f.rerender({ value: f.state });
    resolve({ ...project, name: "Before switch" }); await pending;
    expect(f.setProject).not.toHaveBeenCalled();
    expect(f.setProjects).not.toHaveBeenCalled();
  });

  it("keeps the polling callback stable when same-project fields change", () => {
    const f = fixture(), refresh = f.result.current.refreshProject;
    f.rerender({ value: { ...f.state, project: { ...project, name: "Renamed" } } });
    expect(f.result.current.refreshProject).toBe(refresh);
  });
});

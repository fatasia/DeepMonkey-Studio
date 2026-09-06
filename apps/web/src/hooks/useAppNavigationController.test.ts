import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@bim-studio/contracts";
import type { AppState } from "./useAppState";

vi.mock("react", () => ({ useEffect: () => undefined, useRef: (current: unknown) => ({ current }), useCallback: (callback: unknown) => callback }));
vi.mock("./useManagerDirectoryController", () => ({ useManagerDirectoryController: () => undefined }));
vi.mock("../delivery/sceneViewerDelivery", () => ({ sceneViewerDeliveryRoute: () => undefined }));
const apiMock = vi.hoisted(() => ({ createProject: vi.fn(), updateProject: vi.fn() }));
vi.mock("../api", () => ({ api: apiMock }));
import { useAppNavigationController } from "./useAppNavigationController";

afterEach(() => { vi.clearAllMocks(); vi.unstubAllGlobals(); });

function fixture() {
  const setters = Object.fromEntries([
    "setError", "setBusy", "setProjects", "setProject", "setMessage", "setNewProjectName", "setNewProjectDescription", "setProjectDialogMode",
    "setActiveScene", "setSceneName", "setSelected", "setMeasurements", "setAnnotations", "setSelectedAnnotationId", "setSelectedSpace", "setExpandedModels",
    "setDigitalTwinOpen", "setRoute", "setRevision", "showError",
  ].map(key => [key, vi.fn()]));
  vi.stubGlobal("window", { history: { replaceState: vi.fn(), pushState: vi.fn() } });
  const state = { ...setters, route: { view: "manager" }, newProjectName: "恢复后的项目", newProjectDescription: "", projectDialogMode: "create",
    projects: [], sceneApplyVersionRef: { current: 0 } } as unknown as AppState;
  const controller = useAppNavigationController({ state, sceneSnapshotFactoryRef: { current: undefined } });
  return { state, controller };
}

describe("explicit project submission recovery", () => {
  it("clears the previous failure before a new write and exposes the successful result", async () => {
    const { state, controller } = fixture();
    apiMock.createProject.mockResolvedValue({ id: "created-project", name: "恢复后的项目" } as ProjectRecord);
    await controller.submitProjectDialog();
    expect(state.setError).toHaveBeenCalledExactlyOnceWith(undefined);
    expect(vi.mocked(state.setError).mock.invocationCallOrder[0]).toBeLessThan(apiMock.createProject.mock.invocationCallOrder[0]!);
    expect(state.setMessage).toHaveBeenLastCalledWith("项目“恢复后的项目”已创建");
    expect(state.setProjectDialogMode).toHaveBeenCalledWith(undefined);
    expect(state.setBusy).toHaveBeenLastCalledWith(false);
  });

  it("does not replay a pending write, then allows an explicit retry after failure", async () => {
    const { state, controller } = fixture();
    let fail!: (reason: unknown) => void;
    apiMock.createProject.mockImplementationOnce(() => new Promise((_resolve, reject) => { fail = reject; }));
    const first = controller.submitProjectDialog();
    await controller.submitProjectDialog();
    expect(apiMock.createProject).toHaveBeenCalledOnce();
    const reason = new Error("temporarily unavailable"); fail(reason); await first;
    expect(state.showError).toHaveBeenCalledWith(reason);
    expect(state.setProjectDialogMode).not.toHaveBeenCalled();
    apiMock.createProject.mockResolvedValueOnce({ id: "retry-project", name: "恢复后的项目" } as ProjectRecord);
    await controller.submitProjectDialog();
    expect(apiMock.createProject).toHaveBeenCalledTimes(2);
    expect(state.setError).toHaveBeenCalledTimes(2);
  });
});

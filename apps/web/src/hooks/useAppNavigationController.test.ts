import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProjectRecord } from "@bim-studio/contracts";
import { createSdkExampleScript } from "../behavior/sdkExampleInsertion";
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

describe("documentation navigation preserves author work", () => {
  function docsFixture(name = "draft.js", locked = false) {
    const base = fixture();
    const draft = { ...createSdkExampleScript("lifecycle", [], () => "draft"), name, code: "UNSAVED",
      ...(locked ? { target: { kind: "component" as const, id: "locked-node" } } : {}),
    };
    const dispatch = vi.fn();
    const state = { ...base.state, route: { view: "dashboard", projectId: "p", applicationId: "a", pageId: "one" },
      pendingBehaviorDraftRef: { current: draft }, applicationSessionRef: { current: { store: { dispatch,
        getState: () => ({ document: { scripts: [], pages: [{ nodes: [{ id: "locked-node", locked }] }], scenes: [] } }),
      } } },
    } as unknown as AppState;
    const controller = useAppNavigationController({ state, sceneSnapshotFactoryRef: { current: undefined } });
    return { state, controller, dispatch };
  }

  it("flushes a named draft into the existing store before opening and returns without a reload", () => {
    const { state, controller, dispatch } = docsFixture();
    controller.openDocs("sdk-examples");
    expect(dispatch).toHaveBeenCalledOnce();
    expect(state.pendingBehaviorDraftRef.current).toBeUndefined();
    expect(state.setRoute).toHaveBeenLastCalledWith({ view: "docs", documentId: "sdk-examples" });
    controller.closeDocs();
    expect(state.setRoute).toHaveBeenLastCalledWith(state.route);
    expect(apiMock.createProject).not.toHaveBeenCalled();
    expect(apiMock.updateProject).not.toHaveBeenCalled();
  });

  it("blocks unnamed drafts and store failures without opening docs or discarding data", () => {
    const unnamed = docsFixture(" ");
    unnamed.controller.openDocs("sdk-examples");
    expect(unnamed.state.setRoute).not.toHaveBeenCalled();
    expect(unnamed.state.setError).toHaveBeenCalledWith("请先填写脚本名称，再离开脚本编辑器");
    expect(unnamed.state.pendingBehaviorDraftRef.current?.code).toBe("UNSAVED");
    const failed = docsFixture();
    failed.dispatch.mockImplementationOnce(() => { throw new Error("store rejected"); });
    failed.controller.openDocs("sdk-examples");
    expect(failed.state.showError).toHaveBeenCalled();
    expect(failed.state.setRoute).not.toHaveBeenCalled();
    expect(failed.state.pendingBehaviorDraftRef.current?.code).toBe("UNSAVED");
  });
  it("preserves a locked target draft without saving or leaving the editor", () => {
    const { controller, state, dispatch } = docsFixture("locked.js", true);
    controller.openDocs("sdk-examples");
    expect(dispatch).not.toHaveBeenCalled();
    expect(state.setRoute).not.toHaveBeenCalled();
    expect(state.pendingBehaviorDraftRef.current?.code).toBe("UNSAVED");
    expect(state.setError).toHaveBeenCalledWith("挂载对象已锁定，草稿已保留，请先解锁");
  });
});

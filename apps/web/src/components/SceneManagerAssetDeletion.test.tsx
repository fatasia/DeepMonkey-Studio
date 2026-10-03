import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord, ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import type { SceneManagerController } from "./SceneManager";
import type { SceneManagerProps } from "./sceneManagerTypes";

let captured: SceneManagerController | undefined;

vi.mock("./SceneManagerView", () => ({
  SceneManagerView: ({ controller }: { controller: SceneManagerController }) => {
    captured = controller;
    return null;
  },
}));

import { SceneManager } from "./SceneManager";

const model: ModelRecord = {
  id: "asset-x", projectId: "p", name: "泵", format: "glb", status: "ready",
  progress: 100, size: 1, message: "ready", sourceUrl: "/pump.glb", createdAt: "now", updatedAt: "now",
} as ModelRecord;

const project: ProjectRecord = {
  id: "p", name: "项目", description: "", models: [model], createdAt: "now", updatedAt: "now",
};

const scene: SceneSnapshot = {
  schemaVersion: 1,
  id: "scene-1",
  projectId: "p",
  name: "厂房",
  camera: {} as SceneSnapshot["camera"],
  models: [{
    modelId: "asset-x", name: "泵", visible: true, opacity: 1,
    transform: { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } },
  }],
  primitives: [],
  measurements: [],
  createdAt: "now",
  updatedAt: "now",
} as unknown as SceneSnapshot;

function props(overrides: Partial<SceneManagerProps> = {}): SceneManagerProps {
  return {
    locale: "zh-CN",
    branding: { systemName: "DeepMonkey Studio", iconUrl: "/brand.svg", copyright: "" },
    projects: [project],
    project,
    scenes: [scene],
    applications: [],
    topologies: [],
    userName: "用户",
    isAdmin: false,
    onProjectChange: vi.fn(),
    onCreateProject: vi.fn(),
    onRenameProject: vi.fn(),
    onDeleteProject: vi.fn(),
    onCreate: vi.fn(),
    onCreateShowcase: vi.fn(),
    showcaseExists: false,
    onOpen: vi.fn(),
    onCopy: vi.fn(),
    onRename: vi.fn(),
    onPublish: vi.fn(),
    onUnpublish: vi.fn(),
    onRestorePublication: vi.fn(),
    onBrowse: vi.fn(),
    onBrowsePublished: vi.fn(),
    onImport: vi.fn(),
    onExportLoose: vi.fn(),
    onExportSingle: vi.fn(),
    onExportGlb: vi.fn(),
    onExportFbx: vi.fn(),
    onDelete: vi.fn(),
    onOptimizer: vi.fn(),
    onParametric: vi.fn(),
    onDataCenter: vi.fn(),
    onCreateTopology: vi.fn(),
    onOpenTopology: vi.fn(),
    onVisionCenter: vi.fn(),
    onOperationsCenter: vi.fn(),
    onAiAssistant: vi.fn(),
    onDocs: vi.fn(),
    onSystem: vi.fn(),
    onBranding: vi.fn(),
    onCloudRender: vi.fn(),
    onLocaleToggle: vi.fn(),
    onConnectionStatus: vi.fn(),
    onCredits: vi.fn(),
    onLogout: vi.fn(),
    onUploadModels: vi.fn(),
    onDeleteModel: vi.fn(),
    onRefreshModels: vi.fn(),
    ...overrides,
  } as SceneManagerProps;
}

describe("SceneManager asset deletion impact", () => {
  beforeEach(() => {
    captured = undefined;
    vi.stubGlobal("window", { confirm: vi.fn(() => false) });
  });

  it("adds field-level asset deletion impact to the existing delete confirmation", async () => {
    renderToStaticMarkup(<SceneManager {...props()} />);
    await captured!.deleteLibraryModel(model);
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("影响范围：共 1 处引用"));
    expect(window.confirm).toHaveBeenCalledWith(expect.stringContaining("models[0].modelId"));
  });
});

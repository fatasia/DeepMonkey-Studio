import { createRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ACCEPTED_MODELS } from "../appDefaults";
import { ProjectAssetToolbar } from "./ProjectAssetToolbar";
import type { SceneManagerController } from "./SceneManager";

function createController(overrides: Partial<SceneManagerController> = {}) {
  return {
    imageUploadRef: createRef<HTMLInputElement>(),
    locale: "zh-CN",
    modelLibraryBusy: false,
    modelUploadRef: createRef<HTMLInputElement>(),
    onParametric: vi.fn(),
    onOptimizer: vi.fn(),
    project: undefined,
    refreshLibraryModels: vi.fn(),
    uploadLibraryImages: vi.fn(),
    uploadLibraryModels: vi.fn(),
    uploadLibraryVideos: vi.fn(),
    videoUploadRef: createRef<HTMLInputElement>(),
    ...overrides,
  } as SceneManagerController;
}

describe("ProjectAssetToolbar", () => {
  it("hides model workflow entries when opened directly from the asset library", () => {
    const html = renderToStaticMarkup(<ProjectAssetToolbar controller={createController()} />);

    expect(html).not.toContain("上传模型");
    expect(html).not.toContain("导入与优化");
    expect(html).not.toContain(`accept="${ACCEPTED_MODELS}"`);
    expect(html).toContain("上传图片");
    expect(html).toContain("上传视频");
  });

  it("shows model workflow entries in an editor return context", () => {
    const html = renderToStaticMarkup(<ProjectAssetToolbar controller={createController({ onReturnToScene: vi.fn() })} />);

    expect(html).toContain("上传模型");
    expect(html).toContain("导入与优化");
    expect(html).toContain(`accept="${ACCEPTED_MODELS}"`);
  });
});

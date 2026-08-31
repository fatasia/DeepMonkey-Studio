import { describe, expect, it } from "vitest";
import { publicationSuccessMessage } from "./scenePublicationMessage";

describe("publication success message", () => {
  it("区分网页渲染与云渲染的真实状态", () => {
    expect(publicationSuccessMessage({ locale: "zh-CN", sceneName: "产线", mode: "webgpu-preferred", performanceProfile: "fast" })).toContain("WebGPU 优先 · 自动优化");
    expect(publicationSuccessMessage({ locale: "zh-CN", sceneName: "产线", mode: "cloud", performanceProfile: "standard", cloudViewerReady: false })).toContain("正在建立");
    expect(publicationSuccessMessage({ locale: "en-US", sceneName: "Line", mode: "cloud", performanceProfile: "standard", cloudViewerReady: true })).toContain("cloud rendering started");
  });
});

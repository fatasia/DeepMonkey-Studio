import { Object3D, PerspectiveCamera, Scene, type WebGLRenderer } from "three";
import { describe, expect, it, vi } from "vitest";
import { captureModelThumbnail } from "./captureModelThumbnail";

describe("model preview capture", () => {
  it("captures only the rendered frame and restores each helper's prior visibility", async () => {
    const visible = new Object3D(); const hidden = new Object3D(); hidden.visible = false;
    const blob = new Blob(["pixels"], { type: "image/png" });
    const render = vi.fn();
    const toBlob = vi.fn((done: BlobCallback) => {
      expect(visible.visible).toBe(false); expect(hidden.visible).toBe(false);
      done(blob);
    });
    const renderer = { render, domElement: { toBlob } } as unknown as WebGLRenderer;
    expect(await captureModelThumbnail(renderer, new Scene(), new PerspectiveCamera(), [visible, hidden])).toBe(blob);
    expect(visible.visible).toBe(true); expect(hidden.visible).toBe(false);
    expect(render).toHaveBeenCalledTimes(2);
    expect(toBlob.mock.calls[0]?.length).toBe(2);
  });
  it("reports failed pixel reads without leaving helpers hidden", async () => {
    const helper = new Object3D();
    const renderer = { render: vi.fn(), domElement: { toBlob: (done: BlobCallback) => done(null) } } as unknown as WebGLRenderer;
    await expect(captureModelThumbnail(renderer, new Scene(), new PerspectiveCamera(), [helper])).rejects.toThrow("预览图生成失败");
    expect(helper.visible).toBe(true);
  });
});

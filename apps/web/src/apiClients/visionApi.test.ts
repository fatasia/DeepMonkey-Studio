import { describe, expect, it, vi } from "vitest";
import { createVisionApi } from "./visionApi";

describe("vision API client", () => {
  it("creates a protocol-aware live source", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createVisionApi(request);

    await api.createVisionSource("project-1", {
      name: "Line camera",
      kind: "video",
      protocol: "rtsp",
      sourceUrl: "rtsp://camera.local/live",
      playbackProtocol: "webrtc",
    });

    expect(request).toHaveBeenCalledWith("/api/projects/project-1/vision/sources", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(String(request.mock.calls[0]![1]?.body))).toMatchObject({ protocol: "rtsp", playbackProtocol: "webrtc" });
  });

  it("uploads image and video sources through the vision domain endpoint", async () => {
    const request = vi.fn().mockResolvedValue({});
    const api = createVisionApi(request);
    const file = new File(["video"], "line.mp4", { type: "video/mp4" });

    await api.uploadVisionSource("project-1", file, "Line recording");

    const [url, init] = request.mock.calls[0]!;
    expect(url).toBe("/api/projects/project-1/vision/sources/upload?name=Line%20recording");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeInstanceOf(FormData);
    expect((init?.body as FormData).get("file")).toBe(file);
  });
});

import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { VisionSourceRecord } from "@bim-studio/contracts";
import {
  inferVisionSourceProtocol,
  resolveVisionStream,
  validateVisionStreamUrl,
  visionSourceFilePath,
  visionUploadContentType,
} from "./visionSources.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("vision source protocols", () => {
  it("validates the production ingest protocols explicitly", () => {
    expect(inferVisionSourceProtocol("rtsp://camera.local/live")).toBe("rtsp");
    expect(inferVisionSourceProtocol("rtmps://media.local/live")).toBe("rtmp");
    expect(inferVisionSourceProtocol("srt://media.local:9000?mode=caller")).toBe("srt");
    expect(inferVisionSourceProtocol("wheps://media.local/camera")).toBe("webrtc");
    expect(validateVisionStreamUrl("https://media.local/live/index.m3u8", "hls").pathname).toBe("/live/index.m3u8");
    expect(() => validateVisionStreamUrl("https://media.local/live.mp4", "hls")).toThrow(".m3u8");
    expect(() => validateVisionStreamUrl("javascript:alert(1)", "webrtc")).toThrow("协议与地址不匹配");
  });

  it("uses direct HLS for browser playback and server frame extraction", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await resolveVisionStream("https://media.local/live/index.m3u8", "hls", "hls", "studio.local");
    expect(result).toEqual({
      playbackUrl: "https://media.local/live/index.m3u8",
      playbackProtocol: "hls",
      frameUrl: "https://media.local/live/index.m3u8",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns WebRTC playback but keeps an HLS frame extraction URL", async () => {
    vi.stubEnv("MEDIA_GATEWAY_CONTROL_URL", "http://gateway:9997");
    vi.stubEnv("MEDIA_GATEWAY_HLS_URL", "https://media.local:8888");
    vi.stubEnv("MEDIA_GATEWAY_WEBRTC_URL", "https://media.local:8889");
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveVisionStream("rtsp://camera.local/live", "rtsp", "webrtc", "studio.local");

    expect(result.playbackProtocol).toBe("webrtc");
    expect(result.playbackUrl).toMatch(/^https:\/\/media\.local:8889\/vision-[a-f0-9]{16}$/);
    expect(result.frameUrl).toMatch(/^https:\/\/media\.local:8888\/vision-[a-f0-9]{16}\/index\.m3u8$/);
    expect(JSON.parse(String(fetchMock.mock.calls[0]![1]?.body))).toEqual({ source: "rtsp://camera.local/live", sourceOnDemand: true });
  });
});

describe("vision uploaded sources", () => {
  it("classifies supported image and video formats", () => {
    expect(visionUploadContentType("inspection.TIFF")).toEqual({ kind: "image", mimeType: "image/tiff" });
    expect(visionUploadContentType("line-recording.mkv")).toEqual({ kind: "video", mimeType: "video/x-matroska" });
    expect(visionUploadContentType("payload.exe")).toBeUndefined();
  });

  it("resolves only an uploaded source inside its project directory", () => {
    const source = {
      id: "source-1",
      protocol: "upload",
      fileName: "line.mp4",
    } as VisionSourceRecord;
    expect(visionSourceFilePath("D:\\data", "project-1", source)).toBe(path.resolve("D:\\data", "projects", "project-1", "vision", "sources", "source-1", "line.mp4"));
    expect(() => visionSourceFilePath("D:\\data", "project-1", { ...source, fileName: "../escape.mp4" })).toThrow("路径越界");
  });
});

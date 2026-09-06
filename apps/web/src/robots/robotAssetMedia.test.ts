import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelRecord } from "@bim-studio/contracts";
import type { ViewerEngine } from "../viewer/ViewerEngine";
const mocks = vi.hoisted(() => ({ load: vi.fn(), download: vi.fn(), capture: vi.fn() }));
vi.mock("../viewer/viewerAssetTransport", () => ({ loadViewerAssetBuffer: mocks.load }));
vi.mock("../browserDownload", () => ({ downloadBlob: mocks.download }));
vi.mock("../studio/sceneThumbnailCapture", () => ({ captureSceneThumbnail: mocks.capture }));
import { downloadRobotScreenshot, downloadRobotSource, robotSourceFileName } from "./robotAssetMedia";

beforeEach(() => { vi.clearAllMocks(); });
describe("robot asset media", () => {
  const model = { name: "重命名机械臂", format: "zip", sourceUrl: "/assets/robot.zip", size: 3 } as ModelRecord;
  it("downloads unchanged source bytes with the correct original format after renaming", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer; mocks.load.mockResolvedValue(bytes);
    await downloadRobotSource(model);
    const [blob, filename] = mocks.download.mock.calls[0]!;
    expect(filename).toBe("重命名机械臂.zip"); expect(blob.type).toBe("application/zip");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(mocks.load).toHaveBeenCalledWith(model.sourceUrl, "机器人原包", undefined);
    expect(robotSourceFileName({ name: "robot.URDF", format: "urdf" })).toBe("robot.URDF");
    expect(robotSourceFileName({ name: "../robot", format: "zip" })).toBe(".._robot.zip");
  });
  it("rejects changed lengths, wrong formats and failed downloads without a substitute file", async () => {
    mocks.load.mockResolvedValue(new ArrayBuffer(1));
    await expect(downloadRobotSource(model)).rejects.toThrow("大小");
    await expect(downloadRobotSource({ ...model, format: "glb" })).rejects.toThrow("原始资源");
    mocks.load.mockRejectedValue(new Error("401"));
    await expect(downloadRobotSource(model)).rejects.toThrow("401");
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("does not download a completed request after its workspace was cancelled", async () => {
    const controller = new AbortController();
    mocks.load.mockImplementation(async () => { controller.abort(); return new ArrayBuffer(3); });
    await expect(downloadRobotSource(model, controller.signal)).rejects.toThrow();
    expect(mocks.download).not.toHaveBeenCalled();
  });
  it("uses the actual supplied Viewer capture and reports an unreadable canvas", () => {
    const engine = {} as ViewerEngine;
    mocks.capture.mockReturnValue("data:image/jpeg;base64,AQID");
    downloadRobotScreenshot(engine, "arm.urdf");
    expect(mocks.capture).toHaveBeenCalledWith(engine);
    expect(mocks.download.mock.calls[0]![0].type).toBe("image/jpeg");
    expect(mocks.download.mock.calls[0]![1]).toBe("arm.preview.jpg");
    mocks.capture.mockReturnValue(undefined);
    expect(() => downloadRobotScreenshot(engine, "arm.urdf")).toThrow("截图生成失败");
    expect(mocks.download).toHaveBeenCalledOnce();
  });
});

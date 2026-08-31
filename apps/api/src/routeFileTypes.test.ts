import { describe, expect, it } from "vitest";
import { cleanFileName, contentType, imageContentType, modelFormat, videoContentType } from "./routeFileTypes.js";

describe("route file types", () => {
  it("removes path segments and unsafe filename characters", () => {
    expect(cleanFileName("../设备:模型?.STEP")).toBe("设备_模型_.STEP");
    expect(cleanFileName("..\\camera|feed.mp4")).toBe("camera_feed.mp4");
  });

  it("detects supported model extensions without case sensitivity", () => {
    expect(modelFormat("battery-pack.STEP")).toBe("step");
    expect(modelFormat("pump-body.X_T")).toBe("x_t");
    expect(modelFormat("assembly.JT")).toBe("jt");
    expect(modelFormat("factory.USDZ")).toBe("usdz");
    expect(modelFormat("fixture.OBJ")).toBe("obj");
    expect(modelFormat("legacy.3DS")).toBe("3ds");
    expect(modelFormat("unknown.xyz")).toBeUndefined();
  });

  it("keeps upload validation and download content types aligned", () => {
    expect(imageContentType(".webp")).toBe("image/webp");
    expect(videoContentType(".webm")).toBe("video/webm");
    expect(contentType("scene.gltf")).toBe("application/json; charset=utf-8");
    expect(contentType("worker.wasm")).toBe("application/wasm");
    expect(contentType("scene.usda")).toBe("model/usd");
    expect(contentType("scene.usdz")).toBe("model/vnd.usdz+zip");
    expect(contentType("mesh.stl")).toBe("model/stl");
    expect(contentType("assembly.3mf")).toBe("model/3mf");
    expect(contentType("unknown.bin")).toBe("application/octet-stream");
  });
});

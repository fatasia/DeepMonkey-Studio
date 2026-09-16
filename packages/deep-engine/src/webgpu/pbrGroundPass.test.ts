import { afterEach, describe, expect, it, vi } from "vitest";
import { createPbrGround, drawPbrGround } from "./pbrGroundPass.js";
import type { DeviceSession } from "./deviceSession.js";
import { resolvePbrRendererFeatures } from "./pbrRendererFeatures.js";
import { updatePbrFrameUniforms } from "./pbrFrameUniforms.js";
import { CameraFrameHistory } from "./cameraFrameHistory.js";

afterEach(() => vi.unstubAllGlobals());

function groundSession(failUpload?: string) {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 1, INDEX: 2, COPY_DST: 4 });
  const buffers: GPUBuffer[] = [];
  const createBuffer = vi.fn((descriptor: GPUBufferDescriptor) => {
    const buffer = { label: descriptor.label } as GPUBuffer;
    buffers.push(buffer);
    return buffer;
  });
  const writeBuffer = vi.fn((buffer: GPUBuffer) => {
    if (buffer.label === failUpload) throw new Error("upload failed");
  });
  const release = vi.fn();
  const session = { device: { createBuffer, queue: { writeBuffer } },
    own: (buffer: GPUBuffer) => buffer, release } as unknown as DeviceSession;
  return { session, buffers, createBuffer, writeBuffer, release };
}

describe("preview ground resources", () => {
  it("creates one indexed plane and its writable instance data", () => {
    const fixture = groundSession();
    const ground = createPbrGround(fixture.session);
    expect(ground.mesh.indexCount).toBe(6);
    expect(ground.data).toEqual(new Float32Array(36));
    expect(ground.instance).toBe(fixture.buffers[2]);
    expect(fixture.writeBuffer).toHaveBeenLastCalledWith(ground.instance, 0, ground.data);
    expect(fixture.createBuffer).toHaveBeenCalledTimes(3);
    expect(fixture.release).not.toHaveBeenCalled();
  });
  it.each(["Deep vertices", "Deep indices", "Deep ground"])("releases partial resources after %s fails", label => {
    const fixture = groundSession(label);
    expect(() => createPbrGround(fixture.session)).toThrow("upload failed");
    expect(fixture.release).toHaveBeenCalledTimes(fixture.buffers.length);
    expect(new Set(fixture.release.mock.calls.map(call => call[0]))).toEqual(new Set(fixture.buffers));
  });
});

describe("optional preview ground", () => {
  it.each([true, false])("disabling ground does not touch pass bindings (direct=%s)", direct => {
    const setPipeline = vi.fn(), draw = vi.fn();
    expect(drawPbrGround(false, { setPipeline } as unknown as GPURenderPassEncoder,
      {} as GPURenderPipeline, { draw }, {} as GPUBuffer, direct)).toEqual({ drawCalls: 0, triangles: 0 });
    expect(setPipeline).not.toHaveBeenCalled();
    expect(draw).not.toHaveBeenCalled();
  });
  it.each([true, false])("draws and counts the enabled plane (direct=%s)", direct => {
    const setPipeline = vi.fn(), draw = vi.fn();
    const pass = { setPipeline } as unknown as GPURenderPassEncoder;
    const pipeline = {} as GPURenderPipeline, buffer = {} as GPUBuffer;
    expect(drawPbrGround(true, pass, pipeline, { draw }, buffer, direct)).toEqual({ drawCalls: 1, triangles: 2 });
    expect(setPipeline).toHaveBeenCalledExactlyOnceWith(pipeline);
    expect(draw).toHaveBeenCalledExactlyOnceWith(pass, buffer, 1, false, direct ? undefined : buffer);
  });
  it("does not confuse grid decoration with ground visibility", () => {
    expect(resolvePbrRendererFeatures({ groundGrid: false }).groundPlane).toBe(true);
    expect(resolvePbrRendererFeatures({ groundPlane: false }).groundGrid).toBe(true);
  });
  it("skips ground packing and upload while retaining camera and display updates", () => {
    const writeBuffer = vi.fn();
    const resources = { frameBuffer: {} as GPUBuffer, outputBuffer: {} as GPUBuffer,
      groundInstance: {} as GPUBuffer, frameData: new Float32Array(96), outputData: new Float32Array(8),
      groundData: new Float32Array(36).fill(7) };
    updatePbrFrameUniforms({ writeBuffer } as unknown as GPUQueue, new CameraFrameHistory(), {
      eye: [0, 0, 10], target: [0, 0, 0], extent: 10, background: [0, 0, 0], floor: [0, 0, 0],
      exposure: 1, roughness: 1,
    }, 800, 600, false, resources, undefined, resolvePbrRendererFeatures({ groundPlane: false }));
    expect(writeBuffer).toHaveBeenCalledTimes(2);
    expect(writeBuffer.mock.calls.map(call => call[0])).toEqual([resources.frameBuffer, resources.outputBuffer]);
    expect(Array.from(resources.groundData)).toEqual(Array(36).fill(7));
  });
});

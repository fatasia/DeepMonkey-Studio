import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GeometryResource } from "../renderPacket.js";
import type { DeviceSession } from "./deviceSession.js";
import { MeshBuffers } from "./meshBuffers.js";

beforeEach(() => {
  vi.stubGlobal("GPUBufferUsage", { VERTEX: 32, INDEX: 16, COPY_DST: 8 });
});

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("MeshBuffers disposal", () => {
  it("attempts every owned buffer and aggregates driver destruction failures", () => {
    const buffers: Array<{ destroy: ReturnType<typeof vi.fn> }> = [];
    const device = {
      createBuffer: vi.fn(() => {
        const buffer = { destroy: vi.fn() }; buffers.push(buffer); return buffer as unknown as GPUBuffer;
      }),
      queue: { writeBuffer: vi.fn() },
    };
    const session = {
      device,
      own<T>(value: T): T { return value; },
      release(value: { destroy(): void }): void { value.destroy(); },
    } as unknown as DeviceSession;
    const source = {
      id: "mesh", revision: 0,
      vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 1, 0, 0]),
      indices: new Uint32Array([0, 1, 2]),
    } satisfies GeometryResource;
    const mesh = new MeshBuffers(session, source);
    buffers[0]!.destroy.mockImplementation(() => { throw new Error("vertex destroy failed"); });
    buffers[1]!.destroy.mockImplementation(() => { throw new Error("index destroy failed"); });

    expect(() => mesh.dispose()).toThrow(AggregateError);
    expect(buffers.every(buffer => buffer.destroy.mock.calls.length === 1)).toBe(true);
  });
});

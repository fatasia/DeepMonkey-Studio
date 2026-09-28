import { describe, expect, it } from "vitest";
import { PacketDeformationState } from "./packetDeformationState.js";
import type { DeviceSession } from "./deviceSession.js";
import type { Pipelines } from "./pipelines.js";
import type { DeformationSnapshot } from "../deformation/types.js";

function fakePipelines(): Pipelines {
  return { deformationPlainLayout: {} } as unknown as Pipelines;
}

function session(): DeviceSession {
  return { device: { limits: { maxStorageBufferBindingSize: 128 * 1024 * 1024 } } } as unknown as DeviceSession;
}

describe("PacketDeformationState deferred pipeline attachment", () => {
  it("starts disabled and enables after attachPipelines", () => {
    const state = new PacketDeformationState(session());
    expect(state.enabled).toBe(false);
    state.attachPipelines(fakePipelines());
    expect(state.enabled).toBe(true);
  });

  it("ignores repeated attachments and keeps the first pipelines", () => {
    const state = new PacketDeformationState(session());
    const first = fakePipelines();
    state.attachPipelines(first);
    state.attachPipelines(fakePipelines());
    expect(state.enabled).toBe(true);
  });

  it("rejects attachment after disposal", () => {
    const state = new PacketDeformationState(session());
    state.dispose();
    expect(() => state.attachPipelines(fakePipelines())).toThrow("after disposal");
  });

  it("refuses to publish deformation resources while pipelines are missing", () => {
    const state = new PacketDeformationState(session());
    const resources = { dispose() { /* stub */ } } as never;
    expect(() => state.publish(resources, { sources: [], poses: [] } as unknown as DeformationSnapshot))
      .toThrow("incomplete");
  });
});

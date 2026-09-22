import { describe, expect, it, vi } from "vitest";
import { RenderGraphBuilder, type RenderGraphCompileResult } from "../renderGraph.js";
import { compilePbrFrameGraph } from "./pbrFrameGraph.js";
import { encodeRenderGraphEncoderGroup, executeRenderGraphEncoders,
  type RenderGraphEncoderPass } from "./renderGraphEncoderExecutor.js";

function plan(): RenderGraphCompileResult {
  return new RenderGraphBuilder()
    .addResource({ id: "input", descriptor: "external", external: true })
    .addResource({ id: "left", descriptor: "buffer" })
    .addResource({ id: "right", descriptor: "buffer" })
    .addResource({ id: "surface", descriptor: "swapchain", external: true })
    .addPass({ id: "left-pass", kind: "compute", inputs: ["input"], outputs: ["left"] })
    .addPass({ id: "right-pass", kind: "compute", inputs: ["input"], outputs: ["right"] })
    .addPass({ id: "present", kind: "render", inputs: ["left", "right"], outputs: ["surface"] })
    .compile();
}

function fixture() {
  let encoderId = 0;
  const created: Array<{ id: number; label?: string; finished: boolean }> = [];
  const submissions: number[][] = [];
  const device = {
    queue: { submit: vi.fn((buffers: Array<{ id: number }>) => submissions.push(buffers.map(buffer => buffer.id))) },
    createCommandEncoder: vi.fn(({ label }: { label?: string }) => {
      const record = { id: ++encoderId, label, finished: false };
      created.push(record);
      return {
        finish: vi.fn(() => {
          record.finished = true;
          return { id: record.id };
        }),
      };
    }),
  } as unknown as GPUDevice;
  return { device, created, submissions };
}

function pass(run?: (passId: string) => Promise<void> | void): RenderGraphEncoderPass {
  return async ({ passId }) => run?.(passId);
}

describe("executeRenderGraphEncoders", () => {
  it("encodes independent passes concurrently and submits command buffers in stable group order", async () => {
    const subject = plan(), f = fixture(), releases = new Map<string, () => void>(), started: string[] = [];
    const callbacks = new Map(subject.order.map(passId => [passId, pass(async (id) => {
      started.push(id);
      if (id === "present") return;
      await new Promise<void>(resolve => releases.set(id, resolve));
    })]));

    const execution = executeRenderGraphEncoders(f.device, subject, callbacks, { maxConcurrency: 2 });
    await vi.waitFor(() => expect(started).toEqual(["left-pass", "right-pass"]));
    expect(f.submissions).toEqual([]);
    releases.get("right-pass")!();
    releases.get("left-pass")!();
    const result = await execution;

    expect(result).toEqual({ planHash: subject.planHash, encodedPasses: subject.order,
      submittedGroups: 2, commandBufferCount: 3 });
    expect(f.submissions).toEqual([[1, 2], [3]]);
    expect(f.created.map(entry => entry.label)).toEqual([
      "Deep RenderGraph: left-pass", "Deep RenderGraph: right-pass", "Deep RenderGraph: present",
    ]);
    expect(f.created.every(entry => entry.finished)).toBe(true);
  });

  it("does not submit a partially encoded failing group or start dependent groups", async () => {
    const subject = plan(), f = fixture(), started: string[] = [];
    const callbacks = new Map(subject.order.map(passId => [passId, pass((id) => {
      started.push(id);
      if (id === "right-pass") throw new Error("pipeline missing");
    })]));

    await expect(executeRenderGraphEncoders(f.device, subject, callbacks)).rejects
      .toThrow("right-pass failed to encode: pipeline missing");
    expect(started).toEqual(["left-pass", "right-pass"]);
    expect(f.submissions).toEqual([]);
  });

  it("cancels before submit and leaves the next dependency group untouched", async () => {
    const subject = plan(), f = fixture(), controller = new AbortController(), started: string[] = [];
    const callbacks = new Map(subject.order.map(passId => [passId, pass((id) => {
      started.push(id);
      if (id === "right-pass") controller.abort(new Error("superseded frame"));
    })]));

    await expect(executeRenderGraphEncoders(f.device, subject, callbacks, { signal: controller.signal }))
      .rejects.toThrow("superseded frame");
    expect(started).toEqual(["left-pass", "right-pass"]);
    expect(f.submissions).toEqual([]);
  });

  it("rejects incomplete, extra, or inconsistent execution maps before allocating encoders", async () => {
    const subject = plan(), f = fixture();
    const missing = new Map(subject.order.slice(1).map(passId => [passId, pass()]));
    await expect(executeRenderGraphEncoders(f.device, subject, missing)).rejects.toThrow("missing pass callback: left-pass");
    const extra = new Map(subject.order.map(passId => [passId, pass()])); extra.set("phantom", pass());
    await expect(executeRenderGraphEncoders(f.device, subject, extra)).rejects.toThrow("outside the compiled plan: phantom");
    await expect(executeRenderGraphEncoders(f.device, { ...subject, parallelGroups: [["present"]] },
      new Map(subject.order.map(passId => [passId, pass()])))).rejects.toThrow("cover the compiled pass order exactly");
    expect(f.created).toEqual([]);
  });

  it("accepts depth groups whose flattened schedule differs from the DFS topological order", async () => {
    const subject = new RenderGraphBuilder()
      .addResource({ id: "input", descriptor: "external", external: true })
      .addResource({ id: "first", descriptor: "buffer" })
      .addResource({ id: "chained", descriptor: "buffer", external: true })
      .addResource({ id: "independent", descriptor: "buffer", external: true })
      .addPass({ id: "first-pass", kind: "compute", inputs: ["input"], outputs: ["first"] })
      .addPass({ id: "chained-pass", kind: "compute", inputs: ["first"], outputs: ["chained"] })
      .addPass({ id: "independent-pass", kind: "compute", inputs: ["input"], outputs: ["independent"] })
      .compile();
    expect(subject.order).toEqual(["first-pass", "chained-pass", "independent-pass"]);
    expect(subject.parallelGroups).toEqual([["first-pass", "independent-pass"], ["chained-pass"]]);
    const f = fixture(), callbacks = new Map(subject.order.map(passId => [passId, pass()]));
    const result = await executeRenderGraphEncoders(f.device, subject, callbacks);
    expect(result.encodedPasses).toEqual(["first-pass", "independent-pass", "chained-pass"]);
    expect(f.submissions).toEqual([[1, 2], [3]]);
  });

  it("encodes a production group without submitting past the caller transaction boundary", () => {
    const subject = plan(), f = fixture(), encoded: string[] = [];
    const result = encodeRenderGraphEncoderGroup(f.device, subject, 0,
      new Map(subject.parallelGroups![0]!.map(passId => [passId, ({ passId: id }) => { encoded.push(id); }])));

    expect(result).toMatchObject({ planHash: subject.planHash, groupIndex: 0,
      encodedPasses: ["left-pass", "right-pass"] });
    expect(result.commandBuffers).toEqual([{ id: 1 }, { id: 2 }]);
    expect(encoded).toEqual(["left-pass", "right-pass"]);
    expect(f.submissions).toEqual([]);
  });

  it("validates a selected group before allocating command encoders", () => {
    const subject = plan(), f = fixture();
    expect(() => encodeRenderGraphEncoderGroup(f.device, subject, 0,
      new Map([["left-pass", () => {}]]))).toThrow("missing pass callback: right-pass");
    expect(() => encodeRenderGraphEncoderGroup(f.device, subject, 0,
      new Map([["left-pass", () => {}], ["right-pass", () => {}], ["present", () => {}]])))
      .toThrow("outside the selected group: present");
    expect(f.created).toEqual([]);
  });

  it("encodes the real PBR deform and clustered-light callbacks from their compiled dependency level", () => {
    const subject = compilePbrFrameGraph({ transparency: true }), f = fixture();
    const groupIndex = subject.parallelGroups!.findIndex(group =>
      group.length === 2 && group.includes("deform") && group.includes("cluster-lights"));
    const callbacks = new Map([
      ["deform", vi.fn()],
      ["cluster-lights", vi.fn()],
    ]);

    const result = encodeRenderGraphEncoderGroup(f.device, subject, groupIndex, callbacks);

    expect(result.encodedPasses).toEqual(["deform", "cluster-lights"]);
    expect(callbacks.get("deform")).toHaveBeenCalledWith(expect.objectContaining({ passId: "deform" }));
    expect(callbacks.get("cluster-lights")).toHaveBeenCalledWith(expect.objectContaining({ passId: "cluster-lights" }));
    expect(result.commandBuffers).toHaveLength(2);
    expect(f.submissions).toEqual([]);
  });
});

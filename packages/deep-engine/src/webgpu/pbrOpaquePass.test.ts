import { describe, expect, it, vi } from "vitest";
import { beginPbrOpaquePass, describePbrOpaquePass } from "./pbrOpaquePass.js";
import { PBR_MAIN_SAMPLE_COUNT } from "./renderTargets.js";

const singleSampleTargets = { hdr: "hdr", linearDepth: "linear-depth", normal: "normal",
  motion: "motion", depth: "depth" } as unknown as Parameters<typeof beginPbrOpaquePass>[1]["targets"];

/** AA-M1:MSAA 通路附件形态(4x 附件 + 单采样 resolveTarget + 深度 storeOp 策略)。 */
const msaaTargets = { hdr: "hdr", linearDepth: "linear-depth", normal: "normal", motion: "motion", depth: "depth",
  msaaActive: true, mainSampleCount: PBR_MAIN_SAMPLE_COUNT,
  hdrMsaa: "hdr-msaa", linearDepthMsaa: "linear-depth-msaa", normalMsaa: "normal-msaa", motionMsaa: "motion-msaa",
  depthMsaa: "depth-msaa" } as unknown as Parameters<typeof beginPbrOpaquePass>[1]["targets"];

describe("PBR opaque pass", () => {
  it.each([[false, 1, "Deep HDR opaque color"], [true, 4, "Deep HDR opaque MRT"]] as const)(
    "matches geometry-buffer=%s pipeline attachments",
    (writeGeometryBuffers, attachmentCount, label) => {
      const beginRenderPass = vi.fn(() => ({ end: vi.fn() }));
      beginPbrOpaquePass({ beginRenderPass } as unknown as GPUCommandEncoder,
        { targets: singleSampleTargets, background: [0.1, 0.2, 0.3], writeGeometryBuffers });
      expect(beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({
        label, colorAttachments: expect.any(Array), depthStencilAttachment: expect.objectContaining({ view: "depth" }),
      }));
      expect(beginRenderPass.mock.calls[0]![0].colorAttachments).toHaveLength(attachmentCount);
    },
  );

  it("1x renderer keeps the legacy store semantics and has no resolve targets", () => {
    const beginRenderPass = vi.fn(() => ({ end: vi.fn() }));
    beginPbrOpaquePass({ beginRenderPass } as unknown as GPUCommandEncoder,
      { targets: singleSampleTargets, background: [0, 0, 0], writeGeometryBuffers: false, depthConsumedAfterPass: true });
    const descriptor = beginRenderPass.mock.calls[0]![0];
    expect(descriptor.colorAttachments[0]).toMatchObject({ view: "hdr", loadOp: "clear", storeOp: "store" });
    expect(descriptor.colorAttachments[0].resolveTarget).toBeUndefined();
    expect(descriptor.depthStencilAttachment).toMatchObject({ view: "depth", depthStoreOp: "store" });
  });

  it("MSAA path resolves every color attachment and stores depth when consumers follow", () => {
    const beginRenderPass = vi.fn(() => ({ end: vi.fn() }));
    beginPbrOpaquePass({ beginRenderPass } as unknown as GPUCommandEncoder,
      { targets: msaaTargets, background: [0.1, 0.2, 0.3], writeGeometryBuffers: true, depthConsumedAfterPass: true });
    const descriptor = beginRenderPass.mock.calls[0]![0];
    expect(descriptor.colorAttachments.map((attachment: GPURenderPassColorAttachment) => attachment.view))
      .toEqual(["hdr-msaa", "linear-depth-msaa", "normal-msaa", "motion-msaa"]);
    expect(descriptor.colorAttachments.map((attachment: GPURenderPassColorAttachment) => attachment.resolveTarget))
      .toEqual(["hdr", "linear-depth", "normal", "motion"]);
    expect(descriptor.depthStencilAttachment).toMatchObject({ view: "depth-msaa", depthLoadOp: "clear", depthStoreOp: "store" });
  });

  it("MSAA path discards depth when no consumer follows the main pass", () => {
    const beginRenderPass = vi.fn(() => ({ end: vi.fn() }));
    beginPbrOpaquePass({ beginRenderPass } as unknown as GPUCommandEncoder,
      { targets: msaaTargets, background: [0, 0, 0], writeGeometryBuffers: false, depthConsumedAfterPass: false });
    const descriptor = beginRenderPass.mock.calls[0]![0];
    expect(descriptor.depthStencilAttachment).toMatchObject({ view: "depth-msaa", depthStoreOp: "discard" });
    expect(descriptor.colorAttachments[0]).toMatchObject({ view: "hdr-msaa", resolveTarget: "hdr" });
  });

  it("directDisplay frames stay on the 1x swapchain view even on a MSAA4 renderer", () => {
    const beginRenderPass = vi.fn(() => ({ end: vi.fn() }));
    beginPbrOpaquePass({ beginRenderPass } as unknown as GPUCommandEncoder,
      { targets: msaaTargets, background: [0, 0, 0], writeGeometryBuffers: false, directDisplayView: "surface",
        depthConsumedAfterPass: true });
    const descriptor = beginRenderPass.mock.calls[0]![0];
    expect(descriptor.colorAttachments[0]).toMatchObject({ view: "surface" });
    expect(descriptor.colorAttachments[0].resolveTarget).toBeUndefined();
    expect(descriptor.depthStencilAttachment).toMatchObject({ view: "depth", depthStoreOp: "store" });
  });

  it("declares single-sample main-frame contracts and unplanned MSAA attachments for the ledger", () => {
    const plain = describePbrOpaquePass({ writeGeometryBuffers: false });
    expect(plain.claims.every(claim => claim.sampleCount === 1)).toBe(true);
    expect(plain.unplannedAttachments?.map(attachment => attachment.id)).toEqual(["hardware-depth"]);

    const msaa = describePbrOpaquePass({ writeGeometryBuffers: true, msaa: true, depthResolved: true });
    expect(msaa.claims.map(claim => [claim.id, claim.sampleCount])).toEqual([
      ["opaque-hdr", 1], ["linear-depth", 1], ["view-normal", 1], ["motion", 1],
    ]);
    expect(msaa.unplannedAttachments?.map(attachment => attachment.id)).toEqual([
      "opaque-hdr-msaa", "linear-depth-msaa", "view-normal-msaa", "motion-msaa",
      "hardware-depth-msaa", "depth-resolve-pass",
    ]);
    expect(msaa.gpuPassCount).toBe(2);

    const msaaPlainNoResolve = describePbrOpaquePass({ writeGeometryBuffers: false, msaa: true });
    expect(msaaPlainNoResolve.unplannedAttachments?.map(attachment => attachment.id)).toEqual([
      "opaque-hdr-msaa", "hardware-depth-msaa",
    ]);
    expect(msaaPlainNoResolve.gpuPassCount).toBe(1);
  });
});

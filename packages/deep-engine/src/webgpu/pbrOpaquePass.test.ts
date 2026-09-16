import { describe, expect, it, vi } from "vitest";
import { beginPbrOpaquePass } from "./pbrOpaquePass.js";

const targets = { hdr: "hdr", linearDepth: "linear-depth", normal: "normal",
  motion: "motion", depth: "depth" } as unknown as Parameters<typeof beginPbrOpaquePass>[1]["targets"];

describe("PBR opaque pass", () => {
  it.each([[false, 1, "Deep HDR opaque color"], [true, 4, "Deep HDR opaque MRT"]] as const)(
    "matches geometry-buffer=%s pipeline attachments",
    (writeGeometryBuffers, attachmentCount, label) => {
      const beginRenderPass = vi.fn(() => ({ end: vi.fn() }));
      beginPbrOpaquePass({ beginRenderPass } as unknown as GPUCommandEncoder,
        { targets, background: [0.1, 0.2, 0.3], writeGeometryBuffers });
      expect(beginRenderPass).toHaveBeenCalledWith(expect.objectContaining({
        label, colorAttachments: expect.any(Array), depthStencilAttachment: expect.objectContaining({ view: "depth" }),
      }));
      expect(beginRenderPass.mock.calls[0]![0].colorAttachments).toHaveLength(attachmentCount);
    },
  );
});

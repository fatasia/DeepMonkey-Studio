import { describe, expect, it, vi } from "vitest";
import { PbrDepthResolvePass, PBR_DEPTH_RESOLVE_WGSL } from "./pbrDepthResolve.js";

describe("MSAA depth resolve pass", () => {
  it("declares the frag_depth resolve contract in WGSL", () => {
    // 深度格式无法 storage 写、无法 resolveTarget;唯一通路是 depth-only 渲染 pass 的 frag_depth。
    expect(PBR_DEPTH_RESOLVE_WGSL).toContain("texture_depth_multisampled_2d");
    expect(PBR_DEPTH_RESOLVE_WGSL).toContain("@builtin(frag_depth)");
    expect(PBR_DEPTH_RESOLVE_WGSL).toContain("textureLoad(sourceDepth, vec2<i32>(position.xy), 0)");
  });

  it("encodes a depth-only pass from the MSAA source into the 1x target with cached bindings", () => {
    const bindGroup = { label: "bindings" } as unknown as GPUBindGroup;
    const layout = { label: "layout" } as unknown as GPUBindGroupLayout;
    const createBindGroup = vi.fn(() => bindGroup);
    const createRenderPipeline = vi.fn(() => ({ label: "pipeline", getBindGroupLayout: () => layout }) as unknown as GPURenderPipeline);
    const createShaderModule = vi.fn(() => ({ label: "module" }) as unknown as GPUShaderModule);
    const beginRenderPass = vi.fn(() => ({ setPipeline: vi.fn(), setBindGroup: vi.fn(), draw: vi.fn(), end: vi.fn() }));
    const encoder = { beginRenderPass } as unknown as GPUCommandEncoder;
    const session = { device: { createRenderPipeline, createShaderModule, createBindGroup } } as unknown as
      import("./deviceSession.js").DeviceSession;

    const pass = new PbrDepthResolvePass(session);
    const sourceA = { label: "msaa-depth-a" } as unknown as GPUTextureView;
    const sourceB = { label: "msaa-depth-b" } as unknown as GPUTextureView;
    const target = { label: "depth-1x" } as unknown as GPUTextureView;
    pass.encode(encoder, sourceA, target);
    pass.encode(encoder, sourceA, target);
    pass.encode(encoder, sourceB, target);

    // 源视图是 transient 池纹理(resize 换实例):bind group 按源缓存,实例更替重建。
    expect(createBindGroup).toHaveBeenCalledTimes(2);
    expect(createBindGroup.mock.calls[0]![0].entries).toEqual([{ binding: 0, resource: sourceA }]);
    expect(createBindGroup.mock.calls[1]![0].entries).toEqual([{ binding: 0, resource: sourceB }]);
    expect(createRenderPipeline).toHaveBeenCalledTimes(1);
    expect(createRenderPipeline.mock.calls[0]![0]).toMatchObject({
      fragment: { targets: [] },
      depthStencil: { format: "depth32float", depthWriteEnabled: true, depthCompare: "always" },
    });
    expect(beginRenderPass).toHaveBeenCalledTimes(3);
    expect(beginRenderPass.mock.calls[0]![0]).toEqual({ label: "Deep MSAA depth resolve", colorAttachments: [],
      depthStencilAttachment: { view: target, depthClearValue: 1, depthLoadOp: "clear", depthStoreOp: "store" } });
    expect(beginRenderPass.mock.calls[0]![0].depthStencilAttachment.view).toBe(target);
  });
});

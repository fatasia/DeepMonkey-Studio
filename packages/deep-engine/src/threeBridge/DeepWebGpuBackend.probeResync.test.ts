import { describe, expect, it, vi } from "vitest";
import { bridge, mesh } from "./testFixture.js";
import { runtime, view } from "./DeepWebGpuBackend.testUtils.js";
import { DeepWebGpuBackend } from "./DeepWebGpuBackend.js";

/**
 * F5-GI-2 回归:独立包路径 `prepareRenderPacket` 提交后必须重同步 probe 会话
 * (与场景路径 `sync()` 提交分支的 `probeClipmap?.syncPacket` 同一形态)。
 * 缺该接线时,包内容替换后探针继续消费旧表面缓存,直到 GI 关/开重建会话。
 */
describe("DeepWebGpuBackend probe session resync (F5-GI-2)", () => {
  it("resyncs the probe session on every independent packet commit with a monotonic revision", async () => {
    const source = bridge(), author = mesh();
    author.updateWorldMatrix(true, true);
    const projected = source.project(author, { cameraLayerMask: 1 });
    if (!projected.ok) throw new Error("expected packet projection");
    const syncRenderPacket = vi.fn();
    const target = {
      ...runtime(),
      session: { state: "ready", device: {} },
      setProbeClipmap: vi.fn(),
      createProbeClipmapController: vi.fn(() => ({ radianceSource: "scene",
        syncRenderPacket, dispose: vi.fn() })),
    };
    const backend = new DeepWebGpuBackend(target as never, bridge());
    backend.setProbeClipmapEnabled(true);
    expect(syncRenderPacket).not.toHaveBeenCalled();

    await backend.prepareRenderPacket(projected.packet, view);
    expect(syncRenderPacket).toHaveBeenCalledTimes(1);
    expect(syncRenderPacket.mock.calls[0]![0]).toMatchObject({ revision: 1 });

    // 包内容替换(同一入口,发布路径同实现)→ 探针会话必须反映新表面:第二次提交
    // 带递增 revision 再同步,而不是继续用旧表面缓存。
    await backend.prepareRenderPacket(projected.packet, view);
    expect(syncRenderPacket).toHaveBeenCalledTimes(2);
    expect(syncRenderPacket.mock.calls[1]![0]).toMatchObject({ revision: 2 });
  });

  it("keeps packet publication intact when no probe session is enabled", async () => {
    const source = bridge(), author = mesh();
    author.updateWorldMatrix(true, true);
    const projected = source.project(author, { cameraLayerMask: 1 });
    if (!projected.ok) throw new Error("expected packet projection");
    const target = runtime(), backend = new DeepWebGpuBackend(target, bridge());
    await backend.prepareRenderPacket(projected.packet, view);
    expect(target.setPacketValidated).toHaveBeenCalledOnce();
    expect(target.validateFrame).toHaveBeenCalledOnce();
  });
});

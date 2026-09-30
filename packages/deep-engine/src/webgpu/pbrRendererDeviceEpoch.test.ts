import { describe, expect, it, vi } from "vitest";
import { PbrRenderer } from "./pbrRenderer.js";
import { RendererDeviceEpoch } from "./rendererDeviceEpoch.js";

function fixture(replaced: boolean) {
  const original = {}, current = replaced ? {} : original, touched = vi.fn();
  const renderer = Object.assign(Object.create(PbrRenderer.prototype), {
    session: { device: current, state: "ready" }, deviceEpoch: new RendererDeviceEpoch(original),
    sceneChanged: vi.fn(), syncProbeClipmapSurfaces: vi.fn(),
    packets: { set: touched, setValidated: touched, updateInstances: touched,
      stageResidentProjection: touched, stageResidentProjectionValidated: touched },
    environment: { runFrame: touched, stage: touched }, shadowState: { stage: touched }, lighting: { setProbeClipmap: touched },
  }) as PbrRenderer;
  return { renderer, touched };
}

describe("PBR complete device ownership boundary", () => {
  it.each(["packet", "instances", "resident", "environment", "shadow", "render", "probe-binding", "probe-factory", "cluster"])("rejects a replaced device before %s touches GPU owners", operation => {
    const { renderer, touched } = fixture(true);
    const invoke = () => {
      if (operation === "packet") renderer.setPacket({} as never);
      else if (operation === "instances") renderer.updateInstances({} as never);
      else if (operation === "resident") renderer.stageResidentPacket({} as never);
      else if (operation === "environment") renderer.stageEnvironment({} as never);
      else if (operation === "shadow") renderer.stageShadowMapSize(1024);
      else if (operation === "probe-binding") renderer.setProbeClipmap({} as never);
      else if (operation === "probe-factory") renderer.createProbeClipmapController({} as never, "replaced-device");
      else if (operation === "cluster") renderer.stageClusterLodScene({} as never);
      else renderer.render({} as never);
    };
    expect(invoke).toThrow("GPU device changed"); expect(touched).not.toHaveBeenCalled();
  });
  it.each(["packet", "resident", "frame"])("rejects async %s before any validation or upload starts", async operation => {
    const { renderer, touched } = fixture(true);
    const pending = operation === "packet" ? renderer.setPacketValidated({} as never)
      : operation === "resident" ? renderer.stageResidentPacketValidated({} as never) : renderer.validateFrame({} as never);
    await expect(pending).rejects.toThrow("GPU device changed"); expect(touched).not.toHaveBeenCalled();
  });
  it("keeps same-device packet ownership usable", () => {
    const { renderer, touched } = fixture(false);
    renderer.setPacket({} as never); expect(touched).toHaveBeenCalledOnce();
  });
});

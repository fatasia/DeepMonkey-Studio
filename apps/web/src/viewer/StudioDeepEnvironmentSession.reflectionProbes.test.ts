import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
import { StudioDeepEnvironmentSession } from "./StudioDeepEnvironmentSession";
import { prepareStudioDeepEnvironmentSource } from "./studioDeepEnvironmentSource";
import { writeStudioReflectionProbes } from "./studioReflectionProbeCarriers";

async function fixture() {
  const scene = new THREE.Scene(); scene.background = new THREE.Color("#123456");
  const initial = await prepareStudioDeepEnvironmentSource(scene, new AbortController().signal);
  const stage = vi.fn(async () => "staged" as const), onReady = vi.fn(), onFailure = vi.fn();
  const session = new StudioDeepEnvironmentSession({ scene, initial, readView: () => ({} as never), stage, onReady, onFailure });
  return { scene, session, stage, onReady, onFailure };
}

describe("reflection probe environment failure admission", () => {
  it("reports one failed source once across repeated frames and retries after author source replacement", async () => {
    const f = await fixture();
    try {
      writeStudioReflectionProbes(f.scene, { probes: [], owned: [], error: "probe load rejected" });
      f.session.view(); await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce());
      for (let i = 0; i < 20; i++) f.session.view();
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(f.onFailure).toHaveBeenCalledOnce(); expect(f.stage).not.toHaveBeenCalled();
      writeStudioReflectionProbes(f.scene, { probes: [], owned: [] }); f.session.view();
      await vi.waitFor(() => expect(f.onReady).toHaveBeenCalledOnce());
      expect(f.stage).toHaveBeenCalledOnce();
    } finally { f.session.dispose(); }
  });

  it("does not retry the same rejected GPU candidate every frame", async () => {
    const f = await fixture();
    try {
      f.stage.mockRejectedValueOnce(new Error("GPU candidate rejected"));
      writeStudioReflectionProbes(f.scene, { probes: [], owned: [] }); f.session.view();
      await vi.waitFor(() => expect(f.onFailure).toHaveBeenCalledOnce());
      for (let i = 0; i < 20; i++) f.session.view();
      await new Promise(resolve => setTimeout(resolve, 5));
      expect(f.stage).toHaveBeenCalledOnce(); expect(f.onFailure).toHaveBeenCalledOnce();
      writeStudioReflectionProbes(f.scene, { probes: [], owned: [] }); f.session.view();
      await vi.waitFor(() => expect(f.onReady).toHaveBeenCalledOnce());
      expect(f.stage).toHaveBeenCalledTimes(2);
    } finally { f.session.dispose(); }
  });
});

import { describe, expect, it, vi } from "vitest";
import * as contracts from "@bim-studio/contracts";
import type { ProjectRecord, SceneSnapshot } from "@bim-studio/contracts";
import { studioAuthorRenderPacketKey } from "./studioAuthorRenderPacketKey";

describe("live author packet key", () => {
  it("hashes changed author content once while preserving canonical validation on cache hits", () => {
    const spy = vi.spyOn(contracts, "fingerprint64Labeled");
    try {
      const scene = { id: "cache-probe", models: [], primitives: [] } as unknown as SceneSnapshot;
      const first = studioAuthorRenderPacketKey(scene, []);
      for (let index = 0; index < 100; index++) expect(studioAuthorRenderPacketKey({ ...scene, updatedAt: String(index) }, [])).toBe(first);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(studioAuthorRenderPacketKey({ ...scene, name: "new author content" }, [])).not.toBe(first);
      expect(spy).toHaveBeenCalledTimes(2);
    } finally { spy.mockRestore(); }
  });
  it("reuses captures at different wall times while invalidating render edits and asset revisions", () => {
    const scene = { id: "scene", updatedAt: "a", primitives: [{ id: "box", color: "#123456" }] } as unknown as SceneSnapshot;
    const models = [{ id: "asset", status: "ready", manifest: { geometryUrl: "v1.glb" } }] as ProjectRecord["models"];
    const key = studioAuthorRenderPacketKey(scene, models);
    expect(studioAuthorRenderPacketKey({ ...scene, updatedAt: "b" }, models)).toBe(key);
    expect(studioAuthorRenderPacketKey({ ...scene, thumbnail: `data:image/jpeg;base64,${"a".repeat(150_000)}` }, models)).toBe(key);
    expect(studioAuthorRenderPacketKey({ ...scene, camera: { mode: "orbit", position: { x: 20, y: 3, z: 4 }, target: { x: 0, y: 0, z: 0 } },
      selectedModelId: "other", selectedLayerId: "layer", selectedAnnotationId: "note" }, models)).toBe(key);
    expect(studioAuthorRenderPacketKey({ ...scene, primitives: [{ ...scene.primitives[0]!, color: "#abcdef" }] }, models)).not.toBe(key);
    expect(studioAuthorRenderPacketKey(scene, [{ ...models[0]!, manifest: { ...models[0]!.manifest!, geometryUrl: "v2.glb" } }])).not.toBe(key);
  });

  it("detects direct author mutations and keeps validation on cached-content calls", () => {
    const scene = { id: "mutable", primitives: [{ id: "box", color: "#123456" }] } as unknown as SceneSnapshot;
    const first = studioAuthorRenderPacketKey(scene, []);
    expect(studioAuthorRenderPacketKey(scene, [])).toBe(first);
    scene.primitives[0]!.color = "#abcdef";
    expect(studioAuthorRenderPacketKey(scene, [])).not.toBe(first);
    (scene as unknown as Record<string, unknown>).bad = NaN;
    expect(() => studioAuthorRenderPacketKey(scene, [])).toThrow("非有限");
  });
});

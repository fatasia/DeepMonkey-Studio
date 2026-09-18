import { describe, expect, it, vi } from "vitest";
import * as THREE from "three";
vi.mock("./viewerEngineLifecycle", () => ({ ViewerEngineLifecycle: class {} }));
import { ViewerEngineRendering } from "./viewerEngineRendering";
import { ViewerEngineEnvironment } from "./viewerEngineEnvironment";

describe("author editor helper color contract", () => {
  it("constructs selection UI without exposure coupling", () => {
    const context = { scene: new THREE.Scene(), removeSelectionHelper: vi.fn(), selectionHelper: undefined as THREE.Box3Helper | undefined };
    const method = (ViewerEngineRendering.prototype as unknown as { showSelectionBox(box: THREE.Box3): void }).showSelectionBox;
    method.call(context, new THREE.Box3(new THREE.Vector3(-1, -1, -1), new THREE.Vector3(1, 1, 1)));
    const material = context.selectionHelper!.material as THREE.LineBasicMaterial;
    expect(material.toneMapped).toBe(false); expect(material.depthTest).toBe(false); expect(material.opacity).toBe(0.95);
  });
  it("constructs all directional light handles with shared display color semantics", () => {
    const context = { scene: new THREE.Scene(), sceneLightProxies: new Map(), updateSceneLightProxies: vi.fn() };
    const method = (ViewerEngineEnvironment.prototype as unknown as { createSceneLightProxy(state: unknown): void }).createSceneLightProxy;
    method.call(context, { id: "test", type: "directional", enabled: true, color: "#ffffff" });
    let materials = 0;
    context.scene.traverse(object => {
      const material = (object as THREE.Mesh).material as THREE.Material | undefined;
      if (material) { materials++; expect(material.toneMapped).toBe(false); expect(material.depthTest).toBe(false); }
    });
    expect(materials).toBe(5);
  });
});

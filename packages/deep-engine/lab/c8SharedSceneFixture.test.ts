import { expect, it } from "vitest";
import { createSharedSceneFixture, sharedProjection, sharedProfile } from "./c8SharedSceneFixture.js";
import { applyPbrAuthorColorEffects } from "../src/webgpu/pbrAuthorColorEffects.js";

it("the existing production bridge accepts the same six-mesh root and preserves strict emission", () => {
  const fixture = createSharedSceneFixture();
  try {
    const projected = sharedProjection().project(fixture.root, { cameraLayerMask: 1 }); expect(projected.ok).toBe(true);
    if (!projected.ok) throw Error(JSON.stringify(projected.issues));
    expect(projected.packet.instances).toHaveLength(6); expect(projected.packet.materials).toHaveLength(6);
    expect(projected.packet.materials.map(material => material.emissiveFactor)).toEqual(sharedProfile.emission);
    const hash = fixture.rootHash(), view = fixture.view(0, .5);
    expect(view.lights!.directional).toHaveLength(0); expect(view.exposure).toBe(.5);
    fixture.setStage("direct-diagnostic");
    expect(fixture.rootHash()).not.toBe(hash); expect(fixture.view(1, 2).lights!.directional).toHaveLength(1);
    expect(sharedProjection().project(fixture.root, { cameraLayerMask: 1 }).ok).toBe(true);
  } finally { fixture.dispose(); }
});

it("the frozen author grading is identity for black, fixture emission and HDR radiance", () => {
  for (const color of [[0, 0, 0], ...sharedProfile.emission, [2, .4, .1]]) {
    expect(applyPbrAuthorColorEffects(color as [number, number, number], [.5, .5], sharedProfile.authorColorEffects)).toEqual(color);
  }
});

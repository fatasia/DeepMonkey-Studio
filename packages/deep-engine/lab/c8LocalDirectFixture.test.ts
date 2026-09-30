import { expect, it } from "vitest";
import { createLocalDirectFixture, localDirectCases } from "./c8LocalDirectFixture.js";
import { resolvePbrSceneLighting } from "../src/lighting/pbrSceneLighting.js";
import { sharedProjection } from "./c8SharedSceneFixture.js";

for (const kind of localDirectCases) it(`${kind} projects the existing author root without a primary light`, () => {
  const fixture = createLocalDirectFixture(kind);
  try {
    const dark = fixture.view(0, .5), off = resolvePbrSceneLighting(dark.lights);
    expect(off.primary.intensity).toBe(0);
    const hash = fixture.rootHash(); fixture.setStage("direct-diagnostic");
    const lit = resolvePbrSceneLighting(fixture.view(1, .5).lights);
    expect(lit.primary.intensity).toBe(0); expect(fixture.rootHash()).not.toBe(hash);
    const lights = kind === "point-only" ? lit.clustered.points : kind === "spot-only" ? lit.clustered.spots : lit.clustered.directional;
    expect(lights).toHaveLength(1); expect(lights![0]!.intensity).toBeGreaterThan(0);
    if (kind !== "secondary-directional") {
      expect(lit.clustered.directional).toBeUndefined(); expect(lights![0]).toMatchObject({ range: 20, decay: 2 });
    }
    const packet = sharedProjection().project(fixture.root, { cameraLayerMask: 1 });
    expect(packet.ok).toBe(true); if (packet.ok) expect(packet.packet.instances).toHaveLength(6);
    fixture.setStage("strict-emissive");
    const again = resolvePbrSceneLighting(fixture.view(0, .5).lights);
    const disabled = kind === "point-only" ? again.clustered.points : kind === "spot-only" ? again.clustered.spots : again.clustered.directional;
    expect(disabled![0]!.intensity).toBe(0);
  } finally { fixture.dispose(); }
});

it("rejects unknown fixture instead of selecting a fallback", () => {
  expect(() => createLocalDirectFixture("unknown" as never)).toThrow("Unknown local direct fixture");
});

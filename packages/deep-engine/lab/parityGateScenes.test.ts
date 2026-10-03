import { expect, it } from "vitest";
import { DirectionalLight, type Mesh, type MeshPhysicalMaterial } from "three";
import { sharedProjection } from "./c8SharedSceneFixture.js";
import { createExtendedLobeProbe, createParityScene, parityEnvironmentImage, parityProfile, PARITY_EXTENDED_LOBES, PARITY_SCENARIO_IDS } from "./parityGateScenes.js";
import { probeExtendedLobeGaps } from "./parityGateProbe.js";

it("the five standard scenarios plus diagnostics all project through the production bridge", () => {
  expect(PARITY_SCENARIO_IDS.slice(0, 5)).toEqual(["pbr-matrix", "ibl", "directional-shadow", "aa-bloom", "transparency"]);
  for (const id of PARITY_SCENARIO_IDS) {
    const spec = createParityScene(id);
    try {
      const projected = sharedProjection().project(spec.root, { cameraLayerMask: 1 });
      if (!projected.ok) throw Error(`${id}: ${JSON.stringify(projected.issues)}`);
      expect(projected.packet.instances.length).toBe(spec.root.children.length);
      expect(parityProfile.exposure).toBe(1.05);
    } finally { spec.dispose(); }
  }
});

it("only the shadow scenario casts directional shadows, and transparency uses the bridge-legal blend state", () => {
  for (const id of PARITY_SCENARIO_IDS) {
    const spec = createParityScene(id);
    try {
      const casters: boolean[] = []; spec.scene.traverse(object => { if (object instanceof DirectionalLight) casters.push(object.castShadow); });
      expect(spec.shadows).toBe(id === "directional-shadow"); expect(casters.some(Boolean)).toBe(spec.shadows);
      expect(spec.environment !== undefined).toBe(id === "ibl" || id === "ibl-hq");
      if (id === "transparency") {
        const glass = spec.root.children.filter(child => child.name.startsWith("glass")) as Mesh<never, MeshPhysicalMaterial>[];
        expect(glass).toHaveLength(3);
        for (const mesh of glass) expect(mesh.material).toMatchObject({ transparent: true, depthWrite: false });
      }
    } finally { spec.dispose(); }
  }
});

it("the shared environment panorama is finite, HDR (sun > 1) and deterministic", () => {
  const first = parityEnvironmentImage(), second = parityEnvironmentImage();
  expect(first.data.every(value => Number.isFinite(value) && value >= 0)).toBe(true);
  expect(Math.max(...first.data)).toBeGreaterThan(5); expect(Array.from(first.data)).toEqual(Array.from(second.data));
});

it("every extended PBR lobe is a real fail-closed gap in the Deep bridge while the neutral lobe set is accepted", () => {
  const gaps = probeExtendedLobeGaps();
  expect(gaps.map(gap => gap.lobe)).toEqual([...PARITY_EXTENDED_LOBES]);
  for (const gap of gaps) { expect(gap.projected).toBe(false); expect(gap.issues[0]).toMatchObject({ code: "unsupported" }); }
  const neutral = createExtendedLobeProbe("clearcoat");
  try {
    (neutral.root.children[0] as Mesh<never, MeshPhysicalMaterial>).material.clearcoat = 0;
    expect(sharedProjection().project(neutral.root, { cameraLayerMask: 1 }).ok).toBe(true);
  } finally { neutral.dispose(); }
});

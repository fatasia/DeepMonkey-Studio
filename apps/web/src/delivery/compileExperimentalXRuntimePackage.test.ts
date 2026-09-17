import { expect, it } from "vitest";
import { compileExperimentalXRuntimePackage } from "./compileExperimentalXRuntimePackage";

it("freezes explicit X author content without activating ordinary scene/player", () => {
  const compiled = compileExperimentalXRuntimePackage({ packageId: "x.author", packageVersion: "1.0.0",
    renderPacket: { id: "scene.empty", revision: 1, value: { geometries: [], materials: [], instances: [] } },
    experimentalX: { id: "x:status", revision: 1, request: { schemaVersion: 1, expectedEpoch: 7, startedAtMs: 100,
      randomSeed: 42, resources: [], events: [], calls: [{ op: "emit-number", args: 42 }] } } });
  expect(compiled.evidence).toMatchObject({ scope: "closed-x-ir", resourceId: "x:status", activation: "disabled-by-default" });
  expect(JSON.parse(compiled.packageJson).packageHash.value).toBe(compiled.evidence.packageHash);
});

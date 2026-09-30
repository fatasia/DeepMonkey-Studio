import { expect, it } from "vitest";
import { validateRuntimeEnvironment } from "./environment.js";
import { runtimeContentSha256 } from "./hash.js";

const source = { schema: "deep-engine.solid-environment", schemaVersion: 1, id: "scene.environment", revision: 1,
  kind: "solid-background-no-ibl", outputTransform: "native-aces-v1", backgroundSrgb: [0, .5, 1] };
const check = (value: unknown) => validateRuntimeEnvironment(value, "scene.environment", 1, "$");

it("keeps the default payload unchanged and hashes an explicit display selection", () => {
  const before = JSON.stringify(source), hash = runtimeContentSha256(source);
  check(source);
  expect(JSON.stringify(source)).toBe(before);
  expect(runtimeContentSha256(source)).toBe(hash);
  for (const displayProfile of ["deep-aces", "three-aces-r185"]) {
    const selected = { ...source, displayProfile };
    expect(() => check(selected)).not.toThrow();
    expect(runtimeContentSha256(selected)).not.toBe(hash);
    expect(selected.outputTransform).toBe(source.outputTransform);
  }
});

it("rejects unknown/null/numeric modes without treating capability labels as modes", () => {
  for (const displayProfile of [null, 1, "three-aces", "native-aces-v1", "native-aces-grading-v9"]) {
    expect(() => check({ ...source, displayProfile })).toThrow("Unsupported display profile");
  }
});

it("retains author six-channel grading and exposure ranges when selecting a display profile", () => {
  const value = { ...source, schemaVersion: 9, outputTransform: "native-aces-grading-v9", displayProfile: "three-aces-r185",
    colorGrading: { hue: 15, saturation: .2, brightness: -.1, contrast: .3, temperature: .2, tint: -.4 },
    lighting: { direction: [0, 0, 1], radiance: [2, 1, 1], exposure: 1.05, shadows: false } };
  expect(() => check(value)).not.toThrow();
  expect(() => check({ ...value, colorGrading: { ...value.colorGrading, contrast: 2 } })).toThrow();
  expect(() => check({ ...value, lighting: { ...value.lighting, exposure: 2 } })).toThrow();
});

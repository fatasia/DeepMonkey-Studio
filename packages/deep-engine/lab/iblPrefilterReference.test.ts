import { describe, expect, it } from "vitest";
import { basisDirection, brdfLutReference, cubeDirection, ggxHalfVector, hammersley,
  prefilterPanoramaReference, rebasedReferenceMips, referencePanorama, reverseBits32,
  sampleEquirectangular } from "./iblPrefilterReference.js";
import { base64Encode, compareIblReference, encodeIblPlaneBase64, encodeRebasedMipBase64,
  encodeRuntimeIblReference, floatToHalf } from "./iblReferenceEncode.js";
import { validateRuntimePrefilteredIbl } from "../src/runtimePackage/environment.js";
import { visitIblBytes } from "../src/runtimePackage/environmentBytes.js";
import type { RadianceHdrImage } from "../src/textures/radianceHdr.js";

const halfToFloat = (half: number): number => {
  const sign = (half & 0x8000) !== 0 ? -1 : 1, exponent = (half >>> 10) & 0x1f, mantissa = half & 0x3ff;
  if (exponent === 0) return sign * mantissa * 2 ** -24;
  if (exponent === 0x1f) return sign * (mantissa === 0 ? Infinity : NaN);
  return sign * (1 + mantissa / 1024) * 2 ** (exponent - 15);
};

describe("I-C19 reference sampling math (WGSL single-source port)", () => {
  it("keeps hammersley deterministic with the canonical bit-reversal sequence", () => {
    expect(reverseBits32(1)).toBe(0x80000000); expect(reverseBits32(2)).toBe(0x40000000);
    expect(reverseBits32(0xffffffff)).toBe(0xffffffff);
    expect(hammersley(0, 8)).toEqual([0, 0]);
    expect(hammersley(1, 8)[0]).toBe(0.125); expect(hammersley(1, 8)[1]).toBeCloseTo(0.5, 12);
  });
  it("keeps ggx half vectors on the unit hemisphere and matches the a=1 uniform limit", () => {
    for (const roughness of [0, 0.25, 0.5, 1]) for (let i = 0; i < 64; i++) {
      const h = ggxHalfVector(hammersley(i, 64), roughness);
      expect(Math.hypot(h[0], h[1], h[2])).toBeCloseTo(1, 12); expect(h[2]).toBeGreaterThan(0);
      expect(h[2]).toBeLessThanOrEqual(1);
    }
    const uniform = ggxHalfVector([0.25, 0.5], 1);
    expect(Math.hypot(uniform[0], uniform[1])).toBeCloseTo(Math.sqrt(0.5), 12);
  });
  it("maps cube faces exactly like the WGSL cubeDirection (px-nx-py-ny-pz-nz)", () => {
    const center = (face: number) => cubeDirection(0, 0, face).map(value => Number(value.toFixed(12)));
    expect(center(0)).toEqual([1, 0, 0]); expect(center(1)).toEqual([-1, 0, 0]);
    expect(center(2)).toEqual([0, 1, 0]); expect(center(3)).toEqual([0, -1, 0]);
    expect(center(4)).toEqual([0, 0, 1]); expect(center(5)).toEqual([0, 0, -1]);
    const tangent = basisDirection([0, 0, 1], [1, 0, 0]);
    expect(tangent[0]).toBeCloseTo(1, 12); expect(Math.hypot(...tangent)).toBeCloseTo(1, 12);
    const pole = basisDirection([0, 1, 0], [0, 0, 1]);
    expect(Math.hypot(...pole)).toBeCloseTo(1, 12);
  });
  it("samples equirectangular with U repeat, V clamp and exact bilinear weights", () => {
    const stripes: RadianceHdrImage = { width: 2, height: 1, data: new Float32Array([1, 0, 0, 0, 1, 0]) };
    const plusX = sampleEquirectangular(stripes, [1, 0, 0]);
    expect(plusX[0]).toBeCloseTo(0.5, 12); expect(plusX[1]).toBeCloseTo(0.5, 12); expect(plusX[2]).toBeCloseTo(0, 12);
    const minusX = sampleEquirectangular(stripes, [-1, 0, 0]); // u=1 wraps to columns 1|0
    expect(minusX[0]).toBeCloseTo(0.5, 12); expect(minusX[1]).toBeCloseTo(0.5, 12);
    const uniform: RadianceHdrImage = { width: 4, height: 2, data: new Float32Array(24).fill(0.75) };
    for (const direction of [[1, 0, 0], [0, 1, 0], [0, -1, 0], [0.3, 0.4, 0.5]] as const) {
      expect(sampleEquirectangular(uniform, direction)[0]).toBeCloseTo(0.75, 12);
    }
  });
});

describe("I-C19 reference prefilter expectations", () => {
  it("conerves a uniform white panorama through every specular mip and the diffuse plane", () => {
    const panorama: RadianceHdrImage = { width: 8, height: 4, data: new Float32Array(96).fill(1) };
    const reference = prefilterPanoramaReference(panorama, { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    expect(reference.mipCount).toBe(7);
    reference.specular.forEach((plane, level) => {
      const size = 64 >> level;
      expect(plane.length).toBe(size * size * 6 * 3);
      for (const value of plane) expect(Math.abs(value - 1)).toBeLessThan(1e-6);
    });
    expect(reference.diffuse.length).toBe(16 * 16 * 6 * 3);
    for (const value of reference.diffuse) expect(Math.abs(value - 1)).toBeLessThan(1e-6);
  });
  it("produces deterministic planes with direct panorama fetch at roughness zero", () => {
    const panorama = referencePanorama(16, 8);
    const first = prefilterPanoramaReference(panorama, { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    const second = prefilterPanoramaReference(panorama, { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    expect([...first.specular[0]!]).toEqual([...second.specular[0]!]);
    const sharp = first.specular[0]!, size = 64;
    const uv = ((31 + 0.5) / size) * 2 - 1; // 偶数面无正中 texel，取 (31,31) 固定点
    const direct = sampleEquirectangular(panorama, cubeDirection(uv, uv, 0));
    const base = ((0 * size + 31) * size + 31) * 3;
    for (let channel = 0; channel < 3; channel++) {
      expect(sharp[base + channel]!).toBeCloseTo(direct[channel]!, 6); // roughness=0 → 直接取样，weight=1
    }
    expect(() => prefilterPanoramaReference(panorama, { specularSize: 32 as never })).toThrow("quality");
  });
  it("degrades by rebasing onto the kept chain tail", () => {
    const reference = prefilterPanoramaReference(referencePanorama(8, 4), { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    const rebased = rebasedReferenceMips(reference, 3);
    expect(rebased.baseSize).toBe(4); // 链尾保留 sizes[4..6] = 4,2,1；mip0 重定基为 4
    expect(rebased.planes).toHaveLength(3);
    expect(rebased.planes[0]).toBe(reference.specular[4]);
    expect(() => rebasedReferenceMips(reference, 0)).toThrow();
    expect(() => rebasedReferenceMips(reference, 8)).toThrow();
  });
});

describe("I-C19 BRDF LUT reference", () => {
  it("matches the engine convention at the mirror corner and stays non-negative", () => {
    const lut = brdfLutReference(64);
    expect(lut.length).toBe(64 * 64 * 4);
    const corner = (x: number, y: number) => ({ x: lut[(y * 64 + x) * 4]!, y: lut[(y * 64 + x) * 4 + 1]!, z: lut[(y * 64 + x) * 4 + 2]!, w: lut[(y * 64 + x) * 4 + 3]! });
    const mirror = corner(63, 0); // nv≈0.996, rough≈0.004：DFG ≈ (1, 0)
    expect(mirror.x).toBeGreaterThan(0.9); expect(mirror.x).toBeLessThan(1.05);
    expect(mirror.y).toBeLessThan(0.05);
    const alpha = corner(0, 0); expect(alpha.w).toBe(1); expect(alpha.z).toBe(0);
    for (const value of lut) { expect(Number.isFinite(value)).toBe(true); expect(value).toBeGreaterThanOrEqual(0); }
    expect(() => brdfLutReference(48)).toThrow();
  });
});

describe("I-C19 half-float encoding and package assembly", () => {
  it("encodes canonical halves with round-to-nearest-even and contract clamps", () => {
    expect(floatToHalf(0)).toBe(0); expect(floatToHalf(-1)).toBe(0); expect(floatToHalf(NaN)).toBe(0);
    expect(floatToHalf(Infinity)).toBe(0); expect(floatToHalf(1e6)).toBe(0x7bff); expect(floatToHalf(65504)).toBe(0x7bff);
    expect(floatToHalf(1)).toBe(0x3c00); expect(floatToHalf(0.5)).toBe(0x3800); expect(floatToHalf(2)).toBe(0x4000);
    expect(floatToHalf(1e-8)).toBe(0); expect(floatToHalf(6e-8)).toBe(1);
    expect(floatToHalf(1.00048828125)).toBe(0x3c00); // 半 ULP 平局 → 舍入到偶数
    expect(floatToHalf(1.000732421875)).toBe(0x3c01);
    expect(halfToFloat(floatToHalf(0.1))).toBeCloseTo(0.1, 4);
    expect(halfToFloat(floatToHalf(6.5))).toBeCloseTo(6.5, 3);
  });
  it("emits structurally valid base64 planes that pass the canonical byte visitor", () => {
    const plane = new Float32Array(4 * 4 * 6 * 3);
    for (let index = 0; index < plane.length; index++) plane[index] = index % 7 === 0 ? 0 : index * 0.01;
    const text = encodeIblPlaneBase64(plane, 4, 6, 3);
    expect(text.length).toBe(Math.ceil(4 * 4 * 6 * 8 / 3) * 4);
    expect(() => visitIblBytes(text, 4 * 4 * 6 * 8, "$.test")).not.toThrow();
    expect(base64Encode(new Uint8Array([0, 0, 0]))).toBe("AAAA");
    expect(base64Encode(new Uint8Array([255]))).toBe("/w==");
  });
  it("assembles a RuntimePrefilteredIbl that passes validateRuntimePrefilteredIbl", () => {
    const reference = prefilterPanoramaReference(referencePanorama(16, 8), { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    const ibl = encodeRuntimeIblReference(reference,
      { id: "deep.test.reference", revision: 1, contentHash: { algorithm: "sha256", value: "c".repeat(64) }, license: "CC0" }, 64);
    expect(() => validateRuntimePrefilteredIbl(ibl, "deep.test.reference", 1)).not.toThrow();
    expect(ibl.specular.mips).toHaveLength(7);
    expect(ibl.brdfLut.width).toBe(64);
    expect(() => encodeRuntimeIblReference(reference,
      { id: "deep.test.reference", revision: 1, contentHash: { algorithm: "sha256", value: "c".repeat(64) }, license: "CC0" }, 128))
      .toThrow("must not exceed");
  }, 30000);
  it("encodes rebased mip expectations from the kept chain tail", () => {
    const reference = prefilterPanoramaReference(referencePanorama(8, 4), { specularSize: 64, diffuseSize: 16, sampleCount: 64 });
    expect(encodeRebasedMipBase64(reference, 3, 0))
      .toBe(encodeIblPlaneBase64(reference.specular[4]!, 4, 6, 3));
    expect(encodeRebasedMipBase64(reference, 3, 2))
      .toBe(encodeIblPlaneBase64(reference.specular[6]!, 1, 6, 3));
    expect(() => encodeRebasedMipBase64(reference, 3, 3)).toThrow();
  });
});

describe("I-C19 GPU readback comparison", () => {
  const expected = new Float32Array([1, 2, 3, 4, 5, 6]);
  it("reports zero error for identical data through the rgba readback stride", () => {
    const actual = new Float32Array([1, 2, 3, 1, 4, 5, 6, 1]);
    const comparison = compareIblReference(expected, actual);
    expect(comparison.maxAbsError).toBe(0); expect(comparison.pass).toBe(true);
    expect(comparison.samples).toBe(2);
  });
  it("detects channel drift and enforces the tolerance gate", () => {
    const drifted = new Float32Array([1, 2, 3.5, 1, 4, 5, 6, 1]);
    const comparison = compareIblReference(expected, drifted);
    expect(comparison.maxAbsError).toBeCloseTo(0.5, 12); expect(comparison.pass).toBe(false);
    expect(compareIblReference(expected, drifted, { tolerance: 0.5 }).pass).toBe(true);
    expect(comparison.maxRelError).toBeCloseTo(0.5 / 3, 12);
    expect(comparison.meanAbsError).toBeCloseTo(0.5 / 6, 12);
  });
  it("fails closed on inconsistent lengths", () => {
    expect(() => compareIblReference(expected, new Float32Array(4))).toThrow();
    expect(() => compareIblReference(expected, new Float32Array(8), { actualStride: 5 })).toThrow();
  });
});

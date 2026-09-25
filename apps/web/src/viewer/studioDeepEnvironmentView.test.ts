import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { readStudioDeepEnvironmentView } from "./studioDeepEnvironmentView";

function scene() {
  const author = new THREE.Scene();
  author.background = new THREE.Color().setRGB(0.25, 0.5, 2, THREE.LinearSRGBColorSpace);
  return author;
}

function sky(colorSpace: string = THREE.LinearSRGBColorSpace) {
  const texture = new THREE.DataTexture(new Float32Array([2, 1, 0, 1]), 1, 1,
    THREE.RGBAFormat, THREE.FloatType);
  texture.colorSpace = colorSpace;
  texture.mapping = THREE.EquirectangularReflectionMapping;
  return texture;
}

describe("Studio author environment render view", () => {
  it("preserves linear composer background values without injecting IBL or a floor", () => {
    const author = scene(); author.environmentIntensity = 9;
    expect(readStudioDeepEnvironmentView(author, true)).toEqual({
      background: [0.25, 0.5, 2], floor: [0, 0, 0], environmentIntensity: 0,
    });
  });

  it.each([0, 0.4, 1, 2, 64])("uses real author IBL intensity %s", intensity => {
    const author = scene(); author.environment = sky(); author.environmentIntensity = intensity;
    expect(readStudioDeepEnvironmentView(author, true).environmentIntensity).toBe(intensity);
    expect(author.environmentIntensity).toBe(intensity);
  });

  it("rejects pure-color display-domain composition without a composer", () => {
    expect(() => readStudioDeepEnvironmentView(scene(), false)).toThrow("纯色背景显示域合成");
  });

  it("routes sRGB sky to display-space composition without a composer and tone maps it with a composer", () => {
    const author = scene(); author.background = sky(THREE.SRGBColorSpace);
    expect(readStudioDeepEnvironmentView(author, false).panoramaBackground).toMatchObject({ toneMapped: false });
    expect(readStudioDeepEnvironmentView(author, true).panoramaBackground).toMatchObject({ toneMapped: true });
  });

  it("tone maps linear HDR without a composer and preserves author sky intensity", () => {
    const author = scene(); author.background = sky(); author.backgroundIntensity = 2.5;
    expect(readStudioDeepEnvironmentView(author, false)).toMatchObject({
      background: [0, 0, 0], environmentIntensity: 0,
      panoramaBackground: { intensity: 2.5, toneMapped: true },
    });
  });

  it("uses the transposed author rotation matrix and rotates +X toward +Z for +90 degree yaw", () => {
    const author = scene(); author.background = sky(); author.backgroundRotation.set(0, Math.PI / 2, 0);
    const original = author.backgroundRotation.clone();
    const view = readStudioDeepEnvironmentView(author, false);
    const expected = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromEuler(original)).transpose();
    expect(view.panoramaBackground?.rotation).toEqual(expected.toArray());
    const actual = new THREE.Matrix3().fromArray(view.panoramaBackground!.rotation!);
    const direction = new THREE.Vector3(1, 0, 0).applyMatrix3(actual);
    expect(direction.x).toBeCloseTo(0, 12);
    expect(direction.y).toBeCloseTo(0, 12);
    expect(direction.z).toBeCloseTo(1, 12);
    expect(author.backgroundRotation.equals(original)).toBe(true);
  });

  it("preserves the author Euler order for compound rotations", () => {
    const author = scene(); author.background = sky(); author.backgroundRotation.set(0.4, -0.7, 1.2, "ZYX");
    const view = readStudioDeepEnvironmentView(author, true);
    const rotation = new THREE.Matrix3().fromArray(view.panoramaBackground!.rotation!);
    const direction = new THREE.Vector3(0.2, 0.3, 0.9).normalize();
    const expected = direction.clone().applyQuaternion(new THREE.Quaternion().setFromEuler(author.backgroundRotation).invert());
    expect(direction.clone().applyMatrix3(rotation).distanceTo(expected)).toBeLessThan(1e-12);
  });

  it.each([0.1, -1, NaN, Infinity])("rejects unsupported sky blur %s", blur => {
    const author = scene(); author.background = sky(); author.backgroundBlurriness = blur;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("天空模糊");
  });

  it.each([0.1, NaN, Infinity])("rejects nonzero or invalid IBL rotation %s", value => {
    const author = scene(); author.environment = sky(); author.environmentRotation.y = value;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("环境反射旋转");
  });

  it.each([-1, 65, NaN, Infinity])("rejects invalid IBL intensity %s", intensity => {
    const author = scene(); author.environment = sky(); author.environmentIntensity = intensity;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("0 到 64");
  });

  it.each([-1, NaN, Infinity])("rejects invalid linear background component %s", value => {
    const author = scene(); (author.background as THREE.Color).r = value;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("有限非负数");
  });

  it("rejects null transparent background", () => {
    const author = scene(); author.background = null;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("透明场景背景");
  });
  it.each([NaN, Infinity, -1, 65])("rejects invalid panorama intensity %s before staging", value => {
    const author = scene(); author.background = sky(); author.backgroundIntensity = value;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("Panorama intensity");
  });
  it("rejects invalid panorama rotation before staging", () => {
    const author = scene(); author.background = sky(); author.backgroundRotation.x = NaN;
    expect(() => readStudioDeepEnvironmentView(author, true)).toThrow("Panorama rotation");
  });
});

import * as THREE from "three";
import { describe, expect, it } from "vitest";
import {
  applyMaterialTextureTransform,
  materialTextureTransformState,
  readMaterialTextureTransform,
  resolveMaterialTextureTransform,
  writeMaterialTextureTransform,
} from "./materialTextureTransform";

describe("material texture transform", () => {
  it("keeps legacy uniform repeat compatible", () => {
    expect(resolveMaterialTextureTransform({ textureRepeat: 3 })).toMatchObject({
      repeatX: 3,
      repeatY: 3,
      offsetX: 0,
      offsetY: 0,
    });
  });

  it("merges independent UV patches without losing the other axis", () => {
    const current = { repeatX: 4, repeatY: 2, offsetX: 0.25, offsetY: -0.1, rotation: 0.2 };
    expect(resolveMaterialTextureTransform({ textureRepeatY: 6, textureOffsetX: 0.5 }, current)).toEqual({
      ...current,
      repeatY: 6,
      offsetX: 0.5,
    });
  });

  it("applies independent repeat, offset and rotation to a Three texture", () => {
    const texture = new THREE.Texture();
    applyMaterialTextureTransform(texture, {
      repeatX: 5,
      repeatY: 1.5,
      offsetX: 0.2,
      offsetY: -0.35,
      rotation: Math.PI / 4,
    });

    expect(texture.repeat.toArray()).toEqual([5, 1.5]);
    expect(texture.offset.toArray()).toEqual([0.2, -0.35]);
    expect(texture.rotation).toBe(Math.PI / 4);
    expect(texture.wrapS).toBe(THREE.RepeatWrapping);
    expect(texture.wrapT).toBe(THREE.RepeatWrapping);
  });

  it("persists the normalized independent transform without the legacy key", () => {
    const metadata: Record<string, unknown> = { studioTextureRepeat: 2 };
    const transform = resolveMaterialTextureTransform(
      { textureRepeatX: 5, textureOffsetY: 0.4 },
      readMaterialTextureTransform(metadata),
    );
    writeMaterialTextureTransform(metadata, transform);

    expect(metadata).not.toHaveProperty("studioTextureRepeat");
    expect(materialTextureTransformState(metadata)).toEqual({
      textureRepeatX: 5,
      textureRepeatY: 2,
      textureOffsetX: 0,
      textureOffsetY: 0.4,
      textureRotation: 0,
    });
  });
});

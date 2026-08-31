import * as THREE from "three";
import type { SceneMaterialState } from "@bim-studio/contracts";

export interface MaterialTextureTransform {
  repeatX: number;
  repeatY: number;
  offsetX: number;
  offsetY: number;
  rotation: number;
}

export const DEFAULT_MATERIAL_TEXTURE_TRANSFORM: MaterialTextureTransform = {
  repeatX: 1,
  repeatY: 1,
  offsetX: 0,
  offsetY: 0,
  rotation: 0,
};

type TextureTransformMetadata = Record<string, unknown>;

export function hasMaterialTextureTransformPatch(state: SceneMaterialState): boolean {
  return [
    state.textureRepeat,
    state.textureRepeatX,
    state.textureRepeatY,
    state.textureOffsetX,
    state.textureOffsetY,
    state.textureRotation,
  ].some((value) => value !== undefined);
}

export function readMaterialTextureTransform(data: TextureTransformMetadata): MaterialTextureTransform {
  const legacyRepeat = finite(data.studioTextureRepeat);
  return {
    repeatX: finite(data.studioTextureRepeatX) ?? legacyRepeat ?? 1,
    repeatY: finite(data.studioTextureRepeatY) ?? legacyRepeat ?? 1,
    offsetX: finite(data.studioTextureOffsetX) ?? 0,
    offsetY: finite(data.studioTextureOffsetY) ?? 0,
    rotation: finite(data.studioTextureRotation) ?? 0,
  };
}

export function writeMaterialTextureTransform(
  data: TextureTransformMetadata,
  transform: MaterialTextureTransform,
): void {
  data.studioTextureRepeatX = transform.repeatX;
  data.studioTextureRepeatY = transform.repeatY;
  data.studioTextureOffsetX = transform.offsetX;
  data.studioTextureOffsetY = transform.offsetY;
  data.studioTextureRotation = transform.rotation;
  delete data.studioTextureRepeat;
}

export function materialTextureTransformState(data: TextureTransformMetadata): SceneMaterialState {
  const hasLegacyRepeat = finite(data.studioTextureRepeat) !== undefined;
  const hasIndependentTransform = [
    data.studioTextureRepeatX,
    data.studioTextureRepeatY,
    data.studioTextureOffsetX,
    data.studioTextureOffsetY,
  ].some((value) => finite(value) !== undefined);
  if (!hasLegacyRepeat && !hasIndependentTransform && finite(data.studioTextureRotation) === undefined) return {};
  const transform = readMaterialTextureTransform(data);
  return hasIndependentTransform
    ? {
        textureRepeatX: transform.repeatX,
        textureRepeatY: transform.repeatY,
        textureOffsetX: transform.offsetX,
        textureOffsetY: transform.offsetY,
        textureRotation: transform.rotation,
      }
    : {
        ...(hasLegacyRepeat ? { textureRepeat: transform.repeatX } : {}),
        textureRotation: transform.rotation,
      };
}

/**
 * 合并增量材质状态与当前运行时状态。旧版 `textureRepeat` 仍可同时更新 U/V，
 * 新版独立参数优先，避免导入旧场景后出现纹理比例跳变。
 */
export function resolveMaterialTextureTransform(
  state: SceneMaterialState,
  current: MaterialTextureTransform = DEFAULT_MATERIAL_TEXTURE_TRANSFORM,
): MaterialTextureTransform {
  const legacyRepeat = finite(state.textureRepeat);
  return {
    repeatX: clamp(finite(state.textureRepeatX) ?? legacyRepeat ?? current.repeatX, 0.05, 100),
    repeatY: clamp(finite(state.textureRepeatY) ?? legacyRepeat ?? current.repeatY, 0.05, 100),
    offsetX: clamp(finite(state.textureOffsetX) ?? current.offsetX, -100, 100),
    offsetY: clamp(finite(state.textureOffsetY) ?? current.offsetY, -100, 100),
    rotation: finite(state.textureRotation) ?? current.rotation,
  };
}

export function applyMaterialTextureTransform(
  texture: THREE.Texture,
  transform: MaterialTextureTransform,
): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(transform.repeatX, transform.repeatY);
  texture.offset.set(transform.offsetX, transform.offsetY);
  texture.center.set(0.5, 0.5);
  texture.rotation = transform.rotation;
  texture.needsUpdate = true;
}

function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

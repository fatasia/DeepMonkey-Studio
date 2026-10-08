import { planTextureMips, prepareTextures, type DecodedTexture, type PreparedTexture } from "../textures/decodedTexture.js";
import type { PbrFog } from "./pbrFog.js";

const gridSrgbDecode = Float64Array.from({ length: 256 }, (_, byte) => {
  const value = byte / 255;
  return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
});

export interface AuthorGridView {
  readonly texture: DecodedTexture;
  readonly model: readonly number[];
  readonly color: readonly [number, number, number, number];
  readonly fog?: PbrFog | null | undefined;
  readonly authorDirectDisplay?: boolean;
}

/** Fixed Canvas grid input: copy level zero, then construct the linear-light mip chain. */
export function prepareAuthorGridTexture(source: DecodedTexture): PreparedTexture {
  const work = prepareAuthorGridTextureSteps(source);
  for (;;) { const step = work.next(); if (step.done) return step.value; }
}

/** Same exact mip bytes; candidate admission yields between bounded row batches. */
export async function prepareAuthorGridTextureAsync(source: DecodedTexture, isCurrent: () => boolean = () => true): Promise<PreparedTexture> {
  const work = prepareAuthorGridTextureSteps(source);
  for (;;) {
    if (!isCurrent()) throw new Error("Author grid device is unavailable.");
    const step = work.next();
    if (step.done) return step.value;
    const scheduler = (globalThis as { scheduler?: { yield(): Promise<void> } }).scheduler;
    if (scheduler?.yield) await scheduler.yield();
    else await new Promise<void>(resolve => {
      if (typeof MessageChannel === "undefined") { setTimeout(resolve, 0); return; }
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(undefined);
    });
  }
}

function* prepareAuthorGridTextureSteps(source: DecodedTexture): Generator<void, PreparedTexture> {
  if (![source.width, source.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2048))
    throw new Error("Author grid requires bounded texture dimensions.");
  // 作者网格走传统 2×2 mip 折减，非 2 的幂宽高会破坏 mip 链（批次 F 回归保护）。
  if (![source.width, source.height].every(value => (value & (value - 1)) === 0))
    throw new Error("Author grid requires power-of-two texture dimensions.");
  if (source.semantic !== "baseColor" || source.compression || source.mipmaps) throw new Error("Unsupported author grid texture.");
  // The fixed Canvas plane does not tile. Keep explicit SDK sampler choices,
  // but do not inherit the general decoded-texture repeat default at its rim.
  const initial = prepareTextures([{ ...source, sampler: {
    addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge", ...source.sampler,
  } }], { maxDimension: 2048, maxBytes: 24 * 1024 * 1024 })[0]!;
  const levels = [initial.levels[0]!];
  const encode = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  const encoded = new Map<number, number>();
  const encodeByte = (value: number): number => {
    let byte = encoded.get(value);
    if (byte === undefined) {
      byte = Math.round(255 * encode(value));
      if (encoded.size < 4096) encoded.set(value, byte);
    }
    return byte;
  };
  for (const layout of planTextureMips(source.width, source.height, 2048).slice(1)) {
    const previous = levels.at(-1)!, data = new Uint8Array(layout.byteLength);
    for (let y = 0; y < layout.height; y++) {
      for (let x = 0; x < layout.width; x++) for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const byte = previous.data[(Math.min(y * 2 + dy, previous.height - 1) * previous.width + Math.min(x * 2 + dx, previous.width - 1)) * 4 + channel]!;
        sum += channel === 3 ? byte / 255 : gridSrgbDecode[byte]!;
      }
      data[(y * layout.width + x) * 4 + channel] = channel === 3 ? Math.round(255 * (sum / 4)) : encodeByte(sum / 4);
      }
      if (y % 8 === 7) yield;
    }
    levels.push({ ...layout, data });
  }
  return { ...initial, levels, byteLength: levels.reduce((sum, level) => sum + level.byteLength, 0) };
}

export function authorGridUniforms(view: AuthorGridView, viewProjection: ArrayLike<number>): Float32Array<ArrayBuffer> {
  if (view.model.length !== 16 || viewProjection.length !== 16 || !Array.from(viewProjection).every(Number.isFinite)
    || !view.model.every(Number.isFinite) || view.color.length !== 4
    || !view.color.every(value => Number.isFinite(value) && value >= 0 && value <= 1)) throw new Error("Invalid author grid transform/color.");
  const data = new Float32Array(20);
  for (let col = 0; col < 4; col++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++)
    data[col * 4 + row]! += viewProjection[k * 4 + row]! * view.model[col * 4 + k]!;
  data.set(view.color, 16);
  if (!data.every(Number.isFinite)) throw new Error("Author grid transform overflows float32.");
  return data;
}

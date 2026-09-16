import { planTextureMips, prepareTextures, type DecodedTexture, type PreparedTexture } from "../textures/decodedTexture.js";
import type { PbrFog } from "./pbrFog.js";

export interface AuthorGridView {
  readonly texture: DecodedTexture;
  readonly model: readonly number[];
  readonly color: readonly [number, number, number, number];
  readonly fog?: PbrFog | null | undefined;
}

/** Fixed Canvas grid input: copy level zero, then construct the linear-light mip chain. */
export function prepareAuthorGridTexture(source: DecodedTexture): PreparedTexture {
  if (![source.width, source.height].every(value => Number.isSafeInteger(value) && value > 0 && value <= 2048 && (value & (value - 1)) === 0))
    throw new Error("Author grid requires bounded power-of-two texture dimensions.");
  if (source.semantic !== "baseColor" || source.compression || source.mipmaps) throw new Error("Unsupported author grid texture.");
  const initial = prepareTextures([source], { maxDimension: 2048, maxBytes: 24 * 1024 * 1024 })[0]!;
  const levels = [initial.levels[0]!];
  const decode = (v: number) => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  const encode = (v: number) => v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055;
  for (const layout of planTextureMips(source.width, source.height, 2048).slice(1)) {
    const previous = levels.at(-1)!, data = new Uint8Array(layout.byteLength);
    for (let y = 0; y < layout.height; y++) for (let x = 0; x < layout.width; x++) for (let channel = 0; channel < 4; channel++) {
      let sum = 0;
      for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
        const value = previous.data[(Math.min(y * 2 + dy, previous.height - 1) * previous.width + Math.min(x * 2 + dx, previous.width - 1)) * 4 + channel]! / 255;
        sum += channel === 3 ? value : decode(value);
      }
      data[(y * layout.width + x) * 4 + channel] = Math.round(255 * (channel === 3 ? sum / 4 : encode(sum / 4)));
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

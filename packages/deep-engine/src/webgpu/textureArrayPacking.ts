/**
 * 纹理数组打包合同（波次5 bindless 级 1）：把场景纹理按（格式×宽×高）分箱进
 * texture_2d_array，输出数组计划与每纹理的 (arrayIndex, layerIndex) 分配。
 * 确定性：箱内按 textureId 字典序分配层。溢出（层超设备上限）的纹理进 overflowed
 * 由调用方回退常规 bind group 路径——fail-closed，绝不静默丢弃。
 */

export interface TextureArrayPackingEntry {
  readonly textureId: string;
  readonly format: string;
  readonly width: number;
  readonly height: number;
}

export interface TextureArrayPackingInput {
  readonly entries: readonly TextureArrayPackingEntry[];
  /** 设备 maxTextureArrayLayers。 */
  readonly maxArrayLayers: number;
}

export interface TextureArrayPlanEntry {
  readonly format: string;
  readonly width: number;
  readonly height: number;
  readonly arrayIndex: number;
  readonly layers: readonly string[];
}

export interface TextureArrayPlan {
  readonly arrays: readonly TextureArrayPlanEntry[];
  readonly assignments: ReadonlyMap<string, { readonly arrayIndex: number; readonly layerIndex: number }>;
  readonly overflowed: readonly string[];
}

export function planTextureArrays(input: TextureArrayPackingInput): TextureArrayPlan {
  if (!Number.isSafeInteger(input.maxArrayLayers) || input.maxArrayLayers < 1) {
    throw new RangeError("maxArrayLayers must be a positive safe integer.");
  }
  const boxes = new Map<string, { format: string; width: number; height: number; ids: string[] }>();
  for (const entry of input.entries) {
    if (!entry || typeof entry.textureId !== "string" || entry.textureId.length === 0
      || typeof entry.format !== "string" || entry.format.length === 0) {
      throw new TypeError("Texture array entries require non-empty textureId and format.");
    }
    if (!Number.isSafeInteger(entry.width) || entry.width < 1 || !Number.isSafeInteger(entry.height) || entry.height < 1) {
      throw new RangeError(`Texture ${entry.textureId} has invalid dimensions.`);
    }
    const key = `${entry.format}|${entry.width}x${entry.height}`;
    const box = boxes.get(key) ?? { format: entry.format, width: entry.width, height: entry.height, ids: [] };
    box.ids.push(entry.textureId);
    boxes.set(key, box);
  }
  const arrays: TextureArrayPlanEntry[] = [];
  const assignments = new Map<string, { arrayIndex: number; layerIndex: number }>();
  const overflowed: string[] = [];
  const sortedBoxes = [...boxes.values()].sort((a, b) =>
    a.format.localeCompare(b.format) || a.width - b.width || a.height - b.height);
  for (const box of sortedBoxes) {
    const arrayIndex = arrays.length;
    const layers = [...box.ids].sort((a, b) => a < b ? -1 : 1);
    const fitted = layers.slice(0, input.maxArrayLayers);
    if (layers.length > input.maxArrayLayers) overflowed.push(...layers.slice(input.maxArrayLayers));
    arrays.push({ format: box.format, width: box.width, height: box.height, arrayIndex, layers: fitted });
    fitted.forEach((textureId, layerIndex) => assignments.set(textureId, { arrayIndex, layerIndex }));
  }
  return { arrays: Object.freeze(arrays), assignments, overflowed: Object.freeze(overflowed) };
}

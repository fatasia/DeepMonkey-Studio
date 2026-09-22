// 容器预检，不替代 glTF 几何、feature 或依赖闭包验收。
// https://github.com/CesiumGS/3d-tiles/blob/main/specification/TileFormats/Batched3DModel/README.adoc
export function inspectB3dmContainer(input, { maxBytes = 256 * 1024 * 1024 } = {}) {
  if (!(input instanceof Uint8Array)) throw new Error('B3DM input must be bytes');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 28) throw new Error('Invalid B3DM byte budget');
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const require = (condition, reason) => { if (!condition) throw new Error(`B3DM: ${reason}`); };
  require(bytes.length >= 28, 'truncated header');
  require(bytes.length <= maxBytes, 'byte budget exceeded');
  require(bytes.subarray(0, 4).equals(Buffer.from('b3dm')), 'invalid magic');
  require(bytes.readUInt32LE(4) === 1, 'unsupported version');
  require(bytes.readUInt32LE(8) === bytes.length, 'declared length mismatch');
  const lengths = [12, 16, 20, 24].map((offset) => bytes.readUInt32LE(offset));
  const glbOffset = 28 + lengths.reduce((sum, length) => sum + length, 0);
  require(glbOffset + 20 <= bytes.length, 'table lengths exceed payload');
  require(lengths[0] > 0, 'missing feature table');
  require(lengths[2] > 0 || lengths[3] === 0, 'batch binary without JSON');
  const json = (offset, length, label) => {
    if (!length) return {};
    // JSON 表有独立预算，避免极大的元数据在解析时放大内存。
    require(length <= 8 * 1024 * 1024, `${label} JSON budget exceeded`);
    let value;
    try {
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + length)));
    } catch { throw new Error(`B3DM: invalid ${label} JSON`); }
    require(value !== null && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
    return value;
  };
  const featureTable = json(28, lengths[0], 'feature table');
  const batchTable = json(28 + lengths[0] + lengths[1], lengths[2], 'batch table');
  const binaryStart = 28 + lengths[0];
  const scalar = featureTable.BATCH_LENGTH;
  let batchLength;
  if (typeof scalar === 'number') batchLength = scalar;
  else {
    require(scalar && typeof scalar === 'object' && Number.isSafeInteger(scalar.byteOffset)
      && scalar.byteOffset >= 0 && scalar.byteOffset % 4 === 0 && scalar.byteOffset + 4 <= lengths[1],
    'invalid BATCH_LENGTH binary reference');
    batchLength = bytes.readUInt32LE(binaryStart + scalar.byteOffset);
  }
  require(Number.isSafeInteger(batchLength) && batchLength >= 0 && batchLength <= 0xffffffff,
    'invalid BATCH_LENGTH');
  require(bytes.subarray(glbOffset, glbOffset + 4).equals(Buffer.from('glTF')), 'invalid embedded GLB magic');
  const glbVersion = bytes.readUInt32LE(glbOffset + 4);
  require(glbVersion === 1 || glbVersion === 2, 'unsupported embedded GLB version');
  const glbBytes = bytes.readUInt32LE(glbOffset + 8);
  require(glbBytes >= 20 && glbOffset + glbBytes <= bytes.length, 'invalid embedded GLB length');
  const padding = bytes.subarray(glbOffset + glbBytes);
  require(padding.length <= 7 && padding.every((byte) => byte === 0), 'invalid trailing padding');
  const jsonLength = bytes.readUInt32LE(glbOffset + 12);
  require(jsonLength > 0 && jsonLength + 20 <= glbBytes, 'invalid embedded GLB JSON length');
  require(bytes.readUInt32LE(glbOffset + 16) === (glbVersion === 1 ? 0 : 0x4e4f534a),
    'invalid embedded GLB JSON type');
  const diagnostics = [];
  // 保留旧版真实瓦片的 inspect 能力，但不得据此声明符合现代 GLB 2 profile。
  if (glbVersion === 1) diagnostics.push('legacy-glb-1-needs-conversion');
  if (glbOffset % 8 !== 0 || bytes.length % 8 !== 0) diagnostics.push('legacy-container-alignment');
  return { version: 1, glbVersion, glbOffset, glbBytes, batchLength, featureTable, batchTable, diagnostics };
}

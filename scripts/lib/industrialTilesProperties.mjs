// 沿用 properties.json 的 model/elements/displayProperties 结构，不把 batch ID 当业务 ID。
export function buildTilesProperties(sourceSha256, batchLength, table, referencedBatchIds) {
  if (!/^[a-f0-9]{64}$/i.test(sourceSha256)) throw new Error('Invalid source hash');
  if (!Number.isSafeInteger(batchLength) || batchLength < 0 || batchLength > 100_000) {
    throw new Error('Invalid or over-budget batch count');
  }
  if (!table || typeof table !== 'object' || Array.isArray(table)) throw new Error('Invalid batch table');
  assertJsonMetadata(table);
  // 独立快照避免后续源对象变化导致属性与已计算哈希失配。
  table = structuredClone(table);
  for (const [name, values] of Object.entries(table)) {
    if (!Array.isArray(values) || values.length !== batchLength) {
      throw new Error(`Unsupported binary/extension or inconsistent batch property: ${name}`);
    }
  }
  const used = new Set();
  for (const id of referencedBatchIds) {
    if (!Number.isInteger(id) || id < 0 || id >= batchLength) throw new Error('Out-of-range batch ID');
    used.add(id);
  }
  const elements = Object.fromEntries(Array.from({ length: batchLength }, (_, id) => {
    const elementId = `b3dm:${sourceSha256.toLowerCase()}:${id}`;
    const properties = Object.fromEntries(Object.entries(table).map(([name, values]) => [name, values[id]]));
    return [elementId, { elementId, batchId: id, geometryReferenced: used.has(id), properties,
      displayProperties: Object.fromEntries(Object.entries(properties).map(([key, value]) =>
        [key, typeof value === 'string' ? value : JSON.stringify(value)])) }];
  }));
  return { schemaVersion: 1, model: { sourceFormat: '3D Tiles', sourceSha256: sourceSha256.toLowerCase(),
    featureCount: batchLength, referencedFeatureCount: used.size }, elements };
}

function assertJsonMetadata(value) {
  const stack = new Set();
  let remaining = 1_000_000;
  const visit = (item, depth) => {
    if (--remaining < 0 || depth > 64) throw new Error('Batch metadata budget exceeded');
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return;
    if (typeof item === 'number' && Number.isFinite(item)) return;
    if (typeof item !== 'object' || stack.has(item)) throw new Error('Batch property is not finite JSON');
    if (!Array.isArray(item) && Object.getPrototypeOf(item) !== Object.prototype
      && Object.getPrototypeOf(item) !== null) throw new Error('Batch property is not plain JSON');
    stack.add(item);
    for (const child of Array.isArray(item) ? item : Object.values(item)) visit(child, depth + 1);
    stack.delete(item);
  };
  visit(value, 0);
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > 8 * 1024 * 1024) {
    throw new Error('Batch metadata byte budget exceeded');
  }
}

// RTC 平移转成普通父节点；只改节点结构，不烘焙大坐标到 Float32 顶点。
// 轴约定对照 CesiumGS/3d-tiles-tools@4ca692eb 的 GltfUtilities。
export function normalizeTilesRtc(document, upAxis = 'Y') {
  const extension = document.extensions?.CESIUM_RTC;
  if (!extension) {
    if (document.extensionsRequired?.includes('CESIUM_RTC')) throw new Error('Missing required RTC center');
    return document;
  }
  const center = extension.center;
  if (!['X', 'Y', 'Z'].includes(upAxis)) throw new Error('Invalid glTF up axis');
  if (!Array.isArray(center) || center.length !== 3 || !center.every(Number.isFinite)) {
    throw new Error('Invalid RTC center');
  }
  if (!Array.isArray(document.nodes) || !Array.isArray(document.scenes) || !document.scenes.length) {
    throw new Error('RTC document must contain nodes and scenes');
  }
  for (const scene of document.scenes) {
    if (!Array.isArray(scene.nodes) || !scene.nodes.every(index => Number.isInteger(index)
      && index >= 0 && index < document.nodes.length)) throw new Error('Invalid RTC scene root');
  }
  const result = { ...document, nodes: [...document.nodes],
    scenes: document.scenes.map(scene => ({ ...scene, nodes: [...scene.nodes] })),
    extensions: { ...document.extensions } };
  const [x, y, z] = center;
  const translation = upAxis === 'Y' ? [x, z, -y] : upAxis === 'X' ? [y, -z, -x] : [x, y, z];
  for (const scene of result.scenes) {
    scene.nodes = scene.nodes.map(index => {
      const parentIndex = result.nodes.length;
      result.nodes.push({ translation: [...translation], children: [index] });
      return parentIndex;
    });
  }
  delete result.extensions.CESIUM_RTC;
  if (!Object.keys(result.extensions).length) delete result.extensions;
  for (const key of ['extensionsUsed', 'extensionsRequired']) {
    if (Array.isArray(result[key])) {
      result[key] = result[key].filter(value => value !== 'CESIUM_RTC');
      if (!result[key].length) delete result[key];
    }
  }
  return result;
}

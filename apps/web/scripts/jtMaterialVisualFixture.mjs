import assert from 'node:assert/strict';
import { NodeIO } from '@gltf-transform/core';

/** 仅改变展示姿态，保留两个真实源实例的几何、材质与源路径。 */
export async function jtMaterialPair(bytes) {
  const io = new NodeIO(); const document = await io.readBinary(bytes);
  const scene = document.getRoot().getDefaultScene() ?? document.getRoot().listScenes()[0];
  assert.ok(scene);
  const silver = scene.listChildren().find(node => String(node.getExtras().AssemblyPath).includes('/18/184/'));
  const gray = scene.listChildren().find(node => String(node.getExtras().AssemblyPath).includes('/43/184/'));
  assert.ok(silver && gray);
  const a = silver.getMesh().listPrimitives(), b = gray.getMesh().listPrimitives();
  assert.equal(a.length, b.length);
  assert.notDeepEqual(a[0].getMaterial().getBaseColorFactor(), b[0].getMaterial().getBaseColorFactor());
  a.forEach((primitive, index) => {
    assert.equal(primitive.getAttribute('POSITION'), b[index].getAttribute('POSITION'));
    assert.equal(primitive.getIndices(), b[index].getIndices());
  });
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const primitive of a) {
    const values = primitive.getAttribute('POSITION').getArray();
    for (let i = 0; i < values.length; i++) { const axis = i % 3; min[axis] = Math.min(min[axis], values[i]); max[axis] = Math.max(max[axis], values[i]); }
  }
  const span = Math.max(...max.map((value, axis) => value - min[axis]));
  for (const node of [...scene.listChildren()]) if (node !== silver && node !== gray) scene.removeChild(node);
  for (const [index, node] of [silver, gray].entries()) {
    node.setMatrix([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
    node.setTranslation([-0.5 * (max[0] + min[0]) + (index - 0.5) * span * 1.7, -min[1], -0.5 * (max[2] + min[2])]);
    node.setName(index === 0 ? '源节点18 · 银色' : '源节点43 · 灰色');
  }
  return Buffer.from(await io.writeBinary(document));
}

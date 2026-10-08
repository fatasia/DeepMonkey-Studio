export interface InitialPoseFixtureOptions {
  readonly secondInstance?: boolean;
  readonly morphOnly?: boolean;
}

/** Translated mesh, scaled joint, inverse bind and initial morph deliberately disagree with clip frame zero. */
export function initialPoseFixture(options: InitialPoseFixtureOptions = {}): Uint8Array {
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const inverseBind = [...identity]; inverseBind[12] = -1;
  const normal = Math.SQRT1_2;
  const chunks = [
    floats([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    new Uint8Array(12), floats([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0]),
    floats(inverseBind), floats([1, 0, 0, 1, 0, 0, 1, 0, 0]),
    floats([normal, normal, 0, normal, normal, 0, normal, normal, 0]),
    floats([0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1]),
    floats([0, 0, 1, 0, 0, 1]), floats([1, 1, 0, 1, 1, 0]),
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), floats([0, 1]), floats([99, 0, 0, 100, 0, 0]),
  ];
  const offsets: number[] = [];
  const size = chunks.reduce((sum, bytes) => { const offset = (sum + 3) & ~3; offsets.push(offset); return offset + bytes.length; }, 0);
  const bin = new Uint8Array((size + 3) & ~3); chunks.forEach((bytes, index) => bin.set(bytes, offsets[index]!));
  const accessor = (bufferView: number, count: number, type: string) => ({ bufferView, componentType: 5126, count, type });
  const nodes: Record<string, unknown>[] = [{ translation: [1, 0, 0], children: [1, 2] },
    { translation: [10, 0, 0], scale: [2, 1, 1] },
    { mesh: 0, translation: [-24.5, 0, 0], weights: [0.2], ...(options.morphOnly ? {} : { skin: 0 }) }];
  if (options.secondInstance) {
    nodes[0]!.children = [1, 2, 3];
    nodes.push({ mesh: 0, translation: [7, 0, 0], weights: [0.8], skin: 0 });
  }
  const attributes = { POSITION: 0, NORMAL: 5, TANGENT: 6, TEXCOORD_0: 7, TEXCOORD_1: 8,
    ...(options.morphOnly ? {} : { JOINTS_0: 1, WEIGHTS_0: 2 }) };
  const document = { asset: { version: "2.0" }, buffers: [{ byteLength: bin.length }],
    bufferViews: chunks.map((bytes, index) => ({ buffer: 0, byteOffset: offsets[index], byteLength: bytes.length })),
    accessors: [accessor(0, 3, "VEC3"), { ...accessor(1, 3, "VEC4"), componentType: 5121 }, accessor(2, 3, "VEC4"),
      accessor(3, 1, "MAT4"), accessor(4, 3, "VEC3"), accessor(5, 3, "VEC3"), accessor(6, 3, "VEC4"),
      accessor(7, 3, "VEC2"), accessor(8, 3, "VEC2"),
      { ...accessor(10, 2, "SCALAR"), min: [0], max: [1] }, accessor(11, 2, "VEC3")],
    nodes, scenes: [{ nodes: [0] }], scene: 0,
    ...(options.morphOnly ? {} : { skins: [{ joints: [1], inverseBindMatrices: 3 }] }),
    meshes: [{ primitives: [{ attributes, targets: [{ POSITION: 4 }], material: 0 }] }],
    animations: [{ samplers: [{ input: 9, output: 10 }], channels: [{ sampler: 0, target: { node: 1, path: "translation" } }] }],
    images: [{ bufferView: 9, mimeType: "image/png" }], textures: [{ source: 0 }],
    materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } }, extensions: {
      KHR_materials_specular: { specularFactor: 0.4, specularColorFactor: [0.7, 0.8, 0.9],
        specularTexture: { index: 0, texCoord: 1 }, specularColorTexture: { index: 0 } },
      KHR_materials_transmission: { transmissionFactor: 1 },
    } }], extensionsUsed: ["KHR_materials_specular", "KHR_materials_transmission"] };
  const encoded = new TextEncoder().encode(JSON.stringify(document)), jsonLength = (encoded.length + 3) & ~3;
  const output = new Uint8Array(28 + jsonLength + bin.length), view = new DataView(output.buffer);
  view.setUint32(0, 0x46546c67, true); view.setUint32(4, 2, true); view.setUint32(8, output.length, true);
  view.setUint32(12, jsonLength, true); view.setUint32(16, 0x4e4f534a, true);
  output.fill(0x20, 20, 20 + jsonLength); output.set(encoded, 20);
  view.setUint32(20 + jsonLength, bin.length, true); view.setUint32(24 + jsonLength, 0x004e4942, true);
  output.set(bin, 28 + jsonLength); return output;
}
function floats(values: readonly number[]): Uint8Array { return new Uint8Array(new Float32Array(values).buffer); }

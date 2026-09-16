import { describe, expect, it } from "vitest";
import { AnimationAccessorReader } from "./animationAccessors.js";
import { resolveAnimationOptions } from "./animationImportValidation.js";
import { MorphAccessorReader } from "./morphAccessors.js";
import { resolveMorphOptions } from "./morphImportValidation.js";
import { SkinAccessorReader } from "./skinAccessors.js";
import { resolveSkinOptions } from "./skinImportValidation.js";

describe("sparse glTF deformation accessors", () => {
  it("expands base-less animation and morph streams through the shared sparse decoder", () => {
    const animation = sparseFloat("SCALAR", 3, 1, [2.5]);
    const animationReader = new AnimationAccessorReader(animation.document, [animation.bytes], resolveAnimationOptions({}));
    expect([...animationReader.readFloat(0, "SCALAR", 3, "animation.input").values]).toEqual([0, 2.5, 0]);

    const morph = sparseFloat("VEC3", 2, 1, [1, 2, 3]);
    const morphReader = new MorphAccessorReader(morph.document, [morph.bytes], resolveMorphOptions({}));
    expect([...morphReader.readDelta(0, 2, "primitive.targets[0].POSITION").values])
      .toEqual([0, 0, 0, 1, 2, 3]);
  });

  it("decodes sparse integer joints and normalized weights into owned skin arrays", () => {
    const bytes = new Uint8Array(12);
    bytes[0] = 0;
    bytes.set([1, 2, 3, 4], 4);
    bytes.set([255, 0, 0, 0], 8);
    const document = {
      buffers: [{ byteLength: bytes.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 4, byteLength: 4 },
        { buffer: 0, byteOffset: 8, byteLength: 4 },
      ],
      accessors: [
        sparseAccessor("VEC4", 5121, 1, 0, 1),
        { ...sparseAccessor("VEC4", 5121, 1, 0, 2), normalized: true },
      ],
    };
    const reader = new SkinAccessorReader(document, [bytes], resolveSkinOptions({}));
    expect([...reader.readJoints(0, 1, "JOINTS_0").values]).toEqual([1, 2, 3, 4]);
    expect([...reader.readWeights(1, 1, "WEIGHTS_0").values]).toEqual([1, 0, 0, 0]);
  });

  it("rejects a byte offset when a deformation accessor has no dense base", () => {
    const source = sparseFloat("SCALAR", 1, 0, [1]);
    source.document.accessors[0]!.byteOffset = 4;
    const reader = new AnimationAccessorReader(source.document, [source.bytes], resolveAnimationOptions({}));
    expect(() => reader.readFloat(0, "SCALAR", 1, "animation.input")).toThrow("without a buffer view");
  });
});

function sparseFloat(type: "SCALAR" | "VEC3", count: number, index: number, values: readonly number[]) {
  const bytes = new Uint8Array(4 + values.length * 4), view = new DataView(bytes.buffer);
  bytes[0] = index;
  values.forEach((value, component) => view.setFloat32(4 + component * 4, value, true));
  return {
    bytes,
    document: {
      buffers: [{ byteLength: bytes.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 1 },
        { buffer: 0, byteOffset: 4, byteLength: values.length * 4 },
      ],
      accessors: [sparseAccessor(type, 5126, count, 0, 1)],
    },
  };
}

function sparseAccessor(type: "SCALAR" | "VEC3" | "VEC4", componentType: number,
  count: number, indexView: number, valueView: number) {
  return { componentType, type, count, sparse: { count: 1,
    indices: { bufferView: indexView, componentType: 5121 }, values: { bufferView: valueView } } };
}

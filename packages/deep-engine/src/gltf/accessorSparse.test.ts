import { describe, expect, it } from "vitest";
import { AccessorReader } from "./accessors.js";
import { decodeGltf } from "./decodeGltf.js";
import { TextureDataReader } from "./textureDataReader.js";
import { GltfImportError, MAX_BYTES, type JsonObject } from "./validation.js";

function expectError(action: () => unknown, path: string, text = ""): GltfImportError {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GltfImportError);
  expect(caught).toMatchObject({ code: expect.stringMatching(/invalid|limit/), path: expect.stringContaining(path) });
  if (text) expect((caught as Error).message).toContain(text);
  return caught as GltfImportError;
}

function sparseVertexFixture(withBase = true) {
  const bytes = new Uint8Array(64), view = new DataView(bytes.buffer);
  for (let index = 0; index < 9; index++) view.setFloat32(index * 4, index, true);
  bytes[36] = 0; bytes[37] = 2;
  [10, 11, 12, 20, 21, 22].forEach((value, index) => view.setFloat32(40 + index * 4, value, true));
  const accessor: JsonObject = {
    ...(withBase ? { bufferView: 0 } : {}), componentType: 5126, count: 3, type: "VEC3",
    sparse: { count: 2, indices: { bufferView: 1, componentType: 5121 }, values: { bufferView: 2 } },
  };
  const document: JsonObject = { buffers: [{ byteLength: bytes.length }], bufferViews: [
    { buffer: 0, byteLength: 36, target: 34962 }, { buffer: 0, byteOffset: 36, byteLength: 2 },
    { buffer: 0, byteOffset: 40, byteLength: 24 },
  ], accessors: [accessor] };
  return { bytes, document, accessor };
}

describe("glTF sparse accessor expansion", () => {
  it("overlays strictly ordered sparse FLOAT VEC3 values on an owned dense base", () => {
    const source = sparseVertexFixture(), decoded = new AccessorReader(source.document, [source.bytes])
      .read(0, "vertex", "POSITION").values;
    expect([...decoded]).toEqual([10, 11, 12, 3, 4, 5, 20, 21, 22]);
    source.bytes.fill(0);
    expect([...decoded]).toEqual([10, 11, 12, 3, 4, 5, 20, 21, 22]);
  });

  it("zero-initializes accessors without a base buffer view before sparse substitution", () => {
    const source = sparseVertexFixture(false), decoded = new AccessorReader(source.document, [source.bytes])
      .read(0, "vertex", "POSITION").values;
    expect([...decoded]).toEqual([10, 11, 12, 0, 0, 0, 20, 21, 22]);
  });

  it("publishes a RenderPacket only after a pure-sparse POSITION stream is fully expanded", () => {
    const bytes = new Uint8Array(40), view = new DataView(bytes.buffer);
    bytes.set([0, 1, 2]);
    [0, 0, 0, 1, 0, 0, 0, 1, 0].forEach((value, index) => view.setFloat32(4 + index * 4, value, true));
    const document = {
      asset: { version: "2.0" }, buffers: [{ byteLength: bytes.length }], bufferViews: [
        { buffer: 0, byteLength: 3 }, { buffer: 0, byteOffset: 4, byteLength: 36 },
      ], accessors: [{ componentType: 5126, count: 3, type: "VEC3", min: [0, 0, 0], max: [1, 1, 0],
        sparse: { count: 3, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0 } }] }], nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }],
    };
    const packet = decodeGltf(document, [bytes]);
    expect([...packet.geometries[0]!.vertices]).toEqual([
      0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1,
    ]);
  });

  it("expands sparse indices and still forbids primitive-restart values", () => {
    const bytes = new Uint8Array([1, 2, 0, 0, 1, 0, 2, 0]);
    const accessor = { componentType: 5123, count: 3, type: "SCALAR",
      sparse: { count: 2, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } };
    const document = { buffers: [{ byteLength: 8 }], bufferViews: [
      { buffer: 0, byteLength: 2 }, { buffer: 0, byteOffset: 4, byteLength: 4 },
    ], accessors: [accessor] };
    expect([...new AccessorReader(document, [bytes]).read(0, "indices", "indices").values]).toEqual([0, 1, 2]);
    new DataView(bytes.buffer).setUint16(6, 65_535, true);
    expectError(() => new AccessorReader(document, [bytes]).read(0, "indices", "indices"), "accessors[0]", "Primitive restart");
  });

  it.each([
    ["order", (source: ReturnType<typeof sparseVertexFixture>) => { source.bytes[37] = 0; }, "strictly increasing"],
    ["range", (source: ReturnType<typeof sparseVertexFixture>) => { source.bytes[37] = 3; }, "exceeds accessor"],
    ["target", (source: ReturnType<typeof sparseVertexFixture>) => {
      (source.document.bufferViews as JsonObject[])[1]!.target = 34962;
    }, "cannot declare"],
    ["value bounds", (source: ReturnType<typeof sparseVertexFixture>) => {
      (source.document.bufferViews as JsonObject[])[2]!.byteLength = 23;
    }, "exceeds its buffer view"],
    ["count", (source: ReturnType<typeof sparseVertexFixture>) => {
      (source.accessor.sparse as JsonObject).count = 4;
    }, "Sparse count"],
  ])("rejects invalid sparse %s", (_name, mutate, text) => {
    const source = sparseVertexFixture(); mutate(source);
    expectError(() => new AccessorReader(source.document, [source.bytes]).read(0, "vertex", "POSITION"), "sparse", text);
  });

  it("decodes sparse normalized unsigned texture coordinates without moving UV ownership", () => {
    const bytes = new Uint8Array([0, 2, 0, 255, 128, 64]);
    const document = { buffers: [{ byteLength: bytes.length }], bufferViews: [
      { buffer: 0, byteLength: 2 }, { buffer: 0, byteOffset: 2, byteLength: 4 },
    ], accessors: [{ componentType: 5121, normalized: true, count: 3, type: "VEC2",
      sparse: { count: 2, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } }] };
    const values = new TextureDataReader(document, [bytes]).texCoord(0, "TEXCOORD_0");
    expect([...values]).toEqual([0, 1, 0, 0, Math.fround(128 / 255), Math.fround(64 / 255)]);
  });

  it("checks expanded budgets and cancellation before allocating sparse output", () => {
    const source = sparseVertexFixture(false);
    source.accessor.count = Math.floor(MAX_BYTES / 12) + 1;
    expectError(() => new AccessorReader(source.document, [source.bytes]).read(0, "vertex", "POSITION"), "accessors");
    const controller = new AbortController(); controller.abort(new DOMException("cancelled", "AbortError"));
    expect(() => new AccessorReader(source.document, [source.bytes], controller.signal)).toThrowError(/cancelled/);
    expect(() => new TextureDataReader(source.document, [source.bytes], controller.signal)).toThrowError(/cancelled/);
  });

  it("rejects meaningless byte offsets when a sparse accessor has no base view", () => {
    const source = sparseVertexFixture(false); source.accessor.byteOffset = 4;
    expectError(() => new AccessorReader(source.document, [source.bytes]).read(0, "vertex", "POSITION"), "byteOffset");
  });
});

import { describe, expect, it } from "vitest";
import { AccessorReader } from "./accessors.js";
import { GltfImportError, type JsonObject } from "./validation.js";

function fixture() {
  const backing = new Uint8Array(81), bytes = backing.subarray(3);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < 18; index++) view.setFloat32(index * 4, index + 0.5, true);
  for (let index = 0; index < 3; index++) view.setUint16(72 + index * 2, index, true);
  const document: JsonObject = { buffers: [{ byteLength: 78 }], bufferViews: [
    { buffer: 0, byteLength: 72, byteStride: 24 }, { buffer: 0, byteOffset: 72, byteLength: 6 }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 0, byteOffset: 12, componentType: 5126, count: 3, type: "VEC3" },
      { bufferView: 1, componentType: 5123, count: 3, type: "SCALAR" }] };
  return { document, bytes, view };
}
function error(action: () => unknown, code: string, text: string) {
  let caught: unknown;
  try { action(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(GltfImportError);
  expect(caught).toMatchObject({ code });
  expect((caught as Error).message).toContain(text);
}

describe("glTF accessor byte decoding", () => {
  it("honors caller byteOffset, accessor offset and interleaved stride", () => {
    const { document, bytes } = fixture(), reader = new AccessorReader(document, [bytes]);
    expect([...reader.read(0, "vertex", "position").values]).toEqual([0.5, 1.5, 2.5, 6.5, 7.5, 8.5, 12.5, 13.5, 14.5]);
    expect([...reader.read(1, "vertex", "normal").values]).toEqual([3.5, 4.5, 5.5, 9.5, 10.5, 11.5, 15.5, 16.5, 17.5]);
    expect([...reader.read(2, "indices", "indices").values]).toEqual([0, 1, 2]);
    expect(reader.read(0, "vertex", "same")).toBe(reader.read(0, "vertex", "position"));
  });
  it.each([[5121, 1], [5123, 2], [5125, 4]])("decodes unsigned component %s exactly", (component, width) => {
    const bytes = new Uint8Array(width! * 3), view = new DataView(bytes.buffer);
    const expected = component === 5125 ? [0, 65_535, 4_000_000_000] : [0, 2, 8];
    expected.forEach((value, index) => width === 1 ? view.setUint8(index, value)
      : width === 2 ? view.setUint16(index * width, value, true) : view.setUint32(index * width!, value, true));
    const reader = new AccessorReader({ buffers: [{ byteLength: bytes.length }], bufferViews: [{ buffer: 0, byteLength: bytes.length }],
      accessors: [{ bufferView: 0, componentType: component, count: 3, type: "SCALAR" }] }, [bytes]);
    expect([...reader.read(0, "indices", "indices").values]).toEqual(expected);
  });
  it.each([5121, 5123, 5125])("rejects primitive restart for component %s", component => {
    const width = component === 5121 ? 1 : component === 5123 ? 2 : 4, bytes = new Uint8Array(width).fill(255);
    const reader = new AccessorReader({ buffers: [{ byteLength: width }], bufferViews: [{ buffer: 0, byteLength: width }],
      accessors: [{ bufferView: 0, componentType: component, count: 1, type: "SCALAR" }] }, [bytes]);
    error(() => reader.read(0, "indices", "indices"), "invalid", "Primitive restart");
  });
  it.each([
    [0, { byteOffset: 1 }, "alignment"], [0, { count: 4 }, "exceeds"], [0, { count: 0 }, "integer"],
    [0, { bufferView: 2 }, "range"], [2, { byteOffset: 1 }, "alignment"],
    [0, { byteOffset: null }, "integer"],
  ])("rejects accessor bounds/alignment %#", (index, change, text) => {
    const { document, bytes } = fixture(); Object.assign((document.accessors as JsonObject[])[index as number]!, change);
    const reader = new AccessorReader(document, [bytes]);
    error(() => reader.read(index, index === 2 ? "indices" : "vertex", "attribute"), "invalid", text as string);
  });
  it.each([
    { byteStride: 8 }, { byteStride: 13 }, { byteStride: 256 }, { byteOffset: 80 }, { byteLength: 79 }, { target: 34963 },
  ])("rejects incompatible vertex views %j", change => {
    const { document, bytes } = fixture(); Object.assign((document.bufferViews as JsonObject[])[0]!, change);
    error(() => new AccessorReader(document, [bytes]).read(0, "vertex", "position"), "invalid", "");
  });
  it("rejects mixed vertex/index data and strided indices", () => {
    const a = fixture(); (a.document.accessors as JsonObject[])[2]!.bufferView = 0; delete (a.document.bufferViews as JsonObject[])[0]!.byteStride;
    const reader = new AccessorReader(a.document, [a.bytes]); reader.read(0, "vertex", "position");
    error(() => reader.read(2, "indices", "indices"), "invalid", "cannot mix");
    const b = fixture(); (b.document.bufferViews as JsonObject[])[1]!.byteStride = 4;
    error(() => new AccessorReader(b.document, [b.bytes]).read(2, "indices", "indices"), "invalid", "cannot have byteStride");
  });
  it.each([
    { componentType: 5123 }, { type: "VEC4" }, { extensions: { EXT_meshopt_compression: {} } },
  ])("rejects unsupported accessor representations %j", change => {
    const { document, bytes } = fixture(); Object.assign((document.accessors as JsonObject[])[0]!, change);
    error(() => new AccessorReader(document, [bytes]).read(0, "vertex", "position"), "unsupported", "");
  });
  it.each([{ sparse: {} }, { normalized: true }])("rejects invalid accessor representation %j", change => {
    const { document, bytes } = fixture(); Object.assign((document.accessors as JsonObject[])[0]!, change);
    error(() => new AccessorReader(document, [bytes]).read(0, "vertex", "position"), "invalid", "");
  });
  it("does not read bytes outside declared buffers or views even when backing storage exists", () => {
    const a = fixture(); (a.document.buffers as JsonObject[])[0]!.byteLength = 72;
    error(() => new AccessorReader(a.document, [a.bytes]), "invalid", "declared buffer");
    const b = fixture(); (b.document.bufferViews as JsonObject[])[0]!.byteLength = 71;
    error(() => new AccessorReader(b.document, [b.bytes]).read(1, "vertex", "normal"), "invalid", "buffer view");
    const c = fixture();
    error(() => new AccessorReader(c.document, [c.bytes.subarray(0, 77)]), "invalid", "truncated");
  });
});

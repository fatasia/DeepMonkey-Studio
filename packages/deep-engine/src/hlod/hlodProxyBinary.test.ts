import { describe, expect, it } from "vitest";
import { buildHlodTree, generateHlodClusterProxies } from "./index.js";
import { decodeHlodProxyGeometries, encodeHlodProxyGeometries } from "./hlodProxyBinary.js";
import type { GeometryResource } from "../renderPacketTypes.js";

const geometry = (id: string): GeometryResource => ({ id, revision: 0,
  vertices: new Float32Array([0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 1]),
  indices: new Uint32Array([0, 1, 2]) });

describe("T26 proxy binary package", () => {
  it("roundtrips deterministic typed mesh bytes independent of input order", () => {
    const first = encodeHlodProxyGeometries([geometry("g-b"), geometry("g-a")]);
    expect(first).toEqual(encodeHlodProxyGeometries([geometry("g-a"), geometry("g-b")]));
    expect(decodeHlodProxyGeometries(first)).toEqual([geometry("g-a"), geometry("g-b")]);
    expect(first.byteLength).toBe(12 + 2 * (10 + 3 + 18 * 4 + 3 * 4));
  });
  it("rejects truncated, trailing, duplicate and invalid geometry", () => {
    const bytes = encodeHlodProxyGeometries([geometry("g-a")]);
    expect(() => decodeHlodProxyGeometries(bytes.subarray(0, bytes.length - 1))).toThrow(/Truncated/);
    expect(() => decodeHlodProxyGeometries(new Uint8Array([...bytes, 0]))).toThrow(/Trailing/);
    expect(() => encodeHlodProxyGeometries([geometry("g-a"), geometry("g-a")])).toThrow(/Invalid/);
    const invalid = bytes.slice(); new DataView(invalid.buffer).setUint32(invalid.length - 4, 999, true);
    expect(() => decodeHlodProxyGeometries(invalid)).toThrow(/index/);
  });
  it("measures 1k synthetic cluster binary footprint and decode CPU cost", () => {
    const instances = Array.from({ length: 1_000 }, (_, index) => ({ id: `i-${index}`,
      position: [index % 50, 0, Math.floor(index / 50)] as const, radius: 0.5 }));
    const tree = buildHlodTree(instances);
    const shapes = instances.map(instance => ({ instanceId: instance.id,
      min: [instance.position[0] - 0.5, -0.5, instance.position[2] - 0.5] as const,
      max: [instance.position[0] + 0.5, 0.5, instance.position[2] + 0.5] as const }));
    const proxies = generateHlodClusterProxies(tree, shapes, [...tree.nodes.values()]
      .filter(node => node.children.length > 0).map(node => node.id));
    const meshes = proxies.entries.map(entry => ({ id: entry.geometryId, revision: 0,
      vertices: entry.proxy.mesh.vertices, indices: entry.proxy.mesh.indices }));
    const encoded = encodeHlodProxyGeometries(meshes);
    const start = performance.now(), decoded = decodeHlodProxyGeometries(encoded);
    const decodeMs = performance.now() - start;
    expect(decoded).toHaveLength(meshes.length);
    expect(encoded.byteLength).toBeLessThan(8 * 1024 * 1024);
    expect(decodeMs).toBeLessThan(2_000);
  });
});

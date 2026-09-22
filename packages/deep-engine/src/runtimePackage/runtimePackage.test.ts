import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { RenderPacket } from "../renderPacket.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, runtimeContentSha256, runtimePackageSha256,
  serializeDeepRuntimePackage, validateDeepRuntimePackage, type BuildDeepRuntimePackageInput } from "./index.js";

const nativeRoot = new URL("../../../deep-engine-native/", import.meta.url);
const read = (path: string) => JSON.parse(readFileSync(new URL(path, nativeRoot), "utf8"));
const fixture = () => read("tests/fixtures/runtime-package-v1.json");
function input(): BuildDeepRuntimePackageInput {
  const packet = read("fixtures/render_packet_v1.json");
  delete packet.schema; delete packet.version;
  for (const geometry of packet.geometries) {
    geometry.vertices = new Float32Array(geometry.vertices); geometry.indices = new Uint32Array(geometry.indices);
  }
  for (const instance of packet.instances) instance.transform = new Float32Array(instance.transform);
  packet.materials[0].emissiveFactor = [0.125, 0.0625, 0.03125]; packet.materials[0].emissiveStrength = 2.5;
  const deep2d = read("fixtures/deep2d_runtime_atlas_v1.json");
  deep2d.schemaVersion = 2; deep2d.composition = "z-ordered";
  return { packageId: "deep.runtime.golden", packageVersion: "0.1.0-beta.1", renderPacket: { id: "scene.main", revision: 3, value: packet }, deep2d };
}
function resigned(mutate: (value: ReturnType<typeof fixture>) => void) {
  const value = fixture(); mutate(value);
  for (const resource of value.resources) if (Object.hasOwn(value.payloads, resource.id)) {
    resource.contentHash.value = runtimeContentSha256(value.payloads[resource.id]);
  }
  value.packageHash.value = runtimePackageSha256(value);
  return validateDeepRuntimePackage(value);
}

describe("runtime package browser-to-native contract", () => {
  it("rebuilds the cross-language golden from real typed geometry and author emissive gain", () => {
    const source = input(), result = buildDeepRuntimePackage(source), golden = fixture();
    expect(result).toEqual(golden);
    expect(result.packageHash.value).toBe("621d7355747b15ded4f0c128d10090ea4d0730a6b50f4df644a10991fb3cdb6a");
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(result))).toEqual({ valid: true, value: golden, issues: [] });
    expect(parseDeepRuntimePackage(new TextEncoder().encode(serializeDeepRuntimePackage(result))).valid).toBe(true);
    const payload = golden.payloads[golden.entrypoints.renderPacket];
    expect(payload.geometries[0].vertices[0]).toBe(Math.fround(-0.8));
    expect(payload.materials[0].emissiveFactor).toEqual([0.3125, 0.15625, 0.078125]);
    expect(payload.materials[0]).not.toHaveProperty("emissiveStrength");
    expect(source.renderPacket.value.materials[0]?.emissiveStrength).toBe(2.5);
    (source.renderPacket.value.geometries[0]!.vertices)[0] = 999;
    expect(result).toEqual(golden);
  });
  it("supports no overlay and shader packages validated by the existing shader contract", () => {
    const source = input(), { deep2d: _overlay, ...without } = source;
    const shader = read("tests/fixtures/deep_shader_package_v2.json");
    const result = buildDeepRuntimePackage({ ...without, shaderPackages: [{ revision: 1, value: shader }] });
    expect(result.entrypoints.deep2d).toBeNull();
    expect(result.entrypoints.shaderPackages).toEqual([shader.packageId]);
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(result)).valid).toBe(true);
  });
  it("retains backward-compatible version 1 Deep2d composition", () => {
    const source = input();
    const result = buildDeepRuntimePackage({ ...source, deep2d: read("fixtures/deep2d_runtime_atlas_v1.json") });
    expect(validateDeepRuntimePackage(result).valid).toBe(true);
  });
  it("packages a dynamic scene as a first-class v7 resource and entrypoint", () => {
    const source = input();
    const dynamicRuntime = { id: "scene.dynamic", revision: 2, value: {
      schema: "deep-engine.dynamic-runtime", schemaVersion: 1, id: "scene.dynamic", revision: 2,
      animation: { schema: "deep-engine.dynamic-animation", schemaVersion: 1, durationMs: 1000,
        tracks: [{ targetId: "node-a", property: "translation", keyframes: [
          { timeMs: 0, value: [0, 0, 0, 0, 0, 0, 1] },
          { timeMs: 1000, value: [1, 0, 0, 0, 0, 0, 1] },
        ] }] },
    } } as const;
    const result = buildDeepRuntimePackage({ ...source, deep2d: undefined, dynamicRuntime });
    expect(result.schemaVersion).toBe(7);
    expect(result.entrypoints.dynamicRuntime).toBe(dynamicRuntime.id);
    expect(result.resources.find(resource => resource.kind === "dynamic-runtime")?.id).toBe(dynamicRuntime.id);
    expect(parseDeepRuntimePackage(serializeDeepRuntimePackage(result)).valid).toBe(true);
  });
  it("serializes equivalent insertion orders to identical bytes", () => {
    const value = fixture(), reverse = (input: unknown): unknown => {
      if (Array.isArray(input)) return input.map(reverse);
      if (input === null || typeof input !== "object") return input;
      return Object.fromEntries(Object.entries(input).reverse().map(([key, value]) => [key, reverse(value)]));
    };
    expect(serializeDeepRuntimePackage(reverse(value))).toBe(serializeDeepRuntimePackage(value));
    expect(serializeDeepRuntimePackage(value)).toBe(serializeDeepRuntimePackage(JSON.parse(serializeDeepRuntimePackage(value))));
  });
  it("rejects content tampering even when an attacker recomputes the outer manifest hash", () => {
    const value = fixture();
    value.payloads["scene.main"].geometries[0].vertices[0] += 0.125;
    expect(validateDeepRuntimePackage(value).valid).toBe(false);
    value.packageHash.value = runtimePackageSha256(value);
    expect(validateDeepRuntimePackage(value)).toMatchObject({ valid: false, issues: [{ message: expect.stringContaining("content hash mismatch") }] });
    expect(() => serializeDeepRuntimePackage(value)).toThrow(/content hash mismatch/);
  });
  it.each([
    ["root field", (v: ReturnType<typeof fixture>) => { v.future = true; }],
    ["schema", v => { v.schema = "other"; }],
    ["version", v => { v.schemaVersion = 2; }],
    ["package id", v => { v.packageId = "../bad"; }],
    ["package version", v => { v.packageVersion = "beta"; }],
    ["hash algorithm", v => { v.packageHash.algorithm = "sha1"; }],
    ["resource kind", v => { v.resources[0].kind = "script"; }],
    ["resource revision", v => { v.resources[0].revision = 0; }],
    ["resource order", v => { v.resources.reverse(); }],
    ["resource fields", v => { v.resources[0].size = 1; }],
    ["duplicate index", v => { v.resources.push(v.resources[0]); }],
    ["missing resource", v => { delete v.payloads["scene.main"]; }],
    ["extra payload", v => { v.payloads.extra = {}; }],
    ["entrypoint unknown", v => { v.entrypoints.extra = "scene.main"; }],
    ["entrypoint missing", v => { delete v.entrypoints.deep2d; }],
    ["entrypoint kind", v => { v.entrypoints.environment = "scene.main"; }],
    ["unreferenced overlay", v => { v.entrypoints.deep2d = null; }],
    ["render root field", v => { v.payloads["scene.main"].camera = {}; }],
    ["render schema", v => { v.payloads["scene.main"].schema = "other"; }],
    ["render version type", v => { v.payloads["scene.main"].version = "1"; }],
    ["geometry field", v => { v.payloads["scene.main"].geometries[0].future = true; }],
    ["geometry overflow", v => { v.payloads["scene.main"].geometries[0].vertices[0] = 1e100; }],
    ["index fraction", v => { v.payloads["scene.main"].geometries[0].indices[0] = 0.5; }],
    ["index reference", v => { v.payloads["scene.main"].geometries[0].indices[0] = 999; }],
    ["material null", v => { v.payloads["scene.main"].materials[0].alphaMode = null; }],
    ["material field", v => { v.payloads["scene.main"].materials[0].unlit = true; }],
    ["material strength", v => { v.payloads["scene.main"].materials[0].emissiveStrength = 257; }],
    ["instance field", v => { v.payloads["scene.main"].instances[0].visible = true; }],
    ["instance transform", v => { v.payloads["scene.main"].instances[0].transform[15] = 0; }],
    ["empty LOD", v => { v.payloads["scene.main"].instances[0].lod = { levels: [] }; }],
    ["missing instance geometry", v => { v.payloads["scene.main"].instances[0].geometry = "missing"; }],
    ["IBL identity", v => { v.payloads[v.entrypoints.environment].revision = 2; }],
    ["IBL unknown field", v => { v.payloads[v.entrypoints.environment].url = "unused"; }],
    ["Deep2d identity", v => { v.payloads[v.entrypoints.deep2d].id = "mismatch"; }],
    ["Deep2d composition", v => { v.payloads[v.entrypoints.deep2d].composition = "path-then-atlas"; }],
    ["atlas bytes", v => { v.payloads[v.entrypoints.deep2d].atlases[0].dataBase64 = "AA=="; }],
    ["atlas padding bits", v => { v.payloads[v.entrypoints.deep2d].atlases[0].dataBase64 = "AB=="; }],
    ["atlas kind", v => { v.payloads[v.entrypoints.deep2d].atlases[0].kind = "image"; }],
    ["quad bounds", v => { v.payloads[v.entrypoints.deep2d].quads[0].source[2] = 999; }],
    ["quad field", v => { v.payloads[v.entrypoints.deep2d].quads[0].extra = 1; }],
    ["quad dangling atlas", v => { v.payloads[v.entrypoints.deep2d].quads[0].atlasId = "missing"; }],
    ["quad opacity", v => { v.payloads[v.entrypoints.deep2d].quads[0].opacity = null; }],
    ["unused atlas", v => { v.payloads[v.entrypoints.deep2d].quads = []; }],
  ])("rejects resigned invalid %s", (_name, mutate) => { expect(resigned(mutate).valid).toBe(false); });
  it("accepts dense serialized typed arrays and rejects sparse encodings", () => {
    expect(resigned(v => {
      const geometry = v.payloads["scene.main"].geometries[0];
      geometry.vertices = { ...geometry.vertices }; geometry.indices = { ...geometry.indices };
    }).valid).toBe(true);
    expect(resigned(v => { v.payloads["scene.main"].geometries[0].indices = { 0: 0, 2: 2 }; }).valid).toBe(false);
  });
  it("exports RGBA8 typed textures, checks nested fields and rejects unsupported compression", () => {
    const source = input();
    const packet: RenderPacket = { ...source.renderPacket.value, textures: [{ id: "pixel", revision: 1, semantic: "baseColor", width: 1, height: 1,
      data: new Uint8Array([7, 111, 201, 255]), sampler: { magFilter: "nearest" } }] };
    const result = buildDeepRuntimePackage({ ...source, renderPacket: { ...source.renderPacket, value: packet } });
    expect(validateDeepRuntimePackage(result).valid).toBe(true);
    const bad = JSON.parse(serializeDeepRuntimePackage(result));
    bad.payloads["scene.main"].textures[0].data[0] = 256;
    bad.resources.find((entry: { id: string }) => entry.id === "scene.main").contentHash.value = runtimeContentSha256(bad.payloads["scene.main"]);
    bad.packageHash.value = runtimePackageSha256(bad);
    expect(validateDeepRuntimePackage(bad).valid).toBe(false);
    const compressed = { ...packet, textures: [{ ...packet.textures![0], compression: "bc7-rgba" }] } as RenderPacket;
    expect(() => buildDeepRuntimePackage({ ...source, renderPacket: { ...source.renderPacket, value: compressed } })).toThrow(/Unknown field/);
  });
  it("rejects malformed UTF8, JSON, accessors, cycles, sparse arrays and non-JSON values", () => {
    expect(parseDeepRuntimePackage(new Uint8Array([0xc3, 0x28])).valid).toBe(false);
    expect(parseDeepRuntimePackage("{").valid).toBe(false);
    const serialized = serializeDeepRuntimePackage(fixture());
    expect(parseDeepRuntimePackage(serialized.replace('"schemaVersion":1', '"schemaVersion":1,"schemaVersion":1')).valid).toBe(false);
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const disguisedSparse = Object.assign(new Array(2), { 0: 1, extra: 2 });
    const accessor = Object.defineProperty({}, "value", { enumerable: true, get: () => { throw new Error("must not execute"); } });
    for (const value of [undefined, NaN, Infinity, 1n, () => 1, new Date(), cyclic, accessor, new Array(2), disguisedSparse, [undefined], "\ud800"]) {
      expect(validateDeepRuntimePackage(value).valid).toBe(false);
      expect(() => runtimeContentSha256(value)).toThrow();
    }
    let nested: unknown = 1;
    for (let i = 0; i < 33; i += 1) nested = [nested];
    expect(() => runtimeContentSha256(nested)).toThrow(/depth budget/);
  });
});

describe("runtime binary64 canonical hash", () => {
  it("matches the shared native vectors for decimals, subnormals, huge numbers and Unicode keys", () => {
    const vectors = read("tests/fixtures/runtime-canonical-v1.json") as { input: unknown; sha256: string }[];
    for (const vector of vectors) expect(runtimeContentSha256(vector.input)).toBe(vector.sha256);
    expect(runtimeContentSha256(-0)).toBe(runtimeContentSha256(0));
    expect(runtimeContentSha256(1)).not.toBe(runtimeContentSha256("n3ff0000000000000"));
    expect(runtimeContentSha256({ a: 0.1, b: 1e21 })).toBe(runtimeContentSha256({ b: 1e21, a: 0.1 }));
    expect(runtimeContentSha256([1, 2])).not.toBe(runtimeContentSha256([2, 1]));
  });
});

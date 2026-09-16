import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRuntimeIblFixture, createRuntimePackageIblInput } from "../../scripts/runtimePackageIblFixture.mjs";
import { validateRuntimePrefilteredIbl } from "./environment.js";
import { visitIblBytes } from "./environmentBytes.js";
import { buildDeepRuntimePackage, parseDeepRuntimePackage, serializeDeepRuntimePackage,
  type BuildDeepRuntimePackageInput, type RuntimePrefilteredIbl } from "./index.js";

const fixture = (): RuntimePrefilteredIbl => createRuntimeIblFixture() as RuntimePrefilteredIbl;
describe("prefiltered runtime IBL", () => {
  it("builds, parses and snapshots the environment without altering default golden bytes", () => {
    const source = createRuntimePackageIblInput() as BuildDeepRuntimePackageInput;
    const runtime = buildDeepRuntimePackage(source);
    expect(runtime.entrypoints.environment).toBe(source.environment!.id);
    const bytes = serializeDeepRuntimePackage(runtime);
    expect(parseDeepRuntimePackage(bytes).valid).toBe(true);
    expect(`${bytes}\n`).toBe(readFileSync(new URL("../../../deep-engine-native/tests/fixtures/runtime-package-prefiltered-ibl-v1.json", import.meta.url), "utf8"));
  });
  it.each([
    ["version", (v: any) => { v.schemaVersion = 2; }],
    ["format", (v: any) => { v.format = "rgba32float"; }],
    ["unknown", (v: any) => { v.url = "unused"; }],
    ["identity", (v: any) => { v.id = "deep.builtin.studio-ibl.v1"; }],
    ["revision", (v: any) => { v.revision = 0x1_0000_0000; }],
    ["size", (v: any) => { v.specular.mips[0].size = 3; }],
    ["incomplete", (v: any) => { v.specular.mips.pop(); }],
    ["extra mip", (v: any) => { v.specular.mips.push(v.specular.mips[1]); }],
    ["diffuse mips", (v: any) => { v.diffuse.mips.push(v.diffuse.mips[0]); }],
    ["non-square LUT", (v: any) => { v.brdfLut.width = 2; }],
    ["source hash", (v: any) => { v.source.contentHash.value = "A".repeat(64); }],
    ["source license", (v: any) => { v.source.license = " "; }],
    ["sparse", (v: any) => { delete v.specular.mips[0]; }],
  ])("rejects %s", (_name, mutate) => {
    const value = structuredClone(fixture()); mutate(value);
    expect(() => validateRuntimePrefilteredIbl(value, value.id, value.revision)).toThrow();
  });
  it.each([0x7c00, 0xfc00, 0x7e00, 0x8001, 0xbc00])("rejects nonfinite or negative half %i", bits => {
    const value = fixture(), bytes = Buffer.from(value.brdfLut.dataBase64, "base64"); bytes.writeUInt16LE(bits, 0);
    expect(() => validateRuntimePrefilteredIbl({ ...value, brdfLut: { ...value.brdfLut, dataBase64: bytes.toString("base64") } }, value.id, 1)).toThrow("finite");
  });
  it("validates canonical padding and exact decoded bytes, with negative zero accepted", () => {
    const values = Buffer.from([0, 128, 0, 0, 0, 0, 0, 60]), encoded = values.toString("base64"), result: number[] = [];
    visitIblBytes(encoded, 8, "$", byte => result.push(byte)); expect(result).toEqual([...values]);
    for (const bad of [encoded.slice(0, -1), encoded + "AAAA", encoded.replace(/.$/, "A"), "!" + encoded.slice(1)])
      expect(() => visitIblBytes(bad, 8, "$")).toThrow();
  });
  it("checks aggregate budget before texel decoding", () => {
    const value = fixture();
    const mips = Array.from({ length: 12 }, (_, level) => ({ size: 2048 >> level, dataBase64: "" }));
    expect(() => validateRuntimePrefilteredIbl({ ...value, specular: { mips } }, value.id, 1)).toThrow("budget");
  });
});

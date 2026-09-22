import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRuntimeIblFixture, createRuntimePackageIblInput } from "../../scripts/runtimePackageIblFixture.mjs";
import { validateRuntimeEnvironment, validateRuntimePrefilteredIbl } from "./environment.js";
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

/**
 * F3 探针网格运行包载荷(环境字段 irradianceProbes)v1 双形态校验:
 * 单层为既有形状逐位兼容;级联按 levels 键分派,层间合同与 Native
 * decode_probe_grid_cascade / Web packNativeProbeGridLevels 一致。
 */
describe("runtime environment probe grid payload", () => {
  const solid = (): Record<string, unknown> => ({
    schema: "deep-engine.solid-environment", schemaVersion: 1, id: "scene.environment", revision: 1,
    kind: "solid-background-no-ibl", backgroundSrgb: [0.1, 0.2, 0.3], outputTransform: "native-aces-v1",
  });
  const probe = (index = 0) => ({
    irradiance: [index, index * 2, index * 3], validity: 1, meanDistance: index * 0.5, distanceVariance: index,
  });
  /** 2×2×2 层:8 支探针;origin 可调以构造包含性非法。 */
  const level = (origin: readonly number[] = [0, 0, 0], spacing = 2) => ({
    origin, spacing, gridSize: [2, 2, 2], probes: Array.from({ length: 8 }, (_, index) => probe(index)),
  });
  const grid = (payload: Record<string, unknown>) => ({ schema: "deep-engine.probe-grid", schemaVersion: 1, ...payload });
  const validate = (environment: Record<string, unknown>) =>
    validateRuntimeEnvironment(environment, "scene.environment", 1, "$.environment");

  it("keeps accepting the legacy single-level payload shape", () => {
    expect(() => validate({ ...solid(), irradianceProbes: grid(level()) })).not.toThrow();
  });

  it("accepts a fine-to-coarse cascade whose coarse level contains the fine extent", () => {
    const payload = grid({ levels: [level([0, 0, 0], 2), level([0, 0, 0], 4)] });
    expect(() => validate({ ...solid(), irradianceProbes: payload })).not.toThrow();
  });

  it("rejects a coarse level whose spacing does not strictly increase", () => {
    const payload = grid({ levels: [level([0, 0, 0], 2), level([0, 0, 0], 2)] });
    expect(() => validate({ ...solid(), irradianceProbes: payload }))
      .toThrow("strictly increase spacing and contain the fine level extent");
  });

  it("rejects a coarse level whose extent does not contain the fine level", () => {
    const payload = grid({ levels: [level([0, 0, 0], 2), level([10, 0, 0], 4)] });
    expect(() => validate({ ...solid(), irradianceProbes: payload }))
      .toThrow("strictly increase spacing and contain the fine level extent");
  });

  it("rejects cascade payloads that also declare single-level fields", () => {
    const payload = grid({ levels: [level()], origin: [0, 0, 0] });
    expect(() => validate({ ...solid(), irradianceProbes: payload })).toThrow("Unknown field");
    const withProbes = grid({ levels: [level()], probes: [] });
    expect(() => validate({ ...solid(), irradianceProbes: withProbes })).toThrow("Unknown field");
  });

  it("rejects cascade level counts outside [1, 4]", () => {
    expect(() => validate({ ...solid(), irradianceProbes: grid({ levels: [] }) })).toThrow();
    expect(() => validate({
      ...solid(),
      irradianceProbes: grid({ levels: [level([0, 0, 0], 1), level([0, 0, 0], 2), level([0, 0, 0], 4), level([0, 0, 0], 8), level([0, 0, 0], 16)] }),
    })).toThrow();
  });

  it("applies the legacy single-level probe rules inside every cascade level", () => {
    const broken = level();
    (broken.probes as Array<Record<string, unknown>>)[2]!.validity = 2;
    const payload = grid({ levels: [level([0, 0, 0], 2), broken] });
    expect(() => validate({ ...solid(), irradianceProbes: payload })).toThrow("Invalid probe validity");
  });

  it("enforces the native storage record budget across the whole cascade", () => {
    // 每层 64×64×8 = 32768 探针:两层合计 1 + 2×(1+32768) > 65535 预算。
    const wide = (spacing: number) => ({
      origin: [0, 0, 0], spacing, gridSize: [64, 64, 8],
      probes: Array.from({ length: 64 * 64 * 8 }, () => probe()),
    });
    const payload = grid({ levels: [wide(1), wide(2)] });
    expect(() => validate({ ...solid(), irradianceProbes: payload })).toThrow("budget");
  });
});

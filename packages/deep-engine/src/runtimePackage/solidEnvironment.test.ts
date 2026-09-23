import { expect, it } from "vitest";
import { validateRuntimeEnvironment } from "./environment.js";
const source = () => ({ schema: "deep-engine.solid-environment", schemaVersion: 1, id: "scene.environment", revision: 1,
  kind: "solid-background-no-ibl", outputTransform: "native-aces-v1", backgroundSrgb: [0, 0.5, 1] });
it("accepts only the bounded solid profile", () => {
  expect(() => validateRuntimeEnvironment(source(), "scene.environment", 1, "$")).not.toThrow();
  for (const patch of [{ schemaVersion: 2 }, { revision: 2 }, { id: "other" }, { outputTransform: "aces" },
    { backgroundSrgb: [0, 1] }, { backgroundSrgb: [0, 0, 1.01] }, { backgroundSrgb: [0, NaN, 0] },
    { backgroundSrgb: [0, Infinity, 0] }, { extra: true }]) {
    expect(() => validateRuntimeEnvironment({ ...source(), ...patch }, "scene.environment", 1, "$")).toThrow();
  }
});
it("v2 requires bounded directional data and does not reinterpret v1", () => {
  const lighting = { direction: [0, 0.6, 0.8], radiance: [2, 1, 0], exposure: 1.05, shadows: true };
  const value = { ...source(), schemaVersion: 2, outputTransform: "native-aces-light-v2", lighting };
  expect(() => validateRuntimeEnvironment(value, value.id, 1, "$")).not.toThrow();
  for (const patch of [{ direction: [0,0,0] }, { radiance: [257,0,0] }, { exposure: NaN },
    { exposure: 1.56 }, { shadows: 1 }, { extra: true }]) {
    expect(() => validateRuntimeEnvironment({ ...value, lighting: { ...lighting, ...patch } }, value.id, 1, "$")).toThrow();
  }
  expect(() => validateRuntimeEnvironment({ ...source(), lighting }, value.id, 1, "$")).toThrow();
});
it("v3 validates every local light and leaves the v2 contract unchanged", () => {
  const local = { kind:"spot", position:[2,4,0], direction:[0,-1,0], radiance:[2,1,0], range:12, decay:2, innerCos:.9, outerCos:.7 };
  const value = { ...source(), schemaVersion:3, outputTransform:"native-aces-lights-v3",
    lighting:{ direction:[0,1,0], radiance:[1,1,1], exposure:1.05, shadows:true, localLights:[local] } };
  const check=(v:unknown)=>validateRuntimeEnvironment(v,value.id,1,"$");
  expect(()=>check(value)).not.toThrow();
  for (const patch of [{ kind:"area" }, { position:[0,Infinity,0] }, { direction:[0,0,0] }, { range:-1 }, { decay:5 },
    { innerCos:.5 }, { radiance:[257,0,0] }, { castShadow:false }]) {
    expect(()=>check({ ...value, lighting:{ ...value.lighting, localLights:[{ ...local,...patch }] } })).toThrow();
  }
  for (const localLights of [[],Array(17).fill(local),null]) expect(()=>check({ ...value, lighting:{ ...value.lighting,localLights } })).toThrow();
  expect(()=>check({ ...value, schemaVersion:2,outputTransform:"native-aces-light-v2" })).toThrow();
});
it("validates hemisphere ground RGB without admitting unsupported ground fields on direct lights", () => {
  const local = { kind:"hemisphere", position:[0,0,0], direction:[0,1,0], radiance:[2,1,0], groundRadiance:[0,.5,3], range:0, decay:2, innerCos:1, outerCos:0 };
  const value = { ...source(), schemaVersion:3, outputTransform:"native-aces-lights-v3",
    lighting:{ direction:[0,1,0], radiance:[0,0,0], exposure:1.05, shadows:false, localLights:[local] } };
  const check = (light: unknown) => validateRuntimeEnvironment({ ...value, lighting:{ ...value.lighting,localLights:[light] } },value.id,1,"$");
  expect(() => check(local)).not.toThrow();
  for (const patch of [{ groundRadiance:undefined }, { groundRadiance:[NaN,0,0] }, { kind:"point" }, { ies:{profileId:"p"} }]) {
    expect(() => check({...local,...patch})).toThrow();
  }
});
it("v4 preserves the shadow request and rejects unsupported or excessive casters", () => {
  const local = { kind:"spot",position:[0,4,3],direction:[0,-.8,-.6],radiance:[4,4,4],range:12,decay:2,innerCos:.8,outerCos:.5,castShadow:true };
  const value = { ...source(),schemaVersion:4,outputTransform:"native-aces-spot-shadows-v4",
    lighting:{direction:[0,1,0],radiance:[0,0,0],exposure:1.05,shadows:false,localLights:[local]} };
  const check=(v:unknown)=>validateRuntimeEnvironment(v,value.id,1,"$");
  expect(()=>check(value)).not.toThrow();
  for (const patch of [{kind:"point"},{outerCos:0},{outerCos:1,innerCos:1},{range:.00001},{castShadow:1}]) {
    expect(()=>check({...value,lighting:{...value.lighting,localLights:[{...local,...patch}]}})).toThrow();
  }
  expect(()=>check({...value,lighting:{...value.lighting,localLights:Array(5).fill(local)}})).toThrow();
  expect(()=>check({...value,schemaVersion:3,outputTransform:"native-aces-lights-v3"})).toThrow();
});
it("v5 allows one point plus four spots and never reinterprets v4",()=>{
  const point={kind:"point",position:[0,4,3],direction:[0,-1,0],radiance:[4,4,4],range:12,decay:2,innerCos:1,outerCos:0,castShadow:true};
  const spot={...point,kind:"spot",innerCos:.8,outerCos:.5};
  const value={...source(),schemaVersion:5,outputTransform:"native-aces-local-shadows-v5",lighting:{direction:[0,1,0],radiance:[0,0,0],exposure:1.05,shadows:false,localLights:[point,...Array(4).fill(spot)]}};
  const check=(v:unknown)=>validateRuntimeEnvironment(v,value.id,1,"$");
  expect(()=>check(value)).not.toThrow();
  for (const localLights of [[point,point],[point,...Array(5).fill(spot)],[spot],[{...point,range:.00001}]]) {
    expect(()=>check({...value,lighting:{...value.lighting,localLights}})).toThrow();
  }
  expect(()=>check({...value,schemaVersion:4,outputTransform:"native-aces-spot-shadows-v4"})).toThrow();
});
it("v7 requires a valid author fog and keeps lighting optional", () => {
  const fog = { schemaVersion: 1, kind: "exp2", colorLinearRgb: [0.38, 0.47, 0.49], density: 0.018 };
  const value = { ...source(), schemaVersion: 7, outputTransform: "native-aces-fog-v7", fog };
  const check = (v: unknown) => validateRuntimeEnvironment(v, value.id, 1, "$");
  expect(() => check(value)).not.toThrow();
  const lighting = { direction: [0, 0.6, 0.8], radiance: [2, 1, 0], exposure: 1.05, shadows: false };
  expect(() => check({ ...value, lighting })).not.toThrow();
  const local = { kind: "spot", position: [0, 4, 3], direction: [0, -0.8, -0.6], radiance: [4, 4, 4],
    range: 12, decay: 2, innerCos: 0.8, outerCos: 0.5, castShadow: true };
  expect(() => check({ ...value, lighting: { ...lighting, localLights: [local] } })).not.toThrow();
  const volumetric = { ...fog, kind: "volumetric", steps: 56, height: 32, anisotropy: -0.2 };
  expect(() => check({ ...value, fog: volumetric })).not.toThrow();
  for (const patch of [{ schemaVersion: 2 }, { outputTransform: "native-aces-hdr-v6" },
    { fog: { ...fog, schemaVersion: 2 } }, { fog: { ...fog, kind: "linear" } },
    { fog: { ...fog, colorLinearRgb: [0, 0] } }, { fog: { ...fog, colorLinearRgb: [-0.1, 0, 0] } },
    { fog: { ...fog, colorLinearRgb: [65, 0, 0] } }, { fog: { ...fog, density: -0.1 } },
    { fog: { ...fog, density: 8.1 } }, { fog: { ...fog, density: NaN } }, { fog: { ...volumetric, steps: 65 } },
    { fog: { ...volumetric, height: 0 } }, { fog: { ...volumetric, anisotropy: 1 } }, { fog: undefined },
    { fog: { ...fog, extra: true } }]) {
    expect(() => check({ ...value, ...patch }), JSON.stringify(patch)).toThrow();
  }
  expect(() => check({ ...source(), fog })).toThrow();
  expect(() => check({ ...source(), schemaVersion: 7, outputTransform: "native-aces-fog-v7",
    fog, ibl: {} })).toThrow();
});

// F4 逐字段对拍：v9 作者色彩分级档（六通道）与 Native solid_environment decode
// 同一合同——colorGrading 必须声明、kind 双档（no-ibl / builtin-ibl）、
// fog/lighting 可选、旧档声明 colorGrading 一律拒绝。
it("v9 requires the six-channel author grading and admits both no-ibl and builtin-ibl kinds", () => {
  const grading = { hue: -30, saturation: 0.5, brightness: -0.25, contrast: 0.1, temperature: 0.8, tint: -0.4 };
  const value = { ...source(), schemaVersion: 9, outputTransform: "native-aces-grading-v9", colorGrading: grading };
  const check = (v: unknown) => validateRuntimeEnvironment(v, value.id, 1, "$");
  // no-ibl（普通纯色场景）与 builtin-ibl（studio 语义延续）双 kind 均合法。
  expect(() => check(value)).not.toThrow();
  expect(() => check({ ...value, kind: "solid-background-builtin-ibl" })).not.toThrow();
  // lighting / fog 可选（与 v8 语义一致），带局部灯时走同一阶梯校验。
  const lighting = { direction: [0, 0.6, 0.8], radiance: [2, 1, 0], exposure: 1.05, shadows: false };
  expect(() => check({ ...value, lighting })).not.toThrow();
  const fog = { schemaVersion: 1, kind: "exp2", colorLinearRgb: [0.38, 0.47, 0.49], density: 0.018 };
  expect(() => check({ ...value, fog })).not.toThrow();
  expect(() => check({ ...value, fog, lighting })).not.toThrow();
  // 非法形态：kind 三档之外、缺 colorGrading、通道越界/非有限/未知字段、
  // outputTransform 不匹配、prefiltered-ibl kind、声明 ibl。
  for (const patch of [{ kind: "solid-background-prefiltered-ibl" }, { outputTransform: "native-aces-studio-v8" },
    { outputTransform: "native-aces-fog-v7" }, { ibl: {} }]) {
    expect(() => check({ ...value, ...patch }), JSON.stringify(patch)).toThrow();
  }
  const without = { ...value }; delete (without as Record<string, unknown>).colorGrading;
  expect(() => check(without)).toThrow();
  for (const channel of [{ hue: 180.1 }, { hue: -180.1 }, { hue: NaN }, { hue: Infinity },
    { saturation: -1.1 }, { brightness: 1.01 }, { contrast: "0.1" }, { temperature: 1.0001 },
    { tint: -1.0001 }, { temperature: NaN }, { extra: true }]) {
    expect(() => check({ ...value, colorGrading: { ...grading, ...channel } }), JSON.stringify(channel)).toThrow();
  }
  // 旧档声明 colorGrading 一律拒绝（档位名必须真实描述包内容）。
  expect(() => check({ ...source(), colorGrading: grading })).toThrow();
  expect(() => check({ ...source(), schemaVersion: 8, kind: "solid-background-builtin-ibl",
    outputTransform: "native-aces-studio-v8", colorGrading: grading })).toThrow();
});

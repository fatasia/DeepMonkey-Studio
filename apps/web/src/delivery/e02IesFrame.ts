import type { RuntimeLightProfile } from "@bim-studio/deep-engine/runtime-package";
import { expandIesProfileTable, intensityFactor, prepareIesSampling } from "@bim-studio/deep-engine/lighting";
import { sha256Utf8 } from "@bim-studio/deep-engine/shader-package";

/**
 * E02 IES 着色帧摘要合同（`e02-ies-frame-v1`），纪律同 `r3-state-frame-v1`：
 * canonical 侧由冻结场景 JSON 按合同独立折叠；applied 侧读取真实引擎路径
 * （ViewerEngine 灯光状态 → Three 灯 userData 载体 → projectStudioDeepLights
 * 投影 → packIesShading 实际上传字节）逐字段落入同一序列化。两侧逐字节相等
 * 才进入回执；旋转 45°/scaleFactor 0.5 用例的摘要必须随之稳定变化。
 *
 * 数值纪律：rotationDeg 以半度数整型入摘要；scaleFactor 定点 6 位小数（-0→+0）；
 * 采样因子以 binary64 位模式十六进制入序列（同 e02-golden 的 f64bits 纪律）；
 * 展开表以 f32 位模式十六进制入序列（跨端字节序无关）。
 */

export const E02_IES_FRAME_CONTRACT = "e02-ies-frame-v1";
export const E02_IES_SCENARIO_SCHEMA = "deep-monkey.e02-ies-scenario";
const MAX_LIGHTS = 16;
const MAX_PROFILES = 16;
const MAX_SAMPLES = 256;

export interface E02IesLightSpec {
  readonly id: string;
  readonly profileId: string;
  readonly rotationDeg?: number;
  readonly scaleFactor?: number;
}

export interface E02IesScenario {
  readonly id: string;
  readonly lightProfiles: readonly RuntimeLightProfile[];
  readonly lights: readonly E02IesLightSpec[];
  readonly samples: { readonly thetaDeg: readonly number[]; readonly phiDeg: readonly number[] };
}

/** applied 侧投影灯的最小形状（WorldSpotLight 的 ies 字段）。 */
export interface AppliedIesLight {
  readonly id: string;
  readonly ies?: { readonly profileId: string; readonly rotationDeg?: number; readonly scaleFactor?: number };
}

function fail(message: string): never { throw new Error(`e02-ies scenario: ${message}`); }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onHalfDegreeGrid(value: number): boolean {
  return Math.abs(value * 2 - Math.round(value * 2)) <= 1e-6;
}

function iesReference(ies: unknown, where: string): AppliedIesLight["ies"] {
  if (ies === undefined) return undefined;
  if (!isRecord(ies)) fail(`${where} must be an object`);
  for (const key of Object.keys(ies)) {
    if (!["profileId", "rotationDeg", "scaleFactor"].includes(key)) fail(`${where} has unknown field "${key}"`);
  }
  if (typeof ies.profileId !== "string" || !ies.profileId) fail(`${where}.profileId must be a non-empty string`);
  const rotation = ies.rotationDeg;
  if (rotation !== undefined && (typeof rotation !== "number" || !Number.isFinite(rotation) || rotation < 0 || rotation >= 360 || !onHalfDegreeGrid(rotation))) {
    fail(`${where}.rotationDeg must sit on the 0.5° grid inside [0,360)`);
  }
  const scale = ies.scaleFactor;
  if (scale !== undefined && (typeof scale !== "number" || !Number.isFinite(scale) || scale < 0 || scale > 10)) {
    fail(`${where}.scaleFactor must be inside [0,10]`);
  }
  return { profileId: ies.profileId,
    ...(rotation === undefined ? {} : { rotationDeg: rotation }),
    ...(scale === undefined ? {} : { scaleFactor: scale }) };
}

/** 冻结场景载荷：schema/灯阵/profiles/采样计划全白名单，未知字段拒绝。 */
export function parseE02IesScenario(json: unknown): E02IesScenario {
  if (!isRecord(json)) fail("payload must be an object");
  for (const key of Object.keys(json)) {
    if (!["schema", "schemaVersion", "id", "lightProfiles", "lights", "samples"].includes(key)) fail(`unknown field "${key}"`);
  }
  if (json.schema !== E02_IES_SCENARIO_SCHEMA || json.schemaVersion !== 1) fail("unsupported schema or schemaVersion");
  if (typeof json.id !== "string" || !json.id) fail("id must be a non-empty string");
  if (!Array.isArray(json.lightProfiles) || json.lightProfiles.length < 1 || json.lightProfiles.length > MAX_PROFILES) {
    fail(`lightProfiles must hold 1..${MAX_PROFILES} entries`);
  }
  const profiles = json.lightProfiles.map((profile, index) => {
    if (!isRecord(profile) || typeof profile.profileId !== "string" || !profile.profileId) {
      fail(`lightProfiles[${index}] must carry a profileId`);
    }
    return Object.freeze(profile) as unknown as RuntimeLightProfile;
  });
  if (!Array.isArray(json.lights) || json.lights.length < 1 || json.lights.length > MAX_LIGHTS) {
    fail(`lights must hold 1..${MAX_LIGHTS} entries`);
  }
  const seen = new Set<string>();
  const lights = json.lights.map((light, index) => {
    if (!isRecord(light)) fail(`lights[${index}] must be an object`);
    for (const key of Object.keys(light)) {
      if (!["id", "profileId", "rotationDeg", "scaleFactor"].includes(key)) fail(`lights[${index}] has unknown field "${key}"`);
    }
    if (typeof light.id !== "string" || !light.id) fail(`lights[${index}].id must be a non-empty string`);
    if (seen.has(light.id)) fail(`lights[${index}].id duplicates ${light.id}`);
    seen.add(light.id);
    const reference = iesReference({ profileId: light.profileId, rotationDeg: light.rotationDeg, scaleFactor: light.scaleFactor }, `lights[${index}]`);
    return { id: light.id, profileId: reference!.profileId,
      ...(reference!.rotationDeg === undefined ? {} : { rotationDeg: reference!.rotationDeg }),
      ...(reference!.scaleFactor === undefined ? {} : { scaleFactor: reference!.scaleFactor }) };
  });
  if (!isRecord(json.samples)) fail("samples must be an object");
  const theta = json.samples.thetaDeg, phi = json.samples.phiDeg;
  if (!Array.isArray(theta) || !Array.isArray(phi) || theta.length * phi.length > MAX_SAMPLES
    || [...theta, ...phi].some(value => typeof value !== "number" || !Number.isFinite(value))) {
    fail(`samples must hold finite thetaDeg×phiDeg grids of at most ${MAX_SAMPLES} points`);
  }
  const referenced = lights.map(light => light.profileId);
  for (const profileId of referenced) {
    if (!profiles.some(profile => profile.profileId === profileId)) {
      fail(`light references undeclared profileId ${profileId}`);
    }
  }
  return { id: json.id, lightProfiles: profiles, lights,
    samples: { thetaDeg: Object.freeze([...theta]), phiDeg: Object.freeze([...phi]) } };
}

function fixed6(value: number): string { return (value === 0 ? 0 : value).toFixed(6); }

function f64Bits(value: number): string {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, value === 0 ? 0 : value, false);
  let hex = "";
  for (let index = 0; index < 8; index += 1) hex += view.getUint8(index).toString(16).padStart(2, "0");
  return hex;
}

function f32BitsHex(values: ArrayLike<number>): string {
  const view = new DataView(new ArrayBuffer(4));
  let hex = "";
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(0, values[index] === 0 ? 0 : values[index]!, false);
    for (let byte = 0; byte < 4; byte += 1) hex += view.getUint8(byte).toString(16).padStart(2, "0");
  }
  return hex;
}

/** 展开表的跨端摘要（f32 位模式，权威 intensityFactor 逐点展开）。 */
export function iesTableDigest(profiles: readonly RuntimeLightProfile[]): string {
  const payload = profiles.map(profile => `${profile.profileId}|${f32BitsHex(expandIesProfileTable(profile))}`).join("\n");
  return sha256Utf8(`e02-ies-tables-v1\n${payload}`);
}

function lightField(light: E02IesLightSpec): string {
  const rotationHalf = light.rotationDeg === undefined ? 0 : Math.round(light.rotationDeg * 2);
  const scale = light.scaleFactor === undefined ? 1 : light.scaleFactor;
  return `${light.id}:${light.profileId}:rot=${rotationHalf}:scale=${fixed6(scale)}`;
}

/**
 * 折叠一份 IES 灯阵为合同帧：状态字段（灯/profile/旋转/缩放）+ 冻结采样计划上的
 * intensityFactor 位模式 + 展开表位模式摘要。canonical 与 applied 共用本函数，
 * 差异只在输入灯阵来源（冻结 JSON vs 真实引擎投影）。
 */
export function canonicalIesFrame(scenario: E02IesScenario, appliedLights: readonly AppliedIesLight[]): string {
  const applied = new Map(appliedLights.map(light => [light.id, light]));
  let states = "", samples = "";
  for (const spec of [...scenario.lights].sort((left, right) => left.id < right.id ? -1 : 1)) {
    const source = applied.get(spec.id);
    if (!source?.ies) fail(`applied lights missing ies state for ${spec.id}`);
    const actual: E02IesLightSpec = { id: spec.id, profileId: source.ies.profileId,
      ...(source.ies.rotationDeg === undefined ? {} : { rotationDeg: source.ies.rotationDeg }),
      ...(source.ies.scaleFactor === undefined ? {} : { scaleFactor: source.ies.scaleFactor }) };
    const profile = scenario.lightProfiles.find(candidate => candidate.profileId === actual.profileId);
    if (!profile) fail(`applied light ${actual.id} references undeclared profileId ${actual.profileId}`);
    states += `${lightField(actual)};`;
    const sampling = prepareIesSampling(profile);
    for (const theta of scenario.samples.thetaDeg) {
      for (const phi of scenario.samples.phiDeg) {
        const factor = intensityFactor(sampling, theta, phi, actual.rotationDeg ?? 0, actual.scaleFactor ?? 1);
        samples += `${actual.id}|${fixed6(theta)}|${fixed6(phi)}|${f64Bits(factor)}\n`;
      }
    }
  }
  for (const light of appliedLights) {
    if (!scenario.lights.some(spec => spec.id === light.id)) fail(`applied light ${light.id} is not part of the frozen scenario`);
  }
  return `${E02_IES_FRAME_CONTRACT}|scene=${scenario.id}|lights=${states}|samples=${sha256Utf8(samples)}|tables=${iesTableDigest(scenario.lightProfiles)}`;
}

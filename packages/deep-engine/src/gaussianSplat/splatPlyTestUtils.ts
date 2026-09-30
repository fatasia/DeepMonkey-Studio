/**
 * PLY / .splat 合成夹具构造器(仅供 gaussianSplat 测试消费,不出包)。
 * 支持:自定义属性集合与顺序、format 行、SH 带、按(粒,属性)覆写浮点——
 * NaN/Inf 注入在构建后通过 writeFloat 打点,专测 fail-closed 逐字段路径。
 */
import {
  SPLAT_REQUIRED_PROPERTIES,
  splatPlyPayloadByteLength,
  parseSplatPlyHeader,
} from "./splatFormatContract.js";

export interface SplatPlyFixtureOptions {
  splatCount?: number;
  /** 完整属性名序列(默认 = 法线 + 必选集,顺序任意合法)。 */
  propertyNames?: string[];
  formatLine?: string;
  shRestCount?: 0 | 9 | 24 | 45;
  /** 构建后逐点覆写(或注入 NaN/Inf/0)。 */
  overrides?: ReadonlyArray<{ splatIndex: number; property: string; value: number }>;
}

export interface SplatPlyFixture {
  bytes: Uint8Array;
  view: DataView;
  splatCount: number;
  headerByteLength: number;
  floatStride: number;
  propertyColumns: Map<string, number>;
  writeFloat(splatIndex: number, property: string, value: number): void;
}

const LUIGI_REAL_HEADER = [
  "ply",
  "format binary_little_endian 1.0",
  "element vertex 14526",
  ...["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
    "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
    .map((name) => `property float ${name}`),
  "end_header",
].join("\n");

export { LUIGI_REAL_HEADER };
/** 真实样本(见交付报告样本台账)实测头长;payload = 14526×68。 */
export const LUIGI_REAL_HEADER_BYTE_LENGTH = 415;

export function buildSplatPlyFixture(options: SplatPlyFixtureOptions = {}): SplatPlyFixture {
  const splatCount = options.splatCount ?? 2;
  const shRestCount = options.shRestCount ?? 0;
  const propertyNames = options.propertyNames ?? [
    "nx", "ny", "nz", ...SPLAT_REQUIRED_PROPERTIES,
  ];
  const withRest = shRestCount > 0
    ? [...propertyNames, ...Array.from({ length: shRestCount }, (_, i) => `f_rest_${i}`)]
    : propertyNames;
  const formatLine = options.formatLine ?? "format binary_little_endian 1.0";
  const headerText = `${["ply", formatLine, `element vertex ${splatCount}`,
    ...withRest.map((name) => `property float ${name}`), "end_header", ""].join("\n")}`;
  const headerBytes = new TextEncoder().encode(headerText);
  const bytes = new Uint8Array(headerBytes.length + splatCount * withRest.length * 4);
  bytes.set(headerBytes, 0);

  const fixtureView = new DataView(bytes.buffer);
  const propertyColumns = new Map(withRest.map((name, column) => [name, column]));
  const fixture: SplatPlyFixture = {
    bytes,
    view: fixtureView,
    splatCount,
    headerByteLength: headerBytes.length,
    floatStride: withRest.length,
    propertyColumns,
    writeFloat(splatIndex, property, value) {
      const column = propertyColumns.get(property);
      if (column === undefined) throw new Error(`fixture has no property ${property}`);
      fixtureView.setFloat32(
        headerBytes.length + (splatIndex * withRest.length + column) * 4, value, true);
    },
  };
  // 默认单位四元数 w=1:全零四元数是非法负载,不能成为夹具缺省值,
  // 否则测其他字段的 fail-closed 路径会先被旋转校验拦截。
  // 属性被显式剔除的夹具(必选字段缺失测试)跳过,由缺失路径自己报错。
  if (propertyColumns.has("rot_0")) {
    for (let splatIndex = 0; splatIndex < splatCount; splatIndex++) {
      fixture.writeFloat(splatIndex, "rot_0", 1);
    }
  }
  for (const override of options.overrides ?? []) {
    fixture.writeFloat(override.splatIndex, override.property, override.value);
  }
  return fixture;
}

/** 夹具自检:合法夹具必须通过自家合同(防夹具本身坏掉导致测试假绿)。 */
export function assertFixtureIsValid(fixture: SplatPlyFixture): void {
  parseSplatPlyHeader(fixture.bytes);
  const contract = parseSplatPlyHeader(fixture.bytes);
  if (splatPlyPayloadByteLength(contract) !== fixture.bytes.byteLength - fixture.headerByteLength) {
    throw new Error("fixture payload length drifted from its own header");
  }
}

export interface SplatRuntimeFixtureSplat {
  position: readonly [number, number, number];
  scale: readonly [number, number, number];
  color: readonly [number, number, number, number];
  rotation: readonly [number, number, number, number];
}

export function buildSplatRuntimeFixture(splats: SplatRuntimeFixtureSplat[]): Uint8Array {
  const bytes = new Uint8Array(splats.length * 32);
  const view = new DataView(bytes.buffer);
  splats.forEach((splat, index) => {
    const base = index * 32;
    view.setFloat32(base, splat.position[0], true);
    view.setFloat32(base + 4, splat.position[1], true);
    view.setFloat32(base + 8, splat.position[2], true);
    view.setFloat32(base + 12, splat.scale[0], true);
    view.setFloat32(base + 16, splat.scale[1], true);
    view.setFloat32(base + 20, splat.scale[2], true);
    for (let channel = 0; channel < 4; channel++) bytes[base + 24 + channel] = splat.color[channel]!;
    for (let channel = 0; channel < 4; channel++) bytes[base + 28 + channel] = splat.rotation[channel]!;
  });
  return bytes;
}

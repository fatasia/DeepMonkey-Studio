import { array, fields, integer, record, requireValue, resourceId, string } from "./primitives.js";
import { RUNTIME_IBL_MAX_BYTES, type RuntimePrefilteredIbl } from "./environmentTypes.js";
import { visitIblBytes } from "./environmentBytes.js";
import { validateLocalLights } from "./localLights.js";
import { validateLightingIes } from "./lightProfiles.js";
import { runtimeContentSha256 } from "./hash.js";
// 级联层数/记录预算常量唯一来源是 Native 打包器（与 Rust PROBE_GI_GRID_MAX_LEVELS
// 及 storage 65536 预算同源），此处禁止另写数字。
import { NATIVE_PROBE_GRID_MAX_LEVELS, NATIVE_PROBE_GRID_MAX_PROBES } from "../lighting/nativeProbeGridPacker.js";

export const BUILTIN_RUNTIME_IBL_ID = "deep.builtin.studio-ibl.v1";
export function validateRuntimeEnvironment(value: unknown, id: string, revision: number, path: string): void {
  const object = record(value, path);
  if (object.schema === "deep-engine.solid-environment") {
    const hdr = object.schemaVersion === 6;
    // v7 显雾必填；v8 studio 与 v9 分级档沿袭 v7 的雾语义但雾可选。
    const fogged = object.schemaVersion === 7 || object.schemaVersion === 8 || object.schemaVersion === 9;
    const studio = object.schemaVersion === 8;
    // v9 作者色彩分级档：colorGrading 必须声明；kind 允许 no-ibl 与 builtin-ibl
    // （studio 语义延续），与 Native solid_environment decode 档位门同一合同。
    const grading = object.schemaVersion === 9;
    const hasFog = object.fog !== undefined;
    fields(object, ["schema", "schemaVersion", "id", "revision", "kind", "backgroundSrgb", "outputTransform",
      ...(hdr ? ["ibl"] : []), ...(object.schemaVersion === 7 ? ["fog"] : []), ...(grading ? ["colorGrading"] : [])],
      ["lighting", "staticLightmap", "irradianceProbes", ...(studio || grading ? ["fog"] : [])], path);
    const pointShadow = object.schemaVersion === 5;
    const shadows = pointShadow || object.schemaVersion === 4;
    const many = shadows || object.schemaVersion === 3;
    const lit = many || object.schemaVersion === 2;
    const fogLit = fogged && object.lighting !== undefined;
    // v7 的 author fog 是合同必需项：显式 undefined 与缺失一致，均 fail-closed（v8/v9 才可选）。
    requireValue(!(object.schemaVersion === 7 && object.fog === undefined), path, "v7 requires author fog.");
    requireValue((hdr || lit || fogged || object.schemaVersion === 1) && object.id === id && id === "scene.environment"
      && object.revision === 1 && revision === 1
      && object.kind === (grading ? object.kind // v9 的 kind 在下方 grading 块内显式校验双档位。
        : studio ? "solid-background-builtin-ibl" : hdr ? "solid-background-prefiltered-ibl" : "solid-background-no-ibl")
      && object.outputTransform === (grading ? "native-aces-grading-v9" : studio ? "native-aces-studio-v8" : fogged ? "native-aces-fog-v7" : hdr ? "native-aces-hdr-v6" : pointShadow ? "native-aces-local-shadows-v5" : shadows ? "native-aces-spot-shadows-v4" : many ? "native-aces-lights-v3" : lit ? "native-aces-light-v2" : "native-aces-v1")
      && (hdr || lit || fogged || !Object.hasOwn(object, "lighting")), path, "Unsupported solid environment profile.");
    if (grading) {
      // v9 双 kind：builtin-ibl（继承 v8 studio）或 no-ibl（普通纯色场景），二者之外拒绝。
      requireValue(object.kind === "solid-background-no-ibl" || object.kind === "solid-background-builtin-ibl",
        path, "Unsupported solid environment profile.");
      const channels = record(object.colorGrading, `${path}.colorGrading`);
      fields(channels, ["hue", "saturation", "brightness", "contrast"], ["temperature", "tint"], `${path}.colorGrading`);
      // 六通道范围与 Native AuthorGrading::new / 属性面板三方一致：hue ±180 度，其余 ±1。
      const inRange = (value: unknown, min: number, max: number): value is number =>
        typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
      requireValue(inRange(channels.hue, -180, 180)
        && (["saturation", "brightness", "contrast"] as const).every(key => inRange(channels[key], -1, 1))
        && (["temperature", "tint"] as const).every(key => channels[key] === undefined || inRange(channels[key], -1, 1)),
        `${path}.colorGrading`, "Invalid authored color grading.");
    }
    if (hdr) {
      validateRuntimePrefilteredIbl(object.ibl,id,revision,`${path}.ibl`);
      const light = record(object.lighting, `${path}.lighting`);
      const locals = light.localLights as Array<{castShadow?:boolean;kind?:string}> | undefined;
      const point = Array.isArray(locals) && locals.some(value=>value?.kind==="point" && value.castShadow);
      const cast = Array.isArray(locals) && locals.some(value=>value?.castShadow);
      const version=point?5:cast?4:locals?3:2;
      const plain={...object}; delete plain.ibl;
      validateRuntimeEnvironment({...plain,schemaVersion:version,kind:"solid-background-no-ibl",outputTransform:point?"native-aces-local-shadows-v5":cast?"native-aces-spot-shadows-v4":locals?"native-aces-lights-v3":"native-aces-light-v2"},id,revision,path);
    }
    if (lit || fogLit) {
      const light = record(object.lighting, `${path}.lighting`);
      // v3-v5 阶梯强制 localLights；v7 灯光沿用完整阶梯能力但 localLights 可选（同 v2）。
      const withLocals = many || (fogLit && light.localLights !== undefined);
      fields(light, ["direction", "radiance", "exposure", "shadows", ...(withLocals ? ["localLights"] : [])], withLocals ? ["lightProfiles", "globalIlluminationIntensity"] : ["globalIlluminationIntensity"], path);
      if (withLocals) {
        if (lit) {
          validateLocalLights(light.localLights, `${path}.lighting.localLights`, shadows, pointShadow);
        } else {
          const locals = light.localLights as Array<{castShadow?:boolean;kind?:string}> | undefined;
          const point = Array.isArray(locals) && locals.some(value=>value?.kind==="point" && value.castShadow);
          const cast = Array.isArray(locals) && locals.some(value=>value?.castShadow);
          validateLocalLights(light.localLights, `${path}.lighting.localLights`, cast === true || point, point);
        }
        // E02：ies 引用闭合与 lightProfiles 量化网格验证（列名报错）。
        validateLightingIes(light, `${path}.lighting`);
      }
      const direction = array(light.direction, path, 3), radiance = array(light.radiance, path, 3);
      requireValue(direction.length === 3 && direction.every(v => typeof v === "number" && Number.isFinite(v))
        && Math.abs((direction as number[]).reduce((sum, v) => sum + v*v, 0) - 1) < 0.0001
        && radiance.length === 3 && radiance.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 256)
        && typeof light.exposure === "number" && light.exposure >= 0.55 && light.exposure <= 1.55
        && typeof light.shadows === "boolean"
        && (light.globalIlluminationIntensity === undefined || (typeof light.globalIlluminationIntensity === "number"
          && Number.isFinite(light.globalIlluminationIntensity) && light.globalIlluminationIntensity >= 0 && light.globalIlluminationIntensity <= 16)), path, "Invalid authored directional lighting.");
    }
    if (hasFog) {
      const fog = record(object.fog, `${path}.fog`);
      fields(fog, ["schemaVersion", "kind", "colorLinearRgb", "density"], [], `${path}.fog`);
      const color = array(fog.colorLinearRgb, `${path}.fog.colorLinearRgb`, 3);
      // 通道与密度上限与 Native FogSettings(MAX_HDR_CHANNEL=64 / MAX_DENSITY=8)一致。
      requireValue(fog.schemaVersion === 1 && fog.kind === "exp2"
        && color.length === 3 && color.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 64)
        && typeof fog.density === "number" && Number.isFinite(fog.density) && fog.density >= 0 && fog.density <= 8,
        path, "Invalid authored fog.");
    }
    if (object.staticLightmap !== undefined) validateStaticLightmap(object.staticLightmap, `${path}.staticLightmap`);
    if (object.irradianceProbes !== undefined) validateIrradianceProbes(object.irradianceProbes, `${path}.irradianceProbes`);
    const color = array(object.backgroundSrgb, `${path}.backgroundSrgb`, 3);
    requireValue(color.length === 3 && color.every(channel => typeof channel === "number"
      && Number.isFinite(channel) && channel >= 0 && channel <= 1), path, "Invalid sRGB background.");
    return;
  }
  if (object.schema === "deep-engine.ibl-reference") {
    fields(object, ["schema", "schemaVersion", "id", "revision", "kind"], [], path);
    requireValue(object.schemaVersion === 1 && object.id === id && id === BUILTIN_RUNTIME_IBL_ID
      && object.revision === 1 && revision === 1 && object.kind === "builtin-default", path, "Unsupported built-in IBL identity or source.");
    return;
  }
  validateRuntimePrefilteredIbl(value, id, revision, path);
}

export function validateRuntimePrefilteredIbl(value: unknown, id: string, revision: number, path = "$.environment"): RuntimePrefilteredIbl {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "id", "revision", "kind", "format", "encoding", "faceOrder", "source", "specular", "diffuse", "brdfLut"], [], path);
  requireValue(object.schema === "deep-engine.ibl-prefiltered" && object.schemaVersion === 1
    && object.kind === "prefiltered-hdri" && object.format === "rgba16float" && object.encoding === "base64-le"
    && object.faceOrder === "px-nx-py-ny-pz-nz", path, "Unsupported prefiltered IBL profile.");
  requireValue(resourceId(object.id, `${path}.id`) === id && id !== BUILTIN_RUNTIME_IBL_ID
    && integer(object.revision, 1, 0xffff_ffff, `${path}.revision`) === revision, path, "IBL identity differs from its index.");
  const source = record(object.source, `${path}.source`);
  fields(source, ["contentHash", "license"], [], `${path}.source`);
  const hash = record(source.contentHash, `${path}.source.contentHash`);
  fields(hash, ["algorithm", "value"], [], `${path}.source.contentHash`);
  requireValue(hash.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(string(hash.value, path)), path, "Invalid IBL source hash.");
  const license = string(source.license, `${path}.source.license`);
  requireValue(license.trim().length > 0 && license.length <= 256, path, "Invalid IBL source license.");
  const planes: { data: string; bytes: number; path: string }[] = [];
  const cube = (key: "specular" | "diffuse"): void => {
    const p = `${path}.${key}`, value = record(object[key], p); fields(value, ["mips"], [], p);
    const mips = array(value.mips, `${p}.mips`, 12);
    requireValue(mips.length > 0 && (key !== "diffuse" || mips.length === 1), p, "Invalid IBL mip count.");
    let expected = 0;
    for (const [level, input] of mips.entries()) {
      const q = `${p}.mips[${level}]`, mip = record(input, q); fields(mip, ["size", "dataBase64"], [], q);
      const size = dimension(mip.size, `${q}.size`);
      requireValue(level === 0 || size === expected, q, "Invalid IBL mip dimensions."); expected = size / 2;
      planes.push({ data: string(mip.dataBase64, `${q}.dataBase64`), bytes: size * size * 6 * 8, path: q });
    }
    requireValue(key !== "specular" || expected === 0.5, p, "Specular IBL requires a complete mip chain.");
  };
  cube("specular"); cube("diffuse");
  const lut = record(object.brdfLut, `${path}.brdfLut`);
  fields(lut, ["width", "height", "dataBase64"], [], `${path}.brdfLut`);
  const width = dimension(lut.width, path), height = dimension(lut.height, path);
  requireValue(width === height, path, "IBL BRDF LUT must be square.");
  planes.push({ data: string(lut.dataBase64, path), bytes: width * height * 8, path: `${path}.brdfLut` });
  requireValue(planes.reduce((sum, plane) => sum + plane.bytes, 0) <= RUNTIME_IBL_MAX_BYTES, path, "IBL decoded byte budget exceeded.");
  for (const plane of planes) visitIblBytes(plane.data, plane.bytes, plane.path);
  return object as unknown as RuntimePrefilteredIbl;
}

function dimension(value: unknown, path: string): number {
  const size = integer(value, 1, 2048, path);
  requireValue((size & (size - 1)) === 0, path, "IBL dimensions must be powers of two."); return size;
}

export function validateRuntimeStaticLightmapBinding(environment: unknown, renderPacket: unknown, path = "$.environment"): void {
  const object = record(environment, path);
  if (object.staticLightmap === undefined) return;
  const descriptor = record(object.staticLightmap, `${path}.staticLightmap`);
  const packet = record(renderPacket, "$.renderPacket");
  const textures = array(packet.textures, "$.renderPacket.textures");
  const texture = textures.find(candidate => record(candidate, "$.renderPacket.textures[]").id === descriptor.textureId);
  requireValue(texture !== undefined, `${path}.staticLightmap.textureId`, "Static lightmap texture is missing from the render packet.");
  const textureObject = record(texture, `${path}.staticLightmap.textureId`);
  requireValue(textureObject.semantic === "occlusion" || textureObject.semantic === "emissive",
    `${path}.staticLightmap.textureId`, "Static lightmap texture must use an occlusion or emissive slot.");
  requireValue(textureObject.width === descriptor.width && textureObject.height === descriptor.height,
    `${path}.staticLightmap`, "Static lightmap dimensions differ from the texture resource.");
  const uvSet = descriptor.uvSet;
  const geometries = array(packet.geometries, "$.renderPacket.geometries");
  const hasUv = geometries.some((candidate: unknown) => {
    const geometry = record(candidate, "$.renderPacket.geometries[]");
    const values = geometry[uvSet === 0 ? "uv0" : "uv1"];
    return Array.isArray(values) && values.length >= 6;
  });
  requireValue(hasUv, `${path}.staticLightmap.uvSet`, "Static lightmap UV set is missing from the render packet geometry.");
  requireValue(runtimeContentSha256(textureObject) === record(descriptor.textureHash, `${path}.staticLightmap.textureHash`).value,
    `${path}.staticLightmap.textureHash`, "Static lightmap texture hash does not match the render packet.");
}

function validateStaticLightmap(value: unknown, path: string): void {
  const object = record(value, path);
  fields(object, ["schema", "schemaVersion", "textureId", "textureHash", "uvSet", "colorSpace", "intensity", "width", "height"], [], path);
  const hash = record(object.textureHash, `${path}.textureHash`);
  fields(hash, ["algorithm", "value"], [], `${path}.textureHash`);
  const width = object.width, height = object.height;
  requireValue(object.schema === "deep-engine.static-lightmap" && object.schemaVersion === 1
    && typeof object.textureId === "string" && object.textureId.length > 0
    && hash.algorithm === "sha256" && typeof hash.value === "string" && /^[0-9a-f]{64}$/.test(hash.value)
    && (object.uvSet === 0 || object.uvSet === 1)
    && (object.colorSpace === "linear" || object.colorSpace === "srgb")
    && typeof object.intensity === "number" && Number.isFinite(object.intensity) && object.intensity >= 0 && object.intensity <= 64
    && Number.isSafeInteger(width) && (width as number) >= 1 && (width as number) <= 16384
    && Number.isSafeInteger(height) && (height as number) >= 1 && (height as number) <= 16384,
    path, "Invalid static lightmap descriptor.");
}

/**
 * F3 探针网格校验：按 `levels` 键分派 v1 双形态，fail-closed。
 * - 单层：网格/预算/探针字段与 Web 打包器和 Native 解码合同一致（旧路径逐位不变）；
 * - 多层级联：层数 1..=4（Native PROBE_GI_GRID_MAX_LEVELS）、每层走既有单层规则、
 *   细→粗排序（粗层 spacing 严格更大）、粗层范围逐轴包含细层范围、布局头 +
 *   全层记录总数不超 Native storage 预算——与 Native decode_probe_grid_cascade
 *   和 Web packNativeProbeGridLevels 同一套合同；顶层单层字段与 levels 并存
 *   由 fields() 以未知字段拒绝。
 */
function validateIrradianceProbes(value: unknown, path: string): void {
  const object = record(value, path);
  requireValue(object.schema === "deep-engine.probe-grid" && object.schemaVersion === 1,
    path, "Unsupported probe grid schema.");
  if (object.levels !== undefined) {
    fields(object, ["schema", "schemaVersion", "levels"], [], path);
    const levels = array(object.levels, `${path}.levels`, NATIVE_PROBE_GRID_MAX_LEVELS);
    requireValue(levels.length >= 1, `${path}.levels`, "Probe grid cascade requires at least one level.");
    const extents: { origin: number[]; max: number[]; spacing: number }[] = [];
    for (const [index, level] of levels.entries()) {
      const levelPath = `${path}.levels[${index}]`;
      const extent = validateProbeGridLevel(record(level, levelPath), levelPath);
      // 层间嵌套（细→粗）：粗层 spacing 严格更大、粗层范围逐轴包含细层范围
      // （与 Rust decode_probe_grid_cascade 的 fail-closed 校验一致）。
      if (index > 0) {
        const fine = extents[index - 1]!;
        requireValue(extent.spacing > fine.spacing
          && extent.origin.every((value, axis) => value <= fine.origin[axis]!)
          && extent.max.every((value, axis) => value >= fine.max[axis]!),
          levelPath, "Coarse probe grid level must strictly increase spacing and contain the fine level extent.");
      }
      extents.push(extent);
    }
    // v2 布局头 + Σ(层头 + 探针) 记录总数不超 Native storage 预算（与打包器一致）。
    const totalRecords = 1 + levels.reduce((sum: number, level) => {
      const probes = (level as { probes: unknown[] }).probes as unknown[];
      return sum + 1 + probes.length;
    }, 0);
    requireValue(totalRecords <= NATIVE_PROBE_GRID_MAX_PROBES, `${path}.levels`, "Probe grid record budget exceeded.");
    return;
  }
  fields(object, ["schema", "schemaVersion", "origin", "spacing", "gridSize", "probes"], [], path);
  validateProbeGridGeometry(object, path);
}

/** 级联单层校验入口：层不带 schema 身份，字段闭合 + 几何/探针规则。 */
function validateProbeGridLevel(object: Record<string, unknown>, path: string): { origin: number[]; max: number[]; spacing: number } {
  fields(object, ["origin", "spacing", "gridSize", "probes"], [], path);
  return validateProbeGridGeometry(object, path);
}

/** 几何/探针规则（字段闭合由调用方负责）：返回层范围供级联嵌套检查。 */
function validateProbeGridGeometry(object: Record<string, unknown>, path: string): { origin: number[]; max: number[]; spacing: number } {
  const spacing = object.spacing as number;
  const gridSize = object.gridSize as number[];
  const origin = object.origin as number[];
  const probes = array(object.probes, `${path}.probes`, 65_535);
  requireValue(typeof spacing === "number" && Number.isFinite(spacing) && spacing > 0 && spacing <= 1_000_000,
    path, "Invalid probe grid spacing.");
  requireValue(origin.length === 3 && origin.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1_000_000_000),
    path, "Invalid probe grid origin.");
  requireValue(gridSize.length === 3 && gridSize.every(v => Number.isSafeInteger(v) && (v as number) >= 2 && (v as number) <= 64),
    path, "Invalid probe grid size.");
  requireValue(probes.length === (gridSize[0] as number) * (gridSize[1] as number) * (gridSize[2] as number),
    path, "Probe count must equal the grid volume.");
  const maxPosition = [0, 1, 2].map(axis => (origin[axis] as number) + (gridSize[axis] as number) * spacing);
  requireValue(maxPosition.every(v => Number.isFinite(v) && Math.abs(v) <= 1_000_000_000),
    path, "Invalid probe grid extent.");
  for (const [index, probe] of probes.entries()) {
    const probePath = `${path}.probes[${index}]`;
    const item = record(probe, probePath);
    fields(item, ["irradiance", "validity", "meanDistance", "distanceVariance"], ["occlusionFloor", "positionOffset"], probePath);
    const irradiance = item.irradiance as number[];
    requireValue(irradiance.length === 3 && irradiance.every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 65_504),
      probePath, "Invalid probe irradiance.");
    requireValue(typeof item.validity === "number" && Number.isFinite(item.validity) && item.validity >= 0 && item.validity <= 1,
      probePath, "Invalid probe validity.");
    requireValue(typeof item.meanDistance === "number" && Number.isFinite(item.meanDistance) && item.meanDistance >= 0 && item.meanDistance <= 1_000_000,
      probePath, "Invalid probe mean distance.");
    requireValue(typeof item.distanceVariance === "number" && Number.isFinite(item.distanceVariance) && item.distanceVariance >= 0 && item.distanceVariance <= 1_000_000_000_000,
      probePath, "Invalid probe distance variance.");
    if (item.occlusionFloor !== undefined) {
      requireValue(typeof item.occlusionFloor === "number" && Number.isFinite(item.occlusionFloor) && item.occlusionFloor >= 0 && item.occlusionFloor <= 1,
        probePath, "Invalid probe occlusion floor.");
    }
    if (item.positionOffset !== undefined) {
      const offset = item.positionOffset as number[];
      requireValue(offset.length === 3 && offset.every(v => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= spacing),
        probePath, "Invalid probe relocation offset.");
    }
  }
  return { origin, max: maxPosition, spacing };
}

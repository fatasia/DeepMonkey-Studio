import { array, fields, integer, record, requireValue, resourceId, string } from "./primitives.js";
import { RUNTIME_IBL_MAX_BYTES, type RuntimePrefilteredIbl } from "./environmentTypes.js";
import { visitIblBytes } from "./environmentBytes.js";
import { validateLocalLights } from "./localLights.js";
import { validateLightingIes } from "./lightProfiles.js";

export const BUILTIN_RUNTIME_IBL_ID = "deep.builtin.studio-ibl.v1";
export function validateRuntimeEnvironment(value: unknown, id: string, revision: number, path: string): void {
  const object = record(value, path);
  if (object.schema === "deep-engine.solid-environment") {
    const hdr = object.schemaVersion === 6;
    const fogged = object.schemaVersion === 7 || object.schemaVersion === 8;
    const studio = object.schemaVersion === 8;
    const hasFog = object.fog !== undefined;
    fields(object, ["schema", "schemaVersion", "id", "revision", "kind", "backgroundSrgb", "outputTransform",
      ...(hdr ? ["ibl"] : []), ...(object.schemaVersion === 7 ? ["fog"] : [])],
      ["lighting", "staticLightmap", ...(studio ? ["fog"] : [])], path);
    const pointShadow = object.schemaVersion === 5;
    const shadows = pointShadow || object.schemaVersion === 4;
    const many = shadows || object.schemaVersion === 3;
    const lit = many || object.schemaVersion === 2;
    const fogLit = fogged && object.lighting !== undefined;
    // v7 的 author fog 是合同必需项：显式 undefined 与缺失一致，均 fail-closed（v8 studio 才可选）。
    requireValue(!(object.schemaVersion === 7 && object.fog === undefined), path, "v7 requires author fog.");
    requireValue((hdr || lit || fogged || object.schemaVersion === 1) && object.id === id && id === "scene.environment"
      && object.revision === 1 && revision === 1 && object.kind === (studio ? "solid-background-builtin-ibl" : hdr ? "solid-background-prefiltered-ibl" : "solid-background-no-ibl")
      && object.outputTransform === (studio ? "native-aces-studio-v8" : fogged ? "native-aces-fog-v7" : hdr ? "native-aces-hdr-v6" : pointShadow ? "native-aces-local-shadows-v5" : shadows ? "native-aces-spot-shadows-v4" : many ? "native-aces-lights-v3" : lit ? "native-aces-light-v2" : "native-aces-v1")
      && (hdr || lit || fogged || !Object.hasOwn(object, "lighting")), path, "Unsupported solid environment profile.");
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

import { array, fields, integer, record, requireValue, resourceId, string } from "./primitives.js";
import { RUNTIME_IBL_MAX_BYTES, type RuntimePrefilteredIbl } from "./environmentTypes.js";
import { visitIblBytes } from "./environmentBytes.js";

export const BUILTIN_RUNTIME_IBL_ID = "deep.builtin.studio-ibl.v1";
export function validateRuntimeEnvironment(value: unknown, id: string, revision: number, path: string): void {
  const object = record(value, path);
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
